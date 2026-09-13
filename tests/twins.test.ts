import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, approveCurrent, execute, prepare, prepareCurrent, refreshRecords, seedWorkspace } from '../server/recovery.js';
import { mintGithubToken, twinAdapter } from '../server/twins.js';
import type { TwinBinding, Workspace } from '../shared/types.js';

const credentials = { github: 'gh-token', linear: 'lin-token', slack: 'xoxb-token' };
const binding = (provider: TwinBinding['provider'], overrides: Partial<TwinBinding> = {}): TwinBinding =>
  ({ provider, runId: `run-${provider}`, baseUrl: `https://${provider}.twin.test`, status: 'ready', expiresAt: null, ...overrides });
const bindings = { github: binding('github'), linear: binding('linear'), slack: binding('slack') };

/** In-memory stand-in for the three twins, recording every request it receives. */
function fakeTwins(state = { issueState: 'open', assignee: 'Alex Rivera', replies: [] as string[] }) {
  const requests: Array<{ method: string; url: string; body: any; headers: Record<string, string> }> = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? 'GET', url: href, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (href.includes('github.twin.test')) {
      if (init?.method === 'PATCH') { state.issueState = body.state; return json({ number: 184, state: state.issueState }); }
      return json({ number: 184, state: state.issueState });
    }
    if (href.includes('linear.twin.test')) {
      const query: string = body.query;
      if (query.includes('users(')) return json({ data: { users: { nodes: [{ id: 'u1', name: 'Jamie Chen' }, { id: 'u2', name: 'Alex Rivera' }] } } });
      if (query.includes('issueUpdate')) { state.assignee = body.variables.i.assigneeId === 'u1' ? 'Jamie Chen' : 'Alex Rivera'; return json({ data: { issueUpdate: { success: true } } }); }
      return json({ data: { issue: { assignee: { name: state.assignee } } } });
    }
    if (href.endsWith('/api/chat.postMessage')) { state.replies.push(body.text); return json({ ok: true, ts: `ts-${state.replies.length}` }); }
    if (new URL(href).pathname === '/api/conversations.replies') {
      return json({ ok: true, messages: [{ ts: 'ts-original', text: 'Acme is ready.' }, ...state.replies.map((text, i) => ({ ts: `ts-${i + 1}`, text }))] });
    }
    return json({ ok: false, error: 'unexpected' });
  }) as unknown as typeof fetch;
  return { fetcher, requests, state };
}

/** Binds the seeded scenario to twin records without contacting Arga. */
function twinWorkspace(): Workspace {
  const w = seedWorkspace();
  w.mode = 'twin';
  w.twins = Object.values(bindings);
  w.records[0].external = { provider: 'github', owner: 'scenario-user', repo: 'onboarding', issueNumber: 184 };
  w.records[1].external = { provider: 'linear', issueId: 'iss-1', teamId: 'team-1' };
  w.records[2].external = { provider: 'slack', channelId: 'C1', ts: 'ts-original' };
  return w;
}

test('repair writes reach each twin API and are verified by reading it back', async () => {
  const twins = fakeTwins();
  const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  await execute(w, p.id, () => {}, { adapter: twinAdapter(bindings, credentials, twins.fetcher) });
  assert.equal(p.status, 'complete');
  assert.equal(twins.state.issueState, 'closed', 'the duplicate issue must be closed in the twin');
  assert.equal(twins.state.assignee, 'Jamie Chen', 'the original owner must be restored in the twin');
  assert.equal(twins.state.replies.length, 1);
  assert.match(twins.state.replies[0], /^Correction:/);
  const patch = twins.requests.find(r => r.method === 'PATCH');
  assert.equal(patch?.url, 'https://github.twin.test/repos/scenario-user/onboarding/issues/184');
});

test('the correction is a threaded reply and never edits the original message', async () => {
  const twins = fakeTwins();
  const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  await execute(w, p.id, () => {}, { adapter: twinAdapter(bindings, credentials, twins.fetcher) });
  const post = twins.requests.find(r => r.url.endsWith('/api/chat.postMessage'));
  assert.equal(post?.body.thread_ts, 'ts-original');
  assert.equal(twins.requests.some(r => r.url.includes('chat.update')), false);
});

test('an out-of-band twin change stops execution even when the local mirror looks clean', async () => {
  const twins = fakeTwins();
  const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  twins.state.assignee = 'Someone Else'; // changed in the twin only; w.records still says Alex Rivera
  await assert.rejects(() => execute(w, p.id, () => {}, { adapter: twinAdapter(bindings, credentials, twins.fetcher) }), /changed since approval/);
  assert.equal(twins.state.issueState, 'open', 'no operation may be applied once a record is stale');
});

test('a write the twin accepted before a crash reconciles without writing twice', async () => {
  const twins = fakeTwins();
  const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  const adapter = twinAdapter(bindings, credentials, twins.fetcher);
  let disk = '';
  await execute(w, p.id, () => { disk = JSON.stringify(w); }, { adapter, interruptAfterWrite: true });
  const restored: Workspace = JSON.parse(disk);
  assert.equal(restored.plans[0].status, 'interrupted');
  // The crash loses the mirror update the twin already accepted.
  restored.records[0].fields.state = 'open';
  restored.records[0].revision = 1;
  restored.records[0].lastActor = 'agent';
  const before = twins.requests.filter(r => r.method === 'PATCH').length;
  await execute(restored, p.id, () => {}, { adapter });
  assert.equal(twins.requests.filter(r => r.method === 'PATCH').length, before, 'must not repeat the accepted write');
  assert.equal(restored.plans[0].status, 'complete');
  assert.equal(restored.records[0].revision, 2);
});

test('an expired twin refuses writes instead of failing open to the local mirror', async () => {
  const twins = fakeTwins();
  const expired = { ...bindings, github: binding('github', { expiresAt: new Date(Date.now() - 1000).toISOString() }) };
  const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  await assert.rejects(() => execute(w, p.id, () => {}, { adapter: twinAdapter(expired, credentials, twins.fetcher) }), /expired/);
  assert.equal(twins.state.issueState, 'open');
});

test('a record with no twin binding cannot be repaired in twin mode', async () => {
  const twins = fakeTwins();
  const w = twinWorkspace(); delete w.records[0].external;
  const p = prepare(w); approve(w, p.id);
  await assert.rejects(() => execute(w, p.id, () => {}, { adapter: twinAdapter(bindings, credentials, twins.fetcher) }), /not bound to a twin/);
});

test('a read sends no Authorization header when no token is configured', async () => {
  const twins = fakeTwins();
  const w = twinWorkspace();
  const adapter = twinAdapter(bindings, {}, twins.fetcher);
  assert.equal(await adapter.read(w.records[0], 'state'), 'open');
  const read = twins.requests.at(-1)!;
  assert.equal('authorization' in Object.fromEntries(Object.entries(read.headers).map(([k, v]) => [k.toLowerCase(), v])), false);
});

test('the GitHub twin credential is minted through the app manifest handshake', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const seen: string[] = [];
  let installed = false;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url); seen.push(`${init?.method ?? 'GET'} ${new URL(href).pathname}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (href.endsWith('/settings/apps/new')) return new Response(null, { status: 302, headers: { location: 'https://aftercare.local/callback?code=exchange-code' } });
    if (href.includes('/app-manifests/')) {
      assert.match(href, /exchange-code/);
      return json({ id: 8, slug: 'aftercare-1', pem: privateKey }, 201);
    }
    if (href.endsWith('/_ui/apps/aftercare-1/install')) { installed = true; return new Response('', { status: 200 }); }
    if (href.endsWith('/app/installations')) return json(installed ? [{ id: 42 }] : []);
    if (href.endsWith('/app/installations/42/access_tokens')) {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const [header, payload] = auth.replace('Bearer ', '').split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
      assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss, '8');
      return json({ token: 'ghs_minted_installation_token' });
    }
    return json({ message: 'unexpected' }, 404);
  }) as unknown as typeof fetch;

  const token = await mintGithubToken('https://github.twin.test', fetcher);
  assert.equal(token, 'ghs_minted_installation_token');
  assert.deepEqual(seen, [
    'POST /settings/apps/new',
    'POST /app-manifests/exchange-code/conversions',
    'GET /app/installations',
    'POST /_ui/apps/aftercare-1/install',
    'GET /app/installations',
    'POST /app/installations/42/access_tokens',
  ]);
});

test('an assignment changed during an earlier write is preserved and a fresh plan can finish', async () => {
  const twins = fakeTwins();
  const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  const adapter = twinAdapter(bindings, credentials, twins.fetcher);
  const write = adapter.write;
  adapter.write = async (record, field, value) => {
    await write(record, field, value);
    if (record.app === 'GitHub') twins.state.assignee = 'Human choice';
  };
  await assert.rejects(execute(w, p.id, () => {}, { adapter }), /changed since approval/);
  assert.equal(p.status, 'stale');
  assert.equal(twins.state.assignee, 'Human choice');
  assert.equal(twins.state.replies.length, 0, 'dependent Slack correction must be withheld');
  const next = await prepareCurrent(w, adapter);
  assert.equal(next.operations[0].status, 'unchanged', 'already closed issue needs no repeated write');
  assert.equal(next.operations[1].status, 'held');
  assert.equal(next.operations[1].proposed, 'Human choice');
  await approveCurrent(w, next.id, adapter);
  await execute(w, next.id, () => {}, { adapter });
  assert.equal(next.status, 'complete');
  assert.equal(twins.state.assignee, 'Human choice');
  assert.match(twins.state.replies[0], /Human choice/);
  assert.equal(twins.requests.filter(r => r.method === 'PATCH').length, 1);
});

test('approval refreshes twin records and rejects an external change before execution', async () => {
  const twins = fakeTwins(); const w = twinWorkspace(); const p = prepare(w);
  const adapter = twinAdapter(bindings, credentials, twins.fetcher);
  twins.state.assignee = 'Human choice';
  await assert.rejects(approveCurrent(w, p.id, adapter), /state changed/);
  assert.equal(p.status, 'stale');
  assert.equal(w.records[1].fields.assignee, 'Human choice');
  const next = await prepareCurrent(w, adapter);
  assert.equal(next.operations[1].status, 'held');
  await approveCurrent(w, next.id, adapter);
  await execute(w, next.id, () => {}, { adapter });
  assert.equal(next.status, 'complete');
});

test('refresh does not partially replace the mirror when a provider read fails', async () => {
  const twins = fakeTwins(); const w = twinWorkspace(); const before = structuredClone(w.records);
  twins.state.assignee = 'Human choice';
  const adapter = twinAdapter(bindings, credentials, twins.fetcher);
  const read = adapter.read;
  adapter.read = async (record, field) => {
    if (record.app === 'Slack') throw new Error('offline');
    return read(record, field);
  };
  await assert.rejects(refreshRecords(w, adapter), /offline/);
  assert.deepEqual(w.records, before);
});

test('a transport error after an accepted Slack post reconciles without restart or duplicate posts', async () => {
  const twins = fakeTwins(); const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  const adapter = twinAdapter(bindings, credentials, twins.fetcher);
  const write = adapter.write;
  adapter.write = async (record, field, value) => {
    await write(record, field, value);
    if (record.app === 'Slack') throw new Error('accepted then disconnected');
  };
  let disk = '';
  await assert.rejects(execute(w, p.id, () => { disk = JSON.stringify(w); }, { adapter }), /disconnected/);
  assert.equal(p.status, 'interrupted');
  assert.equal(p.operations[2].status, 'uncertain');
  assert.equal(JSON.parse(disk).plans[0].status, 'interrupted');
  assert.equal(twins.state.replies.length, 1);
  adapter.write = write;
  await execute(w, p.id, () => {}, { adapter });
  assert.equal(p.status, 'complete');
  assert.equal(twins.state.replies.length, 1);
});

test('a failed read-back leaves an interrupted plan that can resume in the same process', async () => {
  const twins = fakeTwins(); const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  const adapter = twinAdapter(bindings, credentials, twins.fetcher);
  const read = adapter.read;
  let fail = true;
  adapter.read = async (record, field) => {
    if (record.app === 'GitHub' && twins.state.issueState === 'closed' && fail) {
      fail = false; throw new Error('read-back unavailable');
    }
    return read(record, field);
  };
  await assert.rejects(execute(w, p.id, () => {}, { adapter }), /read-back unavailable/);
  assert.equal(p.status, 'interrupted');
  await execute(w, p.id, () => {}, { adapter });
  assert.equal(p.status, 'complete');
  assert.equal(twins.requests.filter(r => r.method === 'PATCH').length, 1);
});

test('a held human assignment is checked again before posting the dependent summary', async () => {
  const twins = fakeTwins(); const w = twinWorkspace();
  twins.state.assignee = 'Human choice';
  const adapter = twinAdapter(bindings, credentials, twins.fetcher);
  const p = await prepareCurrent(w, adapter); await approveCurrent(w, p.id, adapter);
  const write = adapter.write;
  adapter.write = async (record, field, value) => {
    await write(record, field, value);
    if (record.app === 'GitHub') twins.state.assignee = 'Another human choice';
  };
  await assert.rejects(execute(w, p.id, () => {}, { adapter }), /changed since approval/);
  assert.equal(twins.state.replies.length, 0);
  assert.equal(twins.state.assignee, 'Another human choice');
});

test('a final provider check prevents claiming completion when an earlier outcome changed', async () => {
  const twins = fakeTwins(); const w = twinWorkspace(); const p = prepare(w); approve(w, p.id);
  const adapter = twinAdapter(bindings, credentials, twins.fetcher);
  const write = adapter.write;
  adapter.write = async (record, field, value) => {
    await write(record, field, value);
    if (record.app === 'Slack') twins.state.issueState = 'open';
  };
  await assert.rejects(execute(w, p.id, () => {}, { adapter }), /changed since approval/);
  assert.equal(p.status, 'stale');
  adapter.write = write;
  const next = await prepareCurrent(w, adapter);
  assert.equal(next.operations[2].status, 'unchanged');
  await approveCurrent(w, next.id, adapter);
  await execute(w, next.id, () => {}, { adapter });
  assert.equal(next.status, 'complete');
  assert.equal(twins.state.replies.length, 1, 'a new plan must not repost an existing correction');
});

test('twin correction and evidence use the provisioned issue numbers and original owner', () => {
  const w = twinWorkspace();
  w.records[0].label = '#2'; w.records[0].external!.issueNumber = 2;
  w.records[0].fields.canonicalIssue = '#1';
  w.sourceActions[0].before.canonicalIssue = '#1'; w.sourceActions[0].after.canonicalIssue = '#1';
  w.sourceActions[1].before.assignee = 'Original twin owner';
  w.run!.actions[0].after.assignee = 'Original twin owner';
  const p = prepare(w);
  assert.match(p.operations[0].reason, /Issue #1.*Closing #2/);
  assert.match(p.operations[1].reason, /Original twin owner/);
  assert.match(p.operations[2].proposed, /GitHub #1.*duplicate #2.*Original twin owner/);
  assert.doesNotMatch(p.operations[2].proposed, /#182|#184/);
});

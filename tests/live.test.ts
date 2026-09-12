import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, approveCurrent, execute, prepare, prepareCurrent, seedWorkspace } from '../server/recovery.js';
import { connectLive, liveAdapter, readLiveConfig, type LiveConfig } from '../server/live.js';
import { assess } from '../server/agent.js';
import type { RecordedAction } from '../shared/types.js';

const env = {
  AFTERCARE_GITHUB_TOKEN: 'github_pat_test', AFTERCARE_GITHUB_REPO: 'demo-owner/aftercare-demo',
  AFTERCARE_LINEAR_API_KEY: 'lin_api_test', AFTERCARE_LINEAR_TEAM_KEY: 'OPS',
  AFTERCARE_SLACK_BOT_TOKEN: 'xoxb-test', AFTERCARE_SLACK_CHANNEL_ID: 'C0DEMO01',
};
const config = readLiveConfig(env).config!;
const team = ['Jamie Chen', 'Alex Rivera', 'Morgan Lee'].map((name, i) => ({ id: `u${i + 1}`, name }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** GitHub, Linear and Slack at their real hosts, answering with their public API shapes. */
function fakeApps(options: { members?: Array<{ id: string; name: string }>; escapeSlack?: boolean; respond?: (url: URL, body: any) => Response | undefined } = {}) {
  const members = options.members ?? team.slice(0, 2);
  const issues = new Map<number, string>();
  const assignees = new Map<string, string>();
  const deleted: string[] = [];
  const messages: Array<{ ts: string; text: string; thread_ts?: string }> = [];
  const requests: Array<{ method: string; url: URL; body: any; headers: Record<string, string> }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const override = options.respond?.(url, body);
    if (override) return override;
    if (url.origin === 'https://api.github.com') {
      const match = url.pathname.match(/^\/repos\/demo-owner\/aftercare-demo(.*)$/);
      if (!match) return json({ message: 'Not Found' }, 404);
      if (match[1] === '') return json({ full_name: 'demo-owner/aftercare-demo' });
      if (match[1] === '/issues' && method === 'POST') { issues.set(issues.size + 1, 'open'); return json({ number: issues.size, state: 'open' }, 201); }
      const number = Number(match[1].match(/^\/issues\/(\d+)$/)?.[1]);
      if (!issues.has(number)) return json({ message: 'Not Found' }, 404);
      if (method === 'PATCH') issues.set(number, body.state);
      return json({ number, state: issues.get(number) });
    }
    if (url.href === 'https://api.linear.app/graphql') {
      const { query, variables: v } = body;
      const named = (id: string | null) => members.find(m => m.id === id)?.name ?? '';
      if (query.includes('teams {')) return json({ data: { teams: { nodes: [{ id: 'team-eng', key: 'ENG' }, { id: 'team-ops', key: 'OPS' }] } } });
      if (query.includes('users(')) return json({ data: { users: { nodes: members } } });
      if (query.includes('issueCreate')) { assignees.set('lin-1', named(v.i.assigneeId)); return json({ data: { issueCreate: { issue: { id: 'lin-1', identifier: 'OPS-1' } } } }); }
      if (query.includes('issueDelete')) { deleted.push(v.id); return json({ data: { issueDelete: { success: true } } }); }
      if (query.includes('issueUpdate')) { assignees.set(v.id, named(v.i.assigneeId)); return json({ data: { issueUpdate: { success: true } } }); }
      return json({ data: { issue: { assignee: assignees.get(v.id) ? { name: assignees.get(v.id) } : null } } });
    }
    if (url.href === 'https://slack.com/api/chat.postMessage') {
      const ts = `1700000000.00010${messages.length}`;
      const text: string = options.escapeSlack ? body.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : body.text;
      messages.push({ ts, text, thread_ts: body.thread_ts });
      return json({ ok: true, ts });
    }
    if (url.origin + url.pathname === 'https://slack.com/api/conversations.history') return json({ ok: true, messages: [] });
    if (url.href === 'https://slack.com/api/chat.delete') {
      const index = messages.findIndex(m => m.ts === body.ts);
      if (index >= 0) messages.splice(index, 1);
      return json({ ok: true });
    }
    if (url.origin + url.pathname === 'https://slack.com/api/conversations.replies') {
      // Slack reads these arguments from the query string; a JSON body would be ignored.
      const parent = url.searchParams.get('ts');
      const thread = messages.filter(m => m.ts === parent || m.thread_ts === parent);
      return json(thread.length ? { ok: true, messages: thread } : { ok: false, error: 'thread_not_found' });
    }
    return json({ ok: false, error: 'unknown_method' });
  }) as unknown as typeof fetch;
  const writes = () => requests.filter(r => (r.url.hostname === 'api.github.com' && r.method !== 'GET') || r.url.pathname === '/api/chat.postMessage' || String(r.body?.query ?? '').startsWith('mutation'));
  return { fetcher, requests, writes, issues, assignees, messages, deleted };
}

async function connected(apps = fakeApps()) {
  const w = seedWorkspace();
  await connectLive(w, config, apps.fetcher);
  return { w, apps, adapter: liveAdapter(config, apps.fetcher) };
}

async function refusesBeforeWriting(apps: ReturnType<typeof fakeApps>, settings: LiveConfig, reason: RegExp) {
  const w = seedWorkspace(); const before = structuredClone(w);
  await assert.rejects(connectLive(w, settings, apps.fetcher), reason);
  assert.deepEqual(w, before, 'the workspace is unchanged');
  assert.equal(apps.writes().length, 0);
}

test('live mode needs every value and ignores unprefixed shell tokens', () => {
  assert.deepEqual(readLiveConfig(env).missing, []);
  assert.deepEqual(config.github, { token: 'github_pat_test', owner: 'demo-owner', repo: 'aftercare-demo' });
  const partial = readLiveConfig({ ...env, AFTERCARE_GITHUB_REPO: 'https://github.com/demo-owner/aftercare-demo', AFTERCARE_SLACK_BOT_TOKEN: ' ', AFTERCARE_SLACK_CHANNEL_ID: '#customer-onboarding' });
  assert.equal(partial.config, undefined);
  assert.deepEqual(partial.missing, ['AFTERCARE_GITHUB_REPO', 'AFTERCARE_SLACK_BOT_TOKEN', 'AFTERCARE_SLACK_CHANNEL_ID']);
  assert.equal(readLiveConfig({ GITHUB_TOKEN: 'ghp_shell', SLACK_BOT_TOKEN: 'xoxb-shell' }).config, undefined);
});

test('connecting recreates the failed run in the configured repo, team and channel', async () => {
  const { w, apps } = await connected();
  assert.equal(w.mode, 'live');
  assert.deepEqual(w.records[0].external, { provider: 'github', owner: 'demo-owner', repo: 'aftercare-demo', issueNumber: 2 });
  assert.equal(w.records[0].fields.canonicalIssue, '#1');
  assert.deepEqual(w.records[1].external, { provider: 'linear', issueId: 'lin-1', teamId: 'team-ops' });
  assert.equal(apps.assignees.get('lin-1'), 'Alex Rivera', 'the wrong assignment exists in Linear');
  assert.equal(w.sourceActions[1].before.assignee, 'Jamie Chen');
  assert.ok(apps.requests.some(r => String(r.body?.query).includes('users(filter: { app: { eq: false } })')), 'Linear agents and apps are never chosen as owners');
  assert.equal(w.records[2].external?.channelId, 'C0DEMO01');
  assert.deepEqual(w.run?.actions.map(a => a.assessment), ['setup', 'expected', 'needs_repair', 'needs_repair', 'needs_repair']);
  assert.equal(w.run?.actions[1].outcome, 'reported_timeout', 'the first create succeeded although the agent saw a timeout');
  assert.deepEqual(w.run?.actions.filter(a => a.recordId).map(a => a.recordId), w.records.map(r => r.id));
  assert.equal(apps.requests.some(r => r.url.pathname === '/user/repos' || r.url.pathname === '/api/conversations.create' || String(r.body?.query).includes('teamCreate')), false, 'only existing demo resources are used');
  const auth = (host: string) => apps.requests.find(r => r.url.hostname === host)?.headers.Authorization;
  assert.equal(auth('api.github.com'), 'Bearer github_pat_test');
  assert.equal(auth('api.linear.app'), 'lin_api_test', 'Linear personal keys have no Bearer prefix');
  assert.equal(auth('slack.com'), 'Bearer xoxb-test');
});

test('an approved repair writes to the live APIs and verifies each outcome by reading it back', async () => {
  const { w, apps, adapter } = await connected();
  const p = await prepareCurrent(w, adapter);
  await approveCurrent(w, p.id, adapter);
  await execute(w, p.id, () => {}, { adapter });
  assert.equal(p.status, 'complete');
  assert.deepEqual([...apps.issues], [[1, 'open'], [2, 'closed']], 'only the duplicate is closed');
  assert.equal(apps.assignees.get('lin-1'), 'Jamie Chen');
  const replies = apps.messages.filter(m => m.thread_ts === w.records[2].external?.ts);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /^Correction:.*GitHub #1.*#2 is closed.*Jamie Chen/);
  const read = apps.requests.find(r => r.url.pathname === '/api/conversations.replies');
  assert.equal(read?.method, 'GET');
  assert.equal(read?.url.searchParams.get('channel'), 'C0DEMO01');
});

test('a reassignment made directly in Linear after review is preserved', async () => {
  const { w, apps, adapter } = await connected(fakeApps({ members: team }));
  const p = await prepareCurrent(w, adapter);
  apps.assignees.set('lin-1', 'Morgan Lee');
  await assert.rejects(approveCurrent(w, p.id, adapter), /state changed/);
  const next = await prepareCurrent(w, adapter);
  assert.equal(next.operations[1].status, 'held');
  await approveCurrent(w, next.id, adapter);
  await execute(w, next.id, () => {}, { adapter });
  assert.equal(next.status, 'complete');
  assert.equal(apps.assignees.get('lin-1'), 'Morgan Lee');
  assert.equal(apps.writes().filter(r => String(r.body?.query).includes('issueUpdate')).length, 1, 'only the seeded mistake was written to Linear');
  assert.match(apps.messages.at(-1)!.text, /Handoff owner: Morgan Lee/);
});

test('Slack escaping of &, < and > does not fail read-back verification', async () => {
  const members = [{ id: 'u1', name: 'Jamie & <Ops>' }, { id: 'u2', name: 'Alex Rivera' }];
  const { w, apps, adapter } = await connected(fakeApps({ members, escapeSlack: true }));
  const p = await prepareCurrent(w, adapter);
  await approveCurrent(w, p.id, adapter);
  await execute(w, p.id, () => {}, { adapter });
  assert.equal(p.status, 'complete');
  assert.equal(apps.messages.filter(m => m.thread_ts).length, 1);
});

test('a missing team or an empty Linear workspace stops before anything is written', async () => {
  await refusesBeforeWriting(fakeApps(), { ...config, linear: { ...config.linear, teamKey: 'NOPE' } }, /no team with key NOPE/);
  await refusesBeforeWriting(fakeApps({ members: [] }), config, /no members/);
});

test('with a single Linear member the agent removed the owner and the repair restores them', async () => {
  const { w, apps, adapter } = await connected(fakeApps({ members: team.slice(0, 1) }));
  assert.equal(apps.assignees.get('lin-1'), '', 'the seeded mistake leaves the issue unassigned');
  const p = await prepareCurrent(w, adapter);
  assert.equal(p.operations[1].proposed, 'Jamie Chen');
  await approveCurrent(w, p.id, adapter);
  await execute(w, p.id, () => {}, { adapter });
  assert.equal(p.status, 'complete');
  assert.equal(apps.assignees.get('lin-1'), 'Jamie Chen');
});

test('provider refusals name the cause without echoing response bodies', async () => {
  // The body Linear returned for a rejected key when probed on September 12, 2026.
  const badKey = fakeApps({ respond: url => url.hostname === 'api.linear.app' ? json({ errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, 401) : undefined });
  await assert.rejects(connectLive(seedWorkspace(), config, badKey.fetcher), { message: 'Linear returned HTTP 401 (AUTHENTICATION_ERROR) while listing teams. Check the token and its permissions.' });
  const notInvited = fakeApps({ respond: url => url.pathname === '/api/conversations.history' ? json({ ok: false, error: 'not_in_channel' }) : undefined });
  await assert.rejects(connectLive(seedWorkspace(), config, notInvited.fetcher), { message: 'Slack refused conversations.history: not_in_channel.' });
  assert.equal(notInvited.writes().filter(r => r.url.hostname !== 'slack.com').length, 0, 'GitHub and Linear are untouched');
});

test('a failed run shows the Linear reason and removes what it created', async () => {
  const apps = fakeApps({ respond: (_url, body) => String(body?.query).includes('issueUpdate')
    ? json({ errors: [{ message: 'Argument Validation Error', extensions: { code: 'INVALID_INPUT', userPresentableMessage: 'The assignee is not a member of this team' } }] })
    : undefined });
  const w = seedWorkspace(); const before = structuredClone(w);
  await assert.rejects(connectLive(w, config, apps.fetcher), (error: Error) => {
    assert.match(error.message, /^Linear rejected the request while updating the issue \(INVALID_INPUT\): The assignee is not a member of this team\. Aftercare removed what this run created/);
    return true;
  });
  assert.deepEqual(w, before, 'the workspace is unchanged');
  assert.deepEqual([...apps.issues.values()], ['closed', 'closed'], 'the GitHub issues are closed');
  assert.deepEqual(apps.deleted, ['lin-1'], 'the Linear handoff issue is deleted');
  assert.equal(apps.messages.length, 0, 'nothing was posted to Slack');
});

test('a record not linked to the demo apps is refused instead of being written locally', async () => {
  const apps = fakeApps(); const w = seedWorkspace(); w.mode = 'live';
  const p = prepare(w); approve(w, p.id);
  await assert.rejects(execute(w, p.id, () => {}, { adapter: liveAdapter(config, apps.fetcher) }), /not linked/);
  assert.equal(apps.requests.length, 0);
  assert.equal(w.records[0].fields.state, 'open');
});

test('a response that stalls while its body is read is reported as a timeout', async () => {
  const stalled = (async () => new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); },
  }))) as unknown as typeof fetch;
  const w = seedWorkspace();
  w.records[0].external = { provider: 'github', owner: 'demo-owner', repo: 'aftercare-demo', issueNumber: 2 };
  await assert.rejects(liveAdapter(config, stalled).read(w.records[0], 'state'), (error: Error & { status?: number }) => {
    assert.equal(error.message, 'GitHub stopped responding while reading the issue.');
    assert.equal(error.status, 504);
    return true;
  });
});

test('the recorder flags only the actions that went wrong', () => {
  const at = new Date().toISOString();
  const action = (tool: string, after: Record<string, string>, extra: Partial<RecordedAction> = {}): RecordedAction =>
    ({ id: `${tool}-${Object.values(after).join('-')}`, at, actor: 'onboarding-agent', app: 'GitHub', tool, summary: tool, outcome: 'succeeded', before: {}, after, assessment: 'expected', ...extra });
  const title = 'Provision Acme workspace';
  const clean = assess([
    action('github.create_issue', { issue: '#1', title }),
    action('linear.update_assignee', { assignee: 'Jamie Chen' }),
    action('slack.post_message', { message: 'Acme is ready.' }),
  ], { owner: 'Jamie Chen' });
  assert.deepEqual(clean.map(a => a.assessment), ['expected', 'expected', 'expected'], 'a correct run needs no repair');
  const faulty = assess([
    action('github.create_issue', { issue: '#1', title }, { outcome: 'reported_timeout' }),
    action('github.create_issue', { issue: '#2', title }),
    action('linear.update_assignee', { assignee: 'Alex Rivera' }),
    action('slack.post_message', { message: 'Acme is ready.' }),
  ], { owner: 'Jamie Chen' });
  assert.deepEqual(faulty.map(a => a.assessment), ['expected', 'needs_repair', 'needs_repair', 'needs_repair']);
  assert.match(faulty[1].finding ?? '', /Repeats #1, which GitHub had already created before the agent was told the call timed out/);
});

test('the local scenario run matches what the recorder would flag', () => {
  const run = seedWorkspace().run!;
  const reassessed = assess(run.actions.map(a => ({ ...a, assessment: a.actor === 'intake' ? 'setup' as const : 'expected' as const, finding: undefined })), { owner: 'Jamie Chen' });
  assert.deepEqual(reassessed.map(a => [a.assessment, a.finding]), run.actions.map(a => [a.assessment, a.finding]));
});

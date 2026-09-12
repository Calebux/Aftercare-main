import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { seedWorkspace } from '../server/recovery.js';

/** Real HTTP routes against isolated provider doubles; no external calls or app data. */
test('HTTP review refreshes twins and rejects conflicting mutations during execution', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftercare-http-'));
  let issueState = 'open'; let assignee = 'Alex Rivera'; const replies: string[] = [];
  let releaseWrite!: () => void; let writeStarted!: () => void;
  const blocked = new Promise<void>(resolve => { releaseWrite = resolve; });
  const started = new Promise<void>(resolve => { writeStarted = resolve; });
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    let result: unknown;
    if (req.url === '/graphql') {
      assert.ok(!body.query.includes('issueUpdate'), 'the held human assignment must not be written');
      result = { data: { issue: { assignee: { name: assignee } } } };
    } else if (req.url?.split('?')[0] === '/api/conversations.replies') {
      result = { ok: true, messages: [{ ts: 'original', text: 'Acme is ready.' }, ...replies.map((text, i) => ({ ts: `reply-${i}`, text }))] };
    } else if (req.url === '/api/chat.postMessage') {
      replies.push(body.text); result = { ok: true, ts: `reply-${replies.length - 1}` };
    } else {
      if (req.method === 'PATCH') { writeStarted(); await blocked; issueState = body.state; }
      result = { state: issueState };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerBase = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const w = seedWorkspace(); w.mode = 'twin';
  w.twins = (['github', 'linear', 'slack'] as const).map(provider => ({ provider, runId: `test-${provider}`, baseUrl: providerBase, status: 'ready', expiresAt: null }));
  w.records[0].external = { provider: 'github', owner: 'test', repo: 'onboarding', issueNumber: 184 };
  w.records[1].external = { provider: 'linear', issueId: 'issue' };
  w.records[2].external = { provider: 'slack', channelId: 'C1', ts: 'original' };
  await writeFile(join(dir, 'workspace.json'), JSON.stringify(w));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', AFTERCARE_SCENARIO_ONLY: '1', AFTERCARE_DATA_DIR: dir },
  });
  const exited = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  const post = (action: string, body: object = {}) => fetch(`${base}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test server did not start')), 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Test server exited before startup')); });
      child.stdout.on('data', chunk => {
        if (chunk.toString().includes('Aftercare:')) { clearTimeout(timer); resolve(); }
      });
    });
    const preview = await post('prepare'); assert.equal(preview.status, 200);
    const original = (await preview.json()).plans.at(-1);
    assignee = 'Human choice';
    const stale = await post('approve', { planId: original.id }); assert.equal(stale.status, 409);
    assert.equal((await stale.json()).workspace.records[1].fields.assignee, 'Human choice');
    const revisedResponse = await post('prepare'); assert.equal(revisedResponse.status, 200);
    const revised = (await revisedResponse.json()).plans.at(-1);
    assert.equal(revised.operations[1].status, 'held');
    assert.equal((await post('approve', { planId: revised.id })).status, 200);
    const executing = post('execute', { planId: revised.id });
    await started;
    try {
      for (const action of ['execute', 'reset', 'prepare', 'approve', 'human-edit', 'provision-twins', 'connect-live']) {
        const rejected = await post(action, { planId: revised.id });
        assert.equal(rejected.status, 409, action);
        assert.match((await rejected.json()).error, /Wait for execute/);
      }
      const active = await (await fetch(`${base}/api/workspace`)).json();
      assert.equal(active.plans.at(-1).status, 'executing');
      assert.equal(active.plans.at(-1).operations[0].status, 'running');
    } finally { releaseWrite(); }
    const finished = await executing; assert.equal(finished.status, 200);
    const completed = await finished.json();
    assert.equal(completed.plans.at(-1).status, 'complete');
    assert.equal(completed.records[1].fields.assignee, 'Human choice');
    assert.equal(replies.length, 1);
    assert.match(replies[0], /Human choice/);
    assert.equal((await post('reset')).status, 200, 'the mutation gate must release after completion');
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.connections, 'disabled', 'scenario-only runs never enable writes to real apps');
    assert.equal((await post('connect-live')).status, 409);
  } finally {
    releaseWrite(); child.kill(); await exited;
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

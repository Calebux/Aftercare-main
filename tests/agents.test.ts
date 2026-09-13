import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { approveCurrent, execute, prepareCurrent, seedWorkspace } from '../server/recovery.js';
import { liveAdapter, liveEndpoint, readLiveConfig } from '../server/live.js';
import { MAX_ACTIONS, discardExternalRun, finishExternalRun, recordAction, startExternalRun, throttle, type RunHolder } from '../server/external.js';
import { handleMcp } from '../server/mcp.js';
import { github, linear, slack } from '../server/providers.js';
import { createSessions } from '../server/sessions.js';
import { fakeApps } from '../eval/fakeApps.js';

const config = readLiveConfig({
  AFTERCARE_GITHUB_TOKEN: 'github_pat_test', AFTERCARE_GITHUB_REPO: 'demo-owner/aftercare-demo',
  AFTERCARE_LINEAR_API_KEY: 'lin_api_test', AFTERCARE_LINEAR_TEAM_KEY: 'OPS',
  AFTERCARE_SLACK_BOT_TOKEN: 'xoxb-test', AFTERCARE_SLACK_CHANNEL_ID: 'C0DEMO01',
}).config!;
const holder = (): RunHolder => ({ workspace: seedWorkspace() });
let rpcId = 0;
async function call(h: RunHolder, apps: ReturnType<typeof fakeApps>, name: string, args: Record<string, unknown> = {}) {
  const response = await handleMcp(h, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, { config, fetcher: apps.fetcher }, { reviewUrl: 'http://127.0.0.1:4310' }) as any;
  return { error: response.result.isError === true, text: response.result.content[0].text as string, data: response.result.structuredContent };
}
const writesAfter = (apps: ReturnType<typeof fakeApps>, mark: number) => apps.handled.slice(mark).filter(r => r.method !== 'GET' && !(r.url.hostname === 'api.linear.app' && !String(r.body?.query).startsWith('mutation')));

test('an MCP agent run through the gateway becomes a repairable, verified incident', async () => {
  const apps = fakeApps(); const h = holder();
  assert.equal((await call(h, apps, 'start_run', { agent: 'support-agent', task: 'Onboard Acme', owner: 'Jamie Chen' })).error, false);
  const handoff = await call(h, apps, 'linear_create_issue', { title: 'Acme onboarding handoff', assignee: 'Jamie Chen' });
  const first = await call(h, apps, 'github_create_issue', { title: 'Provision Acme workspace', body: 'Onboarding task for Acme.' });
  await call(h, apps, 'github_create_issue', { title: 'Provision Acme workspace', body: 'Onboarding task for Acme.' });
  await call(h, apps, 'linear_update_assignee', { issue: handoff.data.issue, assignee: 'Alex Rivera' });
  await call(h, apps, 'slack_post_message', { text: '<!channel> Acme is ready.' });
  assert.equal(first.data.issue, 1);
  assert.equal(h.liveRun?.actions.filter(a => a.assessment === 'needs_repair').length, 3, 'the live view flags problems as they happen');

  const finished = await call(h, apps, 'finish_run');
  assert.deepEqual({ repairable: finished.data.repairable, flagged: finished.data.flagged, recorded: finished.data.recorded }, { repairable: true, flagged: 3, recorded: 5 });
  assert.equal(h.workspace.mode, 'live');
  assert.equal(h.workspace.run?.source, 'mcp');
  assert.equal(h.workspace.records[0].external?.issueNumber, 2);
  assert.equal(h.externalRun, undefined);
  // Aftercare's own alert carries its review link; the agent's posts must carry no mention or link sequence.
  const posts = apps.requests.filter(r => r.url.pathname === '/api/chat.postMessage' && !String(r.body.text).startsWith(':warning:')).map(r => String(r.body.text));
  assert.ok(posts.some(text => text.includes('&lt;!channel&gt;')), 'the gateway escaped the agent message');
  for (const text of posts) assert.doesNotMatch(text, /<[!@#]|<https?:/, 'gateway posts cannot mention the channel');

  const adapter = liveAdapter(config, apps.fetcher);
  const plan = await prepareCurrent(h.workspace, adapter);
  await approveCurrent(h.workspace, plan.id, adapter);
  await execute(h.workspace, plan.id, () => {}, { adapter });
  assert.equal(plan.status, 'complete');
  assert.equal(apps.issues.get(2), 'closed');
  assert.equal(apps.assignees.get('lin-1'), 'Jamie Chen');
});

test('a Recorder API run is accepted only after every report matches the apps', async () => {
  const apps = fakeApps(); const h = holder();
  const scope = { config, fetcher: apps.fetcher };
  const gh = liveEndpoint('github', config.github.token, apps.fetcher);
  const lin = liveEndpoint('linear', config.linear.token, apps.fetcher);
  const sl = liveEndpoint('slack', config.slack.token, apps.fetcher);
  const repo = { owner: 'demo-owner', repo: 'aftercare-demo' };
  await startExternalRun(h, { agent: 'triage-agent', task: 'Onboard Acme', owner: 'Jamie Chen' }, 'recorder', scope);
  // The agent makes its own calls, then reports them.
  const handoff = await linear.createIssue(lin, 'team-ops', 'Acme onboarding handoff', 'u1');
  recordAction(h, { tool: 'linear.create_issue', issue: handoff.identifier, title: 'Acme onboarding handoff', assignee: 'Jamie Chen' });
  for (const outcome of ['reported_timeout', 'succeeded']) {
    const issue = await github.createIssue(gh, repo, 'Provision Acme workspace', 'Onboarding task.');
    recordAction(h, { tool: 'github.create_issue', issue, title: 'Provision Acme workspace', body: 'Onboarding task.', outcome });
  }
  await linear.writeAssignee(lin, { provider: 'linear', issueId: handoff.id }, 'Alex Rivera');
  recordAction(h, { tool: 'linear.update_assignee', issue: handoff.identifier, before: 'Jamie Chen', after: 'Alex Rivera' });
  const ts = await slack.post(sl, 'C0DEMO01', 'Acme is ready.');
  recordAction(h, { tool: 'slack.post_message', ts, text: 'Acme is ready.' });

  // A false report of the second issue's title refuses the whole run and leaves it open.
  const truthful = h.externalRun!.actions[2].after.title;
  h.externalRun!.actions[2].after.title = 'Something else';
  await assert.rejects(finishExternalRun(h, scope), /does not match what the app shows/);
  assert.ok(h.externalRun, 'a refused run stays open to fix or discard');
  assert.equal(h.workspace.mode, 'local');
  h.externalRun!.actions[2].after.title = truthful;

  const result = await finishExternalRun(h, scope);
  assert.equal(result.repairable, true);
  assert.equal(h.workspace.run?.source, 'recorder');
  assert.equal(h.workspace.records[1].label, 'OPS-1');
});

test('records outside the connected team are refused before any gateway write, and reports of them fail', async () => {
  const apps = fakeApps(); const h = holder();
  apps.assignees.set('lin-eng-7', 'Jamie Chen');
  await call(h, apps, 'start_run', { agent: 'support-agent', task: 'Onboard Acme', owner: 'Jamie Chen' });
  const mark = apps.handled.length;
  const outside = await call(h, apps, 'linear_update_assignee', { issue: 'ENG-7', assignee: 'Alex Rivera' });
  assert.equal(outside.error, true);
  assert.match(outside.text, /outside the connected Linear team/);
  assert.equal(writesAfter(apps, mark).length, 0);
  assert.equal(apps.assignees.get('lin-eng-7'), 'Jamie Chen');

  recordAction(h, { tool: 'linear.update_assignee', issue: 'ENG-7', before: 'Jamie Chen', after: 'Jamie Chen' });
  await assert.rejects(finishExternalRun(h, { config, fetcher: apps.fetcher }), /outside the connected team/);
});

test('gateway tools refuse to write before a run starts, and the run cannot exceed its action limit', async () => {
  const apps = fakeApps(); const h = holder();
  const early = await call(h, apps, 'github_create_issue', { title: 'Too early' });
  assert.equal(early.error, true);
  assert.match(early.text, /start_run first/);
  assert.equal(apps.handled.filter(r => r.method === 'POST' && r.url.hostname === 'api.github.com').length, 0);

  await startExternalRun(h, { agent: 'loop-agent', task: 'Post updates', owner: 'Jamie Chen' }, 'recorder', { config, fetcher: apps.fetcher });
  for (let i = 0; i < MAX_ACTIONS; i++) recordAction(h, { tool: 'slack.post_message', ts: `1700000000.${String(i).padStart(6, '0')}`, text: `Update ${i}` });
  assert.throws(() => recordAction(h, { tool: 'slack.post_message', ts: '1700000001.000000', text: 'One too many' }), /at most 20 actions/);
  const mark = apps.handled.length;
  assert.equal((await call(h, apps, 'slack_post_message', { text: 'One too many' })).error, true);
  assert.equal(writesAfter(apps, mark).length, 0, 'no write happens when the run is full');
  discardExternalRun(h);
  assert.equal(h.externalRun, undefined);
});

test('reported values are validated, and unsupported tools and control characters are refused', async () => {
  const apps = fakeApps(); const h = holder();
  await startExternalRun(h, { agent: 'triage-agent', task: 'Onboard Acme', owner: 'Jamie Chen' }, 'recorder', { config, fetcher: apps.fetcher });
  assert.throws(() => recordAction(h, { tool: 'github.delete_repo' }), /tool must be one of/);
  assert.throws(() => recordAction(h, { tool: 'github.create_issue', issue: 1, title: 'x'.repeat(257) }), /title must be 1–256/);
  assert.throws(() => recordAction(h, { tool: 'github.create_issue', issue: 1, title: 'Bad\x07bell' }), /control characters/);
  assert.throws(() => recordAction(h, { tool: 'github.create_issue', issue: '1; DROP', title: 'Fine' }), /GitHub issue number/);
  assert.throws(() => recordAction(h, { tool: 'linear.update_assignee', issue: '../../admin', after: 'x' }), /Linear identifier/);
  await assert.rejects(startExternalRun(holder(), { agent: 'x', task: 'y', owner: 'Nobody Here' }, 'recorder', { config, fetcher: apps.fetcher }), /member of the connected Linear workspace/);
  await assert.rejects(startExternalRun(holder(), { agent: 'Bad Name', task: 'y', owner: 'Jamie Chen' }, 'recorder', { config, fetcher: apps.fetcher }), /lowercase/);
});

test('a checked run that does not match a supported repair is recorded without binding the workspace', async () => {
  const apps = fakeApps(); const h = holder();
  const scope = { config, fetcher: apps.fetcher };
  await call(h, apps, 'start_run', { agent: 'support-agent', task: 'File one issue', owner: 'Jamie Chen' });
  await call(h, apps, 'github_create_issue', { title: 'Provision Acme workspace' });
  const result = await finishExternalRun(h, scope);
  assert.deepEqual({ repairable: result.repairable, flagged: result.flagged }, { repairable: false, flagged: 0 });
  assert.equal(h.workspace.mode, 'local');
  assert.equal(h.liveRun?.finishedAt !== undefined, true);
});

test('agent requests are rate limited per workspace', () => {
  const h = holder();
  for (let i = 0; i < 120; i++) throttle(h);
  assert.throws(() => throttle(h), /Too many agent requests/);
});

test('the MCP handler follows JSON-RPC and tool errors never expose provider responses', async () => {
  const h = holder();
  assert.equal(await handleMcp(h, { jsonrpc: '2.0', method: 'notifications/initialized' }, undefined), null);
  assert.deepEqual(await handleMcp(h, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], undefined), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } });
  assert.equal(((await handleMcp(h, { jsonrpc: '2.0', id: 2, method: 'resources/list' }, undefined)) as any).error.code, -32601);
  const init = await handleMcp(h, { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, undefined) as any;
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await handleMcp(h, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, undefined) as any;
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['start_run', 'github_create_issue', 'linear_create_issue', 'linear_update_assignee', 'slack_post_message', 'finish_run', 'discard_run']);
  const unconnected = await handleMcp(h, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'start_run', arguments: {} } }, undefined) as any;
  assert.equal(unconnected.result.isError, true);
  assert.match(unconnected.result.content[0].text, /Connect GitHub, Linear and Slack/);
});

test('agent keys are shown once, stored only as hashes, and stop working when revoked or replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftercare-keys-'));
  try {
    const sessions = createSessions({ dir, hosted: false, secureCookie: false, operatorConnections: {} });
    const slot = sessions.resolve({ headers: {} } as unknown as Request, {} as Response);
    const key = sessions.issueAgentKey(slot);
    assert.match(key, /^aft_[A-Za-z0-9_-]{43}$/);
    assert.equal(sessions.findByAgentKey(key), slot);
    assert.equal(sessions.findByAgentKey(`${key.slice(0, -1)}x`), undefined);
    assert.equal(sessions.findByAgentKey(undefined), undefined);
    assert.doesNotMatch(JSON.stringify(slot), new RegExp(key.slice(4, 20)), 'the key is not kept on the slot');
    const replacement = sessions.issueAgentKey(slot);
    assert.equal(sessions.findByAgentKey(key), undefined, 'issuing a new key revokes the old one');
    sessions.revokeAgentKey(slot);
    assert.equal(sessions.findByAgentKey(replacement), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

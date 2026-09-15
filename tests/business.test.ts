import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import { createSessions } from '../server/sessions.js';
import { businessRoutes } from '../server/business-routes.js';
import { executeBusinessRun, modelDraft, prepareBusinessRun, sampleOnboardingAdapter, saveAgent, seedBusiness, templateDraft } from '../server/business.js';
import { connectBusinessApp, connectionTargets, liveOnboardingAdapter, type BusinessConnections, type OnboardingAdapter } from '../server/business-providers.js';

const definition = { name: 'Customer onboarding', owner: 'Sarah', instructions: 'Collect brand assets and confirm the project scope.', notifySlack: true, planning: 'template' };
async function fixture() {
  const workspace = seedBusiness();
  const agent = saveAgent(workspace, definition);
  const adapter = sampleOnboardingAdapter(workspace, true);
  const run = await prepareBusinessRun(workspace, agent, 'sample', 'sample-acme', adapter, async deal => templateDraft(agent, deal));
  return { workspace, agent, adapter, run };
}

test('onboarding requires review, persists write intent, verifies both outputs, and prevents duplicate launches', async () => {
  const { workspace, agent, adapter, run } = await fixture();
  assert.equal(run.status, 'review');
  assert.deepEqual(workspace.sampleRecords, {});
  let persisted: typeof run | undefined;
  let writes = 0;
  const checking: OnboardingAdapter = { ...adapter, async write(r, step) {
    assert.equal(persisted?.steps.find(s => s.app === step.app)?.status, 'writing', 'intent must be saved before calling the provider');
    writes++; return adapter.write(r, step);
  } };
  await executeBusinessRun(run, checking, () => { persisted = structuredClone(run); });
  assert.equal(run.status, 'complete');
  assert.equal(writes, 2);
  assert.ok(run.steps.every(s => s.status === 'verified' && s.verifiedAt));
  await executeBusinessRun(run, checking, () => {});
  assert.equal(writes, 2, 'repeated approvals do not repeat completed writes');
  await assert.rejects(prepareBusinessRun(workspace, agent, 'sample', 'sample-acme', adapter, async deal => templateDraft(agent, deal)), /already has an onboarding run/);
});

test('stale deal context blocks approval before any writes', async () => {
  const { workspace, adapter, run } = await fixture();
  const changed = { ...adapter, async readDeal(id: string) { return { ...await adapter.readDeal(id), name: 'Renegotiated deal' }; } };
  await assert.rejects(executeBusinessRun(run, changed, () => {}), /deal changed/);
  assert.equal(run.status, 'stale');
  assert.deepEqual(workspace.sampleRecords, {});
});

test('unknown write outcomes never retry or proceed to Slack', async () => {
  const { adapter, run } = await fixture();
  let writes = 0;
  const lost = { ...adapter, async write(r: typeof run, step: typeof run.steps[number]) { writes++; await adapter.write(r, step); throw new Error('response lost'); } };
  await assert.rejects(executeBusinessRun(run, lost, () => {}));
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.steps[0].status, 'uncertain');
  await assert.rejects(executeBusinessRun(run, lost, () => {}), /will not repeat this write/);
  assert.equal(writes, 1);
  assert.equal(run.steps[1].status, 'pending');
});

test('known writes reconcile after a read outage without duplicate creates', async () => {
  const { adapter, run } = await fixture();
  let writes = 0; let outage = true;
  const flaky: OnboardingAdapter = { ...adapter,
    async write(r, step) { writes++; return adapter.write(r, step); },
    async verify(r, step) { if (outage) throw new Error('read timeout'); return adapter.verify(r, step); },
  };
  await assert.rejects(executeBusinessRun(run, flaky, () => {}));
  assert.ok(run.steps[0].resultId);
  outage = false;
  await executeBusinessRun(run, flaky, () => {});
  assert.equal(run.status, 'complete');
  assert.equal(writes, 2);
});

test('later human changes and changed app destinations stop continuation without overwriting', async () => {
  const { workspace, adapter, run } = await fixture();
  const modified: OnboardingAdapter = { ...adapter, async verify(r, step) {
    const matches = await adapter.verify(r, step);
    if (step.app === 'notion') workspace.sampleRecords[step.resultId!].summary = 'Human-added project work';
    return matches;
  } };
  await assert.rejects(executeBusinessRun(run, modified, () => {}), /earlier result changed/);
  assert.equal(run.steps[1].status, 'pending');
  assert.equal(workspace.sampleRecords[run.steps[0].resultId!].summary, 'Human-added project work');
  await assert.rejects(executeBusinessRun(run, { ...adapter, targets: () => ({ ...run.targets, notion: 'different-page' }) }, () => {}), /destinations changed/);
});

test('a change during the last write prevents a false completion report', async () => {
  const { workspace, adapter, run } = await fixture();
  const changedDuringLastWrite: OnboardingAdapter = { ...adapter, async write(r, step) {
    const result = await adapter.write(r, step);
    if (step.app === 'slack') workspace.sampleRecords[r.steps[0].resultId!].summary = 'Human changes during the Slack request';
    return result;
  } };
  await assert.rejects(executeBusinessRun(run, changedDuringLastWrite, () => {}), /output changed before the final check/);
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.steps[0].status, 'uncertain');
  assert.equal(run.steps[1].status, 'verified');
});

test('business state survives restart and recovery resets; credentials never reach persisted state or API views', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftercare-business-'));
  try {
    const options = { dir, hosted: false, secureCookie: false, operatorConnections: {} };
    const sessions = createSessions(options);
    const slot = sessions.resolve({} as Request, {} as Response);
    slot.business = (await fixture()).workspace;
    slot.business.runs[0].status = 'running';
    slot.businessConnections = { hubspot: { token: 'secret-app-token', account: 'A', identity: 'account-a' } };
    slot.businessModel = { key: 'secret-model-key', model: 'model' };
    slot.persist();
    const stored = await readFile(join(dir, 'workspace.json'), 'utf8');
    assert.ok(!stored.includes('secret-app-token') && !stored.includes('secret-model-key'));
    const restored = createSessions(options).resolve({} as Request, {} as Response);
    assert.equal(restored.business?.agents.length, 1);
    assert.equal(restored.business?.runs[0].status, 'needs_attention');
    assert.deepEqual(restored.businessConnections, {});
    assert.equal(restored.businessModel, undefined);
    assert.equal(restored.workspace.incidentId, slot.workspace.incidentId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTTP onboarding isolates hosted workspaces, rejects unsupported actions, and disables all live calls in sample mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftercare-business-http-'));
  const sessions = createSessions({ dir, hosted: true, secureCookie: false, operatorConnections: {} });
  const app = express(); app.use(express.json()); app.use('/api/business', businessRoutes({ resolve: sessions.resolve, liveEnabled: false }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/business`;
  let cookie = '';
  const get = async (path = '') => fetch(base + path, { headers: { Cookie: cookie } });
  const post = async (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await get(); cookie = first.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await first.json()).liveEnabled, false);
    const saved = await (await post('/agents', definition)).json();
    assert.equal(saved.agents.length, 1);
    const agentId = saved.agents[0].id;
    assert.equal((await post('/connections/hubspot', { token: 'never-use-this' })).status, 409);
    assert.equal((await post('/model', { key: 'never-use-this', model: 'a/b' })).status, 409);
    assert.equal((await post('/runs', { agentId, mode: 'live', dealId: '123' })).status, 409);
    assert.equal((await post('/runs', { agentId, mode: 'unknown', dealId: '123' })).status, 422);
    assert.equal((await post('/agents', { ...definition, planning: 'arbitrary' })).status, 422);
    const planned = await (await post('/runs', { agentId, mode: 'sample', dealId: 'sample-acme' })).json();
    assert.equal(planned.runs[0].status, 'review');
    assert.equal((await post('/runs', { agentId, mode: 'sample', dealId: 'sample-acme' })).status, 409);
    const completed = await (await post(`/runs/${planned.runId}/execute`, {})).json();
    assert.equal(completed.runs[0].status, 'complete');
    assert.equal((await post(`/runs/${planned.runId}/cancel`, {})).status, 409);
    assert.equal((await post(`/runs/${planned.runId}/unknown`, {})).status, 404);
    assert.deepEqual((await (await fetch(base)).json()).agents, [], 'another visitor cannot access the first workspace');
    const originalCookie = cookie;
    cookie = ''; const visitor = await get(); cookie = visitor.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await post(`/runs/${planned.runId}/execute`, {})).status, 404);
    cookie = originalCookie;
    assert.equal((await (await get()).json()).runs.length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('live adapters create only reviewed content and verify Notion and Slack using isolated provider responses', async () => {
  const pageId = '11111111-1111-1111-1111-111111111111';
  const resultId = '22222222-2222-2222-2222-222222222222';
  let pageBody: any; let slackText = ''; let drift = false;
  const requests: Array<{ url: string; method: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); requests.push({ url, method: init?.method ?? 'GET' });
    assert.equal(init?.redirect, 'error');
    let result: any;
    if (url.includes('/crm/v3/objects/deals')) result = { id: '123', properties: { dealname: 'Acme', dealstage: 'closedwon', amount: '400' }, updatedAt: 'today' };
    else if (url.endsWith('/v1/pages') && init?.method === 'POST') { pageBody = JSON.parse(String(init.body)); result = { id: resultId }; }
    else if (url.includes('/v1/pages/')) result = { parent: { page_id: pageId }, properties: pageBody.properties, archived: drift, in_trash: false };
    else if (url.includes('/children')) result = { results: pageBody.children, has_more: false };
    else if (url.endsWith('/chat.postMessage')) { slackText = JSON.parse(String(init?.body)).text; result = { ok: true, ts: '1234567890.123456' }; }
    else if (url.includes('/conversations.history')) result = { ok: true, messages: [{ ts: '1234567890.123456', text: slackText }] };
    else throw new Error(`Unexpected URL ${url}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const connections: BusinessConnections = {
    hubspot: { token: 'hubspot-secret', account: 'HubSpot', identity: 'hs' }, notion: { token: 'notion-secret', account: 'Notion', identity: 'no', resource: pageId }, slack: { token: 'xoxb-secret', account: 'Slack', identity: 'sl', resource: 'C12345678' },
  };
  const adapter = liveOnboardingAdapter(connections, true, fetcher);
  const workspace = seedBusiness(); const agent = saveAgent(workspace, { ...definition, owner: '<!channel>' });
  const run = await prepareBusinessRun(workspace, agent, 'live', '123', adapter, async deal => templateDraft(agent, deal));
  assert.ok(requests.every(r => r.method === 'GET'), 'preparing a plan never writes');
  await executeBusinessRun(run, adapter, () => {});
  assert.equal(run.status, 'complete');
  assert.equal(pageBody.parent.page_id, pageId);
  assert.equal(pageBody.children.length, 4);
  assert.ok(slackText.includes('&lt;!channel&gt;'), 'untrusted owner names cannot become Slack mentions');
  drift = true;
  assert.equal(await adapter.verify(run, run.steps[0]), false);
  assert.notEqual(connectionTargets(connections, true).signature, connectionTargets({ ...connections, notion: { ...connections.notion!, identity: 'different-account' } }, true).signature);
});

test('connector input validation rejects arbitrary URL targets before making any network call', async () => {
  const neverFetch: typeof fetch = async () => { throw new Error('Network must not be called'); };
  await assert.rejects(connectBusinessApp('notion', 'secret', 'http://127.0.0.1/admin', neverFetch), /page ID/);
  await assert.rejects(connectBusinessApp('slack', 'user-token', 'C1234567', neverFetch), /bot token/);
  await assert.rejects(connectBusinessApp('hubspot', 'key with spaces', '', neverFetch), /valid app token/);
});

test('AI drafts are schema checked and have no access to app credentials or tools', async () => {
  const { agent, run } = await fixture();
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools, undefined);
    assert.equal(body.max_tokens, 1500);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Acme onboarding', summary: 'Sarah owns the handoff.', tasks: ['Collect brand assets.'] }) } }] }));
  };
  const draft = await modelDraft(agent, run.deal, { key: 'test-key', fetcher });
  assert.deepEqual(draft.tasks, ['Collect brand assets.']);
  await assert.rejects(modelDraft(agent, run.deal, { key: 'test-key', fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"tasks":[]}' } }] })) }), /one and eight/);
});

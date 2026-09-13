import { test } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, validateFinding } from '../server/investigator.js';
import { acceptInvestigation, approve, execute, prepare, seedWorkspace } from '../server/recovery.js';
import { evidenceScenario } from '../server/scenarios.js';
import { mockedInvestigator, runInvestigationTrial, trialWorkspace } from '../eval/investigations.js';
import { ruleDecisions } from '../server/policy.js';
import { recordLink } from '../server/links.js';
import { readLiveConfig, connectLive, liveAdapter } from '../server/live.js';
import { fakeApps } from '../eval/fakeApps.js';

test('a model preservation decision changes the executed plan and dependent Slack text', async () => {
  const w = trialWorkspace('distinct-work', 0, 1);
  // The semantic choice is not forced by a changed-body flag.
  assert.equal(w.records[0].fields.body, w.sourceActions[0].after.body);
  const finding = await investigate(w, { key: 'fake', fetcher: mockedInvestigator(w, 'distinct-work') });
  const plan = acceptInvestigation(w, finding)!;
  assert.equal(plan.operations[0].status, 'held');
  approve(w, plan.id); await execute(w, plan.id, () => {});
  assert.equal(w.records[0].fields.state, 'open');
  assert.equal(w.records[1].fields.assignee, w.sourceActions[1].before.assignee);
  assert.match(w.records[2].fields.correction, /#184 is preserved for separate review/);
  assert.doesNotMatch(w.records[2].fields.correction, /#184 is closed/);
});

test('conflicting ownership refuses a guessed restore and an explicit escalation invalidates an old review', async () => {
  const w = seedWorkspace(); const p = prepare(w);
  w.run!.actions[0].after.assignee = 'A different original owner';
  assert.throws(() => prepare(w), /Ownership evidence conflicts/);
  const finding = await investigate(w, { key: 'fake', fetcher: mockedInvestigator(w, 'owner-conflict') });
  assert.equal(finding.outcome, 'escalated');
  assert.equal(acceptInvestigation(w, finding), undefined);
  assert.equal(p.status, 'stale');
  assert.throws(() => approve(w, p.id), /Human investigation/);
  assert.equal(w.plans.length, 1);
  const reloaded = JSON.parse(JSON.stringify(w));
  assert.equal(reloaded.investigation.outcome, 'escalated');
});

test('existing accurate correction is preserved without a second post; appending is rejected', async () => {
  const w = evidenceScenario('existing-correction');
  const before = structuredClone(w.records);
  const finding = await investigate(w, { key: 'fake', fetcher: mockedInvestigator(w, 'existing-correction') });
  const invalid = structuredClone(finding); invalid.decisions[2].action = 'append_correction';
  assert.throws(() => validateFinding(invalid, w, new Set(w.records.map(r => r.id)), true), /policy/);
  const plan = acceptInvestigation(w, finding)!;
  approve(w, plan.id); await execute(w, plan.id, () => {});
  assert.deepEqual(w.records, before);
  assert.equal(plan.operations[2].status, 'unchanged');
});

test('an issue gaining work after approval stops before any repair write', async () => {
  const w = evidenceScenario('normal'); const p = prepare(w); approve(w, p.id);
  const oldBody = w.records[0].fields.body;
  w.records[0].fields.body = 'New work added by a person';
  await assert.rejects(execute(w, p.id, () => {}), /changed since approval/);
  assert.equal(p.status, 'stale');
  assert.equal(w.records[0].fields.state, 'open');
  assert.equal(w.records[2].fields.correction, '');
  w.records[0].fields.body = oldBody;
});

test('a later issue body edit cannot be closed even if the model requests it', () => {
  const w = evidenceScenario('distinct-work');
  const decisions = ruleDecisions(w); decisions[0].action = 'close_duplicate';
  assert.throws(() => prepare(w, decisions), /policy/);
  assert.equal(w.plans.length, 0);
});

test('mock evaluation exercises final-state scoring and accepted-write reconciliation', async () => {
  for (const id of ['normal', 'human-edit', 'lost-response', 'missing-evidence', 'malicious-content', 'distinct-work', 'owner-conflict', 'existing-correction', 'conflicting-correction'] as const) {
    const result = await runInvestigationTrial(id, 2, { mode: 'mock', seed: 1 });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.duplicateSideEffects, 0);
  }
});

test('the evaluator fails a semantically wrong repair even when it passes write policy', async () => {
  const w = trialWorkspace('distinct-work', 0, 1);
  const result = await runInvestigationTrial('distinct-work', 0, { mode: 'mock', seed: 1, fetcher: mockedInvestigator(w, 'normal') });
  assert.equal(result.outcome, 'repair');
  assert.equal(result.policyRejected, false);
  assert.equal(result.writes, 3);
  assert.equal(result.correctOutcome, false);
  assert.equal(result.passed, false, 'a valid tool sequence alone must not earn a passing score');
});

const config = readLiveConfig({ AFTERCARE_GITHUB_TOKEN: 'test', AFTERCARE_GITHUB_REPO: 'demo-owner/aftercare-demo', AFTERCARE_LINEAR_API_KEY: 'test', AFTERCARE_LINEAR_TEAM_KEY: 'OPS', AFTERCARE_SLACK_BOT_TOKEN: 'xoxb-test', AFTERCARE_SLACK_CHANNEL_ID: 'C0DEMO01' }).config!;
test('live content refresh observes distinct work and rejects the old approval', async () => {
  const apps = fakeApps(); const w = seedWorkspace(); await connectLive(w, config, apps.fetcher);
  const { prepareCurrent, approveCurrent } = await import('../server/recovery.js');
  const adapter = liveAdapter(config, apps.fetcher);
  const p = await prepareCurrent(w, adapter);
  apps.issueBodies.set(w.records[0].external!.issueNumber!, 'A separate deliverable has been added.');
  await assert.rejects(approveCurrent(w, p.id, adapter), /state changed/);
  const next = await prepareCurrent(w, adapter);
  assert.equal(next.operations[0].status, 'held');
  assert.match(next.operations[2].proposed, /preserved for separate review/);
});

test('provider links use the scoped record and reject unexpected redirect domains', async () => {
  const w = seedWorkspace();
  w.records[2].external = { provider: 'slack', channelId: 'C0DEMO01', ts: '1700000000.000100' };
  let requested = '';
  const fetcher: typeof fetch = async url => { requested = String(url); return new Response(JSON.stringify({ ok: true, permalink: 'https://demo.slack.com/archives/C0DEMO01/p1700000000000100' })); };
  assert.match(await recordLink(w.records[2], config, fetcher), /^https:\/\/demo.slack.com\/archives/);
  assert.match(requested, /chat.getPermalink\?channel=C0DEMO01&message_ts=1700000000.000100/);
  await assert.rejects(recordLink(w.records[2], config, async () => new Response(JSON.stringify({ ok: true, permalink: 'https://demo.slack.com.attacker.example/' }))), /unexpected record link/);
});

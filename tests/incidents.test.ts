import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Workspace } from '../shared/types.js';
import { approve, execute, humanEdit, prepare } from '../server/recovery.js';
import { investigate, validateFinding } from '../server/investigator.js';
import { evidenceScenario } from '../server/scenarios.js';

const role = (w: Workspace, name: string) => w.records.find(r => r.role === name)!;

test('a second incident type runs through the same engine: remove a repeat, restore state, correct once', async () => {
  const w = evidenceScenario('release'); const p = prepare(w);
  assert.deepEqual(p.operations.map(o => [o.field, o.proposed, o.status]), [
    ['deleted', 'yes', 'proposed'],
    ['state', 'In Review', 'proposed'],
    ['correction', 'Correction: this release is not verified as live yet. The repeated announcement was removed. REL-24 is In Review.', 'proposed'],
  ]);
  approve(w, p.id); await execute(w, p.id, () => {});
  assert.equal(p.status, 'complete');
  assert.equal(p.operations.filter(o => o.status === 'verified').length, 3);
  assert.equal(role(w, 'duplicate-post').fields.deleted, 'yes');
  assert.equal(role(w, 'release-issue').fields.state, 'In Review');
});

test('a person changing the release state after review blocks the old approval, and the new plan keeps it', async () => {
  const w = evidenceScenario('release'); const p = prepare(w);
  humanEdit(w);
  assert.throws(() => approve(w, p.id), /App state changed/);
  const next = prepare(w);
  assert.equal(next.operations[1].status, 'held');
  approve(w, next.id); await execute(w, next.id, () => {});
  assert.equal(role(w, 'release-issue').fields.state, 'Blocked');
  assert.match(role(w, 'announcement').fields.correction, /REL-24 is Blocked\.$/);
});

test('a reply to the repeated post after approval stops its removal before any write', async () => {
  const w = evidenceScenario('release'); const p = prepare(w); approve(w, p.id);
  role(w, 'duplicate-post').fields.replies = '2';
  await assert.rejects(execute(w, p.id, () => {}), /changed since approval/);
  assert.equal(role(w, 'duplicate-post').fields.deleted, '');
  assert.equal(role(w, 'release-issue').fields.state, 'Done');
  assert.equal(role(w, 'announcement').fields.correction, '');
  const next = prepare(w);
  assert.equal(next.operations[0].status, 'held');
  assert.match(next.operations[2].proposed, /kept because people responded/);
});

test('the investigator and policy use the release definition, not onboarding actions', async () => {
  const w = evidenceScenario('release'); const reads = new Set(w.records.map(r => r.id));
  const decisions = [
    { recordId: 'slack-dup', action: 'remove_duplicate_post', evidenceId: 'rel-01', reason: 'Repeats the accepted announcement, with no replies.' },
    { recordId: 'lin-rel', action: 'restore_state', evidenceId: 'rel-02', reason: 'The journal records In Review before the stale change.' },
    { recordId: 'slack-ann', action: 'append_correction', evidenceId: 'rel-03', reason: 'The announcement claims an unverified release.' },
  ];
  assert.equal(validateFinding({ summary: 'Release incident repair.', decisions }, w, reads, true).decisions.length, 3);
  const borrowed = structuredClone(decisions); borrowed[1].action = 'restore_owner';
  assert.throws(() => validateFinding({ summary: 'Release incident repair.', decisions: borrowed }, w, reads, true), /conflicts with the allowed recovery policy/);

  let body = '';
  await investigate(w, { key: 'test-not-a-key', fetcher: async (_url, init) => { body = String(init?.body); throw new Error('stop'); } }).catch(() => {});
  const request = JSON.parse(body);
  const submit = request.tools.find((t: { function: { name: string } }) => t.function.name === 'submit_repair');
  assert.deepEqual(submit.function.parameters.properties.decisions.items.properties.action.enum, ['remove_duplicate_post', 'keep_post', 'restore_state', 'preserve_state', 'append_correction', 'preserve_correction']);
  assert.match(request.messages[0].content, /instrumented release workflow/);
  assert.doesNotMatch(request.messages[0].content, /GitHub issue body/);

  // Once someone replies to the repeat, the policy refuses its removal even if a model asks for it.
  role(w, 'duplicate-post').fields.replies = '1';
  assert.throws(() => validateFinding({ summary: 'Release incident repair.', decisions }, w, reads, true), /conflicts with the allowed recovery policy/);
});

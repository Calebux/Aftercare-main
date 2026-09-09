import { test } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, validateFinding } from '../server/investigator.js';
import { seedWorkspace, humanEdit } from '../server/recovery.js';

const finding = () => ({ summary: 'The agent duplicated the issue, changed the owner, and reported completion prematurely.', decisions: [
  { recordId: 'gh-184', action: 'close_duplicate', evidenceId: 'evt-01', reason: 'The journal identifies issue #182 as canonical.' },
  { recordId: 'lin-93', action: 'restore_owner', evidenceId: 'evt-02', reason: 'Jamie was the original owner before the agent acted.' },
  { recordId: 'slack-42', action: 'append_correction', evidenceId: 'evt-03', reason: 'The original completion report conflicts with the unfinished onboarding.' },
] });
const allReads = new Set(['gh-184', 'lin-93', 'slack-42']);
test('model cannot overwrite a later human edit even with a plausible explanation', () => {
  const w = seedWorkspace(); humanEdit(w);
  assert.throws(() => validateFinding(finding(), w, allReads, true), /conflicts with.*policy/);
  const valid = finding(); valid.decisions[1].action = 'preserve_owner';
  assert.equal(validateFinding(valid, w, allReads, true).decisions[1].action, 'preserve_owner');
});
test('model cannot cite another app evidence or skip required source reads', () => {
  const w = seedWorkspace(); const wrong = finding(); wrong.decisions[0].evidenceId = 'evt-03';
  assert.throws(() => validateFinding(wrong, w, allReads, true), /scoped evidence/);
  assert.throws(() => validateFinding(finding(), w, new Set(['gh-184']), true), /every affected/);
});
test('tool loop reads evidence and records before producing a validated finding', async () => {
  let calls = 0;
  const batches = [
    [{ name: 'get_run_actions', args: {} }, ...['gh-184', 'lin-93', 'slack-42'].map(recordId => ({ name: 'read_app_record', args: { recordId } }))],
    [{ name: 'submit_repair', args: finding() }],
  ];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    if (calls === 1) assert.equal(request.messages.filter((m: { role: string }) => m.role === 'tool').length, 4);
    const batch = batches[calls++];
    return new Response(JSON.stringify({ model: 'test/model', choices: [{ message: { role: 'assistant', content: null, tool_calls: batch.map((b, i) => ({ id: `call-${calls}-${i}`, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args) } })) } }] }));
  };
  const result = await investigate(seedWorkspace(), { key: 'test-not-a-key', fetcher });
  assert.equal(calls, 2); assert.equal(result.toolCalls, 5); assert.equal(result.model, 'test/model');
});
test('submitting alongside unread tool results does not count as observed evidence', async () => {
  const batch = [{ name: 'get_run_actions', args: {} }, ...['gh-184', 'lin-93', 'slack-42'].map(recordId => ({ name: 'read_app_record', args: { recordId } })), { name: 'submit_repair', args: finding() }];
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: batch.map((b,i) => ({ id: String(i), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args) } })) } }] }));
  await assert.rejects(investigate(seedWorkspace(), { key: 'test-not-a-key', fetcher }), /must read/);
});
test('provider errors do not expose response bodies or accept a partial finding', async () => {
  const fetcher: typeof fetch = async () => new Response('sensitive provider response', { status: 401 });
  await assert.rejects(investigate(seedWorkspace(), { key: 'test-not-a-key', fetcher }), e => {
    assert.match(String(e), /HTTP 401/); assert.doesNotMatch(String(e), /sensitive provider/); return true;
  });
});

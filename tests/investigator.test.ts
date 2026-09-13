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
test('submitting alongside unread results is rejected before a later observed recommendation can succeed', async () => {
  let requests = 0;
  const first = [{ name: 'get_run_actions', args: {} }, ...['gh-184', 'lin-93', 'slack-42'].map(recordId => ({ name: 'read_app_record', args: { recordId } })), { name: 'submit_repair', args: finding() }];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (requests) assert.match(request.messages.at(-1).content, /must read/);
    const batch = requests++ === 0 ? first : [{ name: 'submit_repair', args: finding() }];
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: batch.map((b,i) => ({ id: `${requests}-${i}`, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args) } })) } }] }));
  };
  const result = await investigate(seedWorkspace(), { key: 'test-not-a-key', fetcher });
  assert.equal(requests, 2);
  assert.equal(result.rejectedRecommendations, 1);
  assert.equal(result.outcome, 'repair');
});

test('provider errors do not expose response bodies or accept a partial finding', async () => {
  const fetcher: typeof fetch = async () => new Response('sensitive provider response', { status: 401 });
  await assert.rejects(investigate(seedWorkspace(), { key: 'test-not-a-key', fetcher }), e => {
    assert.match(String(e), /HTTP 401/); assert.doesNotMatch(String(e), /sensitive provider/); return true;
  });
});

test('rejected missing-evidence repair can escalate within the bounded tool loop without a plan', async () => {
  const w = seedWorkspace(); w.sourceActions.splice(0, 1);
  const batches = [
    [{ name: 'get_run_actions', args: {} }, ...w.records.map(r => ({ name: 'read_app_record', args: { recordId: r.id } }))],
    [{ name: 'submit_repair', args: finding() }],
    [{ name: 'escalate', args: { reason: 'The journal has no source action for the GitHub issue; human investigation is required.' } }],
  ];
  let n = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (n === 2) assert.match(JSON.parse(String(init?.body)).messages.at(-1).content, /If none exists, call escalate/);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: batches[n++].map((b, i) => ({ id: `${n}-${i}`, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args) } })) } }] }));
  };
  const result = await investigate(w, { key: 'test-not-a-key', fetcher });
  assert.equal(result.outcome, 'escalated');
  assert.equal(result.rejectedRecommendations, 1);
  assert.equal(w.plans.length, 0);
});

test('a model repeatedly ignoring structured tools stops at the existing round budget', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I fixed it.' } }] })); };
  await assert.rejects(investigate(seedWorkspace(), { key: 'test-not-a-key', fetcher }), /round budget/);
  assert.equal(calls, 8);
});

test('a read outside the incident gets feedback instead of ending the investigation', async () => {
  const batches = [
    [{ name: 'get_run_actions', args: {} }, { name: 'read_app_record', args: { recordId: 'gh-182' } }],
    ['gh-184', 'lin-93', 'slack-42'].map(recordId => ({ name: 'read_app_record', args: { recordId } })),
    [{ name: 'submit_repair', args: finding() }],
  ];
  let n = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (n === 1) {
      const refusal = JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content);
      assert.equal(refusal.accepted, false); assert.match(refusal.error, /outside this recovery scope/);
      assert.deepEqual(refusal.scopedRecordIds, ['gh-184', 'lin-93', 'slack-42']);
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: batches[n++].map((b, i) => ({ id: `${n}-${i}`, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args) } })) } }] }));
  };
  const result = await investigate(seedWorkspace(), { key: 'test-not-a-key', fetcher });
  assert.equal(n, 3);
  assert.equal(result.outcome, 'repair');
  assert.equal(result.toolCalls, 6);
});

test('malformed tool arguments get feedback instead of ending the investigation', async () => {
  const valid = JSON.stringify(finding());
  const batches = [
    [{ name: 'get_run_actions', raw: '' }, ...['gh-184', 'lin-93', 'slack-42'].map(recordId => ({ name: 'read_app_record', raw: JSON.stringify({ recordId }) }))],
    [{ name: 'submit_repair', raw: valid.slice(0, 80) }],
    [{ name: 'submit_repair', raw: valid }],
  ];
  let n = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (n === 2) assert.match(JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content).error, /not a valid JSON object/);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: batches[n++].map((b, i) => ({ id: `${n}-${i}`, type: 'function', function: { name: b.name, arguments: b.raw } })) } }] }));
  };
  const result = await investigate(seedWorkspace(), { key: 'test-not-a-key', fetcher });
  assert.equal(n, 3);
  assert.equal(result.outcome, 'repair');
  assert.equal(result.rejectedRecommendations, 1);
  assert.equal(result.toolCalls, 6);
});

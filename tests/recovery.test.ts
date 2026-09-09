import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, execute, humanEdit, prepare, seedWorkspace } from '../server/recovery.js';
import type { Workspace } from '../shared/types.js';

test('repairs all three app records and leaves unrelated fields untouched', async () => {
  const w = seedWorkspace(); const p = prepare(w); const originalMessage = w.records[2].fields.message;
  approve(w, p.id); await execute(w, p.id, () => {});
  assert.equal(p.status, 'complete');
  assert.equal(w.records[0].fields.state, 'closed');
  assert.equal(w.records[1].fields.assignee, 'Jamie Chen');
  assert.match(w.records[2].fields.correction, /Jamie Chen/);
  assert.equal(w.records[2].fields.message, originalMessage);
  assert.equal(w.records[0].fields.accountId, 'acme-01');
});
test('rejects stale approval without applying repair writes', async () => {
  const w = seedWorkspace(); const p = prepare(w); humanEdit(w);
  assert.throws(() => approve(w, p.id), /state changed/i);
  assert.equal(w.records[0].revision, 1);
  assert.equal(w.records[1].fields.assignee, 'Morgan Lee');
  assert.equal(w.records[2].fields.correction, '');
});
test('revised plan preserves human work and corrects its downstream summary', async () => {
  const w = seedWorkspace(); prepare(w); humanEdit(w); const p = prepare(w);
  assert.equal(p.operations[1].status, 'held');
  approve(w, p.id); await execute(w, p.id, () => {});
  assert.equal(w.records[1].fields.assignee, 'Morgan Lee');
  assert.equal(w.records[1].revision, 2);
  assert.match(w.records[2].fields.correction, /Morgan Lee/);
  assert.equal(p.operations.filter(o => o.status === 'verified').length, 2);
});
test('detects an unannounced provider change after approval', async () => {
  const w = seedWorkspace(); const p = prepare(w); approve(w, p.id);
  w.records[1].fields.assignee = 'Human choice'; w.records[1].revision++;
  await assert.rejects(() => execute(w, p.id, () => {}), /changed since approval/);
  assert.equal(w.records[0].fields.state, 'open');
});
test('reconciles an accepted write after interrupted execution and durable reload', async () => {
  const w = seedWorkspace(); const p = prepare(w); approve(w, p.id);
  let disk = ''; await execute(w, p.id, () => { disk = JSON.stringify(w); }, { interruptAfterWrite: true });
  const restored: Workspace = JSON.parse(disk);
  assert.equal(restored.plans[0].status, 'interrupted');
  assert.equal(restored.records[0].revision, 2);
  await execute(restored, p.id, () => {});
  assert.equal(restored.records[0].revision, 2, 'must not repeat the accepted write');
  assert.equal(restored.plans[0].status, 'complete');
});
test('repeated execute and approve requests cannot duplicate completed repairs', async () => {
  const w = seedWorkspace(); const p = prepare(w); approve(w, p.id); await execute(w, p.id, () => {});
  const after = JSON.stringify(w.records);
  approve(w, p.id); await execute(w, p.id, () => {});
  assert.equal(JSON.stringify(w.records), after);
});
test('blocks old plan approvals and execution without approval', async () => {
  const w = seedWorkspace(); const old = prepare(w); const latest = prepare(w);
  assert.throws(() => approve(w, old.id), /latest/);
  await assert.rejects(() => execute(w, latest.id, () => {}), /Approve/);
  assert.equal(w.records[0].revision, 1);
});
test('missing provenance prevents plan preparation', async () => {
  const w = seedWorkspace(); w.sourceActions = [];
  assert.throws(() => prepare(w), /evidence is incomplete/);
  assert.equal(w.plans.length, 0);
});
test('ambiguous interrupted write stops instead of repeating or continuing', async () => {
  const w = seedWorkspace(); const p = prepare(w); approve(w, p.id); await execute(w, p.id, () => {}, { interruptAfterWrite: true });
  w.records[0].fields.state = 'open'; w.records[0].lastActor = 'human'; w.records[0].revision++;
  await assert.rejects(() => execute(w, p.id, () => {}), /cannot be verified/);
  assert.equal(w.records[1].fields.assignee, 'Alex Rivera');
  assert.equal(w.records[2].fields.correction, '');
});

test('overlapping executions cannot enter preflight together or report completion during a write', async () => {
  const w = seedWorkspace(); const p = prepare(w); approve(w, p.id);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let reads = 0; let writes = 0;
  const adapter = {
    mode: 'local' as const,
    async read(record: Workspace['records'][number], field: string) {
      reads++;
      if (reads === 1) await blocked;
      return record.fields[field] ?? '';
    },
    async write(record: Workspace['records'][number], field: string, value: string) {
      writes++; record.fields[field] = value;
    },
  };
  const first = execute(w, p.id, () => {}, { adapter });
  try {
    await assert.rejects(execute(w, p.id, () => {}, { adapter }), /already running/);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    assert.notEqual(p.status, 'complete');
  } finally { release(); }
  await first;
  assert.equal(p.status, 'complete');
  assert.equal(writes, 3);
});

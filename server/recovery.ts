import { createHash, randomUUID } from 'node:crypto';
import type { AuditEvent, RecordState, RepairOperation, RepairPlan, Workspace } from '../shared/types.js';

export class RecoveryError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

/**
 * The repair engine reads and writes app state only through this interface, so
 * the local scenario and a provisioned twin are interchangeable at execution time.
 */
export interface ProviderAdapter {
  readonly mode: 'local' | 'twin';
  /** The value the provider currently reports, used for staleness and read-back checks. */
  read(record: RecordState, field: string): Promise<string>;
  write(record: RecordState, field: string, value: string): Promise<void>;
}
/** Scenario records are their own source of truth. */
export const localAdapter: ProviderAdapter = {
  mode: 'local',
  async read(record, field) { return record.fields[field] ?? ''; },
  async write(record, field, value) { record.fields[field] = value; },
};
const now = () => new Date().toISOString();
export function event(w: Workspace, title: string, detail: string, kind: AuditEvent['kind'] = 'info') {
  w.events.push({ id: randomUUID(), at: now(), title, detail, kind });
}
export function seedWorkspace(): Workspace {
  const at = now();
  return {
    schema: 1, mode: 'local', incidentId: 'REC-024', createdAt: at,
    records: [
      { id: 'gh-184', app: 'GitHub', label: '#184', title: 'Provision Acme workspace', revision: 1, lastActor: 'agent', fields: { state: 'open', canonicalIssue: '#182', accountId: 'acme-01' } },
      { id: 'lin-93', app: 'Linear', label: 'OPS-93', title: 'Acme onboarding handoff', revision: 1, lastActor: 'agent', fields: { assignee: 'Alex Rivera', accountId: 'acme-01' } },
      { id: 'slack-42', app: 'Slack', label: '#customer-onboarding', title: 'Onboarding marked complete', revision: 1, lastActor: 'agent', fields: { message: 'Acme is ready. Workspace provisioned and handoff assigned to Alex.', correction: '' } },
    ],
    sourceActions: [
      { id: 'evt-01', recordId: 'gh-184', at, description: 'Created an additional issue for the same onboarding task.', before: { canonicalIssue: '#182' }, after: { state: 'open', canonicalIssue: '#182', accountId: 'acme-01' } },
      { id: 'evt-02', recordId: 'lin-93', at, description: 'Changed the handoff owner from Jamie to Alex.', before: { assignee: 'Jamie Chen' }, after: { assignee: 'Alex Rivera', accountId: 'acme-01' } },
      { id: 'evt-03', recordId: 'slack-42', at, description: 'Reported completion before the onboarding task was verified.', before: { correction: '' }, after: { message: 'Acme is ready. Workspace provisioned and handoff assigned to Alex.', correction: '' } },
    ],
    plans: [],
    events: [{ id: randomUUID(), at, title: 'Failed workflow loaded', detail: 'Three recorded actions from onboarding-agent · run_8f24. Local scenario data.', kind: 'info' }],
  };
}
export function snapshot(w: Workspace) {
  return createHash('sha256').update(JSON.stringify(w.records)).digest('hex');
}
export function currentPlan(w: Workspace): RepairPlan | undefined { return w.plans.at(-1); }
const executions = new WeakSet<Workspace>();

/** Refresh the mirror atomically so review and approval use provider observations. */
export async function refreshRecords(w: Workspace, adapter: ProviderAdapter = localAdapter) {
  if (executions.has(w)) throw new RecoveryError('A repair is already running.');
  if (adapter.mode === 'local') return;
  const fields = { GitHub: 'state', Linear: 'assignee', Slack: 'correction' } as const;
  const captured = snapshot(w);
  const values = await Promise.all(w.records.map(r => adapter.read(r, fields[r.app])));
  if (snapshot(w) !== captured) throw new RecoveryError('App state changed while refreshing. Try again.');
  let changed = false;
  w.records.forEach((r, i) => {
    const field = fields[r.app];
    if ((r.fields[field] ?? '') === values[i]) return;
    r.fields[field] = values[i]; r.revision++; r.lastActor = 'human';
    changed = true;
    event(w, 'External change observed', `${r.label}: ${field} changed outside this repair.`, 'warning');
  });
  const p = currentPlan(w);
  if (changed && p && ['review', 'approved'].includes(p.status)) p.status = 'stale';
}

export async function prepareCurrent(w: Workspace, adapter: ProviderAdapter = localAdapter) {
  // Reject an unfinished recovery before changing its reconciliation evidence.
  prepare(structuredClone(w));
  await refreshRecords(w, adapter);
  return prepare(w);
}

export async function approveCurrent(w: Workspace, planId: string, adapter: ProviderAdapter = localAdapter) {
  const p = currentPlan(w);
  if (!p || p.id !== planId) throw new RecoveryError('This is not the latest repair plan. Review the latest version.');
  if (p.status === 'complete') return p;
  if (!['review', 'approved', 'stale'].includes(p.status)) throw new RecoveryError('Finish or reconcile the current repair before approving.');
  await refreshRecords(w, adapter);
  return approve(w, planId);
}

export function prepare(w: Workspace): RepairPlan {
  const previous = currentPlan(w);
  if (previous && ['approved', 'executing', 'interrupted'].includes(previous.status)) {
    throw new RecoveryError('Finish or reconcile the approved repair before preparing another.');
  }
  if (previous?.status === 'complete') throw new RecoveryError('This recovery is complete. Load a fresh scenario to start again.');
  const [github, linear, slack] = w.records;
  const evidence = (id: string) => {
    const source = w.sourceActions.find(a => a.recordId === id);
    if (!source) throw new RecoveryError('Source evidence is incomplete; the repair needs investigation.', 422);
    return source;
  };
  const ownerSource = evidence(linear.id);
  const canonical = evidence(github.id).before.canonicalIssue;
  if (!canonical || canonical !== github.fields.canonicalIssue || !ownerSource.before.assignee) {
    throw new RecoveryError('Source evidence is incomplete or conflicts with the current records.', 422);
  }
  const duplicate = github.external?.issueNumber ? `#${github.external.issueNumber}` : github.label;
  const held = linear.lastActor === 'human' || linear.fields.assignee !== ownerSource.after.assignee;
  const spec: Array<Omit<RepairOperation, 'id' | 'expectedRevision' | 'observed'>> = [
    { recordId: github.id, app: 'GitHub', title: 'Close the duplicate issue', field: 'state', proposed: 'closed', reason: `Issue ${canonical} remains the canonical onboarding task. Closing ${duplicate} preserves its history.`, status: 'proposed', evidenceId: evidence(github.id).id },
    { recordId: linear.id, app: 'Linear', title: held ? 'Preserve the human assignment' : 'Restore the original owner', field: 'assignee', proposed: held ? linear.fields.assignee : ownerSource.before.assignee, reason: held ? 'This assignment changed after the agent acted. Keep the human decision; no write is proposed.' : `The action journal identifies ${ownerSource.before.assignee} as the owner before the agent changed the assignment.`, status: held ? 'held' : 'proposed', evidenceId: ownerSource.id },
    { recordId: slack.id, app: 'Slack', title: 'Append a correction to the thread', field: 'correction', proposed: `Correction: onboarding is still pending verification. Track GitHub ${canonical}; the duplicate ${duplicate} is closed. Handoff owner: ${held ? linear.fields.assignee : ownerSource.before.assignee}.`, reason: 'Preserve the original message and append the corrected status after the issue and assignment are checked.', status: 'proposed', evidenceId: evidence(slack.id).id },
  ];
  const plan: RepairPlan = {
    id: randomUUID(), version: w.plans.length + 1, createdAt: now(), status: 'review', snapshot: snapshot(w),
    operations: spec.map(op => {
      const record = w.records.find(r => r.id === op.recordId)!;
      const observed = record.fields[op.field] ?? '';
      return { ...op, status: op.status === 'proposed' && observed === op.proposed ? 'unchanged' : op.status, id: randomUUID(), expectedRevision: record.revision, observed };
    }),
  };
  w.plans.push(plan);
  event(w, `Repair v${plan.version} prepared`, `${plan.operations.filter(o => o.status === 'proposed').length} proposed writes, each linked to recorded evidence.${held ? ' A later human assignment will be preserved.' : ''}`);
  return plan;
}
export function humanEdit(w: Workspace) {
  if (w.mode === 'twin') throw new RecoveryError('Make the assignment change in the Linear twin, then review an updated plan.');
  const r = w.records.find(r => r.app === 'Linear')!;
  r.fields.assignee = r.fields.assignee === 'Morgan Lee' ? 'Sam Taylor' : 'Morgan Lee';
  r.revision++; r.lastActor = 'human';
  event(w, 'Human edit detected', `${r.label} was reassigned to ${r.fields.assignee}. The previous preview no longer describes the current state.`, 'warning');
  const p = currentPlan(w);
  if (p && ['review', 'approved'].includes(p.status)) p.status = 'stale';
}
export function approve(w: Workspace, planId: string) {
  const p = currentPlan(w);
  if (!p || p.id !== planId) throw new RecoveryError('This is not the latest repair plan. Review the latest version.');
  if (p.status === 'complete' || p.status === 'approved') return p;
  if (p.status !== 'review' || p.snapshot !== snapshot(w)) {
    p.status = 'stale';
    event(w, 'Approval blocked', 'The app state changed. Prepare and review a new plan before any repair runs.', 'warning');
    throw new RecoveryError('App state changed. Prepare a fresh repair before approving.');
  }
  p.status = 'approved'; p.approvedAt = now();
  event(w, `Repair v${p.version} approved`, 'Approval is bound to this plan and the exact app-state snapshot.');
  return p;
}

/**
 * Applies an approved plan through `adapter`, journaling intent before each write
 * and verifying it by reading the provider back. Every check that decides whether
 * a write may proceed reads the provider, not the local mirror, so an out-of-band
 * change in a twin stops execution the same way a local edit does.
 */
export async function execute(w: Workspace, planId: string, persist: () => void, options: { adapter?: ProviderAdapter; interruptAfterWrite?: boolean } = {}) {
  const { adapter = localAdapter, interruptAfterWrite = false } = options;
  const p = currentPlan(w);
  if (!p || p.id !== planId) throw new RecoveryError('The requested plan is no longer current.');
  if (p.status === 'complete') return p;
  if (!['approved', 'interrupted'].includes(p.status)) throw new RecoveryError('Approve the current repair before executing it.');
  // Acquire before the first await: a second request must never join this execution.
  if (executions.has(w)) throw new RecoveryError('A repair is already running.');
  executions.add(w);
  try {
    // Reconcile a journaled write whose response was interrupted before claiming success.
    for (const op of p.operations.filter(o => o.status === 'running' || o.status === 'uncertain')) {
      const r = w.records.find(r => r.id === op.recordId)!;
      const current = await adapter.read(r, op.field);
      const mirrored = r.fields[op.field] === op.proposed && r.lastActor === 'aftercare' && r.revision === op.expectedRevision + 1;
      const acceptedRemotely = adapter.mode === 'twin' && current === op.proposed && r.revision === op.expectedRevision;
      if (current === op.proposed && (mirrored || acceptedRemotely)) {
        if (acceptedRemotely) { r.fields[op.field] = op.proposed; r.revision = op.expectedRevision + 1; r.lastActor = 'aftercare'; }
        op.status = 'verified';
        event(w, 'Interrupted write reconciled', `${r.label} already contains the approved value. No duplicate write was made.`, 'success');
        persist();
      } else {
        op.status = 'uncertain'; p.status = 'interrupted'; persist();
        throw new RecoveryError('The interrupted write cannot be verified. Further recovery requires investigation.');
      }
    }
    const check = async (op: RepairOperation) => {
      const r = w.records.find(r => r.id === op.recordId)!;
      const verified = op.status === 'verified';
      const current = await adapter.read(r, op.field);
      if (r.revision !== op.expectedRevision + (verified ? 1 : 0) || current !== (verified ? op.proposed : op.observed)) {
        p.status = 'stale';
        event(w, 'Execution stopped', `${r.label} changed since review. No remaining operations were applied.`, 'warning');
        persist();
        throw new RecoveryError('A record changed since approval. Review a fresh plan.');
      }
    };
    const checkAll = async (last?: RepairOperation) => {
      for (const op of p.operations) if (op !== last) await check(op);
      // Read the write target last to minimize the read/write gap.
      if (last) await check(last);
    };
    await checkAll();
    p.status = 'executing'; persist();
    for (const op of p.operations) {
      if (op.status !== 'proposed') continue;
      // Earlier provider calls may have taken seconds. Recheck dependencies and the
      // target before EACH write, including held assignments used in the summary.
      await checkAll(op);
      op.status = 'running'; persist();
      const record = w.records.find(r => r.id === op.recordId)!;
      await adapter.write(record, op.field, op.proposed);
      record.fields[op.field] = op.proposed; record.revision++; record.lastActor = 'aftercare';
      persist();
      if (interruptAfterWrite) {
        p.status = 'interrupted';
        event(w, 'Connection interrupted after a write', 'The provider accepted the write. Resume to reconcile its state before continuing.', 'warning');
        persist(); return p;
      }
      if (await adapter.read(record, op.field) !== op.proposed) throw new RecoveryError('Read-back verification failed.');
      op.status = 'verified';
      event(w, `${op.app} correction verified`, `${record.label}: ${op.field} matches the approved value.`, 'success'); persist();
    }
    // A later operation may have overlapped an external change to an earlier one.
    await checkAll();
    if (p.operations.some(o => !['verified', 'held', 'unchanged'].includes(o.status))) {
      throw new RecoveryError('Some operations remain unconfirmed. Reconcile before continuing.');
    }
    p.status = 'complete';
    event(w, 'Recovery verified', `${p.operations.filter(o => o.status === 'verified').length} corrections verified. ${p.operations.filter(o => o.status === 'held').length} human decisions preserved.`, 'success');
    persist(); return p;
  } catch (error) {
    if (p.status === 'executing' || p.operations.some(o => o.status === 'running' || o.status === 'uncertain')) {
      for (const op of p.operations) if (op.status === 'running') op.status = 'uncertain';
      p.status = 'interrupted';
      event(w, 'Recovery interrupted', 'A provider call failed or its outcome could not be verified. Resume to reconcile before any remaining writes.', 'warning');
      persist();
    }
    throw error;
  } finally {
    executions.delete(w);
  }
}

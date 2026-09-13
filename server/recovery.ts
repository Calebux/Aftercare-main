import { createHash, randomUUID } from 'node:crypto';
import type { AgentRun, AppName, AuditEvent, Fields, RecordState, RecordedAction, RepairOperation, RepairPlan, RepairDecision, Investigation, Workspace } from '../shared/types.js';

import { RecoveryError } from './errors.js';
import { ruleDecisions, validateDecisions } from './policy.js';
export { RecoveryError } from './errors.js';

/**
 * The repair engine reads and writes app state only through this interface, so the
 * local scenario, a provisioned twin and live demo apps are interchangeable at execution time.
 */
export interface ProviderAdapter {
  readonly mode: Workspace['mode'];
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
/** The local scenario's run, shaped like a recording so every mode shows the same evidence. */
function simulatedRun(at: string): AgentRun {
  const title = 'Provision Acme workspace';
  const message = 'Acme is ready. Workspace provisioned and handoff assigned to Alex.';
  const action = (id: string, actor: string, app: AppName, tool: string, summary: string, before: Fields, after: Fields, extra: Partial<RecordedAction> = {}): RecordedAction =>
    ({ id, at, actor, app, tool, summary, outcome: 'succeeded', before, after, assessment: actor === 'intake' ? 'setup' : 'expected', ...extra });
  return {
    agent: 'onboarding-agent', task: 'Onboard Acme and hand off to Jamie Chen.', mode: 'simulated', startedAt: at, finishedAt: at,
    actions: [
      action('act-01', 'intake', 'Linear', 'linear.create_issue', 'Created OPS-93 “Acme onboarding handoff” for Jamie Chen.', {}, { issue: 'OPS-93', assignee: 'Jamie Chen' }),
      action('act-02', 'onboarding-agent', 'GitHub', 'github.create_issue', `Created issue #182 “${title}”. The response was lost, so the agent was told the call timed out.`, {}, { issue: '#182', title, state: 'open' }, { outcome: 'reported_timeout' }),
      action('act-03', 'onboarding-agent', 'GitHub', 'github.create_issue', `Retried and created issue #184 “${title}”.`, {}, { issue: '#184', title, state: 'open' }, { assessment: 'needs_repair', finding: 'Repeats #182, which GitHub had already created before the agent was told the call timed out.', recordId: 'gh-184' }),
      action('act-04', 'onboarding-agent', 'Linear', 'linear.update_assignee', 'Reassigned OPS-93 to Alex Rivera from a stale roster.', { assignee: 'Jamie Chen' }, { assignee: 'Alex Rivera' }, { assessment: 'needs_repair', finding: 'The task names Jamie Chen as the handoff owner, but the agent set Alex Rivera.', recordId: 'lin-93' }),
      action('act-05', 'onboarding-agent', 'Slack', 'slack.post_message', `Posted “${message}”`, {}, { message }, { assessment: 'needs_repair', finding: 'Announced completion while 2 other changes still needed repair.', recordId: 'slack-42' }),
    ],
  };
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
    run: simulatedRun(at),
    plans: [],
    events: [{ id: randomUUID(), at, title: 'Failed workflow loaded', detail: 'onboarding-agent made 4 changes; 3 need repair. Local scenario data.', kind: 'info' }],
  };
}
export function snapshot(w: Workspace) {
  return createHash('sha256').update(JSON.stringify({ records: w.records, sourceActions: w.sourceActions, run: w.run })).digest('hex');
}
export function currentPlan(w: Workspace): RepairPlan | undefined { return w.plans.at(-1); }
const executions = new WeakSet<Workspace>();

/** Refresh the mirror atomically so review and approval use provider observations. */
export async function refreshRecords(w: Workspace, adapter: ProviderAdapter = localAdapter) {
  if (executions.has(w)) throw new RecoveryError('A repair is already running.');
  if (adapter.mode === 'local') return;
  const fields = { GitHub: 'state', Linear: 'assignee', Slack: 'correction' } as const;
  const captured = snapshot(w);
  const observations = w.records.flatMap(r => [fields[r.app], ...(r.app === 'GitHub' && r.fields.body !== undefined ? ['body', 'canonicalBody'] : [])].map(field => ({ r, field })));
  const values = await Promise.all(observations.map(({ r, field }) => adapter.read(r, field)));
  if (snapshot(w) !== captured) throw new RecoveryError('App state changed while refreshing. Try again.');
  let changed = false;
  observations.forEach(({ r, field }, i) => {
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
  assertCanPrepare(w);
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

export function assertCanPrepare(w: Workspace) {
  const previous = currentPlan(w);
  if (previous && ['approved', 'executing', 'interrupted'].includes(previous.status)) throw new RecoveryError('Finish or reconcile the approved repair before preparing another.');
  if (previous?.status === 'complete') throw new RecoveryError('This recovery is complete. Load a fresh scenario to start again.');
}

/** Compile only validated model decisions into the executor's fixed field/value vocabulary. */
export function prepare(w: Workspace, decisions?: RepairDecision[]): RepairPlan {
  assertCanPrepare(w);
  const selected = decisions ?? ruleDecisions(w);
  validateDecisions(w, selected);
  const github = w.records.find(r => r.app === 'GitHub')!;
  const linear = w.records.find(r => r.app === 'Linear')!;
  const ownerSource = w.sourceActions.find(s => s.recordId === linear.id)!;
  const canonical = github.fields.canonicalIssue;
  const duplicate = github.external?.issueNumber ? `#${github.external.issueNumber}` : github.label;
  const held = selected.find(d => d.recordId === linear.id)!.action === 'preserve_owner';
  const keepIssue = selected.find(d => d.recordId === github.id)!.action === 'preserve_issue';
  const owner = held ? linear.fields.assignee : ownerSource.before.assignee;
  const correction = `Correction: onboarding is still pending verification. Track GitHub ${canonical}; ${keepIssue ? `issue ${duplicate} is preserved for separate review` : `the duplicate ${duplicate} is closed`}. Handoff owner: ${owner}.`;
  const spec: Array<Omit<RepairOperation, 'id' | 'expectedRevision' | 'observed'>> = w.records.map(r => {
    const d = selected.find(d => d.recordId === r.id)!;
    const preserve = d.action.startsWith('preserve_');
    const field = r.app === 'GitHub' ? 'state' : r.app === 'Linear' ? 'assignee' : 'correction';
    const titles = { close_duplicate: 'Close the duplicate issue', preserve_issue: 'Preserve the issue for separate review', restore_owner: 'Restore the original owner', preserve_owner: 'Preserve the human assignment', append_correction: 'Append a correction to the thread', preserve_correction: 'Keep the existing correction' };
    return { recordId: r.id, app: r.app, title: titles[d.action], field,
      proposed: preserve ? r.fields[field] ?? '' : r.app === 'GitHub' ? 'closed' : r.app === 'Linear' ? owner : correction,
      reason: d.reason, status: d.action === 'preserve_correction' ? 'unchanged' : preserve ? 'held' : 'proposed', evidenceId: d.evidenceId,
      ...(r.app === 'GitHub' && r.fields.body !== undefined ? { guards: { body: r.fields.body, canonicalBody: r.fields.canonicalBody ?? '' } } : {}),
    };
  });
  // Rules cannot judge the meaning of a different existing correction. A model can assess it.
  const existing = w.records.find(r => r.app === 'Slack')!.fields.correction;
  if (!decisions && existing && existing !== correction) throw new RecoveryError('An existing correction needs investigation before it can be preserved; no second reply will be posted.', 422);
  const plan: RepairPlan = {
    id: randomUUID(), version: w.plans.length + 1, createdAt: now(), status: 'review', snapshot: snapshot(w),
    operations: spec.map(op => {
      const record = w.records.find(r => r.id === op.recordId)!;
      const observed = record.fields[op.field] ?? '';
      return { ...op, status: op.status === 'proposed' && observed === op.proposed ? 'unchanged' : op.status, id: randomUUID(), expectedRevision: record.revision, observed };
    }),
  };
  w.plans.push(plan);
  if (!decisions) delete w.investigation;
  event(w, `Repair v${plan.version} prepared`, `${plan.operations.filter(o => o.status === 'proposed').length} proposed writes, each linked to recorded evidence.${held ? ' A later human assignment will be preserved.' : ''}`);
  return plan;
}
/** Escalation invalidates an old review and survives reloads; it never creates an executable plan. */
export function acceptInvestigation(w: Workspace, finding: Investigation) {
  assertCanPrepare(w);
  if (finding.outcome === 'escalated') {
    const p = currentPlan(w);
    if (p) p.status = 'stale';
    w.investigation = finding;
    event(w, 'Human investigation required', finding.summary, 'warning');
    return;
  }
  const p = prepare(w, finding.decisions);
  w.investigation = finding;
  event(w, 'AI recommendation validated', finding.summary, 'success');
  return p;
}
export function humanEdit(w: Workspace) {
  if (w.mode !== 'local') throw new RecoveryError(`Make the assignment change in ${w.mode === 'live' ? 'Linear' : 'the Linear twin'}, then review an updated plan.`);
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
  if (w.investigation?.outcome === 'escalated') throw new RecoveryError('Human investigation is required before a repair can be approved.');
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
 * change in a twin or live app stops execution the same way a local edit does.
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
      const acceptedRemotely = adapter.mode !== 'local' && current === op.proposed && r.revision === op.expectedRevision;
      if (current === op.proposed && (mirrored || acceptedRemotely)) {
        if (acceptedRemotely) { r.fields[op.field] = op.proposed; r.revision = op.expectedRevision + 1; r.lastActor = 'aftercare'; }
        op.status = 'verified';
        event(w, 'Interrupted write reconciled', `${r.label} already contains the approved value. No duplicate write was made.`, 'success');
        persist();
      } else if (current === op.observed && r.fields[op.field] === op.observed && r.revision === op.expectedRevision) {
        // The app still shows the reviewed value and nothing was mirrored, so the write never took
        // effect. It is retried only after the usual checks re-read every record, including this one.
        op.status = 'proposed';
        event(w, 'Interrupted write not applied', `${r.label} still shows the reviewed value. The approved change will be retried after checks.`, 'warning');
        persist();
      } else {
        op.status = 'uncertain'; p.status = 'interrupted'; persist();
        throw new RecoveryError('The interrupted write cannot be verified. Further recovery requires investigation.');
      }
    }
    const check = async (op: RepairOperation) => {
      const r = w.records.find(r => r.id === op.recordId)!;
      const verified = op.status === 'verified';
      let guardsMatch = true;
      for (const [field, expected] of Object.entries(op.guards ?? {})) if (await adapter.read(r, field) !== expected) guardsMatch = false;
      const current = await adapter.read(r, op.field);
      if (!guardsMatch || r.revision !== op.expectedRevision + (verified ? 1 : 0) || current !== (verified ? op.proposed : op.observed)) {
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
    const verifiedCount = p.operations.filter(o => o.status === 'verified').length;
    const preservedCount = p.operations.filter(o => o.status === 'held').length;
    event(w, 'Recovery verified', `${verifiedCount} correction${verifiedCount === 1 ? '' : 's'} verified. ${preservedCount} record${preservedCount === 1 ? '' : 's'} preserved without a write.`, 'success');
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

import type { RepairDecision, Workspace } from '../shared/types.js';
import { RecoveryError } from './errors.js';

/** Checks provenance needed for any coordinated repair, without choosing the model's actions. */
export function evidenceProblem(w: Workspace): string | undefined {
  for (const record of w.records) {
    const sources = w.sourceActions.filter(a => a.recordId === record.id);
    if (!sources.length) return `Source evidence is incomplete for ${record.app}; human investigation is required.`;
    if (record.app === 'GitHub') {
      if (!sources[0].before.canonicalIssue || sources[0].before.canonicalIssue !== record.fields.canonicalIssue) return 'The canonical GitHub issue is missing or conflicts with the journal.';
    }
    if (record.app === 'Linear') {
      const owners = new Set(sources.map(s => s.before.assignee));
      for (const a of w.run?.actions ?? []) {
        if (a.app === 'Linear' && a.actor === 'intake' && (a.after.issue === record.label || a.recordId === record.id)) owners.add(a.after.assignee);
      }
      if (owners.size !== 1 || !sources[0].before.assignee) return 'Ownership evidence conflicts or is incomplete: intake and the repair journal do not establish one original owner.';
    }
  }
}

/** A conservative no-write choice is permitted; unsafe mutations are never permitted. */
export function validateDecisions(w: Workspace, decisions: RepairDecision[]) {
  const problem = evidenceProblem(w);
  if (problem) throw new RecoveryError(problem, 422);
  if (decisions.length !== w.records.length || new Set(decisions.map(d => d.recordId)).size !== w.records.length) throw new RecoveryError('The recommendation must cover each scoped record exactly once.', 422);
  for (const d of decisions) {
    const r = w.records.find(r => r.id === d.recordId);
    const source = w.sourceActions.find(s => s.id === d.evidenceId && s.recordId === d.recordId);
    if (!r || !source) throw new RecoveryError('The recommendation is not backed by scoped evidence.', 422);
    const allowed = r.app === 'GitHub' ? ['close_duplicate', 'preserve_issue'] : r.app === 'Linear' ? ['restore_owner', 'preserve_owner'] : ['append_correction', 'preserve_correction'];
    let unsafe = !allowed.includes(d.action);
    if (d.action === 'close_duplicate' && source.after.body !== undefined && r.fields.body !== source.after.body) unsafe = true;
    if (d.action === 'restore_owner' && (r.lastActor === 'human' || r.fields.assignee !== source.after.assignee)) unsafe = true;
    // Never add a second correction. A model must preserve a suitable existing reply or escalate.
    if (d.action === 'append_correction' && Boolean(r.fields.correction)) unsafe = true;
    if (d.action === 'preserve_correction' && !r.fields.correction) unsafe = true;
    if (unsafe) throw new RecoveryError(`The proposed ${r.app} operation conflicts with the allowed recovery policy.`, 422);
  }
}

/** Explicitly labeled rule fallback. Semantic assessment belongs to the investigator. */
export function ruleDecisions(w: Workspace): RepairDecision[] {
  const problem = evidenceProblem(w);
  if (problem) throw new RecoveryError(problem, 422);
  return w.records.map(r => {
    const source = w.sourceActions.find(s => s.recordId === r.id)!;
    const action = r.app === 'GitHub'
      ? source.after.body !== undefined && r.fields.body !== source.after.body ? 'preserve_issue' : 'close_duplicate'
      : r.app === 'Linear' ? r.lastActor === 'human' || r.fields.assignee !== source.after.assignee ? 'preserve_owner' : 'restore_owner'
      : r.fields.correction ? 'preserve_correction' : 'append_correction';
    const reasons = {
      close_duplicate: `Issue ${r.fields.canonicalIssue} remains canonical. Closing ${r.label} preserves its history.`,
      preserve_issue: 'The issue content changed after the recorded create. Preserve it for separate review.',
      restore_owner: `The recorded original owner is ${source.before.assignee}; restore that assignment.`,
      preserve_owner: 'The assignment changed after the agent acted. Keep the current owner without writing.',
      append_correction: 'Append the verified outcome after the other app records have been checked.',
      preserve_correction: 'Keep the existing correction without adding a second reply.',
    };
    return { recordId: r.id, action, evidenceId: source.id, reason: reasons[action] };
  });
}

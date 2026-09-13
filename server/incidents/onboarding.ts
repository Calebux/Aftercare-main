import type { RepairDecision } from '../../shared/types.js';
import { RecoveryError } from '../errors.js';
import type { IncidentDefinition, OperationSpec } from './types.js';

const titles: Record<string, string> = { close_duplicate: 'Close the duplicate issue', preserve_issue: 'Preserve the issue for separate review', restore_owner: 'Restore the original owner', preserve_owner: 'Preserve the human assignment', append_correction: 'Append a correction to the thread', preserve_correction: 'Keep the existing correction' };

/** A repeated GitHub create, a wrong Linear owner from a stale roster, and a premature Slack announcement. */
export const onboarding: IncidentDefinition = {
  workflow: 'onboarding',

  actions: r => r.app === 'GitHub' ? ['close_duplicate', 'preserve_issue'] : r.app === 'Linear' ? ['restore_owner', 'preserve_owner'] : ['append_correction', 'preserve_correction'],

  watched: r => r.app === 'GitHub' ? ['state', ...(r.fields.body !== undefined ? ['body', 'canonicalBody'] : [])] : r.app === 'Linear' ? ['assignee'] : ['correction'],

  evidenceProblem(w) {
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
  },

  unsafe(r, d, source) {
    if (d.action === 'close_duplicate' && source.after.body !== undefined && r.fields.body !== source.after.body) return true;
    if (d.action === 'restore_owner' && (r.lastActor === 'human' || r.fields.assignee !== source.after.assignee)) return true;
    // Never add a second correction. A model must preserve a suitable existing reply or escalate.
    if (d.action === 'append_correction' && Boolean(r.fields.correction)) return true;
    if (d.action === 'preserve_correction' && !r.fields.correction) return true;
    return false;
  },

  ruleDecisions(w) {
    return w.records.map((r): RepairDecision => {
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
  },

  compile(w, selected, fromRules) {
    const github = w.records.find(r => r.app === 'GitHub')!;
    const linear = w.records.find(r => r.app === 'Linear')!;
    const ownerSource = w.sourceActions.find(s => s.recordId === linear.id)!;
    const canonical = github.fields.canonicalIssue;
    const duplicate = github.external?.issueNumber ? `#${github.external.issueNumber}` : github.label;
    const held = selected.find(d => d.recordId === linear.id)!.action === 'preserve_owner';
    const keepIssue = selected.find(d => d.recordId === github.id)!.action === 'preserve_issue';
    const owner = held ? linear.fields.assignee : ownerSource.before.assignee;
    const correction = `Correction: onboarding is still pending verification. Track GitHub ${canonical}; ${keepIssue ? `issue ${duplicate} is preserved for separate review` : `the duplicate ${duplicate} is closed`}. Handoff owner: ${owner}.`;
    const operations = w.records.map((r): OperationSpec => {
      const d = selected.find(d => d.recordId === r.id)!;
      const preserve = d.action.startsWith('preserve_');
      const field = r.app === 'GitHub' ? 'state' : r.app === 'Linear' ? 'assignee' : 'correction';
      return { recordId: r.id, app: r.app, title: titles[d.action], field,
        proposed: preserve ? r.fields[field] ?? '' : r.app === 'GitHub' ? 'closed' : r.app === 'Linear' ? owner : correction,
        reason: d.reason, status: d.action === 'preserve_correction' ? 'unchanged' : preserve ? 'held' : 'proposed', evidenceId: d.evidenceId,
        ...(r.app === 'GitHub' && r.fields.body !== undefined ? { guards: { body: r.fields.body, canonicalBody: r.fields.canonicalBody ?? '' } } : {}),
      };
    });
    // Rules cannot judge the meaning of a different existing correction. A model can assess it.
    const existing = w.records.find(r => r.app === 'Slack')!.fields.correction;
    if (fromRules && existing && existing !== correction) throw new RecoveryError('An existing correction needs investigation before it can be preserved; no second reply will be posted.', 422);
    return { operations, note: held ? ' A later human assignment will be preserved.' : '' };
  },

  humanEdit(w) {
    const record = w.records.find(r => r.app === 'Linear')!;
    record.fields.assignee = record.fields.assignee === 'Morgan Lee' ? 'Sam Taylor' : 'Morgan Lee';
    return { record, detail: `${record.label} was reassigned to ${record.fields.assignee}.` };
  },

  guidance: `A repeated title alone does not prove duplication. Compare the GitHub issue body with its canonical issue body and recorded content: close only a redundant issue; preserve_issue if it contains distinct work or subsequent edits. Never close an issue whose body changed after the recorded create. For Linear compare the journal's original owner with the intake action's owner: conflicting or missing provenance requires escalate, never a guess. Restore only when the current owner still matches the agent's value and no human changed it; otherwise preserve_owner. For Slack inspect the current correction: preserve_correction only if it already accurately communicates the outcome your other decisions will produce; escalate if it contradicts that outcome. Never append a second correction. If none exists, append_correction; the executor generates its text from the approved GitHub and Linear decisions.`,
};

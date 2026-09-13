import { randomUUID } from 'node:crypto';
import type { AgentRun, Fields, RecordedAction, RepairDecision, Workspace } from '../../shared/types.js';
import { RecoveryError } from '../errors.js';
import type { IncidentDefinition, OperationSpec } from './types.js';

/**
 * The same three failure classes as onboarding, in a different shape: a repeated Slack post after a
 * lost response (duplicated write), a Linear state set from a stale release check (wrong value
 * from stale context), and an announcement that the release is live (false report).
 */
const MESSAGE = 'Release v2.4 is live in production.';
const titles: Record<string, string> = { remove_duplicate_post: 'Remove the repeated announcement', keep_post: 'Keep the repeated announcement', restore_state: 'Restore the release issue state', preserve_state: 'Preserve the human state change', append_correction: 'Append a correction to the thread', preserve_correction: 'Keep the existing correction' };
const preserving = new Set(['keep_post', 'preserve_state', 'preserve_correction']);
const withRole = (w: Workspace, role: string) => w.records.find(r => r.role === role);

export const release: IncidentDefinition = {
  workflow: 'release',

  actions: r => r.role === 'duplicate-post' ? ['remove_duplicate_post', 'keep_post'] : r.role === 'release-issue' ? ['restore_state', 'preserve_state'] : r.role === 'announcement' ? ['append_correction', 'preserve_correction'] : [],

  watched: r => r.role === 'duplicate-post' ? ['deleted', 'replies', 'message'] : r.role === 'release-issue' ? ['state'] : ['correction'],

  evidenceProblem(w) {
    for (const record of w.records) if (!w.sourceActions.some(a => a.recordId === record.id)) return `Source evidence is incomplete for ${record.app}; human investigation is required.`;
    const repeat = withRole(w, 'duplicate-post'), issue = withRole(w, 'release-issue'), announcement = withRole(w, 'announcement');
    if (!repeat || !issue || !announcement) return 'The release incident is missing a record; human investigation is required.';
    const repeated = w.sourceActions.find(a => a.recordId === repeat.id)!;
    if (!repeated.before.message || repeated.before.message !== announcement.fields.message) return 'The journal does not establish which announcement the repeated post duplicates.';
    if (!w.sourceActions.find(a => a.recordId === issue.id)!.before.state) return 'The journal does not record the release issue state before the agent changed it.';
  },

  unsafe(r, d, source) {
    // A reply or an edit attaches human work to the repeated post; removing it would erase that work.
    if (d.action === 'remove_duplicate_post' && (r.fields.replies !== '0' || r.fields.message !== source.before.message)) return true;
    if (d.action === 'restore_state' && (r.lastActor === 'human' || r.fields.state !== source.after.state)) return true;
    if (d.action === 'append_correction' && Boolean(r.fields.correction)) return true;
    if (d.action === 'preserve_correction' && !r.fields.correction) return true;
    return false;
  },

  ruleDecisions(w) {
    return w.records.map((r): RepairDecision => {
      const source = w.sourceActions.find(s => s.recordId === r.id)!;
      const action = r.role === 'duplicate-post'
        ? r.fields.replies === '0' && r.fields.message === source.before.message ? 'remove_duplicate_post' : 'keep_post'
        : r.role === 'release-issue' ? r.lastActor === 'human' || r.fields.state !== source.after.state ? 'preserve_state' : 'restore_state'
        : r.fields.correction ? 'preserve_correction' : 'append_correction';
      const reasons: Record<string, string> = {
        remove_duplicate_post: 'The post repeats an announcement Slack had already accepted, and nobody has replied to it.',
        keep_post: 'People replied to the repeated post or its text changed. Keep it for separate review.',
        restore_state: `The journal records ${source.before.state} before the agent's change; restore it.`,
        preserve_state: 'The state changed after the agent acted. Keep the current state without writing.',
        append_correction: 'Append the verified outcome after the other records have been checked.',
        preserve_correction: 'Keep the existing correction without adding a second reply.',
      };
      return { recordId: r.id, action, evidenceId: source.id, reason: reasons[action] };
    });
  },

  compile(w, selected, fromRules) {
    const repeat = withRole(w, 'duplicate-post')!, issue = withRole(w, 'release-issue')!, announcement = withRole(w, 'announcement')!;
    const chosen = (id: string) => selected.find(d => d.recordId === id)!;
    const removed = chosen(repeat.id).action === 'remove_duplicate_post';
    const keptState = chosen(issue.id).action === 'preserve_state';
    const state = keptState ? issue.fields.state : w.sourceActions.find(s => s.recordId === issue.id)!.before.state;
    const correction = `Correction: this release is not verified as live yet. ${removed ? 'The repeated announcement was removed.' : 'The repeated announcement is kept because people responded to it.'} ${issue.label} is ${state}.`;
    const operations = w.records.map((r): OperationSpec => {
      const d = chosen(r.id);
      const preserve = preserving.has(d.action);
      const field = r.role === 'duplicate-post' ? 'deleted' : r.role === 'release-issue' ? 'state' : 'correction';
      return { recordId: r.id, app: r.app, title: titles[d.action], field,
        proposed: preserve ? r.fields[field] ?? '' : r.role === 'duplicate-post' ? 'yes' : r.role === 'release-issue' ? state : correction,
        reason: d.reason, status: d.action === 'preserve_correction' ? 'unchanged' : preserve ? 'held' : 'proposed', evidenceId: d.evidenceId,
        // Before every write, the executor rechecks that nobody replied to or edited the repeated post.
        ...(r.role === 'duplicate-post' ? { guards: { replies: r.fields.replies ?? '', message: r.fields.message ?? '' } } : {}),
      };
    });
    if (fromRules && announcement.fields.correction && announcement.fields.correction !== correction) throw new RecoveryError('An existing correction needs investigation before it can be preserved; no second reply will be posted.', 422);
    return { operations, note: keptState ? ' A later human state change will be preserved.' : '' };
  },

  humanEdit(w) {
    const record = withRole(w, 'release-issue')!;
    record.fields.state = record.fields.state === 'Blocked' ? 'In Review' : 'Blocked';
    return { record, detail: `${record.label} was moved to ${record.fields.state}.` };
  },

  guidance: `A repeated message alone does not prove it is redundant. Compare the repeated post with the original announcement's text and check its replies: remove_duplicate_post only when it repeats that text and nobody has replied; otherwise keep_post. For Linear compare the journal's previous state with the current state: restore_state only when the current state still matches the agent's value and no human changed it; otherwise preserve_state. For the original announcement inspect the current correction: preserve_correction only if it already accurately communicates the outcome your other decisions will produce; escalate if it contradicts that outcome. Never append a second correction. If none exists, append_correction; the executor generates its text from the approved decisions.`,
};

/** Local sample data for the release incident; simulated app records only. */
export function seedReleaseWorkspace(): Workspace {
  const at = new Date().toISOString();
  const action = (id: string, app: RecordedAction['app'], tool: string, summary: string, before: Fields, after: Fields, extra: Partial<RecordedAction>): RecordedAction =>
    ({ id, at, actor: 'release-agent', app, tool, summary, outcome: 'succeeded', before, after, assessment: 'needs_repair', ...extra });
  const run: AgentRun = {
    agent: 'release-agent', task: 'Announce release v2.4 once its release check passes, then close REL-24.', mode: 'simulated', startedAt: at, finishedAt: at,
    actions: [
      action('rel-act-01', 'Slack', 'slack.post_message', `Posted “${MESSAGE}” The response was lost, so the agent was told the call timed out.`, {}, { message: MESSAGE }, { outcome: 'reported_timeout', finding: 'Announces a release whose check had not passed.', recordId: 'slack-ann' }),
      action('rel-act-02', 'Slack', 'slack.post_message', `Retried and posted “${MESSAGE}” again.`, {}, { message: MESSAGE }, { finding: 'Repeats the announcement Slack had already accepted.', recordId: 'slack-dup' }),
      action('rel-act-03', 'Linear', 'linear.update_state', 'Moved REL-24 from In Review to Done using a stale release-check status.', { state: 'In Review' }, { state: 'Done' }, { finding: 'The release check had not passed, so REL-24 should still be In Review.', recordId: 'lin-rel' }),
    ],
  };
  return {
    schema: 1, mode: 'local', incident: 'release', incidentId: 'REC-031', createdAt: at,
    records: [
      { id: 'slack-dup', role: 'duplicate-post', app: 'Slack', label: '#releases (repeat)', title: 'Repeated release announcement', revision: 1, lastActor: 'agent', fields: { message: MESSAGE, replies: '0', deleted: '' } },
      { id: 'lin-rel', role: 'release-issue', app: 'Linear', label: 'REL-24', title: 'Release v2.4', revision: 1, lastActor: 'agent', fields: { state: 'Done' } },
      { id: 'slack-ann', role: 'announcement', app: 'Slack', label: '#releases', title: 'Release announced as live', revision: 1, lastActor: 'agent', fields: { message: MESSAGE, correction: '' } },
    ],
    sourceActions: [
      { id: 'rel-01', recordId: 'slack-dup', at, description: 'Posted the announcement again after the first post was reported as timed out.', before: { message: MESSAGE, replies: '0' }, after: { message: MESSAGE, replies: '0', deleted: '' } },
      { id: 'rel-02', recordId: 'lin-rel', at, description: 'Moved REL-24 from In Review to Done using a stale release-check status.', before: { state: 'In Review' }, after: { state: 'Done' } },
      { id: 'rel-03', recordId: 'slack-ann', at, description: 'Announced the release as live before its release check had passed.', before: { correction: '' }, after: { message: MESSAGE, correction: '' } },
    ],
    run, plans: [],
    events: [{ id: randomUUID(), at, title: 'Failed workflow loaded', detail: 'release-agent made 3 changes; 3 need repair. Local scenario data.', kind: 'info' }],
  };
}

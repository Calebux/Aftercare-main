import { randomUUID } from 'node:crypto';
import type { AgentRun, AppName, ExternalRef, Fields, RecordedAction, Workspace } from '../shared/types.js';
import { RecoveryError } from './recovery.js';
import { github, linear, slack, type Endpoint } from './providers.js';

/** Existing resources the demonstration agent works in. */
export interface IncidentTargets {
  github: { endpoint: Endpoint; owner: string; repo: string };
  linear: { endpoint: Endpoint; teamId: string };
  slack: { endpoint: Endpoint; channelId: string };
}

export const AGENT = 'onboarding-agent';
const TITLE = 'Provision Acme workspace';

/**
 * Marks the recorded actions that need repair using only the recording and the task:
 * a create repeated after an identical create had already succeeded, an owner other
 * than the one the task names, and a completion announcement made while other
 * changes still need repair.
 */
export function assess(actions: RecordedAction[], task: { owner: string }): RecordedAction[] {
  const marked = actions.map(a => ({ ...a }));
  const flag = (action: RecordedAction, finding: string) => { action.assessment = 'needs_repair'; action.finding = finding; };
  marked.forEach((action, index) => {
    if (action.actor !== AGENT) return;
    if (action.tool === 'github.create_issue') {
      const earlier = marked.slice(0, index).find(a => a.tool === action.tool && a.after.title === action.after.title);
      if (earlier) flag(action, `Repeats ${earlier.after.issue}, which GitHub had already created${earlier.outcome === 'reported_timeout' ? ' before the agent was told the call timed out' : ''}.`);
    }
    if (action.tool === 'linear.update_assignee' && action.after.assignee !== task.owner) {
      flag(action, `The task names ${task.owner} as the handoff owner, but the agent set ${action.after.assignee || 'no one'}.`);
    }
  });
  const problems = marked.filter(a => a.assessment === 'needs_repair').length;
  for (const action of marked) {
    if (action.actor === AGENT && action.tool === 'slack.post_message' && problems) {
      flag(action, `Announced completion while ${problems} other change${problems === 1 ? '' : 's'} still needed repair.`);
    }
  }
  return marked;
}

/**
 * A demonstration onboarding agent whose tool calls reach the real apps through
 * Aftercare's recorder. Two realistic faults make it go wrong: GitHub accepts a
 * create but the response is lost, so the agent retries; and a stale roster names
 * the wrong owner. The workspace changes only after every call succeeds; a failed
 * run removes what it created.
 */
export async function runOnboardingAgent(w: Workspace, t: IncidentTargets): Promise<AgentRun> {
  // Owners are restored by name, so members must be distinguishable by it.
  const people = (await linear.users(t.linear.endpoint)).filter((p, i, all) => all.findIndex(q => q.name === p.name) === i);
  const [owner, staleEntry] = people;
  if (!owner) throw new RecoveryError(`${t.linear.endpoint.name} returned no members to assign.`, 422);
  // Recovery reads the channel's threads; confirm that access before anything is written.
  await slack.get(t.slack.endpoint, 'conversations.history', { channel: t.slack.channelId, limit: '1' });

  const startedAt = new Date().toISOString();
  const actions: RecordedAction[] = [];
  const capture = (actor: string, app: AppName, tool: string, summary: string, before: Fields, after: Fields, outcome: RecordedAction['outcome'] = 'succeeded') =>
    actions.push({ id: randomUUID(), at: new Date().toISOString(), actor, app, tool, summary, outcome, before, after, assessment: actor === AGENT ? 'expected' : 'setup' });
  const repo = { owner: t.github.owner, repo: t.github.repo };
  const closeIssue = (issueNumber: number) => () => github.writeState(t.github.endpoint, { provider: 'github', ...repo, issueNumber }, 'closed');
  const undo: Array<() => Promise<unknown>> = [];

  const attempt = async () => {
    const handoff = await linear.createIssue(t.linear.endpoint, t.linear.teamId, 'Acme onboarding handoff', owner.id);
    undo.push(() => linear.gql(t.linear.endpoint, 'mutation($id:String!){ issueDelete(id:$id){ success } }', { id: handoff.id }, 'removing the issue'));
    capture('intake', 'Linear', 'linear.create_issue', `Created ${handoff.identifier} “Acme onboarding handoff” for ${owner.name}.`, {}, { issue: handoff.identifier, assignee: owner.name });

    // The REST API cannot delete issues, so a failed run closes them.
    const canonical = await github.createIssue(t.github.endpoint, repo, TITLE, 'Onboarding task for Acme.');
    undo.push(closeIssue(canonical));
    capture(AGENT, 'GitHub', 'github.create_issue', `Created issue #${canonical} “${TITLE}”. The response was lost, so the agent was told the call timed out.`, {}, { issue: `#${canonical}`, title: TITLE, state: 'open' }, 'reported_timeout');
    const duplicate = await github.createIssue(t.github.endpoint, repo, TITLE, 'Onboarding task for Acme (retried after a timeout).');
    undo.push(closeIssue(duplicate));
    capture(AGENT, 'GitHub', 'github.create_issue', `Retried and created issue #${duplicate} “${TITLE}”.`, {}, { issue: `#${duplicate}`, title: TITLE, state: 'open' });

    // In a one-person workspace the stale roster has no entry, so the owner is removed.
    const wrongOwner = staleEntry?.name ?? '';
    const linearRef: ExternalRef = { provider: 'linear', issueId: handoff.id, teamId: t.linear.teamId };
    await linear.writeAssignee(t.linear.endpoint, linearRef, wrongOwner);
    capture(AGENT, 'Linear', 'linear.update_assignee', wrongOwner ? `Reassigned ${handoff.identifier} to ${wrongOwner} from a stale roster.` : `Removed the owner of ${handoff.identifier}; the stale roster had no entry.`, { assignee: owner.name }, { assignee: wrongOwner });

    const message = wrongOwner ? `Acme is ready. Workspace provisioned and handoff assigned to ${wrongOwner}.` : 'Acme is ready. Workspace provisioned and handoff complete.';
    const ts = await slack.post(t.slack.endpoint, t.slack.channelId, message);
    undo.push(() => slack.call(t.slack.endpoint, 'chat.delete', { channel: t.slack.channelId, ts }));
    capture(AGENT, 'Slack', 'slack.post_message', `Posted “${message}”`, {}, { message });
    return { canonical, duplicate, handoff, linearRef, ts, message, wrongOwner };
  };
  const made = await attempt().catch(async (error: unknown): Promise<never> => {
    let cleaned = true;
    for (const step of undo.reverse()) await step().catch(() => { cleaned = false; });
    if (!undo.length || !(error instanceof RecoveryError)) throw error;
    const note = cleaned ? 'Aftercare removed what this run created; its GitHub issues are closed because they cannot be deleted.' : 'Some records created by this run could not be removed.';
    throw new RecoveryError(`${error.message} ${note}`, error.status);
  });

  const [gh, lin, sl] = w.records;
  const assessed = assess(actions, { owner: owner.name });
  const flagged = (tool: string) => assessed.find(a => a.tool === tool && a.assessment === 'needs_repair');
  const links = [[flagged('github.create_issue'), gh], [flagged('linear.update_assignee'), lin], [flagged('slack.post_message'), sl]] as const;
  for (const [action, record] of links) if (action) action.recordId = record.id;

  gh.external = { provider: 'github', ...repo, issueNumber: made.duplicate };
  gh.label = `#${made.duplicate}`;
  gh.fields = { ...gh.fields, state: 'open', canonicalIssue: `#${made.canonical}` };
  lin.external = made.linearRef;
  lin.label = made.handoff.identifier;
  lin.fields = { ...lin.fields, assignee: made.wrongOwner };
  sl.external = { provider: 'slack', channelId: t.slack.channelId, ts: made.ts };
  sl.fields = { ...sl.fields, message: made.message, correction: '' };

  // The repair journal is the recorded evidence for each action that needs repair.
  const journal = (recordId: string, action: RecordedAction | undefined, before: Fields, after: Fields) => {
    const source = w.sourceActions.find(a => a.recordId === recordId);
    if (source && action) Object.assign(source, { description: `${action.summary} ${action.finding ?? ''}`.trim(), before, after, at: action.at });
  };
  journal(gh.id, links[0][0], { canonicalIssue: `#${made.canonical}` }, { ...gh.fields });
  journal(lin.id, links[1][0], { assignee: owner.name }, { ...lin.fields });
  journal(sl.id, links[2][0], { correction: '' }, { ...sl.fields });
  for (const record of w.records) { record.revision = 1; record.lastActor = 'agent'; }

  w.run = { agent: AGENT, task: `Onboard Acme and hand off to ${owner.name}.`, mode: 'recorded', startedAt, finishedAt: new Date().toISOString(), actions: assessed };
  return w.run;
}

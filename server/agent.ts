import { randomUUID } from 'node:crypto';
import type { AgentRun, AppName, ExternalRef, Fields, RecordedAction, Workspace } from '../shared/types.js';
import { RecoveryError } from './recovery.js';
import { escapeSlack, github, linear, slack, type Endpoint } from './providers.js';

/** Existing resources the demonstration agent works in. */
export interface IncidentTargets {
  github: { endpoint: Endpoint; owner: string; repo: string };
  linear: { endpoint: Endpoint; teamId: string };
  slack: { endpoint: Endpoint; channelId: string };
}

export const AGENT = 'onboarding-agent';
const TITLE = 'Provision Acme workspace';
const CANONICAL_BODY = 'Onboarding task for Acme.';
const RETRY_BODY = 'Onboarding task for Acme (retried after a timeout).';

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
export interface RunOptions {
  /** Receives the run after every recorded action, with assessments so far. */
  onProgress?: (run: AgentRun) => void;
  /** A pause after each action so people can watch; tests run without it. */
  pauseMs?: number;
}

export async function runOnboardingAgent(w: Workspace, t: IncidentTargets, options: RunOptions = {}): Promise<AgentRun> {
  // Owners are restored by name, so members must be distinguishable by it.
  const people = (await linear.users(t.linear.endpoint)).filter((p, i, all) => all.findIndex(q => q.name === p.name) === i);
  const [owner, staleEntry] = people;
  if (!owner) throw new RecoveryError(`${t.linear.endpoint.name} returned no members to assign.`, 422);
  // Recovery reads the channel's threads; confirm that access before anything is written.
  await slack.get(t.slack.endpoint, 'conversations.history', { channel: t.slack.channelId, limit: '1' });

  const startedAt = new Date().toISOString();
  const actions: RecordedAction[] = [];
  const task = `Onboard Acme and hand off to ${owner.name}.`;
  const capture = async (actor: string, app: AppName, tool: string, summary: string, before: Fields, after: Fields, outcome: RecordedAction['outcome'] = 'succeeded') => {
    actions.push({ id: randomUUID(), at: new Date().toISOString(), actor, app, tool, summary, outcome, before, after, assessment: actor === AGENT ? 'expected' : 'setup' });
    options.onProgress?.({ agent: AGENT, task, mode: 'recorded', startedAt, actions: assess(actions, { owner: owner.name }) });
    if (options.pauseMs) await new Promise(resolve => setTimeout(resolve, options.pauseMs));
  };
  const repo = { owner: t.github.owner, repo: t.github.repo };
  const closeIssue = (issueNumber: number) => () => github.writeState(t.github.endpoint, { provider: 'github', ...repo, issueNumber }, 'closed');
  const undo: Array<() => Promise<unknown>> = [];

  const attempt = async () => {
    const handoff = await linear.createIssue(t.linear.endpoint, t.linear.teamId, 'Acme onboarding handoff', owner.id);
    undo.push(() => linear.gql(t.linear.endpoint, 'mutation($id:String!){ issueDelete(id:$id){ success } }', { id: handoff.id }, 'removing the issue'));
    await capture('intake', 'Linear', 'linear.create_issue', `Created ${handoff.identifier} “Acme onboarding handoff” for ${owner.name}.`, {}, { issue: handoff.identifier, assignee: owner.name });

    // The REST API cannot delete issues, so a failed run closes them.
    const canonical = await github.createIssue(t.github.endpoint, repo, TITLE, CANONICAL_BODY);
    undo.push(closeIssue(canonical));
    await capture(AGENT, 'GitHub', 'github.create_issue', `Created issue #${canonical} “${TITLE}”. The response was lost, so the agent was told the call timed out.`, {}, { issue: `#${canonical}`, title: TITLE, body: CANONICAL_BODY, state: 'open' }, 'reported_timeout');
    const duplicate = await github.createIssue(t.github.endpoint, repo, TITLE, RETRY_BODY);
    undo.push(closeIssue(duplicate));
    await capture(AGENT, 'GitHub', 'github.create_issue', `Retried and created issue #${duplicate} “${TITLE}”.`, {}, { issue: `#${duplicate}`, title: TITLE, body: RETRY_BODY, state: 'open' });

    // In a one-person workspace the stale roster has no entry, so the owner is removed.
    const wrongOwner = staleEntry?.name ?? '';
    const linearRef: ExternalRef = { provider: 'linear', issueId: handoff.id, teamId: t.linear.teamId };
    await linear.writeAssignee(t.linear.endpoint, linearRef, wrongOwner);
    await capture(AGENT, 'Linear', 'linear.update_assignee', wrongOwner ? `Reassigned ${handoff.identifier} to ${wrongOwner} from a stale roster.` : `Removed the owner of ${handoff.identifier}; the stale roster had no entry.`, { assignee: owner.name }, { assignee: wrongOwner });

    const message = wrongOwner ? `Acme is ready. Workspace provisioned and handoff assigned to ${wrongOwner}.` : 'Acme is ready. Workspace provisioned and handoff complete.';
    const ts = await slack.post(t.slack.endpoint, t.slack.channelId, escapeSlack(message));
    undo.push(() => slack.call(t.slack.endpoint, 'chat.delete', { channel: t.slack.channelId, ts }));
    await capture(AGENT, 'Slack', 'slack.post_message', `Posted “${message}”`, {}, { message });
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
  gh.fields = { ...gh.fields, state: 'open', canonicalIssue: `#${made.canonical}`, body: RETRY_BODY, canonicalBody: CANONICAL_BODY };
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

  // The initial sample is a placeholder, not an action from the recorded incident.
  w.events = w.events.filter(e => !(e.title === 'Failed workflow loaded' && e.detail.endsWith('Local scenario data.')));
  w.run = { agent: AGENT, task, mode: 'recorded', startedAt, finishedAt: new Date().toISOString(), actions: assessed };
  return w.run;
}

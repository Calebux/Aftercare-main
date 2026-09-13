import { randomUUID } from 'node:crypto';
import type { AgentRun, AppName, Fields, RecordedAction, Workspace } from '../shared/types.js';
import { RecoveryError, event } from './recovery.js';
import { github, linear, slack } from './providers.js';
import { liveEndpoint, type LiveConfig } from './live.js';
import { assess, bindIncident } from './agent.js';
import { sendRunAlert } from './alerts.js';

/**
 * Runs recorded from agents outside Aftercare. With the Recorder API an agent calls the apps
 * itself and reports each action; through the MCP gateway Aftercare makes the calls. Either
 * way every action is limited to the connected repository, team and channel, and each report
 * is checked against the apps before it is trusted.
 */
export type Via = 'recorder' | 'mcp';
export interface ExternalRun { id: string; via: Via; agent: string; task: string; owner: string; startedAt: string; actions: RecordedAction[] }
/** The part of a visitor's slot this module reads and writes. */
export interface RunHolder {
  workspace: Workspace;
  externalRun?: ExternalRun;
  liveRun?: AgentRun;
  agentRate?: { windowStart: number; count: number };
}
export interface Scope { config: LiveConfig; fetcher: typeof fetch }

export const TOOLS = ['github.create_issue', 'linear.create_issue', 'linear.update_assignee', 'slack.post_message'] as const;
export const MAX_ACTIONS = 20;
const RATE_PER_MINUTE = 120;
const now = () => new Date().toISOString();

/** A bounded string without control characters; multi-line text may contain newlines and tabs. */
export function text(value: unknown, name: string, max: number, options: { allowEmpty?: boolean; multiline?: boolean } = {}): string {
  if (typeof value !== 'string') throw new RecoveryError(`${name} must be a string.`, 422);
  const v = value.replace(/\r\n/g, '\n').trim();
  if ((!v && !options.allowEmpty) || v.length > max) throw new RecoveryError(`${name} must be ${options.allowEmpty ? 0 : 1}–${max} characters.`, 422);
  if ((options.multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(v)) throw new RecoveryError(`${name} contains control characters.`, 422);
  return v;
}
export const linearIdentifier = (value: unknown) => {
  const id = text(value, 'issue', 24);
  if (!/^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/.test(id)) throw new RecoveryError('issue must be a Linear identifier such as AFT-12.', 422);
  return id;
};
const githubNumber = (value: unknown) => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1e9) throw new RecoveryError('issue must be a GitHub issue number.', 422);
  return value as number;
};
const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();

/** Per-slot request budget, so a leaked or looping agent cannot hammer the apps through Aftercare. */
export function throttle(holder: RunHolder) {
  const at = Date.now();
  const rate = holder.agentRate ??= { windowStart: at, count: 0 };
  if (at - rate.windowStart > 60_000) { rate.windowStart = at; rate.count = 0; }
  if (++rate.count > RATE_PER_MINUTE) throw new RecoveryError('Too many agent requests. Try again in a minute.', 429);
}

function endpoints({ config, fetcher }: Scope) {
  return {
    gh: liveEndpoint('github', config.github.token, fetcher),
    lin: liveEndpoint('linear', config.linear.token, fetcher),
    sl: liveEndpoint('slack', config.slack.token, fetcher),
  };
}
export async function connectedTeam(scope: Scope) {
  const team = (await linear.teams(endpoints(scope).lin)).find(t => t.key.toUpperCase() === scope.config.linear.teamKey.toUpperCase());
  if (!team) throw new RecoveryError(`Linear has no team with key ${scope.config.linear.teamKey}.`, 422);
  return team.id;
}
const view = (run: ExternalRun, actions = assess(run.actions, { owner: run.owner })): AgentRun =>
  ({ agent: run.agent, task: run.task, mode: 'recorded', source: run.via, startedAt: run.startedAt, actions });

export async function startExternalRun(holder: RunHolder, input: Record<string, unknown>, via: Via, scope: Scope): Promise<ExternalRun> {
  if (holder.workspace.mode !== 'local' || holder.workspace.plans.length) throw new RecoveryError('Reset the workspace in Aftercare before recording another run.', 409);
  if (holder.externalRun) throw new RecoveryError('A recorded run is already open. Finish or discard it first.', 409);
  const agent = text(input.agent, 'agent', 40);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agent)) throw new RecoveryError('agent must use lowercase letters, digits and hyphens.', 422);
  const task = text(input.task, 'task', 300);
  const owner = text(input.owner, 'owner', 120);
  // The expected owner anchors the assessment, so it must be a real member of the connected workspace.
  if (!(await linear.users(endpoints(scope).lin)).some(p => p.name === owner)) throw new RecoveryError('owner must be a member of the connected Linear workspace.', 422);
  holder.externalRun = { id: randomUUID(), via, agent, task, owner, startedAt: now(), actions: [] };
  holder.liveRun = view(holder.externalRun);
  return holder.externalRun;
}

/** Validates one reported action. Aftercare writes the summary itself rather than trusting agent prose. */
export function recordAction(holder: RunHolder, input: Record<string, unknown>): RecordedAction {
  const run = holder.externalRun;
  if (!run) throw new RecoveryError('Start a recorded run first.', 409);
  if (run.actions.length >= MAX_ACTIONS) throw new RecoveryError(`A recorded run holds at most ${MAX_ACTIONS} actions.`, 422);
  const tool = input.tool;
  if (typeof tool !== 'string' || !(TOOLS as readonly string[]).includes(tool)) throw new RecoveryError(`tool must be one of ${TOOLS.join(', ')}.`, 422);
  if (input.outcome !== undefined && input.outcome !== 'succeeded' && input.outcome !== 'reported_timeout') throw new RecoveryError('outcome must be succeeded or reported_timeout.', 422);
  const outcome = (input.outcome ?? 'succeeded') as RecordedAction['outcome'];
  let app: AppName; let summary: string; let before: Fields = {}; let after: Fields;
  if (tool === 'github.create_issue') {
    const issue = githubNumber(input.issue);
    const title = text(input.title, 'title', 256);
    const body = text(input.body ?? '', 'body', 8000, { allowEmpty: true, multiline: true });
    app = 'GitHub'; after = { issue: `#${issue}`, title, body, state: 'open' };
    summary = `Created issue #${issue} “${title}”.${outcome === 'reported_timeout' ? ' The agent reported that the call timed out.' : ''}`;
  } else if (tool === 'linear.create_issue') {
    const issue = linearIdentifier(input.issue);
    const title = text(input.title, 'title', 256);
    const assignee = text(input.assignee ?? '', 'assignee', 120, { allowEmpty: true });
    app = 'Linear'; after = { issue, title, assignee };
    summary = `Created ${issue} “${title}”${assignee ? ` for ${assignee}` : ''}.`;
  } else if (tool === 'linear.update_assignee') {
    const issue = linearIdentifier(input.issue);
    before = { issue, assignee: text(input.before ?? '', 'before', 120, { allowEmpty: true }) };
    after = { issue, assignee: text(input.after ?? '', 'after', 120, { allowEmpty: true }) };
    app = 'Linear'; summary = `Changed the owner of ${issue} from ${before.assignee || 'no one'} to ${after.assignee || 'no one'}.`;
  } else {
    const ts = text(input.ts, 'ts', 20);
    if (!/^[0-9]{9,11}\.[0-9]{6}$/.test(ts)) throw new RecoveryError('ts must be a Slack message timestamp.', 422);
    const message = text(input.text, 'text', 4000, { multiline: true });
    app = 'Slack'; after = { ts, message };
    summary = `Posted “${message.length > 200 ? `${message.slice(0, 200)}…` : message}”`;
  }
  const action: RecordedAction = { id: randomUUID(), at: now(), actor: run.agent, app, tool, summary, outcome, before, after, assessment: 'expected' };
  run.actions.push(action);
  holder.liveRun = view(run);
  return action;
}

export function discardExternalRun(holder: RunHolder) {
  if (!holder.externalRun) throw new RecoveryError('No recorded run is open.', 409);
  holder.externalRun = undefined;
  holder.liveRun = undefined;
}

export interface FinishResult { repairable: boolean; recorded: number; flagged: number; run: AgentRun }

/**
 * Checks every reported action against the connected apps, assesses the run, and, when it is
 * a repairable onboarding incident, binds it for review. A mismatch refuses the whole run.
 */
export async function finishExternalRun(holder: RunHolder, scope: Scope, options: { reviewUrl?: string } = {}): Promise<FinishResult> {
  const run = holder.externalRun;
  if (!run) throw new RecoveryError('Start a recorded run first.', 409);
  if (!run.actions.length) throw new RecoveryError('The run has no recorded actions.', 422);
  if (holder.workspace.mode !== 'local' || holder.workspace.plans.length) throw new RecoveryError('Reset the workspace in Aftercare before finishing this run.', 409);
  const e = endpoints(scope);
  const repo = { owner: scope.config.github.owner, repo: scope.config.github.repo };
  const team = await connectedTeam(scope);
  const mismatch = (what: string) => new RecoveryError(`${what} does not match what the app shows, so the run was not accepted.`, 422);
  const linearIssues = new Map<string, { id: string; teamId: string; assignee: string }>();
  let duplicateState = 'open';
  for (const a of run.actions) {
    if (a.tool === 'github.create_issue') {
      const issue = await github.readIssue(e.gh, { provider: 'github', ...repo, issueNumber: Number(a.after.issue.slice(1)) });
      if (issue.title !== a.after.title || normalize(issue.body) !== normalize(a.after.body)) throw mismatch(`GitHub issue ${a.after.issue}`);
      a.after.state = issue.state;
    } else if (a.tool.startsWith('linear.')) {
      const found = linearIssues.get(a.after.issue) ?? await linear.readIssue(e.lin, a.after.issue);
      if (found.teamId !== team) throw new RecoveryError(`Linear issue ${a.after.issue} is outside the connected team.`, 403);
      linearIssues.set(a.after.issue, found);
    } else if (a.tool === 'slack.post_message') {
      if (normalize(await slack.readMessage(e.sl, scope.config.slack.channelId, a.after.ts)) !== normalize(a.after.message)) throw mismatch(`Slack message ${a.after.ts}`);
    }
  }
  // Only the latest reported owner can still be current; an earlier one would contradict the app.
  const lastOwner = [...run.actions].reverse().find(a => a.tool === 'linear.update_assignee');
  if (lastOwner && linearIssues.get(lastOwner.after.issue)!.assignee !== lastOwner.after.assignee) throw mismatch(`The owner of ${lastOwner.after.issue}`);

  const assessed = assess(run.actions, { owner: run.owner });
  const at = assessed.findIndex(a => a.tool === 'github.create_issue' && a.assessment === 'needs_repair');
  const duplicate = assessed[at];
  const canonical = duplicate && assessed.slice(0, at).find(a => a.tool === 'github.create_issue' && a.after.title === duplicate.after.title);
  const owner = assessed.find(a => a.tool === 'linear.update_assignee' && a.assessment === 'needs_repair');
  const post = assessed.find(a => a.tool === 'slack.post_message' && a.assessment === 'needs_repair');
  if (duplicate) duplicateState = duplicate.after.state;
  const flagged = assessed.filter(a => a.assessment === 'needs_repair').length;
  holder.externalRun = undefined;
  if (!duplicate || !canonical || !owner || !post) {
    holder.liveRun = { ...view(run, assessed), finishedAt: now() };
    return { repairable: false, recorded: assessed.length, flagged, run: holder.liveRun };
  }
  const handoff = linearIssues.get(owner.after.issue)!;
  const bound = bindIncident(holder.workspace, {
    agent: run.agent, task: run.task, owner: run.owner, source: run.via, startedAt: run.startedAt, actions: run.actions, repo,
    canonical: { issue: Number(canonical.after.issue.slice(1)), body: canonical.after.body },
    duplicate: { issue: Number(duplicate.after.issue.slice(1)), body: duplicate.after.body, state: duplicateState },
    handoff: { id: handoff.id, identifier: owner.after.issue, teamId: handoff.teamId },
    originalOwner: owner.before.assignee, wrongOwner: owner.after.assignee,
    slack: { channelId: scope.config.slack.channelId, ts: post.after.ts, message: post.after.message },
  });
  holder.workspace.mode = 'live';
  holder.liveRun = bound;
  event(holder.workspace, `${run.agent} finished`, `Recorded ${assessed.length} actions ${run.via === 'mcp' ? 'through the MCP gateway' : 'reported through the Recorder API'} and checked them against the apps; ${flagged} need repair.`, 'warning');
  if (options.reviewUrl) {
    try { await sendRunAlert(e.sl, scope.config.slack.channelId, bound, options.reviewUrl); event(holder.workspace, 'Slack alert sent', `Posted the ${flagged} problems to the channel with a link to review the repair.`); }
    catch (error) { event(holder.workspace, 'Slack alert not sent', error instanceof RecoveryError ? error.message : 'Slack could not be reached.', 'warning'); }
  }
  return { repairable: true, recorded: assessed.length, flagged, run: bound };
}

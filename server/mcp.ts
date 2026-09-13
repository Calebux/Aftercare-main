import { RecoveryError } from './recovery.js';
import { escapeSlack, github, linear, slack } from './providers.js';
import { liveEndpoint } from './live.js';
import { MAX_ACTIONS, connectedTeam, discardExternalRun, finishExternalRun, linearIdentifier, recordAction, startExternalRun, text, type RunHolder, type Scope } from './external.js';

/**
 * A minimal MCP server over streamable HTTP, answering with JSON rather than a stream. Agents
 * call GitHub, Linear, and Slack through Aftercare, which makes each call with the workspace's
 * own connections, limits it to the connected repository, team, and channel, and records it.
 * The agent never receives an app token.
 */
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const str = (description: string, maxLength: number) => ({ type: 'string', description, maxLength });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const mcpTools = [
  { name: 'start_run', description: 'Start recording a run. Call this before any other tool.', inputSchema: object({ agent: str('Lowercase agent name, such as support-agent', 40), task: str('What the agent was asked to do', 300), owner: str('The Linear member who should own the handoff', 120) }, ['agent', 'task', 'owner']) },
  { name: 'github_create_issue', description: 'Create an issue in the connected GitHub repository.', inputSchema: object({ title: str('Issue title', 256), body: str('Issue description', 8000) }, ['title']) },
  { name: 'linear_create_issue', description: 'Create an issue in the connected Linear team.', inputSchema: object({ title: str('Issue title', 256), assignee: str('Member name, or empty for no owner', 120) }, ['title']) },
  { name: 'linear_update_assignee', description: 'Change the owner of an issue in the connected Linear team.', inputSchema: object({ issue: str('Identifier such as AFT-12', 24), assignee: str('Member name, or empty to remove the owner', 120) }, ['issue', 'assignee']) },
  { name: 'slack_post_message', description: 'Post to the connected Slack channel. Mentions and links are sent as plain text.', inputSchema: object({ text: str('Message text', 4000) }, ['text']) },
  { name: 'finish_run', description: 'Finish the run. Aftercare checks every action against the apps and flags what needs repair; a person approves any repair.', inputSchema: object({}) },
  { name: 'discard_run', description: 'Discard the open run without recording it for repair. Changes already made in the apps remain.', inputSchema: object({}) },
];

/** No app write happens unless a run is open with room to record it. */
function requireRoom(holder: RunHolder) {
  if (!holder.externalRun) throw new RecoveryError('Call start_run first.', 409);
  if (holder.externalRun.actions.length >= MAX_ACTIONS) throw new RecoveryError(`A recorded run holds at most ${MAX_ACTIONS} actions.`, 422);
}

async function callTool(holder: RunHolder, name: string, args: Record<string, unknown>, scope: Scope, reviewUrl?: string): Promise<Record<string, unknown>> {
  const gh = liveEndpoint('github', scope.config.github.token, scope.fetcher);
  const lin = liveEndpoint('linear', scope.config.linear.token, scope.fetcher);
  const sl = liveEndpoint('slack', scope.config.slack.token, scope.fetcher);
  const repo = { owner: scope.config.github.owner, repo: scope.config.github.repo };
  switch (name) {
    case 'start_run': {
      const run = await startExternalRun(holder, args, 'mcp', scope);
      return { run: run.id, message: 'Recording started. Every tool call is recorded until finish_run.' };
    }
    case 'github_create_issue': {
      requireRoom(holder);
      const title = text(args.title, 'title', 256);
      const body = text(args.body ?? '', 'body', 8000, { allowEmpty: true, multiline: true });
      const issue = await github.createIssue(gh, repo, title, body);
      recordAction(holder, { tool: 'github.create_issue', issue, title, body });
      return { issue };
    }
    case 'linear_create_issue': {
      requireRoom(holder);
      const title = text(args.title, 'title', 256);
      const assignee = text(args.assignee ?? '', 'assignee', 120, { allowEmpty: true });
      const member = assignee ? (await linear.users(lin)).find(u => u.name === assignee) : undefined;
      if (assignee && !member) throw new RecoveryError('assignee must be a member of the connected Linear workspace.', 422);
      const created = await linear.createIssue(lin, await connectedTeam(scope), title, member?.id as string);
      recordAction(holder, { tool: 'linear.create_issue', issue: created.identifier, title, assignee });
      return { issue: created.identifier };
    }
    case 'linear_update_assignee': {
      requireRoom(holder);
      const issue = linearIdentifier(args.issue);
      const assignee = text(args.assignee ?? '', 'assignee', 120, { allowEmpty: true });
      const found = await linear.readIssue(lin, issue);
      const team = await connectedTeam(scope);
      if (found.teamId !== team) throw new RecoveryError('That issue is outside the connected Linear team.', 403);
      await linear.writeAssignee(lin, { provider: 'linear', issueId: found.id, teamId: team }, assignee);
      recordAction(holder, { tool: 'linear.update_assignee', issue: found.identifier, before: found.assignee, after: assignee });
      return { issue: found.identifier, before: found.assignee, after: assignee };
    }
    case 'slack_post_message': {
      requireRoom(holder);
      const message = text(args.text, 'text', 4000, { multiline: true });
      const ts = await slack.post(sl, scope.config.slack.channelId, escapeSlack(message));
      recordAction(holder, { tool: 'slack.post_message', ts, text: message });
      return { ts };
    }
    case 'finish_run': {
      const result = await finishExternalRun(holder, scope, { reviewUrl });
      return {
        repairable: result.repairable, recorded: result.recorded, flagged: result.flagged, review: result.repairable ? reviewUrl ?? null : null,
        message: result.repairable ? 'Aftercare flagged changes that need repair. A person reviews and approves the repair in Aftercare.' : 'Recorded and checked. This run does not match a repair Aftercare supports yet.',
      };
    }
    case 'discard_run': {
      discardExternalRun(holder);
      return { discarded: true };
    }
    default: throw new RecoveryError(`Unknown tool: ${name.slice(0, 60)}.`, 404);
  }
}

/** Handles one JSON-RPC message. Returns null for notifications, which receive no response. */
export async function handleMcp(holder: RunHolder, message: unknown, scope: Scope | undefined, options: { reviewUrl?: string } = {}): Promise<object | null> {
  const req = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: any };
  const id = typeof req?.id === 'string' || typeof req?.id === 'number' ? req.id : null;
  const failure = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (!req || typeof req !== 'object' || Array.isArray(req) || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return failure(-32600, 'Invalid request.');
  if (req.id === undefined) return null;
  switch (req.method) {
    case 'initialize': {
      const requested = req.params?.protocolVersion;
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'aftercare', version: '0.1.0' },
        instructions: 'Call start_run, then use the app tools, then finish_run. Aftercare records and checks every call, and a person approves any repair.',
      } };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: mcpTools } };
    case 'tools/call': {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return failure(-32602, 'Invalid tool call.');
      try {
        if (!scope) throw new RecoveryError('Connect GitHub, Linear and Slack in Aftercare and choose a repository, team and channel first.', 409);
        const result = await callTool(holder, name, args, scope, options.reviewUrl);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } };
      } catch (error) {
        // Tool failures are results the agent can read; provider detail stays in Aftercare's messages.
        const detail = error instanceof RecoveryError ? error.message : 'The tool call failed.';
        if (!(error instanceof RecoveryError)) console.error(error);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: detail }], isError: true } };
      }
    }
    default: return failure(-32601, 'Method not found.');
  }
}

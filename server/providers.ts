import type { ExternalRef, RecordState } from '../shared/types.js';
import { RecoveryError, type ProviderAdapter } from './recovery.js';

/**
 * Clients for the GitHub REST, Linear GraphQL and Slack Web APIs. Arga twins expose
 * the same interfaces, so one client serves a twin and the real provider; only the
 * endpoint differs.
 */
export interface Endpoint {
  /** Names the target in operator-facing errors, e.g. "GitHub" or "The GitHub twin". */
  name: string;
  base: string;
  token?: string;
  fetch: typeof fetch;
}

/**
 * Twins ignore a missing Authorization header for reads but reject an unrecognised
 * one, so a header is sent only when a token exists.
 */
const authHeader = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

export async function api(e: Endpoint, path: string, init: RequestInit, what: string): Promise<any> {
  let response: Response;
  try {
    response = await e.fetch(`${e.base}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch { throw new RecoveryError(`${e.name} could not be reached while ${what}.`, 502); }
  let text: string;
  // The timeout also covers reading the body, which can stall after the headers arrive.
  try { text = await response.text(); }
  catch { throw new RecoveryError(`${e.name} stopped responding while ${what}.`, 504); }
  let body: any = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error page */ }
  if (!response.ok) {
    // Response bodies can carry provider detail; surface only the status and a GraphQL error code.
    const code = body?.errors?.[0]?.extensions?.code;
    const label = typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code) ? ` (${code})` : '';
    const hint = response.status === 401 || response.status === 403 ? ' Check the token and its permissions.' : '';
    throw new RecoveryError(`${e.name} returned HTTP ${response.status}${label} while ${what}.${hint}`, 502);
  }
  return body;
}

export function need<T>(e: Endpoint, value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new RecoveryError(`${e.name} returned no ${what}.`, 502);
  return value;
}

export const github = {
  headers: (e: Endpoint): Record<string, string> => ({ ...authHeader(e.token), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'aftercare', 'X-GitHub-Api-Version': '2022-11-28' }),
  async createRepo(e: Endpoint, name: string) {
    const repo = await api(e, '/user/repos', { method: 'POST', headers: github.headers(e), body: JSON.stringify({ name, private: false }) }, 'creating the repository');
    return { owner: need(e, repo?.owner?.login, 'repository owner') as string, repo: need(e, repo?.name, 'repository name') as string };
  },
  async checkRepo(e: Endpoint, owner: string, repo: string) {
    await api(e, `/repos/${owner}/${repo}`, { headers: github.headers(e) }, `opening ${owner}/${repo}`);
  },
  async createIssue(e: Endpoint, ref: { owner: string; repo: string }, title: string, body: string) {
    const issue = await api(e, `/repos/${ref.owner}/${ref.repo}/issues`, { method: 'POST', headers: github.headers(e), body: JSON.stringify({ title, body }) }, 'creating the issue');
    return need(e, issue?.number, 'issue number') as number;
  },
  async readState(e: Endpoint, ref: ExternalRef) {
    const issue = await api(e, `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`, { headers: github.headers(e) }, 'reading the issue');
    return String(need(e, issue?.state, 'issue state'));
  },
  async writeState(e: Endpoint, ref: ExternalRef, value: string) {
    await api(e, `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`, { method: 'PATCH', headers: github.headers(e), body: JSON.stringify({ state: value }) }, 'updating the issue');
  },
};

export const linear = {
  async gql(e: Endpoint, query: string, variables: Record<string, unknown>, what: string): Promise<any> {
    // Linear personal keys are sent without a Bearer prefix.
    const body = await api(e, '/graphql', { method: 'POST', headers: { ...(e.token ? { Authorization: e.token } : {}), 'Content-Type': 'application/json' } as Record<string, string>, body: JSON.stringify({ query, variables }) }, what);
    const error = body?.errors?.[0];
    if (error) {
      // Linear's messages explain refusals such as invalid input and carry no credentials.
      const code = typeof error.extensions?.code === 'string' && /^[A-Z_]{3,40}$/.test(error.extensions.code) ? ` (${error.extensions.code})` : '';
      const detail = [error.extensions?.userPresentableMessage, error.message].find((m): m is string => typeof m === 'string' && m.trim() !== '');
      const reason = detail ? `: ${detail.replace(/\s+/g, ' ').trim().slice(0, 200).replace(/\.?$/, '.')}` : '.';
      throw new RecoveryError(`${e.name} rejected the request while ${what}${code}${reason}`, 502);
    }
    return body?.data;
  },
  async users(e: Endpoint): Promise<Array<{ id: string; name: string }>> {
    // Linear lists its AI agent and other apps as users; assigning one delegates the issue to it.
    const data = await linear.gql(e, '{ users(filter: { app: { eq: false } }) { nodes { id name } } }', {}, 'listing users');
    return data?.users?.nodes ?? [];
  },
  async teams(e: Endpoint): Promise<Array<{ id: string; key: string; name: string }>> {
    const data = await linear.gql(e, '{ teams { nodes { id key name } } }', {}, 'listing teams');
    return data?.teams?.nodes ?? [];
  },
  async createTeam(e: Endpoint): Promise<string> {
    const data = await linear.gql(e, 'mutation($i:TeamCreateInput!){ teamCreate(input:$i){ team { id } } }', { i: { name: 'Operations', key: 'OPS' } }, 'creating the team');
    return need(e, data?.teamCreate?.team?.id, 'team id');
  },
  async createIssue(e: Endpoint, teamId: string, title: string, assigneeId: string): Promise<{ id: string; identifier: string }> {
    const data = await linear.gql(e, 'mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue { id identifier } } }', { i: { teamId, title, assigneeId } }, 'creating the issue');
    const issue = need(e, data?.issueCreate?.issue, 'issue');
    return { id: issue.id, identifier: issue.identifier ?? 'OPS-93' };
  },
  async readAssignee(e: Endpoint, ref: ExternalRef): Promise<string> {
    const data = await linear.gql(e, 'query($id:String!){ issue(id:$id){ assignee { name } } }', { id: ref.issueId }, 'reading the issue');
    return String(data?.issue?.assignee?.name ?? '');
  },
  async writeAssignee(e: Endpoint, ref: ExternalRef, name: string): Promise<void> {
    // An empty name clears the assignee.
    const match = name ? (await linear.users(e)).find(u => u.name === name) : undefined;
    if (name && !match) throw new RecoveryError(`${e.name} has no user named ${name}; the approved owner cannot be restored.`, 502);
    await linear.gql(e, 'mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id,input:$i){ success } }', { id: ref.issueId, i: { assigneeId: match?.id ?? null } }, 'updating the issue');
  },
};

/** Slack reads &, < and > as control characters; escaping them keeps app data from becoming mentions or links. */
export function escapeSlack(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Slack Web API. Errors arrive as ok:false inside a 200 response. */
export const slack = {
  /** Slack error codes are short identifiers and safe to show; other response detail is not. */
  check(e: Endpoint, method: string, body: any): any {
    if (body?.ok) return body;
    const code = typeof body?.error === 'string' && /^[a-z_]{2,60}$/.test(body.error) ? body.error : '';
    const needed = code === 'missing_scope' && typeof body?.needed === 'string' && /^[a-z:._,]{1,120}$/.test(body.needed) ? ` (needs ${body.needed})` : '';
    throw new RecoveryError(`${e.name} refused ${method}${code ? `: ${code}${needed}` : ''}.`, 502);
  },
  async call(e: Endpoint, method: string, payload: Record<string, unknown>): Promise<any> {
    const body = await api(e, `/api/${method}`, { method: 'POST', headers: { ...authHeader(e.token), 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) }, `calling ${method}`);
    return slack.check(e, method, body);
  },
  /** Slack accepts JSON bodies only for write methods; read methods take query arguments. */
  async get(e: Endpoint, method: string, args: Record<string, string>): Promise<any> {
    const body = await api(e, `/api/${method}?${new URLSearchParams(args)}`, { headers: authHeader(e.token) }, `calling ${method}`);
    return slack.check(e, method, body);
  },
  async createChannel(e: Endpoint, name: string): Promise<string> {
    const body = await slack.call(e, 'conversations.create', { name });
    return need(e, body?.channel?.id, 'channel id');
  },
  async post(e: Endpoint, channel: string, text: string, threadTs?: string): Promise<string> {
    const body = await slack.call(e, 'chat.postMessage', threadTs ? { channel, text, thread_ts: threadTs } : { channel, text });
    return need(e, body?.ts, 'message timestamp');
  },
  /** The correction is a threaded reply; the original message is never edited. */
  async readCorrection(e: Endpoint, ref: ExternalRef): Promise<string> {
    const body = await slack.get(e, 'conversations.replies', { channel: ref.channelId ?? '', ts: ref.ts ?? '' });
    const replies: Array<{ ts: string; text?: string }> = body?.messages ?? [];
    const correction = replies.find(m => m.ts !== ref.ts && m.text?.startsWith('Correction:'));
    // Slack stores &, < and > escaped; compare against the text that was posted.
    return correction?.text?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') ?? '';
  },
};

/** Finds where a record lives, or throws when it cannot be used safely. */
export type Locate = (record: RecordState) => { ref: ExternalRef; endpoint: Endpoint };

/** Routes each repaired field to its provider. Unmapped fields fall back to the local mirror. */
export function providerAdapter(mode: 'twin' | 'live', locate: Locate): ProviderAdapter {
  return {
    mode,
    async read(record, field) {
      const { ref, endpoint } = locate(record);
      if (ref.provider === 'github' && field === 'state') return github.readState(endpoint, ref);
      if (ref.provider === 'linear' && field === 'assignee') return linear.readAssignee(endpoint, ref);
      if (ref.provider === 'slack' && field === 'correction') return slack.readCorrection(endpoint, ref);
      return record.fields[field] ?? '';
    },
    async write(record, field, value) {
      const { ref, endpoint } = locate(record);
      if (ref.provider === 'github' && field === 'state') return github.writeState(endpoint, ref, value);
      if (ref.provider === 'linear' && field === 'assignee') return linear.writeAssignee(endpoint, ref, value);
      // The correction repeats names from other apps, so it is escaped before Slack can read them as mentions or links.
      if (ref.provider === 'slack' && field === 'correction') { await slack.post(endpoint, ref.channelId!, escapeSlack(value), ref.ts); return; }
      throw new RecoveryError(`No write is defined for ${ref.provider}.${field}.`, 422);
    },
  };
}

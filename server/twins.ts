import { createSign } from 'node:crypto';
import type { ExternalRef, ProviderName, RecordState, TwinBinding, Workspace } from '../shared/types.js';
import { RecoveryError, event, type ProviderAdapter } from './recovery.js';
import { connect, provisionTwin, twinExpired } from './arga.js';

/**
 * Twin tokens are per-provider and optional. Twins ignore a missing Authorization
 * header for reads but reject an unrecognised one, so a header is sent only when a
 * token exists. Writes still require one; the seeder mints the GitHub token itself.
 */
export interface TwinCredentials { github?: string; linear?: string; slack?: string }

/** Written into local configuration by the wizard or minted per run; never committed. */
export function twinCredentials(): TwinCredentials {
  return { github: process.env.ARGA_GITHUB_TOKEN, linear: process.env.ARGA_LINEAR_TOKEN, slack: process.env.ARGA_SLACK_TOKEN };
}
const authHeader = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

type Bindings = Partial<Record<ProviderName, TwinBinding>>;

async function api(url: string, init: RequestInit, what: string, fetcher: typeof fetch): Promise<any> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch { throw new RecoveryError(`The twin could not be reached while ${what}.`, 502); }
  const text = await response.text();
  let body: any = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error page */ }
  // Response bodies can carry provider detail; surface only status to the operator.
  if (!response.ok) throw new RecoveryError(`The twin returned HTTP ${response.status} while ${what}.`, 502);
  return body;
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new RecoveryError(`The twin returned no ${what}.`, 502);
  return value;
}

/* GitHub twin — GitHub-compatible REST. */
const github = {
  headers: (token?: string): Record<string, string> => ({ ...authHeader(token), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }),
  async createRepo(base: string, token: string | undefined, name: string, f: typeof fetch) {
    const repo = await api(`${base}/user/repos`, { method: 'POST', headers: github.headers(token), body: JSON.stringify({ name, private: false }) }, 'creating the repository', f);
    return { owner: need(repo?.owner?.login, 'repository owner'), repo: need(repo?.name, 'repository name') as string };
  },
  async createIssue(base: string, token: string | undefined, ref: { owner: string; repo: string }, title: string, body: string, f: typeof fetch) {
    const issue = await api(`${base}/repos/${ref.owner}/${ref.repo}/issues`, { method: 'POST', headers: github.headers(token), body: JSON.stringify({ title, body }) }, 'creating the issue', f);
    return need(issue?.number, 'issue number') as number;
  },
  async readState(base: string, token: string | undefined, ref: ExternalRef, f: typeof fetch) {
    const issue = await api(`${base}/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`, { headers: github.headers(token) }, 'reading the issue', f);
    return String(need(issue?.state, 'issue state'));
  },
  async writeState(base: string, token: string | undefined, ref: ExternalRef, value: string, f: typeof fetch) {
    await api(`${base}/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`, { method: 'PATCH', headers: github.headers(token), body: JSON.stringify({ state: value }) }, 'updating the issue', f);
  },
};

/** Twin error pages state the cause in list items; surface it instead of a bare status. */
async function reason(response: Response) {
  const raw = await response.text().catch(() => '');
  const text = raw.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ');
  const items = [...text.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean);
  if (items.length) return items.join('; ');
  const body = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return body.slice(0, 200) || 'no detail given';
}

/** App JWTs are short-lived and used only to exchange for an installation token. */
function appJwt(appId: string, pem: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issued = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issued - 60, exp: issued + 540, iss: appId })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).end().sign(pem).toString('base64url')}`;
}

/**
 * Twins ship with no usable credential: they ignore a missing Authorization header
 * on reads but reject an unrecognised token, and writes require one. Rather than
 * depend on a secret in local configuration, each run mints its own token through
 * the GitHub App manifest handshake the twin implements.
 */
export async function mintGithubToken(base: string, f: typeof fetch = fetch): Promise<string> {
  const manifest = {
    name: `aftercare-${Date.now().toString(36)}`,
    url: 'https://aftercare.local',
    redirect_url: 'https://aftercare.local/callback',
    hook_attributes: { url: 'https://aftercare.local/hook', active: false },
    public: false,
    default_permissions: { issues: 'write', metadata: 'read' },
    default_events: [],
  };
  // Registration answers with a redirect carrying a single-use exchange code.
  let registered: Response;
  try {
    registered = await f(`${base}/settings/apps/new`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ manifest: JSON.stringify(manifest) }),
    });
  } catch { throw new RecoveryError('The GitHub twin could not be reached while registering an app.', 502); }
  const location = registered.headers.get('location');
  if (!location) throw new RecoveryError(`The GitHub twin refused the app manifest (HTTP ${registered.status}).`, 502);
  const code = new URL(location, base).searchParams.get('code');
  if (!code) throw new RecoveryError('The GitHub twin returned no app registration code.', 502);

  const app = await api(`${base}/app-manifests/${code}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json' } }, 'converting the app manifest', f);
  const jwt = appJwt(String(need(app?.id, 'app id')), String(need(app?.pem, 'app private key')));
  const asApp = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

  let installations = await api(`${base}/app/installations`, { headers: asApp }, 'listing app installations', f);
  if (!Array.isArray(installations) || !installations.length) {
    // A freshly registered app has no installation. The control-plane route is not
    // exposed on the public host, so install through the twin's own UI route.
    const slug = need(app?.slug, 'app slug');
    const installed = await f(`${base}/_ui/apps/${slug}/install`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ app_id: String(app.id) }) });
    if (installed.status >= 400) throw new RecoveryError(`The GitHub twin refused to install the app (HTTP ${installed.status}): ${await reason(installed)}`, 502);
    installations = await api(`${base}/app/installations`, { headers: asApp }, 'listing app installations', f);
  }
  const installationId = need(Array.isArray(installations) ? installations[0]?.id : undefined, 'app installation');
  const minted = await api(`${base}/app/installations/${installationId}/access_tokens`, { method: 'POST', headers: asApp }, 'minting an installation token', f);
  return String(need(minted?.token, 'installation token'));
}

/* Linear twin — GraphQL. Personal keys are sent without a Bearer prefix. */
const linear = {
  async gql(base: string, token: string | undefined, query: string, variables: Record<string, unknown>, what: string, f: typeof fetch) {
    // Linear personal keys are sent without a Bearer prefix.
    const body = await api(`${base}/graphql`, { method: 'POST', headers: { ...(token ? { Authorization: token } : {}), 'Content-Type': 'application/json' } as Record<string, string>, body: JSON.stringify({ query, variables }) }, what, f);
    if (body?.errors?.length) throw new RecoveryError(`The Linear twin rejected the request while ${what}.`, 502);
    return body?.data;
  },
  async users(base: string, token: string | undefined, f: typeof fetch): Promise<Array<{ id: string; name: string }>> {
    const data = await linear.gql(base, token, '{ users { nodes { id name } } }', {}, 'listing users', f);
    return data?.users?.nodes ?? [];
  },
  async createTeam(base: string, token: string | undefined, f: typeof fetch) {
    const data = await linear.gql(base, token, 'mutation($i:TeamCreateInput!){ teamCreate(input:$i){ team { id } } }', { i: { name: 'Operations', key: 'OPS' } }, 'creating the team', f);
    return need(data?.teamCreate?.team?.id, 'team id') as string;
  },
  async createIssue(base: string, token: string | undefined, teamId: string, title: string, assigneeId: string | undefined, f: typeof fetch) {
    const data = await linear.gql(base, token, 'mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue { id identifier } } }', { i: { teamId, title, assigneeId } }, 'creating the issue', f);
    const issue = need(data?.issueCreate?.issue, 'issue');
    return { id: issue.id as string, identifier: (issue.identifier ?? 'OPS-93') as string };
  },
  async readAssignee(base: string, token: string | undefined, ref: ExternalRef, f: typeof fetch) {
    const data = await linear.gql(base, token, 'query($id:String!){ issue(id:$id){ assignee { name } } }', { id: ref.issueId }, 'reading the issue', f);
    return String(data?.issue?.assignee?.name ?? '');
  },
  async writeAssignee(base: string, token: string | undefined, ref: ExternalRef, name: string, f: typeof fetch) {
    const match = (await linear.users(base, token, f)).find(u => u.name === name);
    if (!match) throw new RecoveryError(`The Linear twin has no user named ${name}; the approved owner cannot be restored.`, 502);
    await linear.gql(base, token, 'mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id,input:$i){ success } }', { id: ref.issueId, i: { assigneeId: match.id } }, 'updating the issue', f);
  },
};

/* Slack twin — Web API. Errors arrive as ok:false inside a 200 response. */
const slack = {
  async call(base: string, token: string | undefined, method: string, payload: Record<string, unknown>, f: typeof fetch) {
    const body = await api(`${base}/api/${method}`, { method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json; charset=utf-8' } as Record<string, string>, body: JSON.stringify(payload) }, `calling ${method}`, f);
    if (!body?.ok) throw new RecoveryError(`The Slack twin refused ${method}.`, 502);
    return body;
  },
  async createChannel(base: string, token: string | undefined, name: string, f: typeof fetch) {
    const body = await slack.call(base, token, 'conversations.create', { name }, f);
    return need(body?.channel?.id, 'channel id') as string;
  },
  async post(base: string, token: string | undefined, channel: string, text: string, threadTs: string | undefined, f: typeof fetch) {
    const body = await slack.call(base, token, 'chat.postMessage', threadTs ? { channel, text, thread_ts: threadTs } : { channel, text }, f);
    return need(body?.ts, 'message timestamp') as string;
  },
  /** The correction is a threaded reply; the original message is never edited. */
  async readCorrection(base: string, token: string | undefined, ref: ExternalRef, f: typeof fetch) {
    const body = await slack.call(base, token, 'conversations.replies', { channel: ref.channelId, ts: ref.ts }, f);
    const replies: Array<{ ts: string; text?: string }> = body?.messages ?? [];
    const correction = replies.find(m => m.ts !== ref.ts && m.text?.startsWith('Correction:'));
    return correction?.text ?? '';
  },
};

/** Routes each record to its provider twin. Unmapped fields fall back to the local mirror. */
export function twinAdapter(bindings: Bindings, credentials: TwinCredentials, fetcher: typeof fetch = fetch): ProviderAdapter {
  const target = (record: RecordState) => {
    const ref = record.external;
    if (!ref) throw new RecoveryError(`${record.label} is not bound to a twin. Provision twins before running a repair.`, 409);
    const binding = bindings[ref.provider];
    if (!binding || binding.status !== 'ready') throw new RecoveryError(`The ${ref.provider} twin is not ready.`, 409);
    if (twinExpired(binding)) throw new RecoveryError(`The ${ref.provider} twin expired. Provision twins again before repairing.`, 409);
    return { ref, base: binding.baseUrl, token: credentials[ref.provider] };
  };
  return {
    mode: 'twin',
    async read(record, field) {
      const { ref, base, token } = target(record);
      if (ref.provider === 'github' && field === 'state') return github.readState(base, token, ref, fetcher);
      if (ref.provider === 'linear' && field === 'assignee') return linear.readAssignee(base, token, ref, fetcher);
      if (ref.provider === 'slack' && field === 'correction') return slack.readCorrection(base, token, ref, fetcher);
      return record.fields[field] ?? '';
    },
    async write(record, field, value) {
      const { ref, base, token } = target(record);
      if (ref.provider === 'github' && field === 'state') return github.writeState(base, token, ref, value, fetcher);
      if (ref.provider === 'linear' && field === 'assignee') return linear.writeAssignee(base, token, ref, value, fetcher);
      if (ref.provider === 'slack' && field === 'correction') { await slack.post(base, token, ref.channelId!, value, ref.ts, fetcher); return; }
      throw new RecoveryError(`No twin write is defined for ${ref.provider}.${field}.`, 422);
    },
  };
}

/**
 * Recreates the failed onboarding run inside the twins and rebinds the workspace
 * records to what was actually created. Twins start empty, so the incident this
 * app repairs has to exist there first.
 */
export async function seedTwins(w: Workspace, bindings: Bindings, credentials: TwinCredentials, fetcher: typeof fetch = fetch) {
  const ready = (provider: ProviderName) => {
    const binding = bindings[provider];
    if (!binding || binding.status !== 'ready') throw new RecoveryError(`The ${provider} twin is not ready to seed.`, 409);
    return binding.baseUrl;
  };
  const [gh, lin, sl] = w.records;

  const ghBase = ready('github');
  const repo = await github.createRepo(ghBase, credentials.github, 'onboarding', fetcher);
  const canonical = await github.createIssue(ghBase, credentials.github, repo, 'Provision Acme workspace', 'Canonical onboarding task for Acme.', fetcher);
  const duplicate = await github.createIssue(ghBase, credentials.github, repo, 'Provision Acme workspace', `Duplicate created by onboarding-agent. Canonical: #${canonical}.`, fetcher);
  gh.external = { provider: 'github', ...repo, issueNumber: duplicate };
  gh.label = `#${duplicate}`;
  gh.fields = { ...gh.fields, state: 'open', canonicalIssue: `#${canonical}` };

  const linBase = ready('linear');
  const people = await linear.users(linBase, credentials.linear, fetcher);
  // Twins start with whatever users the build seeds; bind the scenario to real ones.
  const original = people[0], agentChoice = people[1] ?? people[0];
  if (!original) throw new RecoveryError('The Linear twin exposes no users to assign.', 502);
  const teamId = await linear.createTeam(linBase, credentials.linear, fetcher);
  const created = await linear.createIssue(linBase, credentials.linear, teamId, 'Acme onboarding handoff', original.id, fetcher);
  lin.external = { provider: 'linear', issueId: created.id, teamId };
  lin.label = created.identifier;
  // The agent's mistaken reassignment is the state the repair has to undo.
  await linear.writeAssignee(linBase, credentials.linear, lin.external, agentChoice.name, fetcher);
  lin.fields = { ...lin.fields, assignee: agentChoice.name };

  const slBase = ready('slack');
  const channelId = await slack.createChannel(slBase, credentials.slack, 'customer-onboarding', fetcher);
  const message = `Acme is ready. Workspace provisioned and handoff assigned to ${agentChoice.name}.`;
  const ts = await slack.post(slBase, credentials.slack, channelId, message, undefined, fetcher);
  sl.external = { provider: 'slack', channelId, ts };
  sl.fields = { ...sl.fields, message, correction: '' };

  // The journal must describe what the agent actually did in the twins.
  const journal = (recordId: string, description: string, before: Record<string, string>, after: Record<string, string>) => {
    const action = w.sourceActions.find(a => a.recordId === recordId);
    if (action) { action.description = description; action.before = before; action.after = after; action.at = new Date().toISOString(); }
  };
  journal(gh.id, `Created issue #${duplicate} for the task already tracked by #${canonical}.`, { canonicalIssue: `#${canonical}` }, { ...gh.fields });
  journal(lin.id, `Changed the handoff owner from ${original.name} to ${agentChoice.name}.`, { assignee: original.name }, { ...lin.fields });
  journal(sl.id, 'Reported completion before the onboarding task was verified.', { correction: '' }, { ...sl.fields });

  for (const record of w.records) { record.revision = 1; record.lastActor = 'agent'; }
  w.mode = 'twin';
  w.twins = Object.values(bindings).filter(Boolean) as TwinBinding[];
  event(w, 'Twins seeded', `The failed run was recreated in ${w.twins.length} Arga twins. Repairs will write to their real APIs.`, 'success');
}

/** Provisions one run per provider, then seeds the incident into them. */
export async function provisionAndSeed(w: Workspace, ttlMinutes: number, credentials: TwinCredentials, config: Parameters<typeof connect>[0], fetcher: typeof fetch = fetch) {
  const session = await connect(config, fetcher);
  const bindings: Bindings = {};
  for (const provider of ['github', 'linear', 'slack'] as const) {
    bindings[provider] = await provisionTwin(session, provider, ttlMinutes);
    event(w, `${provider} twin provisioned`, `Run ${bindings[provider]!.runId} expires ${bindings[provider]!.expiresAt ?? 'unknown'}.`);
  }
  const failed = Object.values(bindings).filter(b => b.status !== 'ready');
  if (failed.length) throw new RecoveryError(`${failed.length} twin(s) failed to provision.`, 502);
  const minted: TwinCredentials = { ...credentials };
  if (!minted.github) {
    minted.github = await mintGithubToken(bindings.github!.baseUrl, fetcher);
    event(w, 'GitHub twin credential minted', 'Registered an app in the twin and exchanged it for a scoped installation token.');
  }
  w.twinTokens = { ...minted };
  await seedTwins(w, bindings, minted, fetcher);
  return bindings;
}

import type { ProviderName } from '../shared/types.js';
import { RecoveryError } from './recovery.js';
import { api, github, linear, slack } from './providers.js';
import { liveEndpoint, type LiveConfig } from './live.js';

/**
 * A visitor's connection to one app. Tokens stay in server memory for the session;
 * they are never returned to the browser or written to disk.
 */
export interface Connection {
  token: string;
  account: string;
  source: 'env' | 'token';
  resource?: Resource;
}
export interface Resource { id: string; label: string }
export type Connections = Partial<Record<ProviderName, Connection>>;

export const providerNames = ['github', 'linear', 'slack'] as const;
const nouns = { github: 'repository', linear: 'team', slack: 'channel' } as const;

export function isProvider(value: unknown): value is ProviderName {
  return typeof value === 'string' && (providerNames as readonly string[]).includes(value);
}

/** Confirms a pasted token works and names the account it belongs to. */
export async function identify(provider: ProviderName, raw: unknown, fetcher: typeof fetch = fetch): Promise<Connection> {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token || token.length > 400 || /\s/.test(token)) throw new RecoveryError('Paste the token exactly as the app shows it.', 422);
  // A user token would post as the person who created it, not as the app.
  if (provider === 'slack' && !token.startsWith('xoxb-')) throw new RecoveryError('Use the Slack bot token, which starts with xoxb-.', 422);
  const e = liveEndpoint(provider, token, fetcher);
  let account: string;
  if (provider === 'github') {
    const user = await api(e, '/user', { headers: github.headers(e) }, 'checking the token');
    account = String(user?.login ?? 'GitHub account');
  } else if (provider === 'linear') {
    const data = await linear.gql(e, '{ viewer { name organization { name } } }', {}, 'checking the key');
    account = [data?.viewer?.organization?.name, data?.viewer?.name].filter(Boolean).join(' · ') || 'Linear workspace';
  } else {
    const body = await slack.get(e, 'auth.test', {});
    account = String(body?.team ?? 'Slack workspace');
  }
  return { token, account, source: 'token' };
}

/** Lists what this connection can be used on; selections are always checked against it. */
export async function listResources(provider: ProviderName, connection: Connection, fetcher: typeof fetch = fetch): Promise<Resource[]> {
  const e = liveEndpoint(provider, connection.token, fetcher);
  if (provider === 'github') {
    const repos = await api(e, '/user/repos?per_page=100&sort=updated', { headers: github.headers(e) }, 'listing repositories');
    return (Array.isArray(repos) ? repos : [])
      .filter(r => r?.has_issues && typeof r.full_name === 'string')
      .map(r => ({ id: r.full_name as string, label: r.full_name as string }));
  }
  if (provider === 'linear') return (await linear.teams(e)).map(t => ({ id: t.key, label: `${t.name} (${t.key})` }));
  const body = await slack.get(e, 'conversations.list', { types: 'public_channel', exclude_archived: 'true', limit: '200' });
  return (Array.isArray(body?.channels) ? body.channels : [])
    .filter((c: any) => typeof c?.id === 'string' && typeof c?.name === 'string')
    .map((c: any) => ({ id: c.id as string, label: `#${c.name}` }));
}

export async function selectResource(provider: ProviderName, connection: Connection, id: unknown, fetcher: typeof fetch = fetch): Promise<Resource> {
  const resource = (await listResources(provider, connection, fetcher)).find(r => r.id === id);
  if (!resource) throw new RecoveryError(`That ${nouns[provider]} is not available to this connection.`, 422);
  // The bot must be in the channel to post the correction and read its thread.
  if (provider === 'slack') await slack.call(liveEndpoint('slack', connection.token, fetcher), 'conversations.join', { channel: resource.id });
  return resource;
}

/** Live mode needs a connected account and a chosen resource in every app. */
export function liveConfigFor(c: Connections): LiveConfig | undefined {
  if (!c.github?.resource || !c.linear?.resource || !c.slack?.resource) return undefined;
  const [owner, repo] = c.github.resource.id.split('/');
  return {
    github: { token: c.github.token, owner, repo },
    linear: { token: c.linear.token, teamKey: c.linear.resource.id },
    slack: { token: c.slack.token, channelId: c.slack.resource.id },
  };
}

export function connectionsFromEnv(config: LiveConfig): Connections {
  const { owner, repo } = config.github;
  return {
    github: { token: config.github.token, account: 'from .env', source: 'env', resource: { id: `${owner}/${repo}`, label: `${owner}/${repo}` } },
    linear: { token: config.linear.token, account: 'from .env', source: 'env', resource: { id: config.linear.teamKey, label: config.linear.teamKey } },
    slack: { token: config.slack.token, account: 'from .env', source: 'env', resource: { id: config.slack.channelId, label: config.slack.channelId } },
  };
}

/** What the browser may see: never the token. */
export function connectionView(c: Connections) {
  return Object.fromEntries(providerNames.map(p => {
    const connection = c[p];
    return [p, connection ? { connected: true, account: connection.account, source: connection.source, resource: connection.resource ?? null } : { connected: false }];
  }));
}

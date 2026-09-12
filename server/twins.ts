import { createSign } from 'node:crypto';
import type { ProviderName, TwinBinding, Workspace } from '../shared/types.js';
import { RecoveryError, event, type ProviderAdapter } from './recovery.js';
import { connect, provisionTwin, twinExpired } from './arga.js';
import { api, github, linear, need, providerAdapter, seedIncident, slack, type Endpoint } from './providers.js';

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

type Bindings = Partial<Record<ProviderName, TwinBinding>>;

const labels = { github: 'GitHub', linear: 'Linear', slack: 'Slack' } as const;
const twinEndpoint = (provider: ProviderName, base: string, token: string | undefined, fetcher: typeof fetch): Endpoint =>
  ({ name: `The ${labels[provider]} twin`, base, token, fetch: fetcher });

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
  const e = twinEndpoint('github', base, undefined, f);
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

  const app = await api(e, `/app-manifests/${code}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json' } }, 'converting the app manifest');
  const jwt = appJwt(String(need(e, app?.id, 'app id')), String(need(e, app?.pem, 'app private key')));
  const asApp = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

  let installations = await api(e, '/app/installations', { headers: asApp }, 'listing app installations');
  if (!Array.isArray(installations) || !installations.length) {
    // A freshly registered app has no installation. The control-plane route is not
    // exposed on the public host, so install through the twin's own UI route.
    const slug = need(e, app?.slug, 'app slug');
    const installed = await f(`${base}/_ui/apps/${slug}/install`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ app_id: String(app.id) }) });
    if (installed.status >= 400) throw new RecoveryError(`The GitHub twin refused to install the app (HTTP ${installed.status}): ${await reason(installed)}`, 502);
    installations = await api(e, '/app/installations', { headers: asApp }, 'listing app installations');
  }
  const installationId = need(e, Array.isArray(installations) ? installations[0]?.id : undefined, 'app installation');
  const minted = await api(e, `/app/installations/${installationId}/access_tokens`, { method: 'POST', headers: asApp }, 'minting an installation token');
  return String(need(e, minted?.token, 'installation token'));
}

/** Routes each record to its provider twin. An unready or expired twin refuses instead of falling back. */
export function twinAdapter(bindings: Bindings, credentials: TwinCredentials, fetcher: typeof fetch = fetch): ProviderAdapter {
  return providerAdapter('twin', record => {
    const ref = record.external;
    if (!ref) throw new RecoveryError(`${record.label} is not bound to a twin. Provision twins before running a repair.`, 409);
    const binding = bindings[ref.provider];
    if (!binding || binding.status !== 'ready') throw new RecoveryError(`The ${ref.provider} twin is not ready.`, 409);
    if (twinExpired(binding)) throw new RecoveryError(`The ${ref.provider} twin expired. Provision twins again before repairing.`, 409);
    return { ref, endpoint: twinEndpoint(ref.provider, binding.baseUrl, credentials[ref.provider], fetcher) };
  });
}

/**
 * Twins start empty, so the repository, team and channel the incident needs are
 * created first, then the failed run is recreated inside them.
 */
export async function seedTwins(w: Workspace, bindings: Bindings, credentials: TwinCredentials, fetcher: typeof fetch = fetch) {
  const ready = (provider: ProviderName) => {
    const binding = bindings[provider];
    if (!binding || binding.status !== 'ready') throw new RecoveryError(`The ${provider} twin is not ready to seed.`, 409);
    return twinEndpoint(provider, binding.baseUrl, credentials[provider], fetcher);
  };
  const gh = ready('github'), lin = ready('linear'), sl = ready('slack');
  const repo = await github.createRepo(gh, 'onboarding');
  const teamId = await linear.createTeam(lin);
  const channelId = await slack.createChannel(sl, 'customer-onboarding');
  await seedIncident(w, { github: { endpoint: gh, ...repo }, linear: { endpoint: lin, teamId }, slack: { endpoint: sl, channelId } });
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

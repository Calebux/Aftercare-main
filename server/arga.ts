import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { ProviderName, TwinBinding } from '../shared/types.js';
import { RecoveryError } from './recovery.js';

/**
 * Minimal MCP client for Arga's streamable-HTTP transport. Arga exposes twin
 * provisioning only over MCP, so the server speaks JSON-RPC to it directly
 * rather than depending on an MCP host being present.
 */
export interface ArgaConfig { url: string; authorization: string }

/** Credentials live in local configuration, never in this repository. */
export function argaConfig(): ArgaConfig | undefined {
  const url = process.env.ARGA_MCP_URL;
  const authorization = process.env.ARGA_MCP_AUTHORIZATION;
  if (url && authorization) return { url, authorization };
  // Fall back to the Codex MCP entry the operator has already authenticated.
  try {
    const raw = readFileSync(resolve(homedir(), '.codex/config.toml'), 'utf8');
    const block = raw.split(/^\[mcp_servers\.arga-context\]$/m)[1];
    if (!block) return undefined;
    const head = block.split(/^\[/m)[0];
    const found = head.match(/url\s*=\s*"([^"]+)"/);
    const auth = head.match(/Authorization\s*=\s*"([^"]+)"/);
    if (found && auth) return { url: found[1], authorization: auth[1] };
  } catch { /* no local Codex configuration; twin mode stays unavailable */ }
  return undefined;
}

class ArgaSession {
  private headers: Record<string, string>;
  private id = 0;
  constructor(private config: ArgaConfig, private fetcher: typeof fetch = fetch) {
    this.headers = { Authorization: config.authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  }
  private async rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    if (!notify) body.id = ++this.id;
    const response = await this.fetcher(this.config.url, { method: 'POST', headers: this.headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60_000) });
    const session = response.headers.get('Mcp-Session-Id');
    if (session) this.headers['Mcp-Session-Id'] = session;
    if (!response.ok) throw new RecoveryError(`Arga returned HTTP ${response.status}. Check the local MCP credential.`, 502);
    if (notify || response.status === 202) return {};
    const text = await response.text();
    if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const parsed = JSON.parse(line.slice(5));
        if (parsed.id === this.id) return parsed;
      }
      throw new RecoveryError('Arga returned no response for the request.', 502);
    }
    return JSON.parse(text);
  }
  async connect() {
    const result = await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aftercare', version: '0.1.0' } });
    this.headers['MCP-Protocol-Version'] = result.result.protocolVersion;
    await this.rpc('notifications/initialized', undefined, true);
    return this;
  }
  /** Arga returns tool output as JSON text blocks, including for errors. */
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const response = await this.rpc('tools/call', { name, arguments: args });
    if (response.error) throw new RecoveryError(`Arga rejected ${name}: ${response.error.message}`, 502);
    const blocks: unknown[] = [];
    for (const block of response.result?.content ?? []) {
      if (block.type !== 'text') continue;
      try { blocks.push(JSON.parse(block.text)); } catch { blocks.push(block.text); }
    }
    const first = blocks[0];
    // A plan or quota refusal arrives as a plain sentence rather than an error result.
    if (typeof first === 'string' && first.startsWith('Error:')) throw new RecoveryError(`Arga: ${first.slice(6).trim()}`, 402);
    if (response.result?.isError) {
      const detail = blocks.map(b => (typeof b === 'string' ? b : JSON.stringify(b))).join(' ').slice(0, 300);
      throw new RecoveryError(`Arga rejected ${name}${detail ? `: ${detail}` : '.'}`, 502);
    }
    return first;
  }
}

export async function connect(config: ArgaConfig, fetcher?: typeof fetch) {
  return new ArgaSession(config, fetcher).connect();
}

interface TwinRun { run_id: string; status: string; twins: Record<string, { base_url: string }>; expires_at: string | null; error: string | null }

/**
 * Provisions one twin per run. The free plan allows a single twin per run, so
 * each provider gets its own short-lived run and its own expiry.
 */
export async function provisionTwin(session: Awaited<ReturnType<typeof connect>>, provider: ProviderName, ttlMinutes: number): Promise<TwinBinding> {
  const created = await session.call('create_twin_run', { twins: provider, ttl_minutes: ttlMinutes });
  const runId: string | undefined = created?.run_id;
  if (!runId) throw new RecoveryError(`Arga did not return a run for the ${provider} twin.`, 502);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const run: TwinRun = await session.call('get_twin_run', { run_id: runId });
    if (run.status === 'ready') {
      const base = run.twins?.[provider]?.base_url;
      if (!base) throw new RecoveryError(`The ${provider} twin is ready but exposed no base URL.`, 502);
      return { provider, runId, baseUrl: base.replace(/\/$/, ''), status: 'ready', expiresAt: run.expires_at };
    }
    if (run.status === 'error' || run.error) return { provider, runId, baseUrl: '', status: 'error', expiresAt: run.expires_at, error: run.error ?? 'provisioning failed' };
    await new Promise(r => setTimeout(r, 3_000));
  }
  throw new RecoveryError(`The ${provider} twin did not become ready within the provisioning budget.`, 504);
}

export async function teardownTwin(session: Awaited<ReturnType<typeof connect>>, runId: string) {
  await session.call('teardown_twins', { run_id: runId }).catch(() => undefined);
}

export function twinExpired(binding: TwinBinding) {
  return binding.expiresAt !== null && Date.parse(binding.expiresAt) <= Date.now();
}

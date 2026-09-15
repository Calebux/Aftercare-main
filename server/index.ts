import express, { type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedWorkspace, assertCanPrepare, acceptInvestigation, prepareCurrent, approveCurrent, refreshRecords, execute, humanEdit, RecoveryError, snapshot, event, localAdapter } from './recovery.js';
import { provisionAndSeed, twinAdapter, twinCredentials } from './twins.js';
import { argaConfig } from './arga.js';
import { investigate } from './investigator.js';
import { connectLive, liveAdapter, readLiveConfig } from './live.js';
import { connectionView, connectionsFromEnv, identify, isProvider, listResources, liveConfigFor, selectResource } from './connections.js';
import { createSessions, type Slot } from './sessions.js';
import { convexStore } from './store.js';
import { evidenceScenario } from './scenarios.js';
import { evidenceScenarios, type EvidenceScenario } from '../shared/scenarios.js';
import { recordLink } from './links.js';
import { discardExternalRun, finishExternalRun, recordAction, startExternalRun, throttle, type Scope } from './external.js';
import { handleMcp } from './mcp.js';
import type { Workspace } from '../shared/types.js';
import { businessRoutes } from './business-routes.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const app = express();
const port = Number(process.env.PORT || 4310);
const scenarioOnly = process.env.AFTERCARE_SCENARIO_ONLY === '1';
// On Render, the service's own public address is used when no address is configured.
const publicUrl = (process.env.AFTERCARE_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL)?.replace(/\/$/, '');
// A public URL means visitors besides the operator: separate workspaces, and only their own apps.
const hosted = Boolean(publicUrl);
if (hosted && process.env.NODE_ENV !== 'production') {
  // The development server includes Vite's dev middleware, which must never be publicly reachable.
  console.error('AFTERCARE_PUBLIC_URL requires the production build: run npm run build, then npm start.');
  process.exit(1);
}
// On a hosted instance every visitor's investigation would spend the operator's model key.
const modelEnabled = Boolean(process.env.OPENROUTER_API_KEY) && !scenarioOnly && (!hosted || process.env.AFTERCARE_HOSTED_AI === '1');
// Scenario-only runs, including tests, never reach real apps whatever .env contains.
const connectionsEnabled = !scenarioOnly;
const operatorLive = connectionsEnabled && !hosted ? readLiveConfig().config : undefined;
// Visitors to a hosted instance must not spend the operator's Arga runs.
const arga = hosted ? undefined : argaConfig();
const credentials = twinCredentials();
// Links in alerts and agent responses use the configured address, never the request, and carry no session.
const reviewUrl = `${publicUrl ?? `http://127.0.0.1:${port}`}/recoveries`;
const twinTtl = Number(process.env.ARGA_TWIN_TTL_MINUTES || 10);
const sessions = await createSessions({
  dir: resolve(process.env.AFTERCARE_DATA_DIR || '.data'),
  // Convex keeps workspaces on hosts whose disk is erased by restarts, such as Render's free plan.
  store: process.env.CONVEX_URL ? convexStore(process.env.CONVEX_URL, process.env.AFTERCARE_CONVEX_TOKEN, process.env.AFTERCARE_STORE_KEY) : undefined,
  hosted,
  secureCookie: Boolean(publicUrl?.startsWith('https://')),
  operatorConnections: operatorLive ? connectionsFromEnv(operatorLive) : {},
});

// Only requests addressed to this server by name are served, which defeats DNS rebinding.
const allowedHosts = new Set([
  ...(publicUrl ? [new URL(publicUrl).host] : [`127.0.0.1:${port}`, `localhost:${port}`]),
  ...(process.env.AFTERCARE_ALLOWED_HOSTS ?? '').split(','),
].map(h => h.trim().toLowerCase()).filter(Boolean));
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!allowedHosts.has((req.get('host') ?? '').toLowerCase())) { res.status(421).type('text/plain').send('This server does not answer for that host name.'); return; }
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    const origin = req.get('origin');
    const expected = publicUrl ? new URL(publicUrl).origin : `http://${req.get('host')}`;
    if (origin && origin !== expected) { res.status(403).json({ error: 'Cross-origin writes are not allowed.' }); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: 'JSON is required.' }); return; }
  }
  next();
});
/** Twin tokens are server-side credentials and never leave this process. */
function publicView(w: Workspace) { const { twinTokens, ...rest } = w; return rest; }
function fail(res: Response, error: unknown, slot?: Slot) {
  if (error instanceof RecoveryError) res.status(error.status).json({ error: error.message, ...(slot ? { workspace: publicView(slot.workspace) } : {}) });
  else { console.error(error); res.status(500).json({ error: 'The operation failed. Inspect the server logs.', ...(slot ? { workspace: publicView(slot.workspace) } : {}) }); }
}
/** Resolves the visitor's slot and reports any failure, including a full session table. */
async function withSlot(req: Request, res: Response, run: (slot: Slot) => unknown) {
  let slot: Slot | undefined;
  try { slot = sessions.resolve(req, res); await run(slot); }
  catch (error) { if (req.method !== 'GET') await slot?.persist().catch(() => {}); fail(res, error, slot); }
}
/** Remote bindings must stay usable; twin and live recoveries never fall back to local writes. */
function adapterFor(slot: Slot) {
  const w = slot.workspace;
  if (w.mode === 'local') return localAdapter;
  if (w.mode === 'live') {
    const config = liveConfigFor(slot.connections);
    if (!config) throw new RecoveryError('This recovery is linked to your apps, but they are not connected. Reconnect GitHub, Linear and Slack, or reset the scenario.', 409);
    return liveAdapter(config);
  }
  const bindings = Object.fromEntries((w.twins ?? []).map(b => [b.provider, b]));
  // Tokens minted during provisioning take precedence over any configured statically.
  return twinAdapter(bindings, { ...credentials, ...(w.twinTokens ?? {}) });
}
/** Mutations share a per-visitor gate so in-flight provider writes keep their workspace and journal. */
function claim(slot: Slot, action: string) {
  if (slot.activeAction) throw new RecoveryError(`Wait for ${slot.activeAction} to finish before changing the workspace.`);
  slot.activeAction = action;
}

/**
 * Agent routes authenticate with a workspace's agent key only. Cookies are ignored, so a page
 * elsewhere cannot drive them through a visitor's browser session.
 */
function agentSlot(req: Request): Slot {
  const header = req.get('authorization') ?? '';
  const slot = sessions.findByAgentKey(header.startsWith('Bearer ') ? header.slice(7).trim() : undefined);
  if (!slot) throw new RecoveryError('A valid agent key is required in the Authorization header.', 401);
  throttle(slot);
  return slot;
}
function agentScope(slot: Slot): Scope {
  const config = liveConfigFor(slot.connections);
  if (!config) throw new RecoveryError('Connect GitHub, Linear and Slack in Aftercare and choose a repository, team and channel first.', 409);
  return { config, fetcher: fetch };
}
/** Agents receive only the error message, never the workspace. */
function failAgent(res: Response, error: unknown) {
  if (error instanceof RecoveryError) {
    if (error.status === 401) res.set('WWW-Authenticate', 'Bearer');
    res.status(error.status).json({ error: error.message });
  } else { console.error(error); res.status(500).json({ error: 'The agent request failed.' }); }
}
async function withAgent(req: Request, res: Response, run: (slot: Slot) => Promise<unknown>) {
  try {
    const slot = agentSlot(req);
    claim(slot, 'an agent request');
    try { res.json(await run(slot)); } finally { slot.activeAction = undefined; }
  } catch (error) { failAgent(res, error); }
}

app.get('/api/workspace', (req, res) => withSlot(req, res, slot => res.json(publicView(slot.workspace))));
app.use('/api/business', businessRoutes({ resolve: sessions.resolve, liveEnabled: connectionsEnabled, managedKey: modelEnabled ? process.env.OPENROUTER_API_KEY : undefined, managedModel: process.env.OPENROUTER_MODEL }));
app.get('/api/records/:id/open', (req, res) => withSlot(req, res, async slot => {
  const record = slot.workspace.records.find(r => r.id === req.params.id);
  const config = liveConfigFor(slot.connections);
  if (slot.workspace.mode !== 'live' || !record || !config) throw new RecoveryError('Connect the live apps to open this record.', 404);
  res.redirect(302, await recordLink(record, config));
}));
app.get('/api/config', (req, res) => withSlot(req, res, slot => res.json({
  investigator: modelEnabled ? 'openrouter' : 'scenario',
  model: process.env.OPENROUTER_MODEL || 'OpenRouter account default',
  twins: arga ? 'available' : 'unconfigured',
  twinTokens: Object.entries(credentials).filter(([, v]) => v).map(([k]) => k),
  connections: connectionsEnabled ? 'enabled' : 'disabled',
  hosted,
  mode: slot.workspace.mode,
})));

const connectionsBody = (slot: Slot) => ({ apps: connectionView(slot.connections), ready: Boolean(liveConfigFor(slot.connections)) });
app.get('/api/connections', (req, res) => withSlot(req, res, slot => res.json(connectionsBody(slot))));
// Served from memory only, so polling can never trigger provider calls.
app.get('/api/run/live', (req, res) => withSlot(req, res, slot => res.json({ run: slot.liveRun ?? null })));
// A fixed, committed file: nothing from the request is used to locate it.
app.get('/api/evaluation', (_req, res) => {
  const read = (file: string) => { try { return JSON.parse(readFileSync(resolve(file), 'utf8')); } catch { return null; } };
  res.json({ evaluation: read('eval/results.json'), investigations: { mock: read('eval/investigation-mock.json'), model: read('eval/investigation-model.json'), holdout: read('eval/holdout-v1/results.json'), holdoutV2: read('eval/holdout-v2/results.json') } });
});
app.get('/api/connections/:provider/resources', (req, res) => withSlot(req, res, async slot => {
  const provider = req.params.provider;
  if (!isProvider(provider)) throw new RecoveryError('Unknown app.', 404);
  const connection = slot.connections[provider];
  if (!connection) throw new RecoveryError('Connect this app first.', 409);
  res.json({ resources: await listResources(provider, connection) });
}));
app.post('/api/connections/:provider/:change', (req, res) => withSlot(req, res, async slot => {
  const { provider, change } = req.params;
  if (!connectionsEnabled) throw new RecoveryError('App connections are disabled in scenario-only mode.', 409);
  if (!isProvider(provider)) throw new RecoveryError('Unknown app.', 404);
  // Disconnecting only forgets a token, so it is always allowed.
  if (change === 'disconnect') { delete slot.connections[provider]; res.json(connectionsBody(slot)); return; }
  claim(slot, `connecting ${provider}`);
  try {
    if (change === 'token') slot.connections[provider] = await identify(provider, req.body.token);
    else if (change === 'select') {
      const connection = slot.connections[provider];
      if (!connection) throw new RecoveryError('Connect this app first.', 409);
      connection.resource = await selectResource(provider, connection, req.body.id);
    } else throw new RecoveryError('Unknown operation.', 404);
    res.json(connectionsBody(slot));
  } finally { slot.activeAction = undefined; }
}));

// Agent keys are issued from the visitor's own session and shown once.
app.post('/api/agent/key', (req, res) => withSlot(req, res, slot => {
  if (!connectionsEnabled) throw new RecoveryError('App connections are disabled in scenario-only mode.', 409);
  res.json({ key: sessions.issueAgentKey(slot), mcpUrl: `${reviewUrl}/mcp`, recorderUrl: `${reviewUrl}/api/agent/runs` });
}));
app.post('/api/agent/key/revoke', (req, res) => withSlot(req, res, slot => { sessions.revokeAgentKey(slot); res.json({ keyIssued: false }); }));
app.get('/api/agent/status', (req, res) => withSlot(req, res, slot => res.json({
  keyIssued: sessions.hasAgentKey(slot), runOpen: Boolean(slot.externalRun), run: slot.externalRun ? slot.liveRun ?? null : null,
  mcpUrl: `${reviewUrl}/mcp`, recorderUrl: `${reviewUrl}/api/agent/runs`,
})));
// Recorder API: the agent calls the apps itself and reports each action for checking.
app.post('/api/agent/runs', (req, res) => withAgent(req, res, async slot => ({ run: (await startExternalRun(slot, req.body ?? {}, 'recorder', agentScope(slot))).id })));
app.post('/api/agent/runs/current/actions', (req, res) => withAgent(req, res, async slot => {
  agentScope(slot);
  const action = recordAction(slot, req.body ?? {});
  return { recorded: slot.externalRun?.actions.length ?? 0, summary: action.summary };
}));
app.post('/api/agent/runs/current/finish', (req, res) => withAgent(req, res, async slot => {
  const result = await finishExternalRun(slot, agentScope(slot), { reviewUrl });
  if (result.repairable) await slot.persist();
  return { repairable: result.repairable, recorded: result.recorded, flagged: result.flagged, review: result.repairable ? reviewUrl : null };
}));
app.post('/api/agent/runs/current/discard', (req, res) => withAgent(req, res, async slot => { discardExternalRun(slot); return { discarded: true }; }));

// MCP gateway: the agent calls the apps through Aftercare, which records every call.
app.get('/mcp', (_req, res) => { res.status(405).set('Allow', 'POST').json({ error: 'Send MCP requests with POST.' }); });
app.post('/mcp', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.get('origin');
  if (origin && origin !== (publicUrl ? new URL(publicUrl).origin : `http://${req.get('host')}`)) { res.status(403).json({ error: 'Cross-origin MCP requests are not allowed.' }); return; }
  if (!req.is('application/json')) { res.status(415).json({ error: 'JSON is required.' }); return; }
  try {
    const slot = agentSlot(req);
    const call = req.body?.method === 'tools/call';
    if (call) claim(slot, 'an agent tool call');
    try {
      const config = liveConfigFor(slot.connections);
      const response = await handleMcp(slot, req.body, config ? { config, fetcher: fetch } : undefined, { reviewUrl });
      if (slot.workspace.mode === 'live') await slot.persist();
      if (response === null) { res.status(202).end(); return; }
      res.json(response);
    } finally { if (call) slot.activeAction = undefined; }
  } catch (error) { failAgent(res, error); }
});

app.post('/api/:action', (req, res) => withSlot(req, res, async slot => {
  claim(slot, req.params.action);
  const persist = () => slot.persist();
  try {
    switch (req.params.action) {
      case 'prepare': {
        const workspace = slot.workspace;
        if (modelEnabled && process.env.OPENROUTER_API_KEY) {
          // Validate preparation eligibility before spending model calls.
          assertCanPrepare(workspace);
          await refreshRecords(workspace, adapterFor(slot));
          const captured = structuredClone(workspace);
          const expected = snapshot(captured);
          event(workspace, 'AI investigation started', 'OpenRouter will inspect the journal and each app record using scoped, read-only tools.'); await persist();
          // Tool-call notes are saved without waiting; the save after the investigation reports a storage failure.
          const finding = await investigate(captured, { key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, onTool: detail => { event(workspace, 'Investigator tool call', detail); persist().catch(() => {}); } });
          await refreshRecords(workspace, adapterFor(slot));
          if (slot.workspace !== workspace || snapshot(workspace) !== expected) throw new RecoveryError('App state changed during investigation. Run a fresh investigation.');
          acceptInvestigation(workspace, finding);
        } else {
          try { await prepareCurrent(workspace, adapterFor(slot)); }
          catch (error) {
            if (!(error instanceof RecoveryError) || error.status !== 422) throw error;
            acceptInvestigation(workspace, { provider: 'scenario', model: 'Scenario rules', outcome: 'escalated', summary: error.message, decisions: [], toolCalls: 0, completedAt: new Date().toISOString() });
          }
        }
        break;
      }
      case 'scenario': {
        if (slot.workspace.mode !== 'local' || slot.workspace.plans.length) throw new RecoveryError('Reset the local scenario before choosing a different case.');
        if (!evidenceScenarios.some(s => s.id === req.body.scenario)) throw new RecoveryError('Unknown evidence scenario.', 422);
        slot.workspace = evidenceScenario(req.body.scenario as EvidenceScenario);
        break;
      }
      case 'human-edit': humanEdit(slot.workspace); break;
      case 'approve': await approveCurrent(slot.workspace, req.body.planId, adapterFor(slot)); break;
      case 'execute': await execute(slot.workspace, req.body.planId, persist, { adapter: adapterFor(slot), interruptAfterWrite: req.body.interrupt === true }); break;
      case 'reset': slot.workspace = seedWorkspace(); break;
      case 'connect-live': {
        const config = liveConfigFor(slot.connections);
        if (!config) throw new RecoveryError('Connect GitHub, Linear and Slack, and choose a repository, team and channel first.', 409);
        if (slot.workspace.mode !== 'local' || slot.workspace.plans.length) throw new RecoveryError('Reset the workspace before connecting your apps.');
        event(slot.workspace, 'Running onboarding-agent', 'Checking access, then running the agent through the recorder in your GitHub repository, Linear team and Slack channel.'); await persist();
        slot.liveRun = undefined;
        await connectLive(slot.workspace, config, fetch, {
          reviewUrl,
          pauseMs: 700,
          onProgress: run => { slot.liveRun = run; },
        });
        break;
      }
      case 'provision-twins': {
        if (!arga) throw new RecoveryError('Arga is not configured. Add the MCP credential to local configuration.', 409);
        if (slot.workspace.plans.length) throw new RecoveryError('Reset the workspace before binding it to twins.');
        event(slot.workspace, 'Provisioning twins', 'Requesting github, linear and slack twin runs from Arga.'); await persist();
        await provisionAndSeed(slot.workspace, twinTtl, credentials, arga);
        break;
      }
      default: throw new RecoveryError('Unknown operation.', 404);
    }
    await persist(); res.json(publicView(slot.workspace));
  } finally { slot.activeAction = undefined; }
}));

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: { port: port + 10_000 } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const host = process.env.HOST || (hosted ? '0.0.0.0' : '127.0.0.1');
app.listen(port, host, () => console.log(`Aftercare: http://${host}:${port} · ${hosted ? `hosted at ${publicUrl}` : 'local operator'}`));

import express, { type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedWorkspace, prepare, prepareCurrent, approveCurrent, refreshRecords, execute, humanEdit, RecoveryError, snapshot, event, localAdapter } from './recovery.js';
import { provisionAndSeed, twinAdapter, twinCredentials } from './twins.js';
import { argaConfig } from './arga.js';
import { investigate } from './investigator.js';
import { connectLive, liveAdapter, readLiveConfig } from './live.js';
import { connectionView, connectionsFromEnv, identify, isProvider, listResources, liveConfigFor, selectResource } from './connections.js';
import { createSessions, type Slot } from './sessions.js';
import type { Workspace } from '../shared/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const app = express();
const port = Number(process.env.PORT || 4310);
const scenarioOnly = process.env.AFTERCARE_SCENARIO_ONLY === '1';
const modelEnabled = Boolean(process.env.OPENROUTER_API_KEY) && !scenarioOnly;
const publicUrl = process.env.AFTERCARE_PUBLIC_URL?.replace(/\/$/, '');
// A public URL means visitors besides the operator: separate workspaces, and only their own apps.
const hosted = Boolean(publicUrl);
// Scenario-only runs, including tests, never reach real apps whatever .env contains.
const connectionsEnabled = !scenarioOnly;
const operatorLive = connectionsEnabled && !hosted ? readLiveConfig().config : undefined;
// Visitors to a hosted instance must not spend the operator's Arga runs.
const arga = hosted ? undefined : argaConfig();
const credentials = twinCredentials();
const twinTtl = Number(process.env.ARGA_TWIN_TTL_MINUTES || 10);
const sessions = createSessions({
  dir: resolve(process.env.AFTERCARE_DATA_DIR || '.data'),
  hosted,
  secureCookie: Boolean(publicUrl?.startsWith('https://')),
  operatorConnections: operatorLive ? connectionsFromEnv(operatorLive) : {},
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
  catch (error) { slot?.persist(); fail(res, error, slot); }
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

app.get('/api/workspace', (req, res) => withSlot(req, res, slot => res.json(publicView(slot.workspace))));
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

app.post('/api/:action', (req, res) => withSlot(req, res, async slot => {
  claim(slot, req.params.action);
  const persist = () => slot.persist();
  try {
    switch (req.params.action) {
      case 'prepare': {
        const workspace = slot.workspace;
        if (modelEnabled && process.env.OPENROUTER_API_KEY) {
          // Validate preparation eligibility before spending model calls.
          prepare(structuredClone(workspace));
          await refreshRecords(workspace, adapterFor(slot));
          const captured = structuredClone(workspace);
          const expected = snapshot(captured);
          event(workspace, 'AI investigation started', 'OpenRouter will inspect the journal and each app record using scoped, read-only tools.'); persist();
          const finding = await investigate(captured, { key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, onTool: detail => { event(workspace, 'Investigator tool call', detail); persist(); } });
          await refreshRecords(workspace, adapterFor(slot));
          if (slot.workspace !== workspace || snapshot(workspace) !== expected) throw new RecoveryError('App state changed during investigation. Run a fresh investigation.');
          const p = prepare(workspace);
          workspace.investigation = finding;
          for (const op of p.operations) op.reason = finding.decisions.find(d => d.recordId === op.recordId)!.reason;
          event(workspace, 'AI recommendation validated', finding.summary, 'success');
        } else { await prepareCurrent(workspace, adapterFor(slot)); }
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
        event(slot.workspace, 'Connecting your apps', 'Checking access, then recreating the failed run in your GitHub repository, Linear team and Slack channel.'); persist();
        await connectLive(slot.workspace, config);
        break;
      }
      case 'provision-twins': {
        if (!arga) throw new RecoveryError('Arga is not configured. Add the MCP credential to local configuration.', 409);
        if (slot.workspace.plans.length) throw new RecoveryError('Reset the workspace before binding it to twins.');
        event(slot.workspace, 'Provisioning twins', 'Requesting github, linear and slack twin runs from Arga.'); persist();
        await provisionAndSeed(slot.workspace, twinTtl, credentials, arga);
        break;
      }
      default: throw new RecoveryError('Unknown operation.', 404);
    }
    persist(); res.json(publicView(slot.workspace));
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

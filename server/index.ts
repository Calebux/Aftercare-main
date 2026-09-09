import express from 'express';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedWorkspace, prepare, prepareCurrent, approveCurrent, refreshRecords, execute, humanEdit, RecoveryError, snapshot, event, localAdapter } from './recovery.js';
import { provisionAndSeed, twinAdapter, twinCredentials } from './twins.js';
import { argaConfig } from './arga.js';
import { investigate } from './investigator.js';
import type { Workspace } from '../shared/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const app = express();
const port = Number(process.env.PORT || 4310);
const modelEnabled = Boolean(process.env.OPENROUTER_API_KEY) && process.env.AFTERCARE_SCENARIO_ONLY !== '1';
const arga = argaConfig();
const credentials = twinCredentials();
// Provisioning needs only the Arga credential; per-provider tokens are optional.
const twinsAvailable = Boolean(arga);
const twinTtl = Number(process.env.ARGA_TWIN_TTL_MINUTES || 10);
const dir = resolve(process.env.AFTERCARE_DATA_DIR || '.data');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, 'workspace.json');
let workspace: Workspace = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : seedWorkspace();
// An execution interrupted by process exit must be reconciled before it resumes.
for (const p of workspace.plans) if (p.status === 'executing') p.status = 'interrupted';
function persist() {
  writeFileSync(file + '.tmp', JSON.stringify(workspace, null, 2), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
persist();
app.use(express.json({ limit: '32kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    const origin = req.get('origin');
    if (origin && origin !== `http://${req.get('host')}`) { res.status(403).json({ error: 'Cross-origin writes are not allowed.' }); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: 'JSON is required.' }); return; }
  }
  next();
});
/** Twin tokens are server-side credentials and never leave this process. */
function publicView(w: Workspace) { const { twinTokens, ...rest } = w; return rest; }
app.get('/api/workspace', (_req, res) => res.json(publicView(workspace)));
app.get('/api/config', (_req, res) => res.json({
  investigator: modelEnabled ? 'openrouter' : 'scenario',
  model: process.env.OPENROUTER_MODEL || 'OpenRouter account default',
  twins: twinsAvailable ? 'available' : 'unconfigured',
  twinTokens: Object.entries(credentials).filter(([, v]) => v).map(([k]) => k),
  mode: workspace.mode,
}));
/** Twin bindings must remain live; expired twins never fall back to local writes. */
function adapterFor(w: Workspace) {
  if (w.mode !== 'twin') return localAdapter;
  const bindings = Object.fromEntries((w.twins ?? []).map(b => [b.provider, b]));
  // Tokens minted during provisioning take precedence over any configured statically.
  return twinAdapter(bindings, { ...credentials, ...(w.twinTokens ?? {}) });
}
// All mutations share a gate, including reset, so in-flight provider writes retain
// their workspace and durable journal. GET requests remain available for progress.
let activeAction: string | undefined;
app.post('/api/:action', async (req, res) => {
  if (activeAction) {
    res.status(409).json({ error: `Wait for ${activeAction} to finish before changing the workspace.`, workspace: publicView(workspace) });
    return;
  }
  activeAction = req.params.action;
  try {
    switch (req.params.action) {
      case 'prepare': {
        if (modelEnabled && process.env.OPENROUTER_API_KEY) {
          // Validate preparation eligibility before spending model calls.
          prepare(structuredClone(workspace));
          await refreshRecords(workspace, adapterFor(workspace));
          const captured = structuredClone(workspace);
          const expected = snapshot(captured);
          event(workspace, 'AI investigation started', 'OpenRouter will inspect the journal and each app record using scoped, read-only tools.'); persist();
          const finding = await investigate(captured, { key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, onTool: detail => { event(workspace, 'Investigator tool call', detail); persist(); } });
          await refreshRecords(workspace, adapterFor(workspace));
          if (workspace.createdAt !== captured.createdAt || snapshot(workspace) !== expected) throw new RecoveryError('App state changed during investigation. Run a fresh investigation.');
          const p = prepare(workspace);
          workspace.investigation = finding;
          for (const op of p.operations) op.reason = finding.decisions.find(d => d.recordId === op.recordId)!.reason;
          event(workspace, 'AI recommendation validated', finding.summary, 'success');
        } else { await prepareCurrent(workspace, adapterFor(workspace)); }
        break;
      }
      case 'human-edit': humanEdit(workspace); break;
      case 'approve': await approveCurrent(workspace, req.body.planId, adapterFor(workspace)); break;
      case 'execute': await execute(workspace, req.body.planId, persist, { adapter: adapterFor(workspace), interruptAfterWrite: req.body.interrupt === true }); break;
      case 'reset': workspace = seedWorkspace(); break;
      case 'provision-twins': {
        if (!arga) throw new RecoveryError('Arga is not configured. Add the MCP credential to local configuration.', 409);
        if (workspace.plans.length) throw new RecoveryError('Reset the workspace before binding it to twins.');
        event(workspace, 'Provisioning twins', 'Requesting github, linear and slack twin runs from Arga.'); persist();
        await provisionAndSeed(workspace, twinTtl, credentials, arga);
        break;
      }
      default: res.status(404).json({ error: 'Unknown operation.' }); return;
    }
    persist(); res.json(publicView(workspace));
  } catch (error) {
    persist();
    if (error instanceof RecoveryError) res.status(error.status).json({ error: error.message, workspace: publicView(workspace) });
    else { console.error(error); res.status(500).json({ error: 'The operation failed. Inspect the local server logs.', workspace: publicView(workspace) }); }
  } finally { activeAction = undefined; }
});
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: { port: port + 10_000 } }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.listen(port, '127.0.0.1', () => console.log(`Aftercare: http://127.0.0.1:${port} · local scenario`));

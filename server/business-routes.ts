import { Router, type Request, type Response } from 'express';
import type { Slot } from './sessions.js';
import type { BusinessView } from '../shared/business.js';
import { sampleDeals } from '../shared/business.js';
import { connectBusinessApp, businessApps, isBusinessApp, listDeals, liveOnboardingAdapter } from './business-providers.js';
import { executeBusinessRun, modelDraft, prepareBusinessRun, requiredText, sampleOnboardingAdapter, saveAgent, seedBusiness, templateDraft } from './business.js';
import { RecoveryError } from './errors.js';

export function businessRoutes(options: { resolve(req: Request, res: Response): Slot; liveEnabled: boolean; managedKey?: string; managedModel?: string }) {
  const router = Router();
  const view = (slot: Slot): BusinessView => ({
    agents: slot.business!.agents, runs: slot.business!.runs,
    connections: businessApps.map(app => ({ app, connected: !!slot.businessConnections?.[app], account: slot.businessConnections?.[app]?.account, resource: slot.businessConnections?.[app]?.resource })),
    model: { managed: !!options.managedKey, byok: !!slot.businessModel, model: slot.businessModel?.model || options.managedModel || 'Provider default' },
    liveEnabled: options.liveEnabled,
  });
  const handle = (mutating: boolean, fn: (req: Request, res: Response, slot: Slot) => Promise<void> | void) => async (req: Request, res: Response) => {
    let slot: Slot | undefined; let claimed = false;
    try {
      slot = options.resolve(req, res);
      slot.business ??= seedBusiness(); slot.businessConnections ??= {};
      if (mutating) {
        if (slot.activeAction) throw new RecoveryError(`Wait for ${slot.activeAction} to finish.`, 409);
        slot.activeAction = 'the agent operation'; claimed = true;
      }
      await fn(req, res, slot);
    } catch (error) {
      // Provider bodies and credentials are never reflected to the client.
      res.status(error instanceof RecoveryError ? error.status : 500).json({ error: error instanceof RecoveryError ? error.message : 'The operation failed. Try again after checking the run history.' });
    } finally { if (claimed && slot) slot.activeAction = undefined; }
  };
  const requireLive = () => { if (!options.liveEnabled) throw new RecoveryError('Live connections are disabled in this sample environment.', 409); };
  router.get('/', handle(false, (_req, res, slot) => { res.json(view(slot)); }));
  router.get('/deals', handle(false, async (req, res, slot) => {
    if (req.query.mode === 'sample') { res.json({ deals: sampleDeals }); return; }
    requireLive();
    if (!slot.businessConnections?.hubspot) throw new RecoveryError('Connect HubSpot to choose a deal.', 409);
    res.json({ deals: await listDeals(slot.businessConnections.hubspot) });
  }));
  router.post('/connections/:app', handle(true, async (req, res, slot) => {
    requireLive();
    const app = req.params.app;
    if (!isBusinessApp(app)) throw new RecoveryError('Unsupported business app.', 404);
    if (req.body.disconnect === true) delete slot.businessConnections![app];
    else slot.businessConnections![app] = await connectBusinessApp(app, req.body.token, req.body.resource);
    res.json(view(slot));
  }));
  router.post('/model', handle(true, (req, res, slot) => {
    requireLive();
    if (req.body.disconnect === true) slot.businessModel = undefined;
    else {
      const key = requiredText(req.body.key, 'OpenRouter key', 300);
      if (/\s/.test(key)) throw new RecoveryError('Paste the model key without spaces.', 422);
      const model = requiredText(req.body.model, 'Model ID', 120);
      if (!/^[A-Za-z\d_./:@-]+$/.test(model)) throw new RecoveryError('Enter a valid OpenRouter model ID.', 422);
      slot.businessModel = { key, model };
    }
    res.json(view(slot));
  }));
  router.post('/agents', handle(true, (req, res, slot) => {
    saveAgent(slot.business!, req.body); slot.persist(); res.json(view(slot));
  }));
  router.post('/runs', handle(true, async (req, res, slot) => {
    const agent = slot.business!.agents.find(a => a.id === req.body.agentId);
    if (!agent) throw new RecoveryError('Choose a saved agent.', 404);
    const mode = req.body.mode;
    if (mode !== 'sample' && mode !== 'live') throw new RecoveryError('Choose sample or live mode.', 422);
    if (mode === 'live') requireLive();
    const dealId = requiredText(req.body.dealId, 'Deal ID', 60);
    const adapter = mode === 'sample' ? sampleOnboardingAdapter(slot.business!, agent.notifySlack) : liveOnboardingAdapter(slot.businessConnections!, agent.notifySlack);
    // Sample runs are always free of model calls and external app requests.
    const planner = mode === 'sample' ? 'template' : agent.planning;
    let key: string | undefined; let model: string | undefined;
    if (planner !== 'template') {
      key = planner === 'byok' ? slot.businessModel?.key : options.managedKey;
      model = planner === 'byok' ? slot.businessModel?.model : options.managedModel;
      if (!key) throw new RecoveryError('Configure the selected AI service in Settings before preparing a live plan.', 409);
      const now = Date.now();
      if (!slot.businessRate || now - slot.businessRate.startedAt >= 3_600_000) slot.businessRate = { startedAt: now, count: 0 };
      if (++slot.businessRate.count > 10) throw new RecoveryError('This beta allows 10 AI planning requests per workspace per hour.', 429);
    }
    const run = await prepareBusinessRun(slot.business!, { ...agent, planning: planner }, mode, dealId, adapter, async deal => key ? modelDraft(agent, deal, { key, model }) : templateDraft(agent, deal));
    slot.persist(); res.json({ ...view(slot), runId: run.id });
  }));
  router.post('/runs/:id/:action', handle(true, async (req, res, slot) => {
    const run = slot.business!.runs.find(r => r.id === req.params.id);
    if (!run) throw new RecoveryError('Run not found.', 404);
    if (req.params.action === 'cancel') {
      if (run.status !== 'review') throw new RecoveryError('Only a plan awaiting approval can be cancelled.', 409);
      run.status = 'cancelled'; run.events.push({ at: new Date().toISOString(), detail: 'Plan cancelled before execution. No writes made.' }); slot.persist();
    } else if (req.params.action === 'execute') {
      if (run.mode === 'live') requireLive();
      const adapter = run.mode === 'sample' ? sampleOnboardingAdapter(slot.business!, run.agent.notifySlack) : liveOnboardingAdapter(slot.businessConnections!, run.agent.notifySlack);
      await executeBusinessRun(run, adapter, () => slot.persist());
    } else throw new RecoveryError('Unknown run action.', 404);
    res.json(view(slot));
  }));
  return router;
}

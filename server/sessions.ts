import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AgentRun, Workspace } from '../shared/types.js';
import { RecoveryError, seedWorkspace } from './recovery.js';
import type { Connections } from './connections.js';
import type { ExternalRun } from './external.js';
import type { BusinessWorkspace } from '../shared/business.js';
import type { BusinessConnections } from './business-providers.js';
import { seedBusiness } from './business.js';
import { fileStore, isSessionId, LOCAL_SESSION, type WorkspaceStore } from './store.js';

/** One visitor's recovery workspace and app connections. */
export interface Slot {
  workspace: Workspace;
  business?: BusinessWorkspace;
  businessConnections?: BusinessConnections;
  businessModel?: { key: string; model: string };
  businessRate?: { startedAt: number; count: number };
  /** Held in memory only, so a restart asks visitors to reconnect. */
  connections: Connections;
  /** The mutation in progress; conflicting requests from the same visitor are refused. */
  activeAction?: string;
  /** The agent run in progress, kept in memory for the live view. */
  liveRun?: AgentRun;
  /** A run an outside agent is recording, kept in memory until it is finished or discarded. */
  externalRun?: ExternalRun;
  agentRate?: { windowStart: number; count: number };
  touched: number;
  /** Saves the workspace. Resolves once the store holds this state or a later one. */
  persist(): Promise<void>;
}

/**
 * Saves run one at a time, and each sends the workspace as it is when that save starts, so a slow
 * save never overwrites a newer one. Calls made while a save is waiting to start share it.
 */
function saver(write: () => Promise<void>) {
  let last: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | undefined;
  let closed = false;
  return {
    save(): Promise<void> {
      if (closed) return Promise.resolve();
      if (!waiting) {
        waiting = last.catch(() => {}).then(() => { waiting = undefined; return closed ? undefined : write(); });
        last = waiting;
      }
      return waiting;
    },
    /** Refuses further saves, then runs `final` once any save already started has settled. */
    close(final: () => Promise<void>): Promise<void> {
      closed = true;
      last = last.catch(() => {}).then(final);
      return last;
    },
  };
}

function openSlot(saved: string | undefined, connections: Connections, write: (data: string) => Promise<void>) {
  const { business = seedBusiness(), ...workspace }: Workspace & { business?: BusinessWorkspace } = saved ? JSON.parse(saved) : seedWorkspace();
  // An execution interrupted by process exit must be reconciled before it resumes.
  for (const p of workspace.plans) if (p.status === 'executing') p.status = 'interrupted';
  for (const run of business.runs) if (run.status === 'running') {
    run.status = 'needs_attention';
    run.error = 'The server restarted during execution. Reconnect the original apps and verify the recorded outputs before continuing.';
  }
  const saves = saver(() => write(JSON.stringify({ ...slot.workspace, business: slot.business }, null, 2)));
  const slot: Slot = { workspace, business, businessConnections: {}, connections, touched: Date.now(), persist: saves.save };
  return { slot, saves };
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

/**
 * Agent keys let an outside agent act for one workspace without its browser session.
 * Only a SHA-256 hash is kept, in memory, so a restart or revocation invalidates a key.
 */
function agentKeys() {
  const bySlot = new Map<Slot, string>();
  const byHash = new Map<string, Slot>();
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');
  const revoke = (slot: Slot) => {
    const h = bySlot.get(slot);
    if (h) byHash.delete(h);
    bySlot.delete(slot);
  };
  return {
    issueAgentKey(slot: Slot) {
      revoke(slot);
      const key = `aft_${randomBytes(32).toString('base64url')}`;
      bySlot.set(slot, hash(key));
      byHash.set(hash(key), slot);
      return key;
    },
    revokeAgentKey: revoke,
    hasAgentKey: (slot: Slot) => bySlot.has(slot),
    findByAgentKey(key: unknown): Slot | undefined {
      return typeof key === 'string' && /^aft_[A-Za-z0-9_-]{43}$/.test(key) ? byHash.get(hash(key)) : undefined;
    },
  };
}

const COOKIE = 'aftercare_session';
const IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;

export interface SessionOptions {
  dir: string;
  /** Hosted instances give every visitor a separate workspace and no operator tokens. */
  hosted: boolean;
  secureCookie: boolean;
  operatorConnections: Connections;
  /** Where workspaces are saved. Defaults to JSON files under `dir`. */
  store?: WorkspaceStore;
}

export async function createSessions({ dir, hosted, secureCookie, operatorConnections, store = fileStore(dir) }: SessionOptions) {
  const keys = agentKeys();
  const saved = await store.loadAll();
  if (!hosted) {
    // A single operator on localhost keeps the original workspace and .env connections.
    const local = openSlot(saved.find(s => s.session === LOCAL_SESSION)?.data, operatorConnections, data => store.save(LOCAL_SESSION, data)).slot;
    await local.persist();
    return { ...keys, resolve: (_req: Request, _res: Response): Slot => local, settled: async () => {} };
  }
  type Entry = ReturnType<typeof openSlot> & { stored: boolean };
  const slots = new Map<string, Entry>();
  const open = (id: string, data?: string) => {
    const entry: Entry = { ...openSlot(data, {}, text => { entry.stored = true; return store.save(id, text); }), stored: data !== undefined };
    slots.set(id, entry);
    return entry.slot;
  };
  const removals = new Set<Promise<void>>();
  // The store logs failures; a workspace left behind is removed as expired at the next start.
  const track = (removal: Promise<void>) => {
    const done: Promise<void> = removal.catch(() => {}).finally(() => removals.delete(done));
    removals.add(done);
  };
  const forget = (id: string) => {
    const entry = slots.get(id);
    if (!entry) return;
    keys.revokeAgentKey(entry.slot);
    slots.delete(id);
    // A save that has not started is dropped; one in flight finishes before the removal.
    track(entry.saves.close(() => entry.stored ? store.remove(id) : Promise.resolve()));
  };
  // Newest first, with the same expiry and session cap a running server applies.
  const started = Date.now();
  const restorable = saved.filter(s => isSessionId(s.session)).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const [index, s] of restorable.entries()) {
    if (index < MAX_SESSIONS && started - s.updatedAt <= IDLE_MS) open(s.session, s.data).touched = s.updatedAt;
    else track(store.remove(s.session));
  }
  return {
    ...keys,
    /** Resolves once pending workspace removals have finished. */
    settled: async () => { await Promise.all(removals); },
    resolve(req: Request, res: Response): Slot {
      const now = Date.now();
      for (const [id, { slot }] of slots) if (now - slot.touched > IDLE_MS && !slot.activeAction) forget(id);
      // Only identifiers this server issued are accepted, so a planted cookie cannot choose a session.
      const existing = slots.get(readCookie(req, COOKIE) ?? '');
      if (existing) { existing.slot.touched = now; return existing.slot; }
      if (slots.size >= MAX_SESSIONS) {
        const idle = [...slots].filter(([, e]) => !e.slot.activeAction).sort((a, b) => a[1].slot.touched - b[1].slot.touched)[0];
        if (!idle) throw new RecoveryError('Aftercare is busy. Try again shortly.', 503);
        forget(idle[0]);
      }
      const id = randomBytes(32).toString('base64url');
      res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: secureCookie, path: '/', maxAge: IDLE_MS });
      // Nothing is saved until the visitor changes something, so bare requests cannot fill the store.
      return open(id);
    },
  };
}

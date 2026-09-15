import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import type { AgentRun, Workspace } from '../shared/types.js';
import { RecoveryError, seedWorkspace } from './recovery.js';
import type { Connections } from './connections.js';
import type { ExternalRun } from './external.js';
import type { BusinessWorkspace } from '../shared/business.js';
import type { BusinessConnections } from './business-providers.js';
import { seedBusiness } from './business.js';

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
  persist(): void;
}

function slotAt(file: string, connections: Connections): Slot {
  const { business = seedBusiness(), ...workspace }: Workspace & { business?: BusinessWorkspace } = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : seedWorkspace();
  // An execution interrupted by process exit must be reconciled before it resumes.
  for (const p of workspace.plans) if (p.status === 'executing') p.status = 'interrupted';
  for (const run of business.runs) if (run.status === 'running') {
    run.status = 'needs_attention';
    run.error = 'The server restarted during execution. Reconnect the original apps and verify the recorded outputs before continuing.';
  }
  const slot: Slot = {
    workspace, business, businessConnections: {}, connections, touched: Date.now(),
    persist() {
      writeFileSync(file + '.tmp', JSON.stringify({ ...slot.workspace, business: slot.business }, null, 2), { mode: 0o600 });
      renameSync(file + '.tmp', file);
    },
  };
  return slot;
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
const PRUNE_INTERVAL_MS = 60 * 1000;

export interface SessionOptions {
  dir: string;
  /** Hosted instances give every visitor a separate workspace and no operator tokens. */
  hosted: boolean;
  secureCookie: boolean;
  operatorConnections: Connections;
}

export function createSessions({ dir, hosted, secureCookie, operatorConnections }: SessionOptions) {
  mkdirSync(dir, { recursive: true });
  const keys = agentKeys();
  if (!hosted) {
    // A single operator on localhost keeps the original workspace and .env connections.
    const local = slotAt(resolve(dir, 'workspace.json'), operatorConnections);
    local.persist();
    return { ...keys, resolve: (_req: Request, _res: Response): Slot => local };
  }
  const sessionsDir = resolve(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const slots = new Map<string, Slot>();
  const fileFor = (id: string) => resolve(sessionsDir, `${id}.json`);
  const forget = (id: string) => {
    const slot = slots.get(id);
    if (slot) keys.revokeAgentKey(slot);
    slots.delete(id);
    rmSync(fileFor(id), { force: true });
  };
  let pruned = 0;
  /** Bounds disk use: expired workspace files are removed and only the newest MAX_SESSIONS are kept. */
  const prune = (now: number) => {
    if (now - pruned < PRUNE_INTERVAL_MS) return;
    pruned = now;
    readdirSync(sessionsDir)
      .filter(name => /^[A-Za-z0-9_-]{43}\.json$/.test(name))
      .map(name => {
        const id = name.slice(0, -'.json'.length);
        return { id, used: Math.max(statSync(fileFor(id)).mtimeMs, slots.get(id)?.touched ?? 0) };
      })
      .sort((a, b) => b.used - a.used)
      .forEach(({ id, used }, index) => {
        if (!slots.get(id)?.activeAction && (now - used > IDLE_MS || index >= MAX_SESSIONS)) forget(id);
      });
  };
  return {
    ...keys,
    resolve(req: Request, res: Response): Slot {
      const now = Date.now();
      prune(now);
      for (const [id, s] of slots) if (now - s.touched > IDLE_MS && !s.activeAction) forget(id);
      let id = readCookie(req, COOKIE);
      // Only identifiers this server issued are accepted, so a planted cookie cannot choose a session.
      if (id && (!/^[A-Za-z0-9_-]{43}$/.test(id) || (!slots.has(id) && !existsSync(fileFor(id))))) id = undefined;
      let slot = id ? slots.get(id) : undefined;
      if (!slot) {
        if (slots.size >= MAX_SESSIONS) {
          const idle = [...slots].filter(([, s]) => !s.activeAction).sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!idle) throw new RecoveryError('Aftercare is busy. Try again shortly.', 503);
          forget(idle[0]);
        }
        if (!id) {
          id = randomBytes(32).toString('base64url');
          res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: secureCookie, path: '/', maxAge: IDLE_MS });
        }
        // Nothing is written until the visitor changes something, so bare requests cannot fill the disk.
        slot = slotAt(fileFor(id), {});
        slots.set(id, slot);
      }
      slot.touched = now;
      return slot;
    },
  };
}

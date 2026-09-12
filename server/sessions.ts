import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import type { Workspace } from '../shared/types.js';
import { RecoveryError, seedWorkspace } from './recovery.js';
import type { Connections } from './connections.js';

/** One visitor's recovery workspace and app connections. */
export interface Slot {
  workspace: Workspace;
  /** Held in memory only, so a restart asks visitors to reconnect. */
  connections: Connections;
  /** The mutation in progress; conflicting requests from the same visitor are refused. */
  activeAction?: string;
  touched: number;
  persist(): void;
}

function slotAt(file: string, connections: Connections): Slot {
  const workspace: Workspace = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : seedWorkspace();
  // An execution interrupted by process exit must be reconciled before it resumes.
  for (const p of workspace.plans) if (p.status === 'executing') p.status = 'interrupted';
  const slot: Slot = {
    workspace, connections, touched: Date.now(),
    persist() {
      writeFileSync(file + '.tmp', JSON.stringify(slot.workspace, null, 2), { mode: 0o600 });
      renameSync(file + '.tmp', file);
    },
  };
  slot.persist();
  return slot;
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
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
}

export function createSessions({ dir, hosted, secureCookie, operatorConnections }: SessionOptions) {
  mkdirSync(dir, { recursive: true });
  if (!hosted) {
    // A single operator on localhost keeps the original workspace and .env connections.
    const local = slotAt(resolve(dir, 'workspace.json'), operatorConnections);
    return { resolve: (_req: Request, _res: Response): Slot => local };
  }
  const sessionsDir = resolve(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const slots = new Map<string, Slot>();
  const fileFor = (id: string) => resolve(sessionsDir, `${id}.json`);
  return {
    resolve(req: Request, res: Response): Slot {
      const now = Date.now();
      for (const [id, s] of slots) if (now - s.touched > IDLE_MS && !s.activeAction) slots.delete(id);
      let id = readCookie(req, COOKIE);
      // Only identifiers this server issued are accepted, so a planted cookie cannot choose a session.
      if (id && (!/^[A-Za-z0-9_-]{43}$/.test(id) || (!slots.has(id) && !existsSync(fileFor(id))))) id = undefined;
      let slot = id ? slots.get(id) : undefined;
      if (!slot) {
        if (slots.size >= MAX_SESSIONS) {
          const idle = [...slots].filter(([, s]) => !s.activeAction).sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!idle) throw new RecoveryError('Aftercare is busy. Try again shortly.', 503);
          slots.delete(idle[0]);
        }
        if (!id) {
          id = randomBytes(32).toString('base64url');
          res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: secureCookie, path: '/', maxAge: IDLE_MS });
        }
        slot = slotAt(fileFor(id), {});
        slots.set(id, slot);
      }
      slot.touched = now;
      return slot;
    },
  };
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../convex/_generated/api.js';
import { RecoveryError } from './errors.js';

/** The local operator's single workspace. Hosted visitors' sessions use random 43-character IDs. */
export const LOCAL_SESSION = 'local';
export const isSessionId = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

export interface SavedWorkspace { session: string; data: string; updatedAt: number }
/** Where workspaces are kept between restarts. A save is complete only when its promise resolves. */
export interface WorkspaceStore {
  loadAll(): Promise<SavedWorkspace[]>;
  save(session: string, data: string): Promise<void>;
  remove(session: string): Promise<void>;
}

/** JSON files: `workspace.json` for the local operator and `sessions/` for hosted visitors. */
export function fileStore(dir: string): WorkspaceStore {
  const sessionsDir = resolve(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const fileFor = (session: string) => session === LOCAL_SESSION ? resolve(dir, 'workspace.json') : resolve(sessionsDir, `${session}.json`);
  return {
    async loadAll() {
      const hosted = readdirSync(sessionsDir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length)).filter(isSessionId);
      return [LOCAL_SESSION, ...hosted].filter(session => existsSync(fileFor(session)))
        .map(session => ({ session, data: readFileSync(fileFor(session), 'utf8'), updatedAt: statSync(fileFor(session)).mtimeMs }));
    },
    async save(session, data) {
      const file = fileFor(session);
      writeFileSync(file + '.tmp', data, { mode: 0o600 });
      renameSync(file + '.tmp', file);
    },
    async remove(session) { rmSync(fileFor(session), { force: true }); },
  };
}

/** AES-256-GCM bound to the session, so a workspace cannot be read, altered, or moved to another session without the key. */
export function sealWorkspace(key: Buffer, session: string, data: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 }).setAAD(Buffer.from(session));
  const body = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function openWorkspace(key: Buffer, session: string, sealed: string): string {
  const [version, iv, tag, body, ...rest] = sealed.split('.');
  if (version !== 'v1' || iv === undefined || tag === undefined || body === undefined || rest.length) throw new Error('Unrecognized saved workspace format.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 })
    .setAAD(Buffer.from(session)).setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Convex, for hosts whose disk does not survive restarts. Workspaces are sealed here first, so Convex
 * holds only ciphertext. Its functions are public, so every call carries the shared token.
 */
export function convexStore(url: string, tokenValue: string | undefined, keyValue: string | undefined): WorkspaceStore {
  const token = tokenValue ?? '';
  if (token.length < 32) throw new Error('CONVEX_URL requires AFTERCARE_CONVEX_TOKEN, the token also set in the Convex deployment (at least 32 characters).');
  const key = Buffer.from(keyValue ?? '', 'base64url');
  if (key.length !== 32) throw new Error('CONVEX_URL requires AFTERCARE_STORE_KEY: 32 random bytes, base64url encoded.');
  const client = new ConvexHttpClient(url, { logger: false });
  // Storage detail stays in the server log.
  const unavailable = (what: string, error: unknown) => {
    console.error(`Convex ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    return new RecoveryError('Aftercare could not save your progress, so it stopped before making further changes. Try again shortly.', 503);
  };
  return {
    async loadAll() {
      const saved: SavedWorkspace[] = [];
      let cursor: string | null = null;
      do {
        const page: FunctionReturnType<typeof api.workspaces.list> = await client.query(api.workspaces.list, { token, paginationOpts: { numItems: 10, cursor } });
        for (const doc of page.page) {
          let data: string;
          try { data = openWorkspace(key, doc.session, doc.data); }
          catch { throw new Error('A saved workspace could not be decrypted. AFTERCARE_STORE_KEY must be the key it was saved with.'); }
          saved.push({ session: doc.session, data, updatedAt: doc.updatedAt });
        }
        cursor = page.isDone ? null : page.continueCursor;
      } while (cursor);
      return saved;
    },
    async save(session, data) {
      const sealed = sealWorkspace(key, session, data);
      // Convex documents are limited to 1 MiB.
      if (sealed.length > 900_000) throw new RecoveryError('This workspace is too large to save. Reset it, then try again.', 413);
      try { await client.mutation(api.workspaces.save, { token, session, data: sealed }); }
      catch (error) { throw unavailable('save', error); }
    },
    async remove(session) {
      try { await client.mutation(api.workspaces.remove, { token, session }); }
      catch (error) { throw unavailable('removal', error); }
    },
  };
}

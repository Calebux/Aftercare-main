import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { createSessions } from '../server/sessions.js';
import { event } from '../server/recovery.js';
import type { SavedWorkspace, WorkspaceStore } from '../server/store.js';

function visit(cookie?: string) {
  let issued: string | undefined;
  const req = { headers: cookie ? { cookie: `aftercare_session=${cookie}` } : {} } as unknown as Request;
  const res = { cookie: (_name: string, value: string) => { issued = value; } } as unknown as Response;
  return { req, res, issued: () => issued };
}

async function hostedSessions(run: (sessions: Awaited<ReturnType<typeof createSessions>>, files: () => Promise<string[]>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aftercare-sessions-'));
  try {
    await run(await createSessions({ dir, hosted: true, secureCookie: false, operatorConnections: {} }), () => readdir(join(dir, 'sessions')));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** An in-memory store whose saves can be held open or made to fail. */
function memoryStore(initial: SavedWorkspace[] = []) {
  const saved = new Map(initial.map(s => [s.session, s]));
  const started: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  let failures = 0;
  const store: WorkspaceStore = {
    async loadAll() { return [...saved.values()]; },
    async save(session, data) {
      started.push(data);
      await gate;
      if (failures > 0) { failures--; throw new Error('store unavailable'); }
      saved.set(session, { session, data, updatedAt: Date.now() });
    },
    async remove(session) { saved.delete(session); },
  };
  return {
    store, saved, started,
    hold() { let release!: () => void; gate = new Promise<void>(resolve => { release = () => resolve(); }); return release; },
    failNext() { failures++; },
  };
}
const hosted = (store: WorkspaceStore) => createSessions({ dir: 'unused', hosted: true, secureCookie: false, operatorConnections: {}, store });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('hosted sessions write nothing to disk until a visitor changes something', () => hostedSessions(async (sessions, files) => {
  for (let i = 0; i < 25; i++) { const v = visit(); sessions.resolve(v.req, v.res); }
  assert.deepEqual(await files(), []);
  const first = visit();
  const slot = sessions.resolve(first.req, first.res);
  await slot.persist();
  assert.deepEqual(await files(), [`${first.issued()}.json`]);
  const again = visit(first.issued());
  assert.equal(sessions.resolve(again.req, again.res), slot, 'the cookie returns the same workspace');
}));

test('hosted sessions keep a bounded number of workspace files', () => hostedSessions(async (sessions, files) => {
  for (let i = 0; i < 230; i++) { const v = visit(); await sessions.resolve(v.req, v.res).persist(); }
  await sessions.settled();
  assert.ok((await files()).length <= 200, 'evicted sessions remove their files');
}));

test('a restart restores saved hosted workspaces under their cookies and removes expired ones', async () => {
  const expired = 'x'.repeat(43);
  const memory = memoryStore([{ session: expired, data: '{}', updatedAt: Date.now() - 13 * 60 * 60 * 1000 }]);
  const before = await hosted(memory.store);
  const v = visit();
  const slot = before.resolve(v.req, v.res);
  event(slot.workspace, 'Restart marker', 'Saved before the restart.');
  await slot.persist();
  const after = await hosted(memory.store);
  await after.settled();
  assert.ok(!memory.saved.has(expired), 'expired workspaces are removed at start');
  const returning = visit(v.issued());
  assert.match(JSON.stringify(after.resolve(returning.req, returning.res).workspace), /Restart marker/);
  assert.equal(returning.issued(), undefined, 'the saved session keeps its cookie');
});

test('saves never overlap, calls made while one waits share it, and failures reach the caller', async () => {
  const memory = memoryStore();
  const sessions = await hosted(memory.store);
  const v = visit();
  const slot = sessions.resolve(v.req, v.res);
  const release = memory.hold();
  const first = slot.persist();
  await tick();
  event(slot.workspace, 'Later change', 'Made while the first save was in flight.');
  const second = slot.persist();
  assert.equal(slot.persist(), second, 'a waiting save is shared');
  await tick();
  assert.equal(memory.started.length, 1, 'the second save waits for the first');
  release();
  await Promise.all([first, second]);
  assert.equal(memory.started.length, 2);
  assert.match(memory.saved.get(v.issued()!)!.data, /Later change/, 'the later save sends the newer state');
  memory.failNext();
  await assert.rejects(slot.persist(), /store unavailable/);
  await slot.persist();
  assert.equal(memory.started.length, 4, 'the next save retries');
});

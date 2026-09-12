import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { createSessions } from '../server/sessions.js';

function visit(cookie?: string) {
  let issued: string | undefined;
  const req = { headers: cookie ? { cookie: `aftercare_session=${cookie}` } : {} } as unknown as Request;
  const res = { cookie: (_name: string, value: string) => { issued = value; } } as unknown as Response;
  return { req, res, issued: () => issued };
}

async function hostedSessions(run: (sessions: ReturnType<typeof createSessions>, files: () => Promise<string[]>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aftercare-sessions-'));
  try {
    await run(createSessions({ dir, hosted: true, secureCookie: false, operatorConnections: {} }), () => readdir(join(dir, 'sessions')));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('hosted sessions write nothing to disk until a visitor changes something', () => hostedSessions(async (sessions, files) => {
  for (let i = 0; i < 25; i++) { const v = visit(); sessions.resolve(v.req, v.res); }
  assert.deepEqual(await files(), []);
  const first = visit();
  const slot = sessions.resolve(first.req, first.res);
  slot.persist();
  assert.deepEqual(await files(), [`${first.issued()}.json`]);
  const again = visit(first.issued());
  assert.equal(sessions.resolve(again.req, again.res), slot, 'the cookie returns the same workspace');
}));

test('hosted sessions keep a bounded number of workspace files', () => hostedSessions(async (sessions, files) => {
  for (let i = 0; i < 230; i++) { const v = visit(); sessions.resolve(v.req, v.res).persist(); }
  assert.ok((await files()).length <= 200, 'evicted sessions remove their files');
}));

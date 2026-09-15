import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { convexStore, openWorkspace, sealWorkspace } from '../server/store.js';

test('saved workspaces are encrypted, tamper-evident, and bound to their session', () => {
  const key = randomBytes(32);
  const session = 'a'.repeat(43);
  const workspace = JSON.stringify({ business: { runs: [{ deal: { name: 'Acme renewal' } }] } });
  const sealed = sealWorkspace(key, session, workspace);
  assert.ok(!sealed.includes('Acme'), 'Convex receives only ciphertext');
  assert.notEqual(sealWorkspace(key, session, workspace), sealed, 'each save uses a fresh IV');
  assert.equal(openWorkspace(key, session, sealed), workspace);
  assert.throws(() => openWorkspace(key, 'b'.repeat(43), sealed), 'a workspace cannot be moved to another session');
  assert.throws(() => openWorkspace(randomBytes(32), session, sealed), 'another key cannot read it');
  const [version, iv, tag, body] = sealed.split('.');
  const flipped = Buffer.from(body, 'base64url'); flipped[0] ^= 1;
  assert.throws(() => openWorkspace(key, session, [version, iv, tag, flipped.toString('base64url')].join('.')), 'changed ciphertext is rejected');
  assert.throws(() => openWorkspace(key, session, [version, iv, tag.slice(0, 8), body].join('.')), 'a shortened tag is rejected');
});

test('Convex storage refuses to start without its token and a 32-byte key', () => {
  const url = 'https://tacit-example-123.convex.cloud';
  const token = randomBytes(32).toString('base64url');
  assert.throws(() => convexStore(url, undefined, randomBytes(32).toString('base64url')), /AFTERCARE_CONVEX_TOKEN/);
  assert.throws(() => convexStore(url, token, undefined), /AFTERCARE_STORE_KEY/);
  assert.throws(() => convexStore(url, token, randomBytes(16).toString('base64url')), /AFTERCARE_STORE_KEY/);
  assert.doesNotThrow(() => convexStore(url, token, randomBytes(32).toString('base64url')));
});

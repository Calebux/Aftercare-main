import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** A hosted server with operator tokens in its environment; no provider is contacted. */
test('a hosted instance gives each visitor a separate workspace and never shares operator tokens', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftercare-hosted-'));
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', AFTERCARE_DATA_DIR: dir, AFTERCARE_PUBLIC_URL: base, OPENROUTER_API_KEY: 'sk-or-v1-not-a-real-key',
      AFTERCARE_GITHUB_TOKEN: 'operator-secret', AFTERCARE_GITHUB_REPO: 'operator/repo', AFTERCARE_LINEAR_API_KEY: 'operator-secret',
      AFTERCARE_LINEAR_TEAM_KEY: 'OPS', AFTERCARE_SLACK_BOT_TOKEN: 'xoxb-operator-secret', AFTERCARE_SLACK_CHANNEL_ID: 'C0OPERATOR',
    },
  });
  const exited = once(child, 'exit');
  const visitor = () => {
    let cookie = '';
    let lastSetCookie = '';
    const send = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${base}${path}`, { ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
      lastSetCookie = response.headers.get('set-cookie') ?? '';
      if (lastSetCookie) cookie = lastSetCookie.split(';')[0];
      return response;
    };
    const post = (path: string, body: object = {}, headers: Record<string, string> = {}) =>
      send(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
    return { send, post, setCookie: () => lastSetCookie };
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test server did not start')), 8000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Test server exited before startup')); });
      child.stdout.on('data', chunk => { if (chunk.toString().includes('Aftercare:')) { clearTimeout(timer); resolve(); } });
    });
    const a = visitor(); const b = visitor();
    assert.equal((await a.send('/api/workspace')).status, 200);
    assert.match(a.setCookie(), /^aftercare_session=[A-Za-z0-9_-]{43};.*HttpOnly/i);
    assert.match(a.setCookie(), /SameSite=Lax/i);

    const prepared = await a.post('/api/prepare');
    assert.equal(prepared.status, 200);
    assert.equal((await prepared.json()).plans.length, 1);
    assert.equal((await (await b.send('/api/workspace')).json()).plans.length, 0, 'another visitor keeps a separate workspace');

    const config = await (await b.send('/api/config')).json();
    assert.equal(config.hosted, true);
    assert.equal(config.connections, 'enabled');
    assert.equal(config.twins, 'unconfigured', 'visitors cannot spend the operator Arga runs');
    assert.equal(config.investigator, 'scenario', 'visitors cannot spend the operator model key');
    const connections = await (await b.send('/api/connections')).text();
    assert.doesNotMatch(connections, /operator/);
    assert.equal(JSON.parse(connections).apps.github.connected, false, 'operator tokens are never inherited');
    assert.equal((await b.post('/api/connect-live')).status, 409);
    assert.equal((await b.post('/api/connections/slack/token', { token: 'xoxp-user-token' })).status, 422);

    assert.equal((await a.post('/api/reset', {}, { Origin: 'http://attacker.test' })).status, 403);
    const planted = await fetch(`${base}/api/workspace`, { headers: { Cookie: `aftercare_session=${'A'.repeat(43)}` } });
    assert.match(planted.headers.get('set-cookie') ?? '', /^aftercare_session=/, 'an unknown session id is replaced');
    assert.doesNotMatch(planted.headers.get('set-cookie') ?? '', /A{43}/);

    const headers = (await b.send('/api/config')).headers;
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('x-powered-by'), null);
    const filesBefore = (await readdir(join(dir, 'sessions'))).length;
    for (let i = 0; i < 20; i++) await fetch(`${base}/api/workspace`);
    assert.equal((await readdir(join(dir, 'sessions'))).length, filesBefore, 'requests that change nothing write no files');
    const misdirected = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: '/api/workspace', headers: { Host: `attacker.example:${port}` } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on('error', reject);
      request.end();
    });
    assert.equal(misdirected, 421, 'a request for another host name is refused');
  } finally {
    child.kill(); await exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a public URL refuses to start the development server', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftercare-dev-'));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development', PORT: '0', AFTERCARE_DATA_DIR: dir, AFTERCARE_PUBLIC_URL: 'https://aftercare.example' },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(stderr, /requires the production build/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

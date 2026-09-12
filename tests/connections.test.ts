import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionView, identify, listResources, liveConfigFor, selectResource, type Connections } from '../server/connections.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function recorder(respond: (url: URL) => Response) {
  const calls: Array<{ url: URL; method: string; body?: any; auth?: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return respond(url);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test('a pasted token is checked with its app and the account is named', async () => {
  const apps = recorder(url => url.hostname === 'api.github.com' ? json({ login: 'octo' })
    : url.hostname === 'api.linear.app' ? json({ data: { viewer: { name: 'Jamie', organization: { name: 'Acme' } } } })
    : json({ ok: true, team: 'Acme Slack', user: 'aftercare' }));
  assert.equal((await identify('github', ' github_pat_x ', apps.fetcher)).account, 'octo');
  assert.equal((await identify('linear', 'lin_api_x', apps.fetcher)).account, 'Acme · Jamie');
  assert.deepEqual(await identify('slack', 'xoxb-x', apps.fetcher), { token: 'xoxb-x', account: 'Acme Slack', source: 'token' });
  assert.deepEqual(apps.calls.map(c => c.auth), ['Bearer github_pat_x', 'lin_api_x', 'Bearer xoxb-x']);
});

test('malformed or user-level tokens are refused before any request', async () => {
  const apps = recorder(() => json({}));
  await assert.rejects(identify('slack', 'xoxp-user-token', apps.fetcher), /bot token/);
  await assert.rejects(identify('github', 'two words', apps.fetcher), /exactly/);
  await assert.rejects(identify('linear', 42, apps.fetcher), /exactly/);
  assert.equal(apps.calls.length, 0);
});

test('only a listed resource can be chosen, and choosing a Slack channel joins it', async () => {
  const apps = recorder(url => {
    if (url.pathname === '/user/repos') return json([{ full_name: 'octo/demo', has_issues: true }, { full_name: 'octo/no-issues', has_issues: false }]);
    if (url.pathname === '/api/conversations.list') return json({ ok: true, channels: [{ id: 'C0DEMO01', name: 'customer-onboarding' }] });
    if (url.pathname === '/api/conversations.join') return json({ ok: true });
    return json({ message: 'Not Found' }, 404);
  });
  const gh = { token: 'github_pat_x', account: 'octo', source: 'token' as const };
  assert.deepEqual(await listResources('github', gh, apps.fetcher), [{ id: 'octo/demo', label: 'octo/demo' }]);
  await assert.rejects(selectResource('github', gh, 'octo/no-issues', apps.fetcher), /not available/);
  await assert.rejects(selectResource('github', gh, '../../user', apps.fetcher), /not available/);
  const sl = { token: 'xoxb-x', account: 'Acme', source: 'token' as const };
  assert.deepEqual(await selectResource('slack', sl, 'C0DEMO01', apps.fetcher), { id: 'C0DEMO01', label: '#customer-onboarding' });
  assert.deepEqual(apps.calls.find(c => c.url.pathname === '/api/conversations.join')?.body, { channel: 'C0DEMO01' });
});

test('live configuration needs every app chosen, and the browser view never includes tokens', () => {
  const c: Connections = {
    github: { token: 'gh-secret', account: 'octo', source: 'token', resource: { id: 'octo/demo', label: 'octo/demo' } },
    linear: { token: 'lin-secret', account: 'Acme', source: 'token', resource: { id: 'OPS', label: 'Operations (OPS)' } },
    slack: { token: 'xoxb-secret', account: 'Acme', source: 'token' },
  };
  assert.equal(liveConfigFor(c), undefined);
  assert.doesNotMatch(JSON.stringify(connectionView(c)), /secret/);
  c.slack!.resource = { id: 'C0DEMO01', label: '#customer-onboarding' };
  assert.deepEqual(liveConfigFor(c), {
    github: { token: 'gh-secret', owner: 'octo', repo: 'demo' },
    linear: { token: 'lin-secret', teamKey: 'OPS' },
    slack: { token: 'xoxb-secret', channelId: 'C0DEMO01' },
  });
});

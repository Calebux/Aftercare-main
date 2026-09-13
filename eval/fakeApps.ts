export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const team = ['Jamie Chen', 'Alex Rivera', 'Morgan Lee'].map((name, i) => ({ id: `u${i + 1}`, name }));

export type Member = { id: string; name: string };
export interface FakeRequest { method: string; url: URL; body: any; headers: Record<string, string> }
export interface FakeOptions {
  members?: Member[];
  /** Store Slack text the way Slack does: &, < and > escaped unless already escaped. */
  escapeSlack?: boolean;
  /** Returns a response that overrides the fake for one request, or undefined to let it answer. */
  respond?: (url: URL, body: any) => Response | undefined;
  /** Seeds an issue, an assignment and a message unrelated to the incident, which no repair may change. */
  unrelated?: boolean;
}

const UNRELATED_TS = '1690000000.000001';

/**
 * GitHub, Linear and Slack at their real hosts, answering with their public API shapes
 * for the demo repository, team and channel. Shared by the tests and the evaluation harness.
 */
export function fakeApps(options: FakeOptions = {}) {
  const members = options.members ?? team.slice(0, 2);
  const issues = new Map<number, string>();
  const assignees = new Map<string, string>();
  const deleted: string[] = [];
  const messages: Array<{ ts: string; text: string; thread_ts?: string }> = [];
  const requests: FakeRequest[] = [];
  /** Requests the fake itself answered; overridden requests, such as simulated outages, never took effect. */
  const handled: FakeRequest[] = [];
  if (options.unrelated) {
    issues.set(1, 'open');
    assignees.set('lin-unrelated', members[0]?.name ?? '');
    messages.push({ ts: UNRELATED_TS, text: 'Standup notes for Tuesday.' });
  }
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const override = options.respond?.(url, body);
    if (override) return override;
    handled.push(requests[requests.length - 1]);
    if (url.origin === 'https://api.github.com') {
      const match = url.pathname.match(/^\/repos\/demo-owner\/aftercare-demo(.*)$/);
      if (!match) return json({ message: 'Not Found' }, 404);
      if (match[1] === '') return json({ full_name: 'demo-owner/aftercare-demo' });
      if (match[1] === '/issues' && method === 'POST') { issues.set(issues.size + 1, 'open'); return json({ number: issues.size, state: 'open' }, 201); }
      const number = Number(match[1].match(/^\/issues\/(\d+)$/)?.[1]);
      if (!issues.has(number)) return json({ message: 'Not Found' }, 404);
      if (method === 'PATCH') issues.set(number, body.state);
      return json({ number, state: issues.get(number) });
    }
    if (url.href === 'https://api.linear.app/graphql') {
      const { query, variables: v } = body;
      const named = (id: string | null) => members.find(m => m.id === id)?.name ?? '';
      if (query.includes('teams {')) return json({ data: { teams: { nodes: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }, { id: 'team-ops', key: 'OPS', name: 'Operations' }] } } });
      if (query.includes('users(')) return json({ data: { users: { nodes: members } } });
      if (query.includes('issueCreate')) { assignees.set('lin-1', named(v.i.assigneeId)); return json({ data: { issueCreate: { issue: { id: 'lin-1', identifier: 'OPS-1' } } } }); }
      if (query.includes('issueDelete')) { deleted.push(v.id); return json({ data: { issueDelete: { success: true } } }); }
      if (query.includes('issueUpdate')) { assignees.set(v.id, named(v.i.assigneeId)); return json({ data: { issueUpdate: { success: true } } }); }
      return json({ data: { issue: { assignee: assignees.get(v.id) ? { name: assignees.get(v.id) } : null } } });
    }
    if (url.href === 'https://slack.com/api/chat.postMessage') {
      const ts = `1700000000.${String(100 + messages.length).padStart(6, '0')}`;
      const text: string = options.escapeSlack ? body.text.replace(/&(?!(?:amp|lt|gt);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : body.text;
      messages.push({ ts, text, thread_ts: body.thread_ts });
      return json({ ok: true, ts });
    }
    if (url.origin + url.pathname === 'https://slack.com/api/conversations.history') return json({ ok: true, messages: [] });
    if (url.href === 'https://slack.com/api/chat.delete') {
      const index = messages.findIndex(m => m.ts === body.ts);
      if (index >= 0) messages.splice(index, 1);
      return json({ ok: true });
    }
    if (url.origin + url.pathname === 'https://slack.com/api/conversations.replies') {
      // Slack reads these arguments from the query string; a JSON body would be ignored.
      const parent = url.searchParams.get('ts');
      const thread = messages.filter(m => m.ts === parent || m.thread_ts === parent);
      return json(thread.length ? { ok: true, messages: thread } : { ok: false, error: 'thread_not_found' });
    }
    return json({ ok: false, error: 'unknown_method' });
  }) as unknown as typeof fetch;
  const writes = () => requests.filter(r => (r.url.hostname === 'api.github.com' && r.method !== 'GET') || r.url.pathname === '/api/chat.postMessage' || String(r.body?.query ?? '').startsWith('mutation'));
  /** The unrelated records, so a check can confirm a repair left them alone. */
  const unrelatedState = () => JSON.stringify({ issue: issues.get(1), assignee: assignees.get('lin-unrelated'), message: messages.find(m => m.ts === UNRELATED_TS) });
  return { fetcher, requests, handled, writes, issues, assignees, messages, deleted, unrelatedState };
}

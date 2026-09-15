import { createHash } from 'node:crypto';
import type { BusinessApp, BusinessRun, BusinessStep, Deal } from '../shared/business.js';
import { api, escapeSlack, slack, unescapeSlack, type Endpoint } from './providers.js';
import { RecoveryError } from './errors.js';

export interface BusinessConnection { token: string; account: string; resource?: string; identity: string }
export type BusinessConnections = Partial<Record<BusinessApp, BusinessConnection>>;
const bases = { hubspot: 'https://api.hubapi.com', notion: 'https://api.notion.com', slack: 'https://slack.com' };
const names = { hubspot: 'HubSpot', notion: 'Notion', slack: 'Slack' };
export const businessApps = ['hubspot', 'notion', 'slack'] as const;
export const isBusinessApp = (value: unknown): value is BusinessApp => businessApps.includes(value as BusinessApp);
const endpoint = (app: BusinessApp, token: string, fetcher: typeof fetch): Endpoint => ({ name: names[app], base: bases[app], token, fetch: fetcher });
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' });
const rich = (text: string) => [{ type: 'text', text: { content: text } }];
const plain = (parts: any) => Array.isArray(parts) ? parts.map(p => p.plain_text ?? p.text?.content ?? '').join('') : '';
const normalizedId = (id: string) => id.replaceAll('-', '').toLowerCase();

function parseDeal(value: any): Deal {
  if (!value?.id || !value.properties?.dealname || value.archived) throw new RecoveryError('HubSpot returned an unavailable deal.', 422);
  return { id: String(value.id), name: String(value.properties.dealname).slice(0, 250), stage: String(value.properties.dealstage ?? ''), amount: String(value.properties.amount ?? ''), updatedAt: String(value.updatedAt ?? value.properties.hs_lastmodifieddate ?? '') };
}
export async function listDeals(connection: BusinessConnection, fetcher: typeof fetch = fetch): Promise<Deal[]> {
  const body = await api(endpoint('hubspot', connection.token, fetcher), '/crm/v3/objects/deals?limit=50&properties=dealname,dealstage,amount,hs_lastmodifieddate&archived=false', { headers: headers(connection.token) }, 'listing deals');
  if (!Array.isArray(body?.results)) throw new RecoveryError('HubSpot returned no deal list.', 502);
  return body.results.map(parseDeal);
}
export async function readDeal(connection: BusinessConnection, id: string, fetcher: typeof fetch = fetch): Promise<Deal> {
  if (!/^\d{1,30}$/.test(id)) throw new RecoveryError('Choose a valid HubSpot deal.', 422);
  return parseDeal(await api(endpoint('hubspot', connection.token, fetcher), `/crm/v3/objects/deals/${id}?properties=dealname,dealstage,amount,hs_lastmodifieddate`, { headers: headers(connection.token) }, 'reading the deal'));
}
export async function connectBusinessApp(app: BusinessApp, raw: unknown, resource: unknown, fetcher: typeof fetch = fetch): Promise<BusinessConnection> {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token || token.length > 500 || /\s/.test(token)) throw new RecoveryError('Enter a valid app token.', 422);
  const target = typeof resource === 'string' ? resource.trim() : '';
  const e = endpoint(app, token, fetcher);
  const connection: BusinessConnection = { token, account: names[app], identity: createHash('sha256').update(`${app}:${token}`).digest('hex') };
  if (app === 'hubspot') {
    await listDeals(connection, fetcher);
    connection.account = 'HubSpot · deal access verified';
  } else if (app === 'notion') {
    if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(target)) throw new RecoveryError('Enter the Notion parent page ID (32 characters, with optional hyphens).', 422);
    const page = await api(e, `/v1/pages/${target}`, { headers: headers(token) }, 'checking the parent page');
    if (page?.object !== 'page' || page.archived || page.in_trash) throw new RecoveryError('Choose an active Notion page shared with your integration.', 422);
    connection.resource = String(page.id);
    const title = (Object.values(page.properties ?? {}) as any[]).find(p => p.type === 'title');
    connection.account = plain(title?.title) || 'Notion page';
  } else {
    if (!token.startsWith('xoxb-') || !/^[CG][A-Z0-9]{5,30}$/.test(target)) throw new RecoveryError('Use a Slack bot token and a channel ID.', 422);
    const auth = await slack.get(e, 'auth.test', {});
    const info = await slack.get(e, 'conversations.info', { channel: target });
    if (!info.channel?.is_member || info.channel?.is_archived) throw new RecoveryError('Invite the Slack bot to an active channel first.', 422);
    await slack.get(e, 'conversations.history', { channel: target, limit: '1' });
    connection.resource = target;
    connection.account = `${auth.team ?? 'Slack'} · #${info.channel.name}`;
  }
  return connection;
}
export function connectionTargets(connections: BusinessConnections, notifySlack: boolean): BusinessRun['targets'] {
  if (!connections.hubspot || !connections.notion?.resource || (notifySlack && !connections.slack?.resource)) throw new RecoveryError('Connect HubSpot, a Notion parent page, and Slack if notifications are enabled.', 409);
  return {
    notion: connections.notion.resource,
    ...(notifySlack ? { slack: connections.slack!.resource } : {}),
    signature: createHash('sha256').update([connections.hubspot.identity, connections.notion.identity, connections.notion.resource, ...(notifySlack ? [connections.slack!.identity, connections.slack!.resource] : [])].join(':')).digest('hex'),
  };
}
export interface OnboardingAdapter {
  targets(): BusinessRun['targets'];
  readDeal(id: string): Promise<Deal>;
  write(run: BusinessRun, step: BusinessStep): Promise<{ id: string; url?: string }>;
  verify(run: BusinessRun, step: BusinessStep): Promise<boolean>;
}
export function liveOnboardingAdapter(connections: BusinessConnections, notifySlack: boolean, fetcher: typeof fetch = fetch): OnboardingAdapter {
  const notion = () => endpoint('notion', connections.notion!.token, fetcher);
  const nh = () => headers(connections.notion!.token);
  return {
    targets: () => connectionTargets(connections, notifySlack),
    readDeal: id => readDeal(connections.hubspot!, id, fetcher),
    async write(run, step) {
      if (step.app === 'notion') {
        const body = await api(notion(), '/v1/pages', { method: 'POST', headers: nh(), body: JSON.stringify({
          parent: { page_id: run.targets.notion }, properties: { title: { type: 'title', title: rich(run.draft.title) } },
          children: [
            { object: 'block', type: 'paragraph', paragraph: { rich_text: rich(run.draft.summary) } },
            ...run.draft.tasks.map(task => ({ object: 'block', type: 'to_do', to_do: { rich_text: rich(task), checked: false } })),
          ],
        }) }, 'creating the approved onboarding page');
        if (typeof body?.id !== 'string' || !/^[a-f\d-]{32,36}$/i.test(body.id)) throw new RecoveryError('Notion did not return a page ID. Check Notion before taking further action.', 502);
        return { id: body.id, url: `https://www.notion.so/${normalizedId(body.id)}` };
      }
      const body = await slack.call(endpoint('slack', connections.slack!.token, fetcher), 'chat.postMessage', { channel: run.targets.slack, text: escapeSlack(run.message), mrkdwn: false, unfurl_links: false, unfurl_media: false });
      if (typeof body?.ts !== 'string' || !/^\d+\.\d+$/.test(body.ts)) throw new RecoveryError('Slack did not return a message ID. Check the channel before taking further action.', 502);
      return { id: body.ts, url: `https://slack.com/archives/${run.targets.slack}/p${body.ts.replace('.', '')}` };
    },
    async verify(run, step) {
      if (!step.resultId) return false;
      if (step.app === 'notion') {
        const page = await api(notion(), `/v1/pages/${encodeURIComponent(step.resultId)}`, { headers: nh() }, 'verifying the onboarding page');
        const blocks = await api(notion(), `/v1/blocks/${encodeURIComponent(step.resultId)}/children?page_size=100`, { headers: nh() }, 'verifying the onboarding checklist');
        const title = (Object.values(page?.properties ?? {}) as any[]).find(p => p.type === 'title');
        return !page.archived && !page.in_trash && normalizedId(page.parent?.page_id ?? '') === normalizedId(run.targets.notion)
          && plain(title?.title) === run.draft.title && blocks.has_more === false
          && Array.isArray(blocks.results) && blocks.results.length === run.draft.tasks.length + 1
          && plain(blocks.results[0]?.paragraph?.rich_text) === run.draft.summary
          && run.draft.tasks.every((task, i) => plain(blocks.results[i + 1]?.to_do?.rich_text) === task && blocks.results[i + 1]?.to_do?.checked === false);
      }
      const body = await slack.get(endpoint('slack', connections.slack!.token, fetcher), 'conversations.history', { channel: run.targets.slack!, oldest: step.resultId, latest: step.resultId, inclusive: 'true', limit: '1' });
      const message = body.messages?.find((m: any) => m.ts === step.resultId);
      return !!message && unescapeSlack(String(message.text ?? '')) === run.message;
    },
  };
}

import type { RecordState } from '../shared/types.js';
import { liveEndpoint, type LiveConfig } from './live.js';
import { linear, slack } from './providers.js';
import { RecoveryError } from './errors.js';

/** Resolve the exact provider URL with the visitor's own connection, never a token in a URL. */
export async function recordLink(record: RecordState, config: LiveConfig, fetcher: typeof fetch = fetch) {
  const ref = record.external;
  if (!ref) throw new RecoveryError('This record has no live app link.', 404);
  let value: unknown;
  if (ref.provider === 'github') value = `https://github.com/${encodeURIComponent(ref.owner!)}/${encodeURIComponent(ref.repo!)}/issues/${ref.issueNumber}`;
  if (ref.provider === 'linear') {
    const data = await linear.gql(liveEndpoint('linear', config.linear.token, fetcher), 'query($id:String!){ issue(id:$id){ url } }', { id: ref.issueId }, 'opening the issue link');
    value = data?.issue?.url;
  }
  if (ref.provider === 'slack') {
    const data = await slack.get(liveEndpoint('slack', config.slack.token, fetcher), 'chat.getPermalink', { channel: ref.channelId!, message_ts: ref.ts! });
    value = data?.permalink;
  }
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new RecoveryError('The app did not return a record link.', 502); }
  const host = ref.provider === 'github' ? url.hostname === 'github.com' : ref.provider === 'linear' ? url.hostname === 'linear.app' : url.hostname.endsWith('.slack.com');
  if (!host || url.protocol !== 'https:' || url.username || url.password || url.port) throw new RecoveryError('The app returned an unexpected record link.', 502);
  return url.href;
}

import type { AgentRun } from '../shared/types.js';
import { slack, type Endpoint } from './providers.js';

/** Slack reads &, < and > as control characters; escaping them keeps recorded text from becoming mentions or links. */
export function escapeSlack(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Names what needs repair and links to the review. The link comes from the server's
 * configured address and never carries a session, so forwarding the alert grants nothing.
 */
export function alertText(run: AgentRun, reviewUrl: string) {
  const problems = run.actions.filter(a => a.assessment === 'needs_repair');
  const link = new URL(reviewUrl).href.replace(/[<>|]/g, c => encodeURIComponent(c));
  return [
    `:warning: Aftercare found ${problems.length} change${problems.length === 1 ? '' : 's'} that need repair in ${escapeSlack(run.agent)}'s run.`,
    ...problems.map(a => `• ${escapeSlack(a.summary)}`),
    `Nothing has been changed yet. <${link}|Review the repair in Aftercare>`,
  ].join('\n');
}

/** Posted at the top level of the channel, so it never counts as a correction in the agent's thread. */
export function sendRunAlert(e: Endpoint, channelId: string, run: AgentRun, reviewUrl: string) {
  return slack.post(e, channelId, alertText(run, reviewUrl));
}

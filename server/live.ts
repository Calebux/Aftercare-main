import type { ProviderName, Workspace } from '../shared/types.js';
import { RecoveryError, event, type ProviderAdapter } from './recovery.js';
import { github, linear, providerAdapter, type Endpoint } from './providers.js';
import { runOnboardingAgent } from './agent.js';

/**
 * Live mode repairs real GitHub, Linear and Slack accounts the operator controls.
 * It is meant for dedicated demo resources reached with narrowly scoped tokens.
 */
export interface LiveConfig {
  github: { token: string; owner: string; repo: string };
  linear: { token: string; teamKey: string };
  slack: { token: string; channelId: string };
}

// Prefixed so a broad token already exported in the shell (GITHUB_TOKEN, SLACK_BOT_TOKEN) is never used.
const variables = ['AFTERCARE_GITHUB_TOKEN', 'AFTERCARE_GITHUB_REPO', 'AFTERCARE_LINEAR_API_KEY', 'AFTERCARE_LINEAR_TEAM_KEY', 'AFTERCARE_SLACK_BOT_TOKEN', 'AFTERCARE_SLACK_CHANNEL_ID'] as const;

/**
 * Every value is required, so a partial configuration never enables live writes.
 * `missing` names unset or malformed variables and never includes their values.
 */
export function readLiveConfig(env: NodeJS.ProcessEnv = process.env): { config?: LiveConfig; missing: string[] } {
  const value = (name: typeof variables[number]) => env[name]?.trim() ?? '';
  const repo = value('AFTERCARE_GITHUB_REPO').match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  const channel = /^[CG][A-Z0-9]{6,}$/.test(value('AFTERCARE_SLACK_CHANNEL_ID'));
  const missing = variables.filter(name => !value(name)
    || (name === 'AFTERCARE_GITHUB_REPO' && !repo)
    || (name === 'AFTERCARE_SLACK_CHANNEL_ID' && !channel));
  if (missing.length || !repo) return { missing };
  return {
    missing,
    config: {
      github: { token: value('AFTERCARE_GITHUB_TOKEN'), owner: repo[1], repo: repo[2] },
      linear: { token: value('AFTERCARE_LINEAR_API_KEY'), teamKey: value('AFTERCARE_LINEAR_TEAM_KEY') },
      slack: { token: value('AFTERCARE_SLACK_BOT_TOKEN'), channelId: value('AFTERCARE_SLACK_CHANNEL_ID') },
    },
  };
}

const hosts = { github: 'https://api.github.com', linear: 'https://api.linear.app', slack: 'https://slack.com' } as const;
const names = { github: 'GitHub', linear: 'Linear', slack: 'Slack' } as const;
export const liveEndpoint = (provider: ProviderName, token: string, fetcher: typeof fetch = fetch): Endpoint =>
  ({ name: names[provider], base: hosts[provider], token, fetch: fetcher });
const endpoint = (config: LiveConfig, provider: ProviderName, fetcher: typeof fetch): Endpoint =>
  liveEndpoint(provider, config[provider].token, fetcher);

export function liveAdapter(config: LiveConfig, fetcher: typeof fetch = fetch): ProviderAdapter {
  return providerAdapter('live', record => {
    if (!record.external) throw new RecoveryError(`${record.label} is not linked to a record in the demo apps. Connect them before running a repair.`, 409);
    return { ref: record.external, endpoint: endpoint(config, record.external.provider, fetcher) };
  });
}

/** Checks access to the configured demo resources, then runs the recorded demonstration agent in them. */
export async function connectLive(w: Workspace, config: LiveConfig, fetcher: typeof fetch = fetch) {
  const gh = endpoint(config, 'github', fetcher);
  const lin = endpoint(config, 'linear', fetcher);
  const { owner, repo } = config.github;
  await github.checkRepo(gh, owner, repo);
  const team = (await linear.teams(lin)).find(t => t.key.toUpperCase() === config.linear.teamKey.toUpperCase());
  if (!team) throw new RecoveryError(`Linear has no team with key ${config.linear.teamKey}. Check AFTERCARE_LINEAR_TEAM_KEY.`, 422);
  const run = await runOnboardingAgent(w, {
    github: { endpoint: gh, owner, repo },
    linear: { endpoint: lin, teamId: team.id },
    slack: { endpoint: endpoint(config, 'slack', fetcher), channelId: config.slack.channelId },
  });
  w.mode = 'live';
  const needsRepair = run.actions.filter(a => a.assessment === 'needs_repair').length;
  event(w, `${run.agent} finished`, `Recorded ${run.actions.length} actions in ${owner}/${repo}, Linear team ${team.key} and Slack channel ${config.slack.channelId}; ${needsRepair} need repair. Approved repairs will write to these apps.`, needsRepair ? 'warning' : 'success');
}

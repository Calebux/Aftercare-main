/**
 * Verifies the twin credential path end to end against a live Arga twin:
 * provision → mint an installation token → authenticated read → authenticated write.
 * Prints no credential material. Run with: npx tsx scripts/verify_twin_mint.mts
 */
import { argaConfig, connect, provisionTwin, teardownTwin } from '../server/arga.js';
import { mintGithubToken } from '../server/twins.js';

const config = argaConfig();
if (!config) { console.error('No Arga credential in local configuration.'); process.exit(1); }

const session = await connect(config);
const binding = await provisionTwin(session, 'github', Number(process.env.ARGA_TWIN_TTL_MINUTES || 10));
console.log(`provisioned ${binding.provider} (expires ${binding.expiresAt})`);

try {
  const token = await mintGithubToken(binding.baseUrl);
  console.log(`minted installation token: ${token.slice(0, 4)}… (${token.length} chars)`);

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const repo = await (await fetch(`${binding.baseUrl}/user/repos`, { method: 'POST', headers, body: JSON.stringify({ name: 'onboarding' }) })).json();
  const owner = repo?.owner?.login;
  console.log(`created repo ${owner}/${repo?.name}`);

  const issue = await (await fetch(`${binding.baseUrl}/repos/${owner}/onboarding/issues`, { method: 'POST', headers, body: JSON.stringify({ title: 'Provision Acme workspace' }) })).json();
  console.log(`created issue #${issue?.number} state=${issue?.state}`);

  const patched = await fetch(`${binding.baseUrl}/repos/${owner}/onboarding/issues/${issue?.number}`, { method: 'PATCH', headers, body: JSON.stringify({ state: 'closed' }) });
  console.log(`PATCH issue -> HTTP ${patched.status}`);

  const readBack = await (await fetch(`${binding.baseUrl}/repos/${owner}/onboarding/issues/${issue?.number}`, { headers })).json();
  console.log(`read back state=${readBack?.state}`);
  console.log(readBack?.state === 'closed' ? 'PASS: minted credential can read and write the twin.' : 'FAIL: write did not take effect.');
} finally {
  await teardownTwin(session, binding.runId);
  console.log('torn down');
}

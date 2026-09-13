// A deliberately faulty onboarding agent that works only through Aftercare's MCP gateway.
// It never holds app tokens: Aftercare makes each GitHub, Linear, and Slack call and records it.
//
// Usage: AFTERCARE_AGENT_KEY=aft_... npm run agent:example -- "Owner name" ["Wrong owner"]
// Leave out the wrong owner to remove the owner instead, as in a one-person Linear workspace.
export {};
const url = process.env.AFTERCARE_MCP_URL ?? 'http://127.0.0.1:4310/mcp';
const key = process.env.AFTERCARE_AGENT_KEY;
const [owner, wrongOwner = ''] = process.argv.slice(2);
if (!key) throw new Error('Set AFTERCARE_AGENT_KEY to the key shown in Aftercare.');
if (!owner) throw new Error('Usage: npm run agent:example -- "Owner name" ["Wrong owner"]');

const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` };
let id = 0;
async function rpc(method: string, params?: object) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? `HTTP ${response.status}`);
  return body.result;
}
async function tool(name: string, args: object = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  console.log(`✓ ${name} ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'example-onboarding-agent', version: '1.0.0' } });
await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
console.log(`Tools: ${(await rpc('tools/list')).tools.map((t: { name: string }) => t.name).join(', ')}`);

await tool('start_run', { agent: 'example-onboarding-agent', task: `Onboard Acme and hand off to ${owner}.`, owner });
const { issue: handoff } = await tool('linear_create_issue', { title: 'Acme onboarding handoff', assignee: owner });
await tool('github_create_issue', { title: 'Provision Acme workspace', body: 'Onboarding task for Acme.' });
console.log('… the response timed out, so the agent retries (fault 1)');
await tool('github_create_issue', { title: 'Provision Acme workspace', body: 'Onboarding task for Acme.' });
console.log('… a stale roster names the wrong owner (fault 2)');
await tool('linear_update_assignee', { issue: handoff, assignee: wrongOwner });
await tool('slack_post_message', { text: 'Acme is ready. Workspace provisioned and handoff complete.' });
const finished = await tool('finish_run');
console.log(finished.repairable ? `Aftercare flagged ${finished.flagged} changes. Review and approve the repair at ${finished.review}` : finished.message);

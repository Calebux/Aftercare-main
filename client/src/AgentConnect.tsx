import React, { useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, LoaderCircle } from 'lucide-react';
import type { AgentRun, AppName } from '../../shared/types';
import { AgentRunView } from './AgentRun';

interface Status { keyIssued: boolean; runOpen: boolean; run: AgentRun | null; mcpUrl: string; recorderUrl: string }
const code: React.CSSProperties = { display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: '#fff', border: '1px solid #e4e3dc', borderRadius: 6, padding: '10px 12px', fontSize: 11, lineHeight: 1.6, fontFamily: 'ui-monospace, SFMono-Regular, monospace', color: '#4e4f54', marginTop: 6 };

async function post(path: string) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed.');
  return body;
}

/**
 * Lets a visitor point an MCP client or their own code at Aftercare with a workspace agent key.
 * The key lives only in this component's state: it is shown once and gone after a reload.
 */
export function AgentConnect({ icon, onRunFinished }: { icon: (app: AppName) => React.ReactNode; onRunFinished: () => void }) {
  const [status, setStatus] = useState<Status>();
  const [ready, setReady] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    let stopped = false;
    // Both endpoints read memory only, so polling never reaches the apps.
    const load = () => Promise.all([fetch('/api/agent/status').then(r => r.json()), fetch('/api/connections').then(r => r.json())]).then(([next, connections]) => {
      if (stopped) return;
      setStatus(next); setReady(Boolean(connections.ready));
      if (wasOpen.current && !next.runOpen) onRunFinished();
      wasOpen.current = next.runOpen;
    }).catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  if (!status) return null;

  async function run(task: () => Promise<void>) {
    setWorking(true); setError('');
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setWorking(false); }
  }
  const snippets = key ? [
    ['MCP client (Claude Code)', `claude mcp add --transport http aftercare ${status.mcpUrl} --header "Authorization: Bearer ${key}"`],
    ['Example agent in this repository', `AFTERCARE_AGENT_KEY=${key} npm run agent:example -- "Owner name"`],
    ['Recorder API', `curl -X POST ${status.recorderUrl} \\\n  -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"agent":"my-agent","task":"Onboard Acme","owner":"Owner name"}'`],
  ] : [];

  return <section className="decision-card" style={{ marginBottom: 20 }} aria-labelledby="agent-connect-title">
    <div className="small-label">BRING YOUR OWN AGENT</div>
    <h3 id="agent-connect-title">Record your own agent’s work.</h3>
    <p>Point an MCP client at Aftercare’s gateway, or report actions from your own code. Aftercare checks every GitHub, Linear and Slack action against the apps, flags what needs repair, and waits for your approval. App tokens never leave Aftercare.</p>
    {!ready ? <p style={{ marginTop: 12, fontSize: 12 }}>Connect your apps above first. The agent works only in the repository, team and channel you choose.</p> : <>
      {error && <div className="notice danger" role="alert" style={{ marginTop: 12 }}><span>{error}</span></div>}
      {key ? <div style={{ marginTop: 14 }}>
        <p style={{ fontSize: 12, fontWeight: 600 }}>This agent key is shown once. Store it like a password.</p>
        {snippets.map(([label, value]) => <div key={label} style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>{label}<button className="evidence-link" onClick={() => { navigator.clipboard?.writeText(value).catch(() => {}); }}><Copy size={12} />Copy</button></div>
          <code style={code}>{value}</code>
        </div>)}
      </div> : <p style={{ marginTop: 12, fontSize: 12 }}>{status.keyIssued ? 'An agent key is active. Creating a new key replaces it.' : 'Create a key to connect an agent to this workspace.'}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button className="button primary" disabled={working} onClick={() => run(async () => { setKey((await post('/api/agent/key')).key); setStatus({ ...status, keyIssued: true }); })}>{working ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{status.keyIssued ? 'Replace agent key' : 'Create agent key'}</button>
        {status.keyIssued && <button className="button subtle" disabled={working} onClick={() => run(async () => { await post('/api/agent/key/revoke'); setKey(''); setStatus({ ...status, keyIssued: false }); })}>Revoke key</button>}
      </div>
      {status.runOpen && <div style={{ marginTop: 16 }}><div className="small-label">RECORDING</div><AgentRunView live run={status.run ?? undefined} icon={icon} /></div>}
    </>}
  </section>;
}

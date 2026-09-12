import React, { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { AppName } from '../../shared/types';

type Provider = 'github' | 'linear' | 'slack';
type Resource = { id: string; label: string };
interface AppView { connected: boolean; account?: string; source?: 'env' | 'token'; resource?: Resource | null }
interface ConnectionsView { apps: Record<Provider, AppView>; ready: boolean }

const apps: Array<{ id: Provider; name: AppName; noun: string; placeholder: string; help: string }> = [
  { id: 'github', name: 'GitHub', noun: 'repository', placeholder: 'github_pat_…', help: 'Fine-grained token with Issues: Read and write on a demo repository.' },
  { id: 'linear', name: 'Linear', noun: 'team', placeholder: 'lin_api_…', help: 'Personal API key from your Linear settings.' },
  { id: 'slack', name: 'Slack', noun: 'channel', placeholder: 'xoxb-…', help: 'Bot token from your own Slack app with chat:write, channels:read, channels:join and channels:history.' },
];
const field: React.CSSProperties = { width: '100%', minHeight: 40, padding: '8px 10px', border: '1px solid #deded8', borderRadius: 5, font: 'inherit', fontSize: 12, background: '#fff', color: '#4e4f54' };

async function call(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed.');
  return body;
}
const post = (path: string, data: object) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/** Lets each visitor connect their own apps; tokens go to the server and are never shown again. */
export function ConnectApps({ icon, busy, onCreate }: { icon: (app: AppName) => React.ReactNode; busy: boolean; onCreate: () => void }) {
  const [view, setView] = useState<ConnectionsView>();
  const [tokens, setTokens] = useState<Record<Provider, string>>({ github: '', linear: '', slack: '' });
  const [resources, setResources] = useState<Partial<Record<Provider, Resource[]>>>({});
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  async function run(label: string, task: () => Promise<void>) {
    setWorking(label); setError('');
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setWorking(''); }
  }
  async function loadResources(provider: Provider) {
    const body = await call(`/api/connections/${provider}/resources`);
    setResources(r => ({ ...r, [provider]: body.resources }));
  }
  useEffect(() => { call('/api/connections').then(setView).catch(e => setError(e.message)); }, []);
  // Tokens connected earlier in this session still need their choices listed.
  useEffect(() => {
    if (!view) return;
    for (const app of apps) if (view.apps[app.id].source === 'token' && !resources[app.id]) loadResources(app.id).catch(e => setError(e.message));
  }, [view]);
  if (!view) return error ? <div className="notice danger" role="alert"><span>{error}</span></div> : null;

  return <section className="decision-card" style={{ marginBottom: 20 }} aria-labelledby="connect-title">
    <div className="small-label">TRY IT WITH YOUR OWN APPS</div>
    <h3 id="connect-title">Connect GitHub, Linear and Slack.</h3>
    <p>Aftercare recreates the failed run in a repository, team and channel you choose, then repairs it only after you approve. Use demo resources. Tokens stay on the server for this session and are never shown again.</p>
    {error && <div className="notice danger" role="alert" style={{ marginTop: 14 }}><span>{error}</span></div>}
    {apps.map(app => {
      const state = view.apps[app.id];
      const choices = resources[app.id];
      return <div key={app.id} className="state-card" style={{ margin: '12px 0 0' }}>
        <div>
          {icon(app.name)}
          <h4>{app.name}<small>{state.connected ? `Connected · ${state.account}` : app.help}</small></h4>
          {state.source === 'token' && <button className="button subtle" style={{ marginLeft: 'auto' }} disabled={!!working || busy} onClick={() => run('disconnect', async () => {
            setView(await post(`/api/connections/${app.id}/disconnect`, {}));
            setResources(r => ({ ...r, [app.id]: undefined }));
          })}>Disconnect</button>}
        </div>
        {!state.connected
          ? <form style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); run(app.id, async () => {
              setView(await post(`/api/connections/${app.id}/token`, { token: tokens[app.id] }));
              setTokens(t => ({ ...t, [app.id]: '' }));
              await loadResources(app.id);
            }); }}>
              <input aria-label={`${app.name} token`} type="password" autoComplete="off" spellCheck={false} style={{ ...field, flex: '1 1 220px', width: 'auto' }} placeholder={app.placeholder} value={tokens[app.id]} onChange={e => setTokens(t => ({ ...t, [app.id]: e.target.value }))} />
              <button className="button primary" disabled={!tokens[app.id] || !!working || busy}>{working === app.id && <LoaderCircle className="spin" size={14} />}Connect</button>
            </form>
          : state.source === 'env'
            ? <p style={{ marginTop: 12, fontSize: 12 }}>Using {state.resource?.label} from the server’s .env file.</p>
            : <label style={{ display: 'block', marginTop: 14, fontSize: 12 }}>Choose a {app.noun}
                <select style={{ ...field, marginTop: 6 }} value={state.resource?.id ?? ''} disabled={!!working || busy || !choices?.length} onChange={e => run(app.id, async () => setView(await post(`/api/connections/${app.id}/select`, { id: e.target.value })))}>
                  <option value="" disabled>{!choices ? 'Loading…' : choices.length ? `Select a ${app.noun}` : `No ${app.noun} available to this token`}</option>
                  {(choices ?? []).map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </label>}
      </div>;
    })}
    <button className="button primary full" style={{ marginTop: 16 }} disabled={!view.ready || !!working || busy} onClick={onCreate}>{busy && <LoaderCircle className="spin" size={14} />}Recreate the failed run in my apps</button>
    <span className="summary-caption">Creates two GitHub issues, one Linear issue and one Slack message</span>
  </section>;
}

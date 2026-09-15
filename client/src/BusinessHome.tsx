import React, { useEffect, useState } from 'react';
import { Activity, ArrowRight, ArrowUpRight, BookOpen, Bot, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, ExternalLink, FileText, Grid2X2, Hash, Layers3, LoaderCircle, LockKeyhole, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Unplug, X } from 'lucide-react';
import type { BusinessAgent, BusinessApp, BusinessRun, BusinessView, Deal, PlanningMode } from '../../shared/business';
import './business.css';

type Section = 'agents' | 'runs' | 'apps' | 'settings';
const appNames = { hubspot: 'HubSpot', notion: 'Notion', slack: 'Slack' };
const catalog = [
  { id: 'hubspot', name: 'HubSpot', category: 'Sales', description: 'Bring deal context into your customer handoffs.', status: 'available', mark: 'H', color: '#e57953' },
  { id: 'notion', name: 'Notion', category: 'Knowledge', description: 'Create an onboarding page with a clear checklist.', status: 'available', mark: 'N', color: '#373b39' },
  { id: 'slack', name: 'Slack', category: 'Communication', description: 'Send the team a reviewed, verified handoff.', status: 'available', mark: '#', color: '#86587c' },
  { id: 'jira', name: 'Jira', category: 'Projects', description: 'Delivery tasks, project ownership, and issue tracking.', status: 'planned', mark: 'J', color: '#4179cb' },
  { id: 'gmail', name: 'Gmail', category: 'Communication', description: 'Customer follow-ups and email drafts.', status: 'planned', mark: 'M', color: '#bb655d' },
  { id: 'gcal', name: 'Google Calendar', category: 'Scheduling', description: 'Kickoff meetings and delivery milestones.', status: 'planned', mark: '31', color: '#587caf' },
  { id: 'salesforce', name: 'Salesforce', category: 'Sales', description: 'Account context and sales-to-delivery handoffs.', status: 'planned', mark: 'S', color: '#4b97b7' },
  { id: 'airtable', name: 'Airtable', category: 'Operations', description: 'Shared trackers and operational records.', status: 'planned', mark: 'A', color: '#b58a43' },
  { id: 'teams', name: 'Microsoft Teams', category: 'Communication', description: 'Team updates and approval requests.', status: 'planned', mark: 'T', color: '#7771ae' },
  { id: 'zendesk', name: 'Zendesk', category: 'Support', description: 'Support triage and engineering handoffs.', status: 'planned', mark: 'Z', color: '#47746a' },
  { id: 'github', name: 'GitHub', category: 'Development', description: 'Recorded agent work and approved issue repairs.', status: 'recovery', mark: 'G', color: '#575763' },
  { id: 'linear', name: 'Linear', category: 'Projects', description: 'Recorded handoffs and assignment recovery.', status: 'recovery', mark: 'L', color: '#7972b3' },
];
const statusLabel = { review: 'Needs approval', running: 'Running', complete: 'Verified', needs_attention: 'Needs attention', stale: 'Plan outdated', cancelled: 'Cancelled' };
const freshAgent = () => ({ name: 'Customer onboarding', owner: '', instructions: 'Prepare a customer onboarding page. Include collecting brand assets, confirming project scope, and agreeing on a kickoff date.', notifySlack: true, planning: 'template' as PlanningMode });
function AppMark({ id }: { id: string }) { const app = catalog.find(a => a.id === id)!; return <span className="biz-app-mark" style={{ '--app-color': app?.color ?? '#7162cf' } as React.CSSProperties}>{app?.mark ?? 'A'}</span>; }
function AppTrail({ slack = true }: { slack?: boolean }) { return <div className="biz-app-trail"><AppMark id="hubspot" /><ArrowRight size={13} /><AppMark id="notion" />{slack && <><ArrowRight size={13} /><AppMark id="slack" /></>}</div>; }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/business${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}
export function BusinessHome() {
  const [section, setSection] = useState<Section>('agents');
  const [view, setView] = useState<BusinessView>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<ReturnType<typeof freshAgent> & { id?: string }>();
  const [launch, setLaunch] = useState('');
  const [mode, setMode] = useState<'sample' | 'live'>('sample');
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealId, setDealId] = useState('');
  const [dealsLoading, setDealsLoading] = useState(false);
  const [selectedRun, setSelectedRun] = useState('');
  const [search, setSearch] = useState('');
  const [connection, setConnection] = useState<BusinessApp>();
  const [token, setToken] = useState('');
  const [resource, setResource] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [modelId, setModelId] = useState('');
  const refresh = () => request<BusinessView>('').then(setView);
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!busy && !view?.runs.some(r => r.status === 'running')) return;
    const timer = setInterval(() => { refresh().catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [busy, view?.runs.some(r => r.status === 'running')]);
  useEffect(() => {
    if (!launch) return;
    let current = true;
    setDealsLoading(true); setDeals([]); setDealId(''); setError('');
    request<{ deals: Deal[] }>(`/deals?mode=${mode}`).then(data => { if (current) { setDeals(data.deals); setDealId(data.deals[0]?.id ?? ''); } }).catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setDealsLoading(false); });
    return () => { current = false; };
  }, [launch, mode]);
  async function mutate(path: string, body: unknown, done?: (data: BusinessView & { runId?: string }) => void) {
    setBusy(path); setError(''); setNotice('');
    try { const data = await request<BusinessView & { runId?: string }>(path, body); setView(data); done?.(data); }
    catch (e) { setError(e instanceof Error ? e.message : 'The operation failed.'); await refresh().catch(() => {}); }
    finally { setBusy(''); }
  }
  const navigate = (next: Section) => { setSection(next); setError(''); setNotice(''); setEditor(undefined); setLaunch(''); setConnection(undefined); setToken(''); setResource(''); setModelKey(''); };
  const openRun = (id: string) => { navigate('runs'); setSelectedRun(id); };
  const run = view?.runs.find(r => r.id === selectedRun);
  const pending = view?.runs.filter(r => r.status === 'review').length ?? 0;
  const launchAgent = view?.agents.find(a => a.id === launch);
  function exportRun(run: BusinessRun) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `aftercare-run-${run.id}.json`; link.click(); URL.revokeObjectURL(url);
  }
  const startLaunch = (agent: BusinessAgent) => { setEditor(undefined); setLaunch(agent.id); setMode('sample'); };
  return <div className="biz-shell">
    <aside className="biz-sidebar">
      <a className="brand" href="/" aria-label="Aftercare home"><span className="brand-mark"><span /><span /><span /><span /></span>aftercare<span className="brand-period">.</span></a>
      <div className="biz-workspace"><span>A</span><div>Your workspace<small>Private beta</small></div><ChevronRight size={14} /></div>
      <div className="biz-nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{([
        ['agents', Bot, 'Agents'], ['runs', Activity, 'Runs'], ['apps', Grid2X2, 'Apps'], ['settings', Settings2, 'Settings'],
      ] as const).map(([id, Icon, label]) => <button key={id} aria-label={label} title={label} className={`biz-nav ${section === id ? 'selected' : ''}`} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span>{id === 'runs' && pending > 0 && <b>{pending}</b>}</button>)}
      <a className="biz-nav" href="/recoveries" aria-label="Recoveries" title="Recoveries"><ShieldCheck size={18} /><span>Recoveries</span><ArrowUpRight size={13} /></a></nav>
      <div className="biz-sidebar-note"><span className="biz-note-icon"><ShieldCheck size={19} /></span><strong>You stay in control.</strong><p>Review the plan.<br />Approve the changes.<br />See the verified results.</p></div>
      <div className="biz-profile"><span>W</span><div>Workspace operator<small>Browser session</small></div></div>
    </aside>
    <div className="biz-main-shell">
      <header className="biz-topbar"><div>Workspace<ChevronRight size={13} /><strong>{section[0].toUpperCase() + section.slice(1)}</strong></div><span><span className="biz-dot" />Private beta</span></header>
      <main className="biz-main">
        {error && <div className="biz-notice error" role="alert"><CircleHelp size={18} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}
        {notice && <div className="biz-notice" role="status"><Check size={18} /><span>{notice}</span></div>}
        {!view ? <div className="biz-empty"><LoaderCircle className="spin" /><h2>{error ? 'Workspace unavailable' : 'Opening your workspace…'}</h2>{error && <button className="button outline" onClick={() => { setError(''); refresh().catch(e => setError(e.message)); }}>Try again</button>}</div> : <>
          {section === 'agents' && <>
            <div className="biz-heading"><div><div className="biz-eyebrow">A LITTLE LESS BUSYWORK</div><h1>Give the work<br /><span>a good start.</span></h1><p>Delegate the handoff. Keep your team moving.</p></div><button className="button primary" disabled={!!busy} onClick={() => { setLaunch(''); setEditor(freshAgent()); }}><Plus size={16} />New agent</button></div>
            {!editor && !launch && <section className="biz-intro"><div><span className="biz-tag">YOUR FIRST WORKFLOW</span><h2>From closed deal to clear next steps.</h2><p>Bring a HubSpot deal into Notion, prepare an onboarding checklist, and hand it over in Slack.</p><button className="biz-text-button" onClick={() => { setEditor(freshAgent()); }}>Set up an onboarding agent <ArrowRight size={15} /></button></div><div className="biz-flow"><div><AppMark id="hubspot" /><strong>Deal context</strong><small>Read from HubSpot</small></div><ArrowRight size={17} /><div><AppMark id="notion" /><strong>A shared plan</strong><small>Prepare in Notion</small></div><ArrowRight size={17} /><div><AppMark id="slack" /><strong>A clear handoff</strong><small>Update in Slack</small></div></div></section>}
            {editor && <section className="biz-panel" aria-labelledby="agent-editor-title"><div className="biz-section-heading"><div><h2 id="agent-editor-title">{editor.id ? 'Edit agent' : 'Create your onboarding agent'}</h2><p>Choose the brief and owner. Every run starts with a plan for your approval.</p></div><button aria-label="Close agent editor" disabled={!!busy} onClick={() => setEditor(undefined)}><X size={18} /></button></div>
              <form className="biz-form" onSubmit={e => { e.preventDefault(); mutate('/agents', editor, data => { const saved = editor.id ? data.agents.find(a => a.id === editor.id)! : data.agents.at(-1)!; setEditor(undefined); startLaunch(saved); }); }}>
                <div className="biz-form-grid"><label>Agent name<input required maxLength={80} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label><label>Handoff owner<input required maxLength={100} placeholder="e.g. Sarah" value={editor.owner} onChange={e => setEditor({ ...editor, owner: e.target.value })} /></label></div>
                <label>Instructions<textarea aria-label="Instructions" aria-describedby="instructions-help" required rows={4} maxLength={1200} value={editor.instructions} onChange={e => setEditor({ ...editor, instructions: e.target.value })} /><small id="instructions-help">Describe the onboarding work. This agent creates a page and checklist; it does not send customer emails or create Jira tasks.</small></label>
                <div className="biz-form-grid"><label>Planning<select value={editor.planning} onChange={e => setEditor({ ...editor, planning: e.target.value as PlanningMode })}><option value="template">Guided template · no AI usage</option><option value="managed" disabled={!view.model.managed}>Aftercare AI{!view.model.managed ? ' · not configured' : ''}</option><option value="byok" disabled={!view.model.byok}>My model key{!view.model.byok ? ' · add in Settings' : ''}</option></select><small>{editor.planning === 'template' ? 'Keeps your instructions as the brief, with a standard checklist.' : 'AI turns your instructions into a checklist for review.'}</small></label><label className="biz-checkbox"><input type="checkbox" checked={editor.notifySlack} onChange={e => setEditor({ ...editor, notifySlack: e.target.checked })} /><span>Post an internal handoff in Slack<small>Only after the Notion page is verified.</small></span></label></div>
                <div className="biz-form-footer"><span><ShieldCheck size={15} />Approval required for every run</span><button className="button primary" disabled={!!busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Save agent</button></div>
              </form>
            </section>}
            {launchAgent && <section className="biz-panel" aria-labelledby="launch-title"><div className="biz-section-heading"><div><h2 id="launch-title">Launch {launchAgent.name}</h2><p>Choose a deal to prepare a plan. App changes begin only after approval.</p></div><button aria-label="Close launch" disabled={!!busy} onClick={() => setLaunch('')}><X size={18} /></button></div><form className="biz-form" onSubmit={e => { e.preventDefault(); mutate('/runs', { agentId: launch, mode, dealId }, data => openRun(data.runId!)); }}>
              <div className="biz-mode-switch" role="group" aria-label="Run environment"><button type="button" disabled={!!busy} aria-pressed={mode === 'sample'} onClick={() => setMode('sample')}><Sparkles size={15} />Try sample data</button><button type="button" disabled={!view.liveEnabled || !!busy} aria-pressed={mode === 'live'} onClick={() => setMode('live')}><Layers3 size={15} />Use connected apps</button></div>
              <div className="biz-mode-note">{mode === 'sample' ? 'Sample runs use simulated records and a guided template. No app connections or model usage needed.' : 'This run uses your connected accounts. Check your destinations in Apps before preparing a plan.'}</div>
              <label>HubSpot deal<select required value={dealId} disabled={dealsLoading || !deals.length || !!busy} onChange={e => setDealId(e.target.value)}>{!deals.length && <option value="">{dealsLoading ? 'Loading deals…' : 'No deals available'}</option>}{deals.map(d => <option key={d.id} value={d.id}>{d.name} · {d.stage}</option>)}</select><small>{mode === 'live' ? 'Showing up to 50 deals. Confirm the selected deal is ready for onboarding.' : 'Choose a fictional customer to try the workflow.'}</small></label>
              <div className="biz-form-footer"><AppTrail slack={launchAgent.notifySlack} /><button className="button primary" disabled={!!busy || dealsLoading || !dealId}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}Prepare plan</button></div>
            </form></section>}
            <div className="biz-section-heading"><h2>Your agents <span className="biz-count">{view.agents.length}</span></h2><span className="biz-caption">Run when you need them</span></div>
            {!view.agents.length ? <div className="biz-empty biz-empty-compact"><Bot size={27} /><h3>Your first agent starts here.</h3><p>Give it a brief, choose an owner, and try a sample handoff.</p><button className="button outline" onClick={() => setEditor(freshAgent())}><Plus size={15} />Create an agent</button></div> : <div className="biz-agent-grid">{view.agents.map(agent => <article className="biz-agent-card" key={agent.id}><div className="biz-agent-top"><span className="biz-bot-mark"><Bot size={21} /></span><span className="biz-tag">ON DEMAND</span></div><h3>{agent.name}</h3><p className="biz-agent-description">{agent.instructions}</p><AppTrail slack={agent.notifySlack} /><div className="biz-agent-meta"><span><ShieldCheck size={13} />Approval required</span><span>{agent.owner}</span></div><div className="biz-card-footer"><button className="biz-text-button" disabled={!!busy} onClick={() => { setLaunch(''); setEditor({ ...agent }); }}>Edit instructions</button><button className="button outline" disabled={!!busy} onClick={() => startLaunch(agent)}><Play size={13} />Launch</button></div></article>)}</div>}
            <section className="biz-bottom-note"><BookOpen size={19} /><div><strong>A wider workspace is on the way.</strong><p>Explore Jira, email, CRM, and support tools on the app roadmap.</p></div><button className="biz-text-button" onClick={() => navigate('apps')}>Explore apps <ArrowRight size={15} /></button></section>
          </>}
          {section === 'runs' && <>
            <div className="biz-heading compact"><div><div className="biz-eyebrow">WORK, WITH A RECEIPT</div><h1>Every handoff, accounted for.</h1><p>Review proposed changes and follow the results across your apps.</p></div></div>
            <div className="biz-stats"><div><strong>{pending}</strong><span>Awaiting approval</span></div><div><strong>{view.runs.filter(r => r.status === 'complete').length}</strong><span>Verified runs</span></div><div><strong>{view.runs.filter(r => r.status === 'needs_attention').length}</strong><span>Need attention</span></div></div>
            {!view.runs.length ? <div className="biz-empty"><Activity size={28} /><h2>Your run history starts with a job.</h2><p>Launch an agent to prepare your first plan.</p><button className="button outline" onClick={() => navigate('agents')}>Go to agents <ArrowRight size={15} /></button></div> : <div className="biz-runs-layout"><section className="biz-run-list" aria-label="Run history">{view.runs.map(item => <button key={item.id} className={`biz-run-list-item ${run?.id === item.id ? 'selected' : ''}`} onClick={() => setSelectedRun(item.id)}><div><strong>{item.deal.name}</strong><span>{item.agent.name}</span></div><div><span className={`biz-status ${item.status}`}>{statusLabel[item.status]}</span><small>{item.mode === 'sample' ? 'Sample run' : 'Live apps'} · {new Date(item.createdAt).toLocaleDateString()}</small></div></button>)}</section>
              {run ? <section className="biz-panel biz-run-detail" aria-label="Run details"><div className="biz-section-heading"><div><span className={`biz-status ${run.status}`}>{statusLabel[run.status]}</span><h2>{run.deal.name}</h2><p>{run.mode === 'sample' ? 'Simulated app records' : 'Connected app records'} · {run.agent.planning === 'template' ? 'Guided template' : 'AI-prepared plan'}</p></div><button className="button subtle" onClick={() => exportRun(run)}><FileText size={14} />Export receipt</button></div>
                {run.mode === 'sample' && <div className="biz-mode-note">Sample run · All writes and verification happen against simulated records.</div>}
                {run.error && <div className="biz-notice error"><CircleHelp size={16} /><span>{run.error}</span></div>}
                <div className="biz-run-steps">{run.steps.map((step, i) => <div key={step.app}><span className={`biz-step-number ${step.status === 'verified' ? 'verified' : ''}`}>{step.status === 'verified' ? <Check size={15} /> : i + 1}</span><div><strong>{step.title}</strong><small>{appNames[step.app]} · {step.status === 'pending' ? 'Awaiting execution' : step.status}</small></div>{step.url && <a href={step.url} target="_blank" rel="noreferrer" aria-label={`Open ${appNames[step.app]} result`}><ExternalLink size={16} /></a>}</div>)}</div>
                <div className="biz-draft"><div className="biz-draft-label"><AppMark id="notion" /><span>NOTION PAGE PREVIEW</span></div><h3>{run.draft.title}</h3><p>{run.draft.summary}</p><ul>{run.draft.tasks.map((task, i) => <li key={i}><span className="biz-unchecked" />{task}</li>)}</ul></div>
                {run.agent.notifySlack && <div className="biz-draft"><div className="biz-draft-label"><AppMark id="slack" /><span>SLACK MESSAGE PREVIEW</span></div><p>{run.message}</p></div>}
                <div className="biz-run-destinations"><strong>Destinations</strong><span>Notion: {run.targets.notion}</span>{run.targets.slack && <span>Slack: {run.targets.slack}</span>}</div>
                {run.status === 'review' && <div className="biz-approval"><div><ShieldCheck size={19} /><span><strong>Review before you delegate.</strong><small>{run.steps.length} new records. The checklist describes work still to do.</small></span></div><div><button className="button outline" disabled={!!busy} onClick={() => mutate(`/runs/${run.id}/cancel`, {})}>Cancel plan</button><button className="button primary" disabled={!!busy} onClick={() => mutate(`/runs/${run.id}/execute`, {})}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{run.mode === 'sample' ? 'Approve & run sample' : 'Approve & run in apps'}</button></div></div>}
                {run.status === 'needs_attention' && <button className="button outline" disabled={!!busy} onClick={() => mutate(`/runs/${run.id}/execute`, {})}>{busy ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}Verify & resume</button>}
                {run.status === 'complete' && <div className="biz-complete"><CheckCheck size={20} /><div><strong>{run.mode === 'sample' ? 'Sample handoff verified.' : 'Handoff verified.'}</strong><p>The page{run.agent.notifySlack ? ' and team message match' : ' matches'} the approved plan. The onboarding checklist is ready for the team to work through.</p></div></div>}
                <details className="biz-events"><summary>Activity · {run.events.length} events</summary>{run.events.map((event, i) => <div key={i}><Clock3 size={13} /><p>{event.detail}</p><time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>)}</details>
              </section> : <div className="biz-empty"><FileText size={26} /><h3>Select a run to see its plan and results.</h3></div>}
            </div>}
          </>}
          {section === 'apps' && <>
            <div className="biz-heading compact"><div><div className="biz-eyebrow">YOUR TOOLS, WORKING TOGETHER</div><h1>A home for your business apps.</h1><p>Connect the tools for your first workflow. Explore what comes next.</p></div></div>
            <div className="biz-app-toolbar"><label><Search size={17} /><input aria-label="Search apps" placeholder="Search apps or categories…" value={search} onChange={e => setSearch(e.target.value)} /></label><span>{view.connections.filter(c => c.connected).length} connected for onboarding</span></div>
            {connection && <section className="biz-panel" aria-labelledby="connection-title"><div className="biz-section-heading"><div><h2 id="connection-title">Connect {appNames[connection]}</h2><p>Tokens stay in server memory for this browser session. Reconnect after a server restart.</p></div><button aria-label="Close connection form" disabled={!!busy} onClick={() => { setConnection(undefined); setToken(''); }}><X size={18} /></button></div>
              <div className="biz-connect-help">{connection === 'hubspot' ? <p>Use a HubSpot private app token with <code>crm.objects.deals.read</code>. Aftercare reads deals and does not modify your CRM. <a href="https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide" target="_blank" rel="noreferrer">Setup reference <ExternalLink size={12} /></a></p> : connection === 'notion' ? <p>Create a Notion internal integration with read and insert content access. Share the parent page with it, then copy the page ID from its URL. <a href="https://developers.notion.com/guides/get-started/quick-start" target="_blank" rel="noreferrer">Setup guide <ExternalLink size={12} /></a></p> : <p>Use a Slack bot token with <code>chat:write</code>, <code>channels:read</code>, and <code>channels:history</code> (private channels need the corresponding <code>groups</code> scopes). Invite the bot to the selected channel.</p>}</div>
              <form className="biz-form" onSubmit={e => { e.preventDefault(); mutate(`/connections/${connection}`, { token, resource }, () => { setToken(''); setResource(''); setConnection(undefined); setNotice('App connected. You can now prepare a live onboarding plan.'); }); }}><label>{appNames[connection]} token<input type="password" required autoComplete="off" maxLength={500} value={token} onChange={e => setToken(e.target.value)} /></label>{connection !== 'hubspot' && <label>{connection === 'notion' ? 'Notion parent page ID' : 'Slack channel ID'}<input required value={resource} onChange={e => setResource(e.target.value)} placeholder={connection === 'notion' ? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' : 'C0123456789'} /></label>}<div className="biz-form-footer"><span><LockKeyhole size={14} />Credentials are never included in receipts</span><button className="button primary" disabled={!!busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}Connect {appNames[connection]}</button></div></form>
            </section>}
            <div className="biz-app-grid">{catalog.filter(app => `${app.name} ${app.category}`.toLowerCase().includes(search.toLowerCase())).map(app => { const connected = view.connections.find(c => c.app === app.id && c.connected); return <article key={app.id} className="biz-app-card"><div className="biz-app-card-top"><AppMark id={app.id} /><span className={`biz-status ${connected ? 'complete' : ''}`}>{connected ? 'Connected' : app.status === 'available' ? 'Available' : app.status === 'recovery' ? 'Recovery workflows' : 'Planned'}</span></div><h3>{app.name}</h3><span className="biz-caption">{app.category}</span><p>{app.description}</p>{connected && <small className="biz-connected-account">{connected.account}</small>}<div className="biz-card-footer">{app.status === 'available' ? <button className="button outline full" disabled={!!busy || !view.liveEnabled} onClick={() => { if (connected) mutate(`/connections/${app.id}`, { disconnect: true }); else { setToken(''); setResource(''); setConnection(app.id as BusinessApp); } }}>{connected ? <><Unplug size={14} />Disconnect</> : <><Plus size={14} />Connect {app.name}</>}</button> : app.status === 'recovery' ? <a className="biz-text-button" href="/recoveries">Open recoveries <ArrowUpRight size={14} /></a> : <span className="biz-caption">On the integration roadmap</span>}</div></article>; })}</div>
            {!catalog.some(app => `${app.name} ${app.category}`.toLowerCase().includes(search.toLowerCase())) && <div className="biz-empty"><Search size={24} /><h3>No matching apps.</h3><p>Try a different app name or category.</p></div>}
            {!view.liveEnabled && <p className="biz-caption biz-spaced">This environment has live connections disabled. You can still try the entire onboarding workflow with sample data.</p>}
          </>}
          {section === 'settings' && <>
            <div className="biz-heading compact"><div><div className="biz-eyebrow">MAKE IT YOURS</div><h1>Your models. Your control.</h1><p>Choose how agents prepare work, with approval before every app change.</p></div></div>
            <div className="biz-settings-grid"><section className="biz-panel"><span className="biz-bot-mark"><Sparkles size={22} /></span><h2 className="biz-spaced">Planning options</h2><div className="biz-setting-row"><div><strong>Guided template</strong><p>Standard checklist with your brief preserved. Available for every workspace.</p></div><span className="biz-status complete">Available</span></div><div className="biz-setting-row"><div><strong>Aftercare AI</strong><p>AI planning through the service operator’s configured model.</p></div><span className="biz-status">{view.model.managed ? 'Available' : 'Not configured'}</span></div><div className="biz-setting-row"><div><strong>Your model key</strong><p>Use your OpenRouter account for inference. Choose this option when editing an agent.</p></div><span className={`biz-status ${view.model.byok ? 'complete' : ''}`}>{view.model.byok ? 'Key added' : 'Optional'}</span></div><p className="biz-caption">AI planning sends the selected deal, owner, and instructions to the model provider. This beta limits AI planning to 10 requests per workspace per hour. Sample runs always use the guided template.</p></section>
              <section className="biz-panel"><h2>Bring your own key</h2><p className="biz-caption biz-spaced">Stored in server memory for this session. Your provider bills model usage separately. The key is checked when you prepare an AI plan.</p><form className="biz-form" onSubmit={e => { e.preventDefault(); mutate('/model', { key: modelKey, model: modelId }, () => { setModelKey(''); setNotice('Model key added. Select “My model key” when editing an agent.'); }); }}><label>OpenRouter API key<input type="password" required autoComplete="off" value={modelKey} onChange={e => setModelKey(e.target.value)} /></label><label>Model ID<input required placeholder="provider/model-name" maxLength={120} value={modelId} onChange={e => setModelId(e.target.value)} /></label><button className="button primary" disabled={!!busy || !view.liveEnabled}>{busy ? <LoaderCircle size={15} className="spin" /> : <LockKeyhole size={15} />}Save model key</button>{view.model.byok && <button type="button" className="button outline" disabled={!!busy} onClick={() => mutate('/model', { disconnect: true }, () => setNotice('Model key removed.'))}>Remove saved key</button>}</form></section></div>
            <section className="biz-bottom-note"><ShieldCheck size={20} /><div><strong>Built for a supervised first launch.</strong><p>Manual runs, reviewed plans, and persisted run history. App and model keys need reconnecting after restart. Browser workspaces are temporary; export receipts you want to keep.</p></div></section>
          </>}
        </>}
        <footer className="biz-footer"><span>aftercare<span>.</span></span><p>A clear brief. A reviewed plan. A verified handoff.</p></footer>
      </main>
    </div>
  </div>;
}

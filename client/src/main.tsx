import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDown, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, Circle, Clock3, Code2, ExternalLink, FileText, GitBranch, Github, Hash, Layers3, LoaderCircle, LockKeyhole, PanelRightClose, Play, RotateCcw, ShieldCheck, Sparkles, TriangleAlert, X, Zap } from 'lucide-react';
import type { AgentRun, AppName, RepairOperation, Workspace } from '../../shared/types';
import { ConnectApps } from './ConnectApps';
import { AgentRunView } from './AgentRun';
import { Welcome } from './Welcome';
import { EvaluationView } from './Evaluation';
import { evidenceScenarios } from '../../shared/scenarios';

const WELCOME_SEEN = 'aftercare.welcome.seen';
import './styles.css';

function AppIcon({ app, small = false }: { app: AppName; small?: boolean }) {
  return <span className={`app-icon ${app.toLowerCase()} ${small ? 'small' : ''}`}>{app === 'GitHub' ? <Github size={small ? 14 : 20} /> : app === 'Slack' ? <Hash size={small ? 15 : 22} /> : <span className="linear-mark" />}</span>;
}
function App() {
  const [w, setW] = useState<Workspace>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'repair' | 'run' | 'activity' | 'state'>('repair');
  const [evidence, setEvidence] = useState<RepairOperation>();
  const [interrupt, setInterrupt] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [liveRun, setLiveRun] = useState<AgentRun>();
  const [showEvaluation, setShowEvaluation] = useState(false);
  // While the agent runs, poll the in-memory recording so each action appears as it happens.
  useEffect(() => {
    if (busy !== 'connect-live') return;
    setLiveRun(undefined);
    const timer = setInterval(() => { fetch('/api/run/live').then(r => r.json()).then(body => setLiveRun(body.run ?? undefined)).catch(() => {}); }, 600);
    return () => clearInterval(timer);
  }, [busy]);
  // Shown on a first visit; storage can be unavailable, in which case it simply shows again.
  const [showWelcome, setShowWelcome] = useState(() => { try { return localStorage.getItem(WELCOME_SEEN) !== '1'; } catch { return true; } });
  const dismissWelcome = () => { setShowWelcome(false); try { localStorage.setItem(WELCOME_SEEN, '1'); } catch { /* storage unavailable */ } };
  const [config, setConfig] = useState({ investigator: 'scenario', model: '', twins: 'unconfigured', connections: 'disabled', hosted: false, mode: 'local' });
  useEffect(() => { fetch('/api/workspace').then(r => { if (!r.ok) throw new Error('Cannot load workspace.'); return r.json(); }).then(setW).catch(e => setError(e.message)); }, []);
  useEffect(() => { fetch('/api/config').then(r => r.json()).then(setConfig).catch(() => {}); }, []);
  useEffect(() => {
    if (busy !== 'prepare') return;
    const timer = setInterval(() => { fetch('/api/workspace').then(r => r.json()).then(setW).catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => { const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') { setEvidence(undefined); setShowReset(false); setShowEvaluation(false); dismissWelcome(); } }; window.addEventListener('keydown', fn); return () => window.removeEventListener('keydown', fn); }, []);
  useEffect(() => {
    if (!evidence && !showReset && !showWelcome && !showEvaluation) return;
    const previous = document.activeElement as HTMLElement;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')];
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [evidence, showReset, showWelcome, showEvaluation]);
  async function action(name: string, extra = {}) {
    setBusy(name); setError('');
    try {
      const r = await fetch(`/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(extra) });
      const body = await r.json();
      if (!r.ok) { if (body.workspace) setW(body.workspace); throw new Error(body.error); }
      setW(body);
      if (name === 'connect-live') setTab('run');
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); }
    finally { setBusy(''); }
  }
  const escalated = w?.investigation?.outcome === 'escalated';
  const plan = escalated ? undefined : w?.plans.at(-1);
  const provenance = w?.run?.mode === 'recorded' ? 'Captured from the demonstration agent’s real tool calls' : w?.mode === 'twin' ? 'Seeded evidence in Arga twins' : 'Simulated scenario evidence';
  const twinMode = w?.mode === 'twin';
  const liveMode = w?.mode === 'live';
  const remote = twinMode || liveMode;
  const soonest = (w?.twins ?? []).map(b => b.expiresAt).filter(Boolean).sort()[0];
  const twinExpiry = soonest ? new Date(soonest).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const complete = plan?.status === 'complete';
  const stale = plan?.status === 'stale';
  const approved = plan?.status === 'approved';
  const interrupted = plan?.status === 'interrupted';
  const held = plan?.operations.filter(o => o.status === 'held' && o.app === 'Linear').length || 0;
  const writes = plan?.operations.filter(o => o.status !== 'held' && o.status !== 'unchanged').length || 0;
  const verified = plan?.operations.filter(o => o.status === 'verified').length || 0;
  function exportReceipt() {
    if (!w) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ mode: w.mode, incidentId: w.incidentId, provenance, investigation: w.investigation, sourceActions: w.sourceActions, run: w.run, plan, records: w.records, events: w.events }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = escalated ? 'aftercare-investigation-receipt.json' : 'aftercare-recovery-receipt.json'; a.click(); URL.revokeObjectURL(url);
  }
  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Aftercare home"><span className="brand-mark"><span /><span /><span /><span /></span>aftercare<span className="brand-period">.</span></a>
      <div className="workspace-picker"><span className="workspace-avatar">A</span><div>Acme workspace<small>Development</small></div><ChevronRight size={14} /></div>
      <div className="nav-label">WORKSPACE</div>
      <button className="nav-item active" onClick={() => { setTab('repair'); setEvidence(undefined); }}><Layers3 size={17} />Recoveries<span className="nav-count">1</span></button>
      <button className={`nav-item ${tab === 'activity' ? 'selected' : ''}`} onClick={() => setTab('activity')}><Activity size={17} />Activity</button>
      <button className={`nav-item ${tab === 'state' ? 'selected' : ''}`} onClick={() => setTab('state')}><GitBranch size={17} />App state</button>
      <button className="nav-item" onClick={() => setShowEvaluation(true)}><ShieldCheck size={17} />Evaluation</button>
      <div className="sidebar-divider" />
      <div className="nav-label">{liveMode ? 'CONNECTED TO DEMO APPS' : twinMode ? 'CONNECTED TO TWINS' : 'CONNECTED TO SCENARIO'}</div>
      {(['GitHub', 'Linear', 'Slack'] as AppName[]).map(app => <button className="app-nav" key={app} onClick={() => setTab('state')}><AppIcon app={app} small />{app}<span className="local-dot" style={remote ? { background: '#7fae8f' } : undefined} /></button>)}
      <div className="sidebar-bottom">
        <div className="sandbox-label"><Code2 size={15} />{liveMode ? 'LIVE DEMO APPS' : twinMode ? 'ARGA TWINS' : 'LOCAL SCENARIO'}</div>
        <p>{liveMode
          ? <>Approved repairs write to your<br />GitHub, Linear and Slack.</>
          : twinMode
          ? <>Repairs write to real twin APIs.<br />{twinExpiry ? `Session ends ${twinExpiry}.` : 'Session active.'}</>
          : <>App records are simulated.<br />No external writes are enabled.</>}</p>
        {!remote && config.twins === 'available' && <button className="button subtle full" style={{ marginTop: 12 }} disabled={!!busy} onClick={() => action('provision-twins')}>{busy === 'provision-twins' ? <><LoaderCircle size={13} className="spin" />Provisioning…</> : <><Zap size={13} />Provision twins</>}</button>}
        <div className="profile"><span>CA</span><div>Caleb<small>Workspace owner</small></div></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}><span>Recoveries</span><ChevronRight size={13} /><strong>REC-024</strong></div><div style={{ gap: 6, flexShrink: 0 }}><button className="button subtle" style={{ paddingInline: 9 }} onClick={() => setShowEvaluation(true)}>Evaluation</button><button className="button subtle" style={{ paddingInline: 9 }} onClick={() => setShowWelcome(true)}>How it works</button><span className="top-status"><span />Development workspace</span></div></header>
      <main>
        <div className="eyebrow"><span className="tiny-square" />AGENT RECOVERY<span className="mono">/ 024</span></div>
        <div className="page-heading"><div><h1>A clean handoff.<br /><span>Even after a messy run.</span></h1><p>Review the impact. Preserve the good work. Repair the rest.</p></div><button className="button subtle" onClick={() => setShowReset(true)} disabled={!!busy}><RotateCcw size={14} />Reset scenario</button></div>
        {error && <div className="notice danger" role="alert"><TriangleAlert size={17} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {!w ? <div className="loading"><LoaderCircle className="spin" />{error ? 'Workspace unavailable. Reload to try again.' : 'Loading recovery workspace…'}</div> : <>
          {busy === 'connect-live' && <section className="decision-card" style={{ marginBottom: 20 }}><div className="small-label">LIVE RUN</div><AgentRunView live run={liveRun} icon={app => <AppIcon app={app} small />} /></section>}
          {config.connections === 'enabled' && w.mode === 'local' && !plan && busy !== 'connect-live' && <ConnectApps icon={app => <AppIcon app={app} />} busy={busy === 'connect-live'} onCreate={() => action('connect-live')} />}
          {w.mode === 'local' && !w.plans.length && <section className="scenario-picker" aria-label="Evidence scenarios"><label htmlFor="evidence-case">Explore a different incident</label><select id="evidence-case" disabled={!!busy} defaultValue="" onChange={e => { if (e.target.value) { setTab('repair'); action('scenario', { scenario: e.target.value }); } }}><option value="" disabled>Choose sample evidence</option>{evidenceScenarios.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select><p>Simulated app records · {config.investigator === 'openrouter' ? 'AI chooses from scoped repairs, preservation, or escalation.' : 'Scenario rules; enable AI to evaluate semantic decisions.'}</p></section>}
          <section className="incident-card">
            <div className="incident-top"><div className="incident-title"><span className={`incident-icon ${complete ? 'resolved' : ''}`}>{complete ? <CheckCheck size={20} /> : <GitBranch size={20} />}</span><div><div className="small-label">ONBOARDING WORKFLOW</div><h2>Acme onboarding went off course</h2></div></div><span className={`status-pill ${complete ? 'green' : escalated || stale || interrupted ? 'amber' : 'purple'}`}><span />{escalated ? 'Human investigation required' : complete ? 'Recovery verified' : stale ? 'Review needs updating' : interrupted ? 'Recovery interrupted' : approved ? 'Approved to repair' : plan ? 'Ready for review' : 'Needs recovery'}</span></div>
            <p className="incident-description">A repeated issue title, an ownership change, and a completion message.<br className="desktop-break" /> {w.run ? `${w.run.agent} made ${w.run.actions.filter(a => a.actor === w.run!.agent).length} changes; ${w.run.actions.filter(a => a.assessment === 'needs_repair').length} flagged for review.` : 'Three successful API calls. One unfinished onboarding.'}</p>
            <div className="incident-meta"><span><span className="agent-avatar"><Sparkles size={12} /></span>onboarding-agent</span><span><Clock3 size={13} />{w.run?.mode === 'recorded' ? 'Recorded from real tool calls' : 'Simulated recording'}</span><span className="mono">run_8f24</span><div className="app-stack">{(['GitHub', 'Linear', 'Slack'] as AppName[]).map(app => <AppIcon key={app} app={app} small />)}<span>3 apps affected</span></div></div>
            <div className="progress-rail">{['Investigate', 'Review repair', 'Apply changes', 'Verify outcome'].map((step, i) => { const current = !plan ? 0 : complete ? 4 : approved || interrupted ? 2 : 1; return <div className={`rail-step ${i < current ? 'done' : i === current ? 'current' : ''}`} key={step}><span>{i < current ? <Check size={12} /> : `0${i + 1}`}</span>{step}{i < 3 && <span className="rail-line" />}</div>; })}</div>
          </section>
          <div className="content-grid"><section className="review-panel">
            <div className="tabs" role="tablist" aria-label="Recovery details">{([['repair', 'Repair plan'], ['run', 'Agent run'], ['activity', 'Activity'], ['state', 'App state']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={tab === id ? 'tab active' : 'tab'}>{label}{id === 'repair' && plan && <span>{writes}</span>}{id === 'run' && w.run && <span>{w.run.actions.length}</span>}{id === 'activity' && <span>{w.events.length}</span>}</button>)}<span className="tab-note">{plan ? `VERSION ${String(plan.version).padStart(2, '0')}` : 'AWAITING INVESTIGATION'}</span></div>
            {tab === 'repair' && <div className="tab-content">
              {escalated && <div className="notice danger" role="status"><TriangleAlert size={20} /><div><strong>Human investigation required</strong><p>{w.investigation?.summary}</p><small>{w.investigation?.model} · No repair is available to approve. Resolve the evidence conflict before investigating again.</small></div></div>}
              {!plan ? <div className="empty-plan"><span className="empty-icon"><Layers3 size={28} /></span><h3>{escalated ? 'Clarify the evidence before continuing.' : 'Every recovery starts with evidence.'}</h3><p>Compare the agent’s recorded actions with the current app state to prepare a reviewable repair.</p><button className="button primary" disabled={!!busy} onClick={() => action('prepare')}>{busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{busy === 'prepare' ? 'Investigating…' : escalated ? 'Investigate again' : config.investigator === 'openrouter' ? 'Investigate & prepare repair' : 'Prepare repair plan'}<ArrowRight size={15} /></button><small>{config.investigator === 'openrouter' ? 'OpenRouter investigator · read-only tools · no changes applied' : 'Scenario rules · 3 recorded actions · no changes applied'}</small></div> : <>
                <div className="plan-intro"><div><h3>{complete ? 'The outcome, verified.' : stale ? 'The world changed. Your plan should too.' : 'Small corrections. Clear consequences.'}</h3><p>{complete ? `Each approved change was checked against the resulting ${liveMode ? 'live' : twinMode ? 'twin' : 'local'} app state.` : stale ? 'A human updated a record after this preview. Refresh before approving.' : `${writes} proposed changes${held ? ` · ${held} human decision preserved` : ' · review each change before approval'}.`}</p></div><ShieldCheck size={21} /></div>
                {w.investigation?.outcome !== 'escalated' && w.investigation && <div className="investigation-summary"><div><Sparkles size={15} /><span>{w.investigation.provider === 'openrouter' ? 'AI INVESTIGATION' : 'SCENARIO RULES'}</span><small>{w.investigation.toolCalls} tool calls{w.investigation.rejectedRecommendations ? ` · ${w.investigation.rejectedRecommendations} responses rejected before completion` : ''}</small></div><p>{w.investigation.summary}</p><small>{w.investigation.model} · recommendations validated by recovery policy</small></div>}
                {plan.operations.map((op, i) => <article className={`repair-card ${op.status === 'held' ? 'held' : ''}`} key={op.id}>
                  <div className="repair-top"><AppIcon app={op.app} /><div><span className="small-label">{op.app} <span className="record-label">{w.records.find(r => r.id === op.recordId)?.label}</span></span><h4>{op.title}</h4></div><span className={`operation-state ${op.status}`}>{op.status === 'verified' ? <><Check size={12} />Verified</> : op.status === 'held' ? <><LockKeyhole size={12} />Preserved</> : op.status === 'unchanged' ? <><Check size={12} />Already matches</> : op.status === 'running' || op.status === 'uncertain' ? 'Unconfirmed' : `0${i + 1}`}</span></div>
                  <div className="field-diff"><div className="diff-label">{op.field === 'correction' ? 'THREAD REPLY' : op.field.toUpperCase()}</div>{op.status === 'held' || op.status === 'unchanged' ? <div className="preserved-value"><LockKeyhole size={13} />{op.observed}<span>Keep current value</span></div> : <><div className="diff-before"><span>−</span>{op.observed || (op.field === 'correction' ? 'No correction posted' : 'Unassigned')}</div><div className="diff-after"><span>+</span>{op.proposed}</div></>}</div>
                  <div className="repair-bottom"><p>{op.reason}</p>{liveMode && <a className="evidence-link" href={`/api/records/${encodeURIComponent(op.recordId)}/open`} target="_blank" rel="noreferrer">Open in {op.app}<ExternalLink size={13} /></a>}<button className="evidence-link" onClick={() => setEvidence(op)}>Evidence<ArrowUpRight size={13} /></button></div>
                </article>)}
                <div className="plan-footnote"><LockKeyhole size={13} /><span>{remote ? `${liveMode ? 'App' : 'Twin'} state is checked before each write. Providers do not offer atomic protection against edits between a read and write.` : complete ? 'Verification covers this local scenario.' : 'State is checked before each write. A changed record blocks a stale repair.'}</span></div>
              </>}
            </div>}
            {tab === 'run' && <AgentRunView run={w.run} icon={app => <AppIcon app={app} small />} />}
            {tab === 'activity' && <div className="activity-list"><div className="section-intro"><h3>A record of every decision.</h3><p>Persisted locally, including conflicts and interrupted writes.</p></div>{[...w.events].reverse().map(e => <div className={`activity-event ${e.kind}`} key={e.id}><span className="activity-dot">{e.kind === 'success' ? <Check size={13} /> : e.kind === 'warning' ? <TriangleAlert size={12} /> : <Circle size={9} />}</span><div><h4>{e.title}</h4><p>{e.detail}</p><time>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div></div>)}</div>}
            {tab === 'state' && <div className="state-list"><div className="section-intro"><h3>What the apps contain now.</h3><p>{liveMode ? 'Last observed values from your demo apps. Refreshed during preparation, approval, and execution.' : twinMode ? 'Last observed twin values. Refreshed during preparation, approval, and execution.' : 'Actual records in the local adapter. Refreshes after each operation.'}</p></div>{w.records.map(record => <article className="state-card" key={record.id}><div><AppIcon app={record.app} /><h4>{record.title}<small>{record.label} · revision {record.revision} · last changed by {record.lastActor}</small></h4></div><dl>{Object.entries(record.fields).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v || '—'}</dd></React.Fragment>)}</dl></article>)}</div>}
          </section>
          <aside className="right-column">
            <section className="decision-card"><div className="small-label">RECOVERY SUMMARY</div><h3>{complete ? 'Back on solid ground.' : 'You stay in control.'}</h3><p>{complete ? 'The repair has finished. Review or export the evidence behind the result.' : 'Approve a specific set of changes, with the evidence in reach.'}</p><div className="summary-stats"><div><span>Apps involved</span><strong>03</strong></div><div><span>{complete ? 'Changes verified' : 'Proposed changes'}</span><strong>{String(complete ? verified : writes).padStart(2, '0')}</strong></div><div><span>Human decisions preserved</span><strong>{String(held).padStart(2, '0')}</strong></div></div>
              {plan && <div className={`decision-note ${stale || interrupted ? 'warning' : ''}`}>{stale || interrupted ? <TriangleAlert size={16} /> : complete ? <ShieldCheck size={16} /> : <LockKeyhole size={16} />}<span>{stale ? 'Approval is blocked. Review the changed record in a new plan.' : interrupted ? 'A write may have succeeded. Resume will check it before continuing.' : complete ? 'Observed outcomes match the approved repair.' : 'Approval applies only to this version of the repair.'}</span></div>}
              {escalated ? <button className="button primary full" onClick={exportReceipt}><FileText size={15} />Export investigation receipt<ArrowDown size={14} /></button> : !plan ? <button className="button full" disabled><LockKeyhole size={14} />Prepare a plan first</button> : complete ? <button className="button primary full" onClick={exportReceipt}><FileText size={15} />Export recovery receipt<ArrowDown size={14} /></button> : stale ? <button className="button primary full" disabled={!!busy} onClick={() => action('prepare')}><RotateCcw size={15} />Review updated plan</button> : approved || interrupted ? <button className="button primary full" disabled={!!busy} onClick={() => action('execute', { planId: plan.id, interrupt: interrupted ? false : interrupt })}>{busy ? <LoaderCircle className="spin" size={15} /> : <Play size={14} />}{interrupted ? 'Reconcile & resume' : 'Apply approved repair'}</button> : <button className="button primary full" disabled={!!busy} onClick={() => action('approve', { planId: plan.id })}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Approve {writes} changes<ArrowRight size={14} /></button>}
              <span className="summary-caption">{complete ? 'JSON · plan, app state, and audit events' : liveMode ? 'Changes apply to your connected demo apps' : twinMode ? 'Changes apply to the provisioned Arga twins' : 'Changes apply to the local scenario only'}</span>
            </section>
            <section className="challenge-card"><span className="challenge-icon"><Zap size={15} /></span><div className="small-label">PUT IT TO THE TEST</div><h3>Someone changed the plan.</h3><p>{liveMode ? 'Prepare a repair, then reassign the task in Linear. Try approving: Aftercare should stop, preserve the person’s choice, and ask for a new review.' : twinMode ? 'Change the assignment in the Linear twin. Approval will refresh its state and require a new review if it changed.' : 'Reassign the Linear task while the repair is waiting. Aftercare should preserve the human’s decision.'}</p><button className="button full outline" disabled={!!busy || !plan || complete || interrupted || remote} onClick={() => action('human-edit')}>Simulate a human edit<ArrowUpRight size={14} /></button><label className="fault-toggle"><input type="checkbox" checked={interrupt} disabled={!!busy || complete || interrupted} onChange={e => setInterrupt(e.target.checked)} /><span>Interrupt after the first write<small>Test read-back recovery on resume</small></span></label></section>
            <div className="build-note"><span className="mono">BUILD 001</span><p>{config.investigator === 'openrouter' ? 'OpenRouter investigator configured.' : 'Add your OpenRouter key to enable AI investigation.'}<br />{liveMode ? 'Writing to your connected GitHub, Linear and Slack.' : twinMode ? 'Writing to provisioned Arga twins.' : config.connections === 'enabled' ? 'Connect your apps to try a live recovery.' : 'Live apps are off in scenario-only mode.'}</p></div>
          </aside></div>
          <footer><span className="footer-mark"><ShieldCheck size={14} />Evidence before action.</span><span>{config.investigator === 'openrouter' ? 'OPENROUTER INVESTIGATOR' : 'SCENARIO RULES · NO MODEL CONNECTED'}<span className="footer-dot">·</span>{liveMode ? 'LIVE DEMO APPS' : twinMode ? 'ARGA TWINS' : 'LOCAL ADAPTER'}</span></footer>
        </>}
      </main>
    </div>
    {evidence && w && <div className="drawer-backdrop" onClick={() => setEvidence(undefined)}><section className="evidence-drawer" role="dialog" aria-modal="true" aria-label="Source evidence" onClick={e => e.stopPropagation()}><div className="drawer-heading"><div className="small-label">SOURCE EVIDENCE</div><button autoFocus aria-label="Close evidence" onClick={() => setEvidence(undefined)}><PanelRightClose size={19} /></button></div><AppIcon app={evidence.app} /><h2>{evidence.title}</h2><p>{evidence.reason}</p><div className="evidence-origin"><ShieldCheck size={15} />{provenance}</div><h3>Recorded agent action</h3><p>{w.sourceActions.find(a => a.id === evidence.evidenceId)?.description}</p><pre>{JSON.stringify(w.sourceActions.find(a => a.id === evidence.evidenceId), null, 2)}</pre><h3>Current app record</h3><pre>{JSON.stringify(w.records.find(r => r.id === evidence.recordId), null, 2)}</pre><div className="drawer-warning">{w.run?.mode === 'recorded' ? 'Recorded demonstration calls, compared with app observations refreshed during investigation, approval, and execution. This does not reconstruct unrecorded production activity.' : 'These are seeded scenario records. They demonstrate recovery behavior; they are not evidence of a live production incident.'}</div></section></div>}
    {showEvaluation && <EvaluationView onClose={() => setShowEvaluation(false)} />}
    {showWelcome && <Welcome
      connectionsEnabled={config.connections === 'enabled'}
      onClose={dismissWelcome}
      onSample={() => {
        dismissWelcome();
        if (w && w.mode !== 'local') setError('This workspace is linked to real apps. Reset the scenario to return to sample data.');
        else setTab('repair');
      }}
      onOwnApps={() => {
        dismissWelcome();
        if (!w || w.mode !== 'local' || w.plans.length) { setError('Reset the scenario to connect your own apps.'); return; }
        requestAnimationFrame(() => document.getElementById('connect-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }}
    />}
    {showReset && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="reset-title" className="reset-modal"><RotateCcw size={24} /><h2 id="reset-title">Start a fresh scenario?</h2><p>This replaces the local records, repair plans, and activity history.{liveMode ? ' Issues and messages already created in your demo apps stay there.' : ''} Export your receipt first if you want to keep it.</p><div><button autoFocus className="button outline" onClick={() => setShowReset(false)}>Keep current recovery</button><button className="button primary" onClick={() => { setShowReset(false); setTab('repair'); setInterrupt(false); action('reset'); }}>Reset scenario</button></div></section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

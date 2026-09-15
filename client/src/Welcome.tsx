import React from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react';

const steps = [
  { icon: <Sparkles size={18} />, title: 'The agent runs', text: 'onboarding-agent works across GitHub, Linear and Slack. Aftercare records every change it makes.' },
  { icon: <ShieldCheck size={18} />, title: 'Aftercare flags suspicious changes', text: 'A duplicate issue, the wrong owner, a premature announcement: each is marked with the evidence behind it.' },
  { icon: <Wrench size={18} />, title: 'You approve, Aftercare repairs', text: 'Nothing changes until you approve. Each fix is checked again in the real app afterwards.' },
];
export const dialog: React.CSSProperties = { width: 'min(780px, 100%)', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', background: '#fafaf7', border: '1px solid #e4e1da', borderRadius: 12, padding: 'clamp(20px, 4vw, 34px)', boxShadow: '0 20px 80px #28203020' };
const card: React.CSSProperties ={ border: '1px solid #e4e3dc', borderRadius: 8, background: '#fff', padding: 16 };
const link: React.CSSProperties = { color: '#6653ac', textDecoration: 'underline', display: 'inline-flex', alignItems: 'center', gap: 3 };

/** First-visit introduction: what Aftercare does, how to try it, and what to look for. */
export function Welcome({ connectionsEnabled, onClose, onSample, onOwnApps }: { connectionsEnabled: boolean; onClose: () => void; onSample: () => void; onOwnApps: () => void }) {
  return <div className="modal-backdrop">
    <section role="dialog" aria-modal="true" aria-labelledby="welcome-title" style={dialog}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <a href="/" className="recovery-home-link" style={{ marginBottom: 0 }}><ArrowLeft size={15} />Back to agent home</a>
        <button aria-label="Close introduction" onClick={onClose} style={{ color: '#8e8a94', display: 'flex' }}><X size={18} /></button>
      </div>
      <h2 id="welcome-title" style={{ fontFamily: 'Manrope, sans-serif', fontSize: 'clamp(22px, 3.2vw, 28px)', lineHeight: 1.3, letterSpacing: '-0.8px', margin: '12px 0 10px' }}>When an AI agent makes a mess across your apps, Aftercare cleans it up safely.</h2>
      <p style={{ fontSize: 13, lineHeight: 1.7, color: '#6f746b' }}>Agents now change GitHub, Linear and Slack on their own. When a run goes wrong, Aftercare shows exactly what happened, proposes a fix, and changes nothing until you approve.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, margin: '22px 0' }}>
        {steps.map((step, i) => <div key={step.title} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6653ac' }}>{step.icon}<span className="mono" style={{ fontSize: 10 }}>0{i + 1}</span></div>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: '10px 0 6px' }}>{step.title}</h3>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: '#747971' }}>{step.text}</p>
        </div>)}
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Try it</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <div style={card}>
          <button autoFocus className="button primary full" onClick={onSample}>See it on sample data<ArrowRight size={14} /></button>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: '#747971', marginTop: 10 }}>Instant, with no accounts. App records are simulated. If AI is enabled, it receives the sample evidence; repairs stay in the scenario.</p>
        </div>
        {connectionsEnabled && <div style={card}>
          <button className="button outline full" onClick={onOwnApps}>Use your own apps<ArrowRight size={14} /></button>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: '#747971', marginTop: 10 }}>Real GitHub, Linear and Slack. Creates demo issues and a Slack message, so use demo resources.</p>
          <details style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7, color: '#5f645c' }}>
            <summary style={{ cursor: 'pointer' }}>What you’ll need</summary>
            <ul style={{ paddingLeft: 18, margin: '8px 0 0' }}>
              <li><strong>GitHub:</strong> a fine-grained token with Issues: Read and write on a demo repository. <a style={link} href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a token<ExternalLink size={11} /></a></li>
              <li><strong>Linear:</strong> a personal API key, under Settings → Security &amp; access → Personal API keys.</li>
              <li><strong>Slack:</strong> a bot token from an app you create, with chat:write, channels:read, channels:join and channels:history. <a style={link} href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Create a Slack app<ExternalLink size={11} /></a></li>
            </ul>
          </details>
        </div>}
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '22px 0 8px' }}>What to look for</h3>
      <ul style={{ paddingLeft: 18, fontSize: 12, lineHeight: 1.8, color: '#5f645c' }}>
        <li><strong>Open the Agent run tab</strong> to see every recorded action and why three of them need repair.</li>
        <li><strong>Change a record after preparing the plan</strong> (Simulate a human edit, or edit Linear directly). Approval is blocked and the person’s change is kept.</li>
        <li><strong>Tick “Interrupt after the first write”</strong> before applying. Aftercare resumes without repeating anything, then you can export the receipt.</li>
        <li><strong>Open Evaluation</strong> in the top bar for repeated, seeded trials of nine failure scenarios, judged by the apps’ final state.</li>
      </ul>
    </section>
  </div>;
}

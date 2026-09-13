import React, { useEffect, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { dialog } from './Welcome';

interface ScenarioResult { id: string; title: string; proves: string; trials: number; passed: number; failures: Record<string, number>; p50ms: number; p95ms: number }
interface AgentResults {
  mode: 'mock' | 'model'; model: string; generatedAt: string; complete: boolean; plannedTrials: number;
  total: { passed: number; trials: number };
  scenarios: Array<{ id: string; correct: number; trials: number; humanPreserved: number; humanTrials: number; duplicateSideEffects: number; writes: number; policyRejected: number; rejectedRecommendations?: number; p50ms: number | null; p95ms: number | null }>;
}
interface Results { generatedAt: string; seed: number; trialsPerScenario: number; total: { trials: number; passed: number }; scenarios: ScenarioResult[] }

/** Defects the evaluation's first run found. The full record, with dates, is in VALIDATION.md. */
const caught = [
  { title: 'Partial outage', before: '0/25', fix: 'A write an app refused is now retried once the app shows it never landed.' },
  { title: 'Hostile content in app data', before: '12/25', fix: 'Names copied from other apps are now escaped before anything is posted to Slack.' },
];
const cell: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid #ebeae4', textAlign: 'left', verticalAlign: 'top', fontSize: 12, lineHeight: 1.5 };
const percent = (r: { passed: number; trials: number }) => Math.round((100 * r.passed) / r.trials);

/** Results of the seeded evaluation harness, read from the committed results file. */
export function EvaluationView({ onClose }: { onClose: () => void }) {
  const [results, setResults] = useState<Results | null>();
  const [agent, setAgent] = useState<AgentResults | null>(null);
  const [mock, setMock] = useState<AgentResults | null>(null);
  useEffect(() => { fetch('/api/evaluation').then(r => r.json()).then(body => { setResults(body.evaluation ?? null); setAgent(body.investigations?.model ?? null); setMock(body.investigations?.mock ?? null); }).catch(() => setResults(null)); }, []);
  return <div className="modal-backdrop">
    <section role="dialog" aria-modal="true" aria-labelledby="evaluation-title" style={dialog}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div className="small-label">EVALUATION</div>
        <button autoFocus aria-label="Close evaluation" onClick={onClose} style={{ color: '#8e8a94', display: 'flex' }}><X size={18} /></button>
      </div>
      <h2 id="evaluation-title" style={{ fontFamily: 'Manrope, sans-serif', fontSize: 'clamp(22px, 3.2vw, 28px)', lineHeight: 1.3, letterSpacing: '-0.8px', margin: '12px 0 10px' }}>How reliably Aftercare repairs</h2>
      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>AI decisions · real model, simulated app state</h3>
      {agent ? <>
        <p style={{ fontSize: 13, lineHeight: 1.7 }}>{agent.total.passed}/{agent.total.trials} trials passed · {agent.model} · {new Date(agent.generatedAt).toLocaleDateString()}{!agent.complete && ` · Incomplete: ${agent.total.trials}/${agent.plannedTrials} planned trials`}</p>
        <div style={{ overflowX: 'auto', margin: '12px 0' }}><table style={{ width: '100%', minWidth: 690, borderCollapse: 'collapse' }}><thead><tr>{['Case', 'Correct outcome', 'Human changes kept', 'Duplicate effects / writes', 'Investigation p50 / p95'].map(t => <th key={t} style={cell}>{t}</th>)}</tr></thead><tbody>{agent.scenarios.map(s => <tr key={s.id}><td style={cell}>{s.id.replaceAll('-', ' ')}{(s.rejectedRecommendations ?? 0) > 0 && <small style={{ display: 'block' }}>{s.rejectedRecommendations} responses rejected before completion</small>}{s.policyRejected > 0 && <small style={{ display: 'block' }}>{s.policyRejected} policy rejections (failed trials)</small>}</td><td style={cell}>{s.correct}/{s.trials}</td><td style={cell}>{s.humanTrials ? `${s.humanPreserved}/${s.humanTrials}` : 'N/A'}</td><td style={cell}>{s.duplicateSideEffects}/{s.writes}</td><td style={cell}>{s.p50ms ?? '—'} / {s.p95ms ?? '—'} ms</td></tr>)}</tbody></table></div>
        <p style={{ fontSize: 12, lineHeight: 1.6, color: '#6f746b' }}>Correct final state or an appropriate explicit escalation counts as correct. Terminally blocked recommendations count as failed trials; rejected intermediate responses are shown separately. Human-edit trials include a second investigation. This small authored set tests one workflow; it does not establish performance on arbitrary incidents.</p>
      </> : <p style={{ fontSize: 13 }}>No real-model evaluation has been recorded.</p>}
      {mock && <p style={{ fontSize: 12, color: '#6f746b', margin: '10px 0' }}>Harness check: {mock.total.passed}/{mock.total.trials} with scripted model responses. This checks the evaluation machinery, not AI judgment.</p>}
      <h3 style={{ fontSize: 14, margin: '22px 0 8px' }}>Recovery engine · scenario rules, simulated APIs</h3>
      {results === undefined ? <p style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#747971' }}><LoaderCircle className="spin" size={16} />Loading results…</p>
        : results === null ? <p style={{ fontSize: 13, color: '#747971' }}>No results yet. Run <code>npm run eval -- --write</code> to create them.</p>
        : <>
          <p style={{ fontSize: 16, fontWeight: 600, color: results.total.passed === results.total.trials ? '#34836b' : '#9b783f' }}>{results.total.passed} of {results.total.trials} trials passed ({percent(results.total)}%)</p>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: '#6f746b', margin: '8px 0 18px' }}>
            {results.scenarios.length} failure scenarios, {results.trialsPerScenario} seeded trials each (seed {results.seed}, run {new Date(results.generatedAt).toLocaleDateString()}). No model is called. Every trial runs onboarding-agent and a repair against simulated GitHub, Linear and Slack that also hold unrelated records, and is judged by the apps’ final state and the requests they actually handled, never by Aftercare’s own claims.
          </p>
          <div style={{ overflowX: 'auto', border: '1px solid #e4e3dc', borderRadius: 8, background: '#fff' }}>
            <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse' }}>
              <thead><tr><th style={cell}>Scenario</th><th style={cell}>Passed</th></tr></thead>
              <tbody>{results.scenarios.map(s => <tr key={s.id}>
                <td style={cell}><strong>{s.title}</strong><div style={{ color: '#747971', marginTop: 3 }}>{s.proves}</div></td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                  {s.passed}/{s.trials}
                  <div aria-hidden="true" style={{ width: 90, height: 5, borderRadius: 3, background: '#ecebe6', marginTop: 6 }}><div style={{ width: `${percent(s)}%`, height: '100%', borderRadius: 3, background: s.passed === s.trials ? '#34836b' : '#b08a4a' }} /></div>
                </td>
              </tr>)}</tbody>
            </table>
          </div>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: '22px 0 8px' }}>What the evaluation caught</h3>
          <ul style={{ paddingLeft: 18, fontSize: 12, lineHeight: 1.8, color: '#5f645c' }}>
            {caught.map(c => {
              const now = results.scenarios.find(s => s.title === c.title);
              return <li key={c.title}><strong>{c.title}:</strong> {c.before} on the first run. {c.fix}{now && ` Now ${now.passed}/${now.trials}.`}</li>;
            })}
          </ul>
          <p style={{ fontSize: 11, color: '#7d8179', marginTop: 14 }}>Live-app acceptance is recorded separately in VALIDATION.md. Neither evaluation table above represents trials against real provider accounts.</p>
        </>}
    </section>
  </div>;
}

import { existsSync, writeFileSync } from 'node:fs';
import { investigationCases, runInvestigationTrial, type TrialResult } from './investigations.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const mode = option('mode', 'mock');
const trials = Number(option('trials', '3'));
const seed = Number(option('seed', '20260913'));
const concurrency = Number(option('concurrency', '1'));
const tag = option('tag', '');
if (![1, 2, 3].includes(concurrency) || !/^[a-z0-9-]*$/.test(tag)) throw new Error('Concurrency must be 1–3; tag must be lowercase letters, digits, or hyphens.');
const suffix = tag ? `-${tag}` : '';
if (!['mock', 'model'].includes(mode) || !Number.isInteger(trials) || trials < 1 || trials > 20 || !Number.isInteger(seed)) throw new Error('Usage: npm run eval:agent -- --mode mock|model --trials 1-20 [--seed integer] [--write]');
if (mode === 'model' && existsSync('.env')) process.loadEnvFile('.env');
const key = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;
if (mode === 'model' && (!key || !model?.trim())) throw new Error('Real-model evaluation requires OPENROUTER_API_KEY and OPENROUTER_MODEL. No app tokens are used.');
const rows: TrialResult[] = [];
const startedAt = new Date().toISOString();
const jobs = investigationCases.flatMap(id => Array.from({ length: trials }, (_, trial) => ({ id, trial })));
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < jobs.length) {
    const { id, trial } = jobs[next++];
    const row = await runInvestigationTrial(id, trial, { mode: mode as 'mock' | 'model', key, model, seed });
    rows.push(row);
    rows.sort((a, b) => investigationCases.indexOf(a.case) - investigationCases.indexOf(b.case) || a.trial - b.trial);
    console.log(`${id} ${trial + 1}/${trials}: ${row.passed ? 'PASS' : 'FAIL'} · ${row.outcome} · ${row.investigationMs}ms · ${row.rejectedRecommendations} corrected/rejected responses${row.error ? ` · ${row.error}` : ''}`);
    // Persist completed trials, including failures. Planned but unfinished trials are never credited.
    if (args.includes('--write')) writeResults();
  }
}));

function writeResults() {
  const scenarios = investigationCases.map(id => {
    const sample = rows.filter(r => r.case === id);
    const human = sample.filter(r => r.humanPreserved !== null);
    const durations = sample.map(r => r.investigationMs).sort((a, b) => a - b);
    const quantile = (q: number) => durations.length ? durations[Math.max(0, Math.ceil(q * durations.length) - 1)] : null;
    return { id, passed: sample.filter(r => r.passed).length, trials: sample.length, correct: sample.filter(r => r.correctOutcome).length,
      humanPreserved: human.filter(r => r.humanPreserved).length, humanTrials: human.length,
      duplicateSideEffects: sample.reduce((n, r) => n + r.duplicateSideEffects, 0), writes: sample.reduce((n, r) => n + r.writes, 0),
      policyRejected: sample.filter(r => r.policyRejected).length, rejectedRecommendations: sample.reduce((n, r) => n + r.rejectedRecommendations, 0), p50ms: quantile(0.5), p95ms: quantile(0.95) };
  });
  const report = { mode, apps: 'independent in-memory app state; no external app calls', startedAt, generatedAt: new Date().toISOString(), seed, concurrency, model: [...new Set(rows.map(r => r.model))].join(', '), plannedTrials: trials * investigationCases.length, complete: rows.length === trials * investigationCases.length, total: { passed: rows.filter(r => r.passed).length, trials: rows.length }, scenarios, rows };
  writeFileSync(`eval/investigation-${mode}${suffix}.json`, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(`EVALUATION-${mode.toUpperCase()}${suffix.toUpperCase()}.md`, [
    '# Investigator evaluation', '',
    mode === 'model' ? `Real model: ${report.model}. Apps are independent in-memory state, not live provider accounts.` : 'Scripted model responses and independent in-memory app state. These results validate the harness, not AI judgment.', '',
    `Started ${startedAt}. Seed ${seed}. Completed ${rows.length}/${report.plannedTrials} planned trials.`, '',
    '| Case | Correct outcome / trials | Human changes preserved / eligible trials | Duplicate effects / accepted writes | Failed policy rejections / rejected responses | Investigation p50 / p95 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...scenarios.map(s => `| ${s.id} | ${s.correct}/${s.trials} | ${s.humanTrials ? `${s.humanPreserved}/${s.humanTrials}` : 'N/A'} | ${s.duplicateSideEffects}/${s.writes} | ${s.policyRejected} / ${s.rejectedRecommendations} | ${s.p50ms ?? '—'} / ${s.p95ms ?? '—'} ms |`), '',
    `Overall passed: ${report.total.passed}/${report.total.trials}.`, '',
    'Correctness requires the expected final state or an explicit, appropriate model escalation. A terminal policy rejection or network failure is a failed trial, even if no unsafe write occurred. Rejected intermediate responses are counted separately; the model can correct them within the original round, tool-call, and time budgets. Human-edit trials include a stale approval attempt and a second investigation; latency sums those investigations. Duplicate effects count accepted writes beyond the first to the same record and field. Zero writes provides no evidence about replay behavior.', '',
    'Trials vary owner names and fault targets. All cases use one onboarding workflow; this small authored set does not establish generalization to arbitrary incidents. No expected answers or case labels are supplied to the real model. Low trial counts make percentiles descriptive only.', '',
    'App-adapter reliability: [EVALUATION.md](EVALUATION.md). Live-account acceptance: [VALIDATION.md](VALIDATION.md).', '',
    ...(mode === 'model' && existsSync('EVALUATION-MODEL-BASELINE.md') ? ['The earlier run is retained in [EVALUATION-MODEL-BASELINE.md](EVALUATION-MODEL-BASELINE.md). These authored development cases were reused during improvement; this is not a held-out benchmark. Concurrency differs between runs, so latency is not a controlled comparison.', ''] : []),
    ...rows.filter(r => !r.passed).map(r => `- Failed ${r.case}, trial ${r.trial}: ${r.error ?? `unexpected ${r.outcome} or final state`}.`), '',
  ].join('\n'));
}
console.log(`${rows.filter(r => r.passed).length}/${rows.length} passed. ${mode === 'model' ? 'Real model, simulated app state.' : 'Mock model; harness validation only.'}`);
process.exitCode = rows.every(r => r.passed) ? 0 : 1;

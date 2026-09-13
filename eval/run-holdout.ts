import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { holdoutTrial, holdoutMock, type HoldoutCase, type HoldoutResult } from './holdout.js';

const args = process.argv.slice(2);
// Each frozen suite lives in its own folder, is run once, and is never replaced: eval/holdout-v1, eval/holdout-v2, ...
const root = args.find(a => a.startsWith('--suite='))?.slice('--suite='.length) ?? 'eval/holdout-v1';
const version = /^eval\/holdout-v(\d+)$/.exec(root)?.[1];
if (!version) throw new Error('Name a suite folder such as --suite=eval/holdout-v2.');
const reportFile = version === '1' ? 'EVALUATION-HOLDOUT.md' : `EVALUATION-HOLDOUT-V${version}.md`;
const suite = JSON.parse(readFileSync(`${root}/cases.json`, 'utf8')) as { version: number; trialsPerCase: number; concurrency: number; note?: string; cases: HoldoutCase[] };
const files = [`${root}/cases.json`, 'eval/holdout.ts', 'eval/run-holdout.ts', 'server/investigator.ts', 'server/policy.ts', 'server/recovery.ts', 'server/errors.ts', 'shared/types.ts'];
const fingerprint = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
if (!args.includes('--mock') && existsSync('.env')) process.loadEnvFile('.env');
const model = process.env.OPENROUTER_MODEL;
if (args.includes('--freeze')) {
  if (existsSync(`${root}/manifest.json`)) throw new Error('This suite is already frozen. Do not replace its manifest.');
  if (!model?.trim()) throw new Error('Configure the model before freezing the suite.');
  writeFileSync(`${root}/manifest.json`, JSON.stringify({ frozenAt: new Date().toISOString(), requestedModel: model, plannedTrials: suite.cases.length * suite.trialsPerCase, trialsPerCase: suite.trialsPerCase, concurrency: suite.concurrency, hashes: fingerprint() }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Frozen ${suite.cases.length} cases, expected outcomes, scorer, investigator, policy, and executor before any holdout inference.`);
} else if (args.includes('--mock')) {
  let passed = 0;
  for (const [index, c] of suite.cases.entries()) {
    const row = await holdoutTrial(c, index, 1, { key: 'mock', model: 'mock', fetcher: holdoutMock(c, index) });
    if (!row.passed) throw new Error(JSON.stringify(row.failures)); passed++;
  }
  const wrong = await holdoutTrial(suite.cases[0], 0, 1, { key: 'mock', model: 'mock', fetcher: holdoutMock(suite.cases[0], 0, 'close_duplicate') });
  if (wrong.passed || wrong.acceptedWrites.length !== 3) throw new Error('Negative control did not detect a policy-allowed but semantically wrong repair.');
  console.log(`${passed}/${suite.cases.length} scripted positive controls passed; the deliberately wrong semantic decision failed scoring. No real model called.`);
} else if (args.includes('--run')) {
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8'));
  if (JSON.stringify(fingerprint()) !== JSON.stringify(manifest.hashes)) throw new Error('Frozen inputs or implementation changed; refusing to call this an unchanged holdout run.');
  if (!process.env.OPENROUTER_API_KEY || model !== manifest.requestedModel) throw new Error('The key must be configured and the model must match the freeze.');
  const output = `${root}/results.json`;
  if (existsSync(output)) throw new Error('Holdout results already exist. Never overwrite or silently rerun the first attempt.');
  const startedAt = new Date().toISOString();
  const rows: HoldoutResult[] = [];
  const jobs = suite.cases.flatMap((c, index) => Array.from({ length: suite.trialsPerCase }, (_, n) => ({ c, index, trial: n + 1 })));
  const report = () => ({ kind: 'frozen-holdout', apps: 'independent in-memory state; no live provider calls', requestedModel: model, frozenAt: manifest.frozenAt, startedAt, generatedAt: new Date().toISOString(), plannedTrials: jobs.length, complete: rows.length === jobs.length, hashesUnchanged: JSON.stringify(fingerprint()) === JSON.stringify(manifest.hashes), total: { passed: rows.filter(r => r.passed).length, trials: rows.length }, cases: suite.cases.map(c => {
    const sample = rows.filter(r => r.id === c.id);
    const durations = sample.map(r => r.investigationMs).sort((a, b) => a - b);
    const q = (p: number) => durations.length ? durations[Math.ceil(p * durations.length) - 1] : null;
    return { id: c.id, title: c.title, expectedOutcome: c.expectedOutcome, passed: sample.filter(r => r.passed).length, trials: sample.length, humanPreserved: sample.filter(r => r.humanPreserved).length, humanTrials: sample.filter(r => r.humanPreserved !== null).length, duplicateSideEffects: sample.reduce((n, r) => n + r.duplicateSideEffects, 0), writes: sample.reduce((n, r) => n + r.acceptedWrites.length, 0), p50ms: q(0.5), p95ms: q(0.95) };
  }), rows });
  writeFileSync(output, JSON.stringify(report(), null, 2) + '\n', { flag: 'wx' });
  let next = 0;
  await Promise.all(Array.from({ length: suite.concurrency }, async () => {
    while (next < jobs.length) {
      const { c, index, trial } = jobs[next++];
      const result = await holdoutTrial(c, index, trial, { key: process.env.OPENROUTER_API_KEY!, model: model! });
      rows.push(result); rows.sort((a, b) => suite.cases.findIndex(c => c.id === a.id) - suite.cases.findIndex(c => c.id === b.id) || a.trial - b.trial);
      writeFileSync(output, JSON.stringify(report(), null, 2) + '\n');
      console.log(`${c.id} ${trial}/${suite.trialsPerCase}: ${result.passed ? 'PASS' : 'FAIL'} · ${result.investigationMs}ms${result.failures.length ? ' · ' + result.failures.join(' ') : ''}`);
    }
  }));
  const final = report();
  writeFileSync(reportFile, [
    `# Frozen holdout evaluation${version === '1' ? '' : ` v${version}`}`, '',
    `Frozen ${manifest.frozenAt}; run started ${startedAt}. Model: ${model}. Implementation and input hashes unchanged: ${final.hashesUnchanged}.`, '',
    ...(suite.note ? [suite.note, ''] : []),
    `${suite.cases.length} newly authored examples, each repeated ${suite.trialsPerCase} times using the unchanged investigator and policy. Case labels, expected outcomes, and rationales are never supplied to the model. Repeats measure variation on these ${suite.cases.length} examples; they are not ${jobs.length} independent examples. Apps use independent in-memory state, not real provider accounts.`, '',
    '| Case | Expected | Passed / trials | Human state preserved | Duplicate effects / writes | Investigation p50 / p95 |', '| --- | --- | --- | --- | --- | --- |',
    ...final.cases.map(c => `| ${c.title} | ${c.expectedOutcome} | ${c.passed}/${c.trials} | ${c.humanTrials ? `${c.humanPreserved}/${c.humanTrials}` : 'N/A'} | ${c.duplicateSideEffects}/${c.writes} | ${c.p50ms} / ${c.p95ms} ms |`), '',
    `Total: ${final.total.passed}/${final.total.trials}. All attempts, including failures, are retained in [results.json](${root}/results.json).`, '',
    `The [case definitions](${root}/cases.json), expectations, scorer, and implementation were hashed in a [manifest](${root}/manifest.json) before inference. The runner refuses changed hashes and refuses to overwrite the first run. Positive scripted controls pass; a policy-allowed but semantically wrong closure fails the scorer. Scoring requires expected decisions, final state, write counts, unchanged existing corrections, and explicit escalation where required.`, '',
    'This is a small internal holdout from the same workflow family, not an independent benchmark or proof of broad generalization. No prompt, policy, case, or expected answer was tuned after observing these results. Provider errors and terminally rejected recommendations count as failed trials. Low-sample percentiles are descriptive only.', '',
    ...rows.filter(r => !r.passed).map(r => `- ${r.id}, trial ${r.trial}: ${r.failures.join(' ')}`), '',
    `${version === '1' ? '' : 'Earlier holdout: [EVALUATION-HOLDOUT.md](EVALUATION-HOLDOUT.md). '}Earlier development results: [EVALUATION-MODEL.md](EVALUATION-MODEL.md). Actual live runs: [VALIDATION.md](VALIDATION.md).`, '',
  ].join('\n'));
  console.log(`${final.total.passed}/${final.total.trials} passed; frozen hashes unchanged: ${final.hashesUnchanged}.`);
  process.exitCode = final.total.passed === final.total.trials && final.hashesUnchanged ? 0 : 1;
} else throw new Error('Use --mock to check scoring, --freeze once before inference, then --run once. Add --suite=eval/holdout-v2 for a later suite.');

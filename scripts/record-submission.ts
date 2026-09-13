// Actual browser capture for submission. Sample mode uses real model inference on simulated
// app records. --live uses the connected local server and runs examples/mcp-agent.ts.
// Only captions and wait edits are added to the recording; application outcomes are not changed.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const live = process.argv.includes('--live');
const owner = process.argv.find(a => a.startsWith('--owner='))?.slice(8);
if (live && !owner) throw new Error('Live capture requires --owner=<connected Linear member name>.');
const port = live ? 4310 : 4397;
const base = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve('demo-output', `${live ? 'live-mcp' : 'submission'}-${stamp}`);
mkdirSync(out, { recursive: true });
const record: any = { startedAt: new Date().toISOString(), mode: live ? 'live-mcp' : 'sample-apps-real-model', attempts: [], cuts: [], complete: false };
const save = () => writeFileSync(join(out, 'capture.json'), JSON.stringify(record, null, 2));
save();
let server: ChildProcess | undefined;
if (!live) {
  if (!existsSync('dist/client/index.html')) throw new Error('Run npm run build first.');
  const data = mkdtempSync(join(tmpdir(), 'aftercare-submission-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', AFTERCARE_SCENARIO_ONLY: '0', AFTERCARE_PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', AFTERCARE_DATA_DIR: data },
  });
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('Capture server did not start.')), 15_000);
    server!.stdout!.on('data', chunk => { if (String(chunk).includes('Aftercare:')) { clearTimeout(timer); ready(); } });
    server!.once('exit', () => { clearTimeout(timer); fail(new Error('Capture server exited.')); });
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, recordVideo: { dir: out, size: { width: 1440, height: 1080 } }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
const pause = (ms: number) => page.waitForTimeout(ms);
const badge = live ? 'REAL APPS · MCP GATEWAY · INJECTED AGENT FAULTS' : 'SAMPLE APPS · REAL AI INVESTIGATION · INJECTED FAULTS';
async function caption(text: string, hold = 4500) {
  await page.evaluate(({ text, badge }) => {
    let label = document.getElementById('capture-label');
    if (!label) {
      label = document.createElement('div'); label.id = 'capture-label';
      label.style.cssText = 'position:fixed;right:18px;top:12px;z-index:99999;background:#242032;color:#fff;padding:8px 14px;border-radius:8px;font:600 12px system-ui;pointer-events:none';
      document.body.append(label);
    }
    label.textContent = badge;
    let el = document.getElementById('capture-caption');
    if (!el) {
      el = document.createElement('div'); el.id = 'capture-caption';
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;width:1060px;box-sizing:border-box;background:#211c32f2;color:#fff;padding:20px 30px;border-radius:12px;font:600 25px/1.4 system-ui;text-align:center;pointer-events:none;box-shadow:0 8px 36px #0003';
      document.body.append(el);
    }
    el.textContent = text;
  }, { text, badge });
  await pause(hold);
}
async function investigate(buttonName: string) {
  await caption('The AI reads the evidence. Investigation wait shortened in this video.', 0);
  const start = elapsed();
  const responsePromise = page.waitForResponse(r => r.url() === `${base}/api/prepare` && r.request().method() === 'POST', { timeout: 150_000 });
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  const response = await responsePromise;
  const body = await response.json();
  const end = elapsed();
  record.attempts.push({ startedAt: new Date(t0 + start * 1000).toISOString(), latencyMs: Math.round((end - start) * 1000), httpStatus: response.status(), investigation: body.investigation, error: body.error });
  if (end - start > 5) record.cuts.push({ start: start + 2.5, end: end - 1 });
  save();
  if (!response.ok() || !body.plans?.length) throw new Error(`Investigation did not produce a plan: ${body.error ?? body.investigation?.summary ?? response.status()}`);
  await pause(700);
}
let keyIssued = false;
try {
  const config = await (await context.request.get(`${base}/api/config`)).json();
  if (config.investigator !== 'openrouter') throw new Error('Real AI investigator is required; no rules fallback.');
  record.model = config.model;
  await page.goto(base);
  await page.getByRole('button', { name: 'See it on sample data' }).click();
  if (live) {
    const connections = await (await context.request.get(`${base}/api/connections`)).json();
    if (!connections.ready) throw new Error('Connect all three demo apps in the local browser first.');
    const initial = await (await context.request.get(`${base}/api/workspace`)).json();
    if (initial.mode !== 'local' || initial.plans.length) {
      writeFileSync(join(out, 'previous-workspace.json'), JSON.stringify(initial, null, 2));
      if (initial.plans.some((p: any) => ['approved', 'executing', 'interrupted'].includes(p.status))) throw new Error('An approved or interrupted repair must finish before this capture can start. Previous workspace saved.');
      const reset = await context.request.post(`${base}/api/reset`, { data: {} });
      if (!reset.ok()) throw new Error('Could not start a fresh workspace; previous state saved.');
      await page.reload();
    }
    const issued = await context.request.post(`${base}/api/agent/key`, { data: {} });
    if (!issued.ok()) throw new Error('Could not issue the scoped agent key.');
    const { key } = await issued.json(); keyIssued = true;
    await caption('An outside onboarding agent is about to write through Aftercare’s MCP gateway.', 3500);
    const start = elapsed();
    const output = await new Promise<string>((done, fail) => {
      let stdout = '';
      const child = spawn(process.execPath, ['--import', 'tsx', 'examples/mcp-agent.ts', owner!], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, AFTERCARE_AGENT_KEY: key, AFTERCARE_MCP_URL: `${base}/mcp` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', c => { stdout += String(c); });
      child.stderr.on('data', () => {});
      child.on('error', fail);
      child.on('exit', code => code === 0 ? done(stdout) : fail(new Error(`MCP example exited ${code}. Captured provider records remain in the apps.`)));
    });
    writeFileSync(join(out, 'mcp-run.txt'), output);
    record.mcpRunMs = Math.round((elapsed() - start) * 1000);
    if (elapsed() - start > 5) record.cuts.push({ start: start + 2.5, end: elapsed() - 1 });
    await page.reload();
  }
  await page.getByRole('tab', { name: /Agent run/ }).click();
  await page.locator('.incident-card').scrollIntoViewIfNeeded();
  record.openingSeconds = elapsed();
  await caption('The agent told Slack it was done. It wasn’t. Here’s how we know.', 6000);
  await caption('A duplicate GitHub issue. A missing Linear owner. A premature Slack announcement.', 6000);
  await page.getByRole('tab', { name: 'Repair plan', exact: true }).click();
  await investigate('Investigate & prepare repair');
  await page.getByRole('button', { name: 'Approve 3 changes', exact: true }).waitFor();
  await caption('Aftercare proposes three repairs. Each needs evidence and human approval.', 6000);
  await page.getByRole('button', { name: 'Evidence', exact: true }).first().click();
  await caption('The model recommends. Scoped policy checks what the executor can change.', 5500);
  await page.keyboard.press('Escape');
  if (live) {
    const current = await (await context.request.get(`${base}/api/workspace`)).json();
    const issue = current.records.find((r: any) => r.app === 'GitHub');
    const ref = issue?.external;
    if (!ref || ref.provider !== 'github') throw new Error('The live duplicate has no GitHub reference.');
    const body = `${issue.fields.body}\n\nAlso migrate the audit logs`;
    const editFile = join(out, 'human-edit.json');
    writeFileSync(editFile, JSON.stringify({ body }));
    const changed = spawnSync('gh', ['api', '--method', 'PATCH', `repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`, '--input', editFile, '--silent'], { encoding: 'utf8' });
    if (changed.status !== 0) throw new Error('Could not apply the simulated teammate edit to the actual GitHub issue.');
    record.humanEdit = { at: new Date().toISOString(), source: 'operator simulation through GitHub API', issue: `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`, added: 'Also migrate the audit logs' }; save();
    await caption('A simulated teammate adds real work in GitHub: “Also migrate the audit logs.”', 6500);
    await page.getByRole('button', { name: 'Approve 3 changes', exact: true }).click();
    await page.getByRole('button', { name: 'Review updated plan' }).waitFor();
    await caption('The old approval is blocked. The issue changed while the repair was waiting.', 6000);
    await investigate('Review updated plan');
    await page.getByText('Preserve the issue for separate review').waitFor();
    await caption('The new plan keeps the issue open for its added work. Two repairs remain.', 6500);
  } else {
    await page.getByRole('button', { name: 'Simulate a human edit' }).click();
    await caption('Now a teammate reassigns the task. The old approval is stale.', 6500);
    await page.getByRole('button', { name: 'Review updated plan' }).waitFor();
    await caption('Aftercare blocks the old plan. The human’s work changes what recovery should do.', 5500);
    await investigate('Review updated plan');
    await page.getByText('Preserve the human assignment').waitFor();
    await caption('The new plan keeps the teammate’s assignment and repairs the remaining two records.', 6500);
  }
  await page.getByLabel('Interrupt after the first write').check();
  await caption('Let’s interrupt the repair immediately after its first write succeeds.', 5000);
  await page.getByRole('button', { name: 'Approve 2 changes', exact: true }).click();
  await page.getByRole('button', { name: 'Apply approved repair', exact: true }).click();
  await page.getByRole('button', { name: 'Reconcile & resume', exact: true }).waitFor({ timeout: 120_000 });
  await caption('Did that write happen? Aftercare checks the app before trying again.', 6000);
  await page.getByRole('button', { name: 'Reconcile & resume', exact: true }).click();
  await page.getByRole('button', { name: 'Export recovery receipt' }).waitFor({ timeout: 120_000 });
  await page.getByRole('tab', { name: /^Activity/ }).click();
  await caption('It recognizes the completed write and continues without repeating it.', 6000);
  await page.getByRole('tab', { name: 'App state', exact: true }).click();
  await caption(live ? 'Read back from real apps: new work kept open, owner restored, one Slack correction.' : 'Verified sample state: duplicate closed, human assignment kept, one Slack correction.', 6500);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recovery receipt' }).click();
  await (await download).saveAs(join(out, 'recovery-receipt.json'));
  await caption('The receipt records the run, the decision, the human edit, and the verified outcome.', 5000);
  const final = await (await context.request.get(`${base}/api/workspace`)).json();
  record.final = final;
  record.complete = final.plans.at(-1)?.status === 'complete';
  if (!record.complete) throw new Error('The final repair is not complete.');
  await page.getByRole('button', { name: 'Evaluation', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'How reliably Aftercare repairs' }).waitFor();
  await caption('Frozen AI holdouts: 10/12, then 15/15 on new cases. Both reports keep every failure.', 6500);
  await caption('Small authored suites · real model, simulated apps. Live receipts are separate evidence.', 5500);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Repair plan/ }).click();
  await caption('Aftercare. Repair agent mistakes. Preserve human work. aftercare-ynmc.onrender.com', 6000);
  await page.screenshot({ path: join(out, 'final-frame.png') });
  record.finishedAt = new Date().toISOString(); save();
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error); save();
  await page.screenshot({ path: join(out, 'failure-frame.png') }).catch(() => {});
  throw error;
} finally {
  if (keyIssued) await context.request.post(`${base}/api/agent/key/revoke`, { data: {} }).catch(() => {});
  const video = page.video();
  await context.close();
  if (video) renameSync(await video.path(), join(out, 'uncut.webm'));
  await browser.close(); server?.kill();
}

const input = join(out, 'uncut.webm');
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input], { encoding: 'utf8' });
if (probe.status !== 0) throw new Error('ffprobe could not read the captured video.');
const duration = Number(probe.stdout.trim());
const segments: { start: number; end: number }[] = [];
let start = record.openingSeconds ?? 0;
for (const cut of record.cuts) {
  if (cut.end <= start) continue;
  if (cut.start > start) segments.push({ start, end: cut.start });
  start = cut.end;
}
segments.push({ start, end: duration });
const graph = segments.map((s, i) => `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`).join(';')
  + ';' + segments.map((_, i) => `[v${i}]`).join('') + `concat=n=${segments.length}:v=1:a=0[out]`;
const target = join(out, live ? 'aftercare-live-mcp.mp4' : 'aftercare-submission.mp4');
const converted = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libx264', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target], { stdio: 'inherit' });
if (converted.status !== 0) throw new Error('Video conversion failed; original recording retained.');
record.video = { file: target, uncutSeconds: duration, editedSeconds: segments.reduce((sum, s) => sum + s.end - s.start, 0) }; save();
if (record.video.editedSeconds > 120) throw new Error('Video exceeds two minutes; shorten pauses before publishing.');
console.log(JSON.stringify({ complete: record.complete, mode: record.mode, model: record.model, investigations: record.attempts.map((a: any) => ({ latencyMs: a.latencyMs, httpStatus: a.httpStatus })), video: record.video, artifacts: out }, null, 2));

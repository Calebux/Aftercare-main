// Records a silent, captioned walkthrough of the local sample scenario. It uses scenario rules
// and simulated app records only: no model calls, no app tokens, and a throwaway data directory.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, type Page } from '@playwright/test';

const PORT = 4398;
const base = `http://127.0.0.1:${PORT}`;
const out = resolve('demo-output');
if (!existsSync('dist/client/index.html')) throw new Error('Build the client first: npm run build');
mkdirSync(out, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'aftercare-demo-'));

const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', AFTERCARE_SCENARIO_ONLY: '1', AFTERCARE_DATA_DIR: data },
});
await new Promise<void>((ready, fail) => {
  const timer = setTimeout(() => fail(new Error('The demo server did not start.')), 15_000);
  server.stdout!.on('data', chunk => { if (String(chunk).includes('Aftercare:')) { clearTimeout(timer); ready(); } });
  server.once('exit', () => fail(new Error('The demo server exited before starting.')));
});

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
/** A caption strip that never intercepts clicks. */
async function caption(page: Page, text: string, hold = 2200) {
  await page.evaluate(value => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.setAttribute('style', 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;max-width:80%;padding:12px 20px;border-radius:10px;background:#1f1b2ecc;color:#fff;font:600 18px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none');
      document.body.appendChild(el);
    }
    el.textContent = value;
  }, text);
  await pause(hold);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: out, size: { width: 1440, height: 900 } }, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(base);

  await page.getByRole('dialog', { name: /When an AI agent makes a mess/ }).waitFor();
  await caption(page, 'When an AI agent makes a mess across your apps, Aftercare cleans it up safely.', 3000);
  await page.getByRole('button', { name: 'See it on sample data' }).click();

  await page.getByRole('tab', { name: /Agent run/ }).click();
  await caption(page, 'Every action the agent took is recorded, with the values before and after.', 3200);

  await page.getByRole('tab', { name: /Repair plan/ }).click();
  await page.getByRole('button', { name: /Prepare repair plan/ }).click();
  await page.getByRole('button', { name: 'Approve 3 changes' }).waitFor();
  await caption(page, 'Aftercare proposes exact changes. Nothing is written until you approve.', 2800);
  await page.getByRole('button', { name: 'Evidence', exact: true }).first().click();
  await caption(page, 'Each change links to the recorded evidence behind it.', 2600);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Simulate a human edit' }).click();
  await caption(page, 'Meanwhile, a teammate reassigns the task. The old approval is now blocked.', 3000);
  await page.getByRole('button', { name: 'Review updated plan' }).click();
  await page.getByText('Preserve the human assignment').waitFor();
  await caption(page, 'The updated plan keeps the teammate’s decision instead of overwriting it.', 3000);

  await page.getByLabel('Interrupt after the first write').check();
  await caption(page, 'Now simulate a dropped connection right after the first write.', 2200);
  await page.getByRole('button', { name: 'Approve 2 changes' }).click();
  await page.getByRole('button', { name: 'Apply approved repair' }).click();
  await page.getByRole('button', { name: 'Reconcile & resume' }).waitFor();
  await caption(page, 'Aftercare reads the app back before continuing, so nothing is written twice.', 3000);
  await page.getByRole('button', { name: 'Reconcile & resume' }).click();
  await page.getByRole('button', { name: 'Export recovery receipt' }).waitFor();
  await caption(page, 'Verified. The receipt records the evidence, decisions, and outcome.', 2600);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recovery receipt' }).click();
  await (await download).saveAs(join(out, 'sample-recovery-receipt.json'));

  await page.getByRole('button', { name: 'Evaluation', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'How reliably Aftercare repairs' }).waitFor();
  await caption(page, 'Measured, not claimed: seeded failure trials and real-model results, failures included.', 3400);
  await page.getByRole('dialog').evaluate(el => el.scrollBy({ top: 700, behavior: 'smooth' }));
  await pause(2600);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Reset scenario' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset scenario' }).click();
  await page.getByLabel('Explore a different incident').selectOption('distinct-work');
  await page.getByRole('button', { name: /Prepare repair plan/ }).click();
  await page.getByText('Preserve the issue for separate review').waitFor();
  await caption(page, 'Same title, different work: the issue is kept for review, not closed.', 3400);

  const video = page.video();
  await context.close();
  const webm = join(out, 'aftercare-walkthrough.webm');
  if (video) renameSync(await video.path(), webm);
  // Convert when ffmpeg is available; the WebM is kept either way.
  if (spawnSync('ffmpeg', ['-version']).status === 0) {
    const mp4 = join(out, 'aftercare-walkthrough.mp4');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
  }
  console.log(`Saved ${readdirSync(out).filter(f => f.startsWith('aftercare-walkthrough') || f.endsWith('.json')).join(', ')} in ${out}`);
} finally {
  await browser.close();
  server.kill();
  rmSync(data, { recursive: true, force: true });
}

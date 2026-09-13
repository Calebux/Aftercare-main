// Verifies that the published artifact is a playable video, not an SPA fallback or broken link.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
const url = process.argv[2] ?? 'http://127.0.0.1:4310/demo.html';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  assert.equal(response?.status(), 200);
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 1; }, { timeout: 60_000 });
  const metadata = await page.locator('video').evaluate(async video => {
    video.muted = true;
    await video.play();
    await new Promise(done => setTimeout(done, 1200));
    video.pause();
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, error: video.error?.message ?? null };
  });
  assert(metadata.duration > 60 && metadata.duration <= 120);
  assert(metadata.width >= 1280 && metadata.height > 0 && metadata.currentTime > 0);
  assert.equal(metadata.error, null);
  mkdirSync('demo-output', { recursive: true });
  await page.screenshot({ path: 'demo-output/playback-check.png', fullPage: true });
  console.log(JSON.stringify({ url, playable: true, ...metadata }, null, 2));
} finally { await browser.close(); }

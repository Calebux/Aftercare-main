import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui', workers: 1,
  use: { baseURL: 'http://127.0.0.1:4311', viewport: { width: 1440, height: 1100 } },
  webServer: { command: 'PORT=4311 AFTERCARE_SCENARIO_ONLY=1 AFTERCARE_DATA_DIR=.data/ui-test npm run dev', url: 'http://127.0.0.1:4311', reuseExistingServer: false },
});

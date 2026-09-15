import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Every browser test invocation gets fresh state without touching the operator's workspace.
const dataDir = mkdtempSync(join(tmpdir(), 'aftercare-ui-'));
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: '4311', HOST: '127.0.0.1', NODE_ENV: 'development', AFTERCARE_SCENARIO_ONLY: '1', AFTERCARE_PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', AFTERCARE_DATA_DIR: dataDir },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { rmSync(dataDir, { recursive: true, force: true }); process.exit(code ?? 0); });

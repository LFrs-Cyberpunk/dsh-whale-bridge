#!/usr/bin/env node
// CLI wrapper around scripts/selfcheck-core.mjs. Exit 0 = all checks passed.
// A failing run writes logs/selfcheck-<stamp>.log and pops up a dialog, unless
// WHALE_SELFCHECK_NO_POPUP=1. Pass --quiet to skip the dialog explicitly.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfcheck } from './selfcheck-core.mjs';
import { alertFailure } from './selfcheck-alert.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet') || process.env.WHALE_SELFCHECK_NO_POPUP === '1';

runSelfcheck({ projectRoot })
  .then(async (report) => {
    const alert = report.ok ? { logged: null, popped: false } : await alertFailure({
      projectRoot, report, env: quiet ? { ...process.env, WHALE_SELFCHECK_NO_POPUP: '1' } : process.env,
    });
    process.stdout.write(JSON.stringify({ ...report, alert }, null, 2) + '\n');
    process.exit(report.ok ? 0 : 1);
  })
  .catch(async (error) => {
    const report = { ok: false, error: String(error?.code ?? error?.message ?? error) };
    const alert = await alertFailure({
      projectRoot, report, error, env: quiet ? { ...process.env, WHALE_SELFCHECK_NO_POPUP: '1' } : process.env,
    });
    process.stdout.write(JSON.stringify({ ...report, alert }, null, 2) + '\n');
    process.exit(1);
  });

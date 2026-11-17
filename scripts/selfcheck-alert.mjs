/**
 * Alerting for a failed self-check.
 *
 * The user asked for this explicitly: "开发阶段故障直接弹弹窗报错就好了，然后自己
 * 写报错日志自己读，自己修." So a failing check must be loud — but never on a
 * passing run, and never in CI or a scripted run.
 *
 * Rules:
 *   - only fires when the report says ok:false
 *   - WHALE_SELFCHECK_NO_POPUP=1 silences the dialog (log still written)
 *   - non-Windows / headless: log only, no dialog attempt
 *   - never throws: alerting must not be able to break the check it reports on
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const KEEP_LOGS = 20;

/** Failing check names, one line each, in a form that reads well in a dialog. */
export function failureSummary(report) {
  const failed = (report?.checks ?? []).filter((c) => !c.ok);
  if (!failed.length) return '';
  return failed.map((c) => '· ' + (c.name || c.id || '未命名检查') + (c.detail ? '：' + String(c.detail).slice(0, 120) : '')).join('\n');
}

export async function writeFailureLog({ projectRoot, report, error = null }) {
  const dir = join(projectRoot, 'logs');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `selfcheck-${stamp}.log`);
  const body = [
    'time: ' + new Date().toISOString(),
    'ok: ' + (report?.ok ?? false),
    'mockOnly: ' + (report?.mockOnly ?? null),
    '',
    '--- failed checks ---',
    failureSummary({ checks: (report?.checks ?? []).filter((c) => !c.ok) }) || '(none reported)',
    '',
    '--- full report ---',
    JSON.stringify(report ?? { error: String(error?.message ?? error) }, null, 2),
  ].join('\n');
  await writeFile(file, body + '\n', 'utf8');
  // Keep the directory from growing without bound during a debugging session.
  try {
    const logs = (await readdir(dir)).filter((n) => n.startsWith('selfcheck-')).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) await rm(join(dir, old), { force: true });
  } catch { /* cleanup is best effort */ }
  return file;
}

/** Windows message box, fire-and-forget. Returns false when it was not shown. */
export function showPopup({ title, message, env = process.env }) {
  if (env.WHALE_SELFCHECK_NO_POPUP === '1') return false;
  if (process.platform !== 'win32') return false;
  // Escape single quotes for the PowerShell string literal.
  const esc = (s) => String(s).replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName PresentationFramework",
    `[System.Windows.MessageBox]::Show('${esc(message)}','${esc(title)}','OK','Error') | Out-Null`,
  ].join('; ');
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    return true;
  } catch { return false; }
}

/**
 * One call the CLI uses: log always, pop up only when something actually failed.
 * Returns what it did so tests (and the CLI) can assert without dialogs.
 */
export async function alertFailure({ projectRoot, report, error = null, env = process.env }) {
  const failed = (report?.checks ?? []).some((c) => !c.ok);
  const fatal = Boolean(error) || report?.ok === false;
  if (!fatal) return { logged: null, popped: false };
  let logged = null;
  try { logged = await writeFailureLog({ projectRoot, report, error }); } catch { /* never mask the real failure */ }
  const summary = failureSummary(report) || String(error?.message ?? error ?? '自检失败');
  const popped = showPopup({
    title: '鲸鲸桥接自检失败',
    message: summary + (logged ? '\n\n日志：' + logged : ''),
    env,
  });
  return { logged, popped, failed: failed || Boolean(error) };
}

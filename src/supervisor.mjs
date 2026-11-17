/**
 * Keeps the bridge process alive without the user opening a terminal.
 *
 * WHY A SUPERVISOR AND NOT IN-PROCESS: running the HTTP listener and an ACP child
 * inside DSH's own process would put every bridge bug on the critical path of the
 * thing the user cannot afford to lose. A supervised child process is one crash
 * away from the host and can be restarted without touching DSH.
 *
 * Rules:
 *   - the user's switch is the only thing that starts it; nothing auto-starts on load
 *   - a crash restarts with capped backoff, and gives up after repeated fast failures
 *     so a broken install cannot spin forever
 *   - stopping kills the whole process tree (cmd.exe does not take its child with it)
 *   - every failure is recorded, never swallowed silently
 */
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';

const FAST_FAIL_MS = 5000;
const MAX_FAST_FAILS = 3;
const BACKOFF_MS = [1000, 3000, 8000];

export class BridgeSupervisor {
  #ready = null;
  #resolveReady = null;

  constructor({ projectRoot, nodePath = process.execPath, entry = null, env = {}, onEvent = null, backoff = BACKOFF_MS, maxFastFails = MAX_FAST_FAILS } = {}) {
    this.backoff = backoff;
    this.maxFastFails = maxFastFails;
    this.projectRoot = projectRoot;
    this.nodePath = nodePath;
    this.entry = entry ?? join(projectRoot, 'scripts', 'wire-host.mjs');
    this.baseEnv = env;
    this.onEvent = onEvent;
    this.child = null;
    this.desired = false;      // what the user asked for
    this.fastFails = 0;
    this.restartTimer = null;
    this.listening = null;     // { url, token } once the child reports ready
    this.lastError = null;
    this.startedAt = null;
    this.stdoutTail = '';
    this.#ready = null;
    this.#resolveReady = null;
  }

  status() {
    return {
      desired: this.desired,
      running: Boolean(this.child && this.child.exitCode === null),
      pid: this.child?.pid ?? null,
      listening: this.listening?.url ?? null,
      hasToken: Boolean(this.listening?.token),
      startedAt: this.startedAt,
      restarts: this.fastFails,
      lastError: this.lastError,
      tail: this.stdoutTail.slice(-600),
    };
  }

  /**
   * Ask the child for its live counters. The settings panel used to read the
   * host-side engine, which sits idle forever because every real request goes
   * directly to the child's HTTP proxy. Returns null when the child is down.
   */
  async liveStatus(timeoutMs = 1500) {
    const url = this.listening?.url;
    const token = this.listening?.token;
    if (!url || !token || !this.child || this.child.exitCode !== null) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/status', {
        headers: { authorization: 'Bearer ' + token },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      return body?.status ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start and resolve once the child prints its ready JSON (or fails to). */
  async start({ timeoutMs = 30000, env: overrideEnv = null } = {}) {
    if (this.child && this.child.exitCode === null) return this.status();
    this.desired = true;
    this.lastError = null;
    this.stdoutTail = '';
    this.#ready = null;
    this.#resolveReady = null;
    this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
    const child = spawn(this.nodePath, [this.entry], {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        ...this.baseEnv,
        // The settings page decides adapter/model/key; read them fresh on every
        // start so a changed setting cannot be served by a stale process.
        ...(overrideEnv ?? {}),
        // Inside the DSH desktop app process.execPath is the Electron binary, not
        // node. Without this flag the spawn would open a second GUI window instead
        // of running the script.
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.startedAt = Date.now();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      this.stdoutTail += chunk;
      if (this.stdoutTail.length > 8000) this.stdoutTail = this.stdoutTail.slice(-4000);
      buffered += chunk;
      // The bridge prints one JSON object with listening/token when it is ready.
      const match = buffered.match(/\{[\s\S]*?"listening"[\s\S]*?\}/);
      if (match && !this.listening) {
        try {
          const info = JSON.parse(match[0]);
          if (info.listening && info.token) {
            this.listening = { url: info.listening, token: info.token };
            this.fastFails = 0;
            this.onEvent?.({ type: 'ready', ...this.listening });
            this.#resolveReady?.({ ok: true, ...this.listening });
          }
        } catch { /* partial JSON, wait for more */ }
      }
    });
    child.stderr.on('data', (chunk) => { this.lastError = String(chunk).slice(-400); });
    child.once('exit', (code) => {
      const ranFor = Date.now() - (this.startedAt ?? Date.now());
      this.child = null;
      this.listening = null;
      if (ranFor < FAST_FAIL_MS) this.fastFails += 1; else this.fastFails = 0;
      this.onEvent?.({ type: 'exit', code, ranFor, fastFails: this.fastFails });
      this.#resolveReady?.({ ok: false, error: this.lastError || `进程退出 code=${code}` });
      if (this.desired) this.#scheduleRestart();
    });

    const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: '启动超时' }), timeoutMs));
    return Promise.race([this.#ready, timeout]).then(async (result) => {
      if (!result.ok) { this.lastError = result.error ?? this.lastError; }
      return this.status();
    });
  }

  #scheduleRestart() {
    if (this.restartTimer) return;
    if (this.fastFails >= this.maxFastFails) {
      this.desired = false;
      this.lastError = (this.lastError || '') + '\n连续快速失败，已停止自动重启。请手动排查。';
      this.onEvent?.({ type: 'gave_up', fastFails: this.fastFails });
      return;
    }
    const wait = this.backoff[Math.min(this.fastFails, this.backoff.length - 1)];
    this.onEvent?.({ type: 'restart_scheduled', wait });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.desired) this.start().catch(() => {});
    }, wait);
    this.restartTimer.unref?.();
  }

  /** Stop and kill the whole tree; cmd/Electron children do not die on their own. */
  async stop() {
    this.desired = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const child = this.child;
    if (!child || child.exitCode !== null) return this.status();
    const pid = child.pid;
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      setTimeout(done, 4000);
      try {
        if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
        else try { child.kill('SIGTERM'); } catch { /* ignore */ }
      } catch { /* ignore */ }
    });
    this.child = null;
    this.listening = null;
    return this.status();
  }

  async toggle(on) { return on ? this.start() : this.stop(); }
}

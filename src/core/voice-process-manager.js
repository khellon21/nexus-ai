/**
 * VoiceProcessManager — lifecycle supervisor for the local Python voice microservice.
 *
 * Responsibilities
 *   • Boot `uvicorn services.tts.server:app` as a child process when the
 *     Node.js app starts (auto-start).
 *   • Track idle time — if no voice request has been routed to the server
 *     for IDLE_MS milliseconds, terminate the child to free RAM.
 *   • On the next voice request, lazily re-spawn and block the caller
 *     until `/health` returns 200 (lazy wake-up / cold start).
 *   • Surface stdout/stderr from the child into the main Node.js console
 *     with a distinct prefix so a dev can see both processes interleaved.
 *
 * Concurrency
 *   • ensureAwake() is idempotent and coalesces: multiple simultaneous
 *     callers during a cold start share a single wake promise.
 *   • shutdown() is safe to call multiple times and from signal handlers.
 *
 * Usage
 *   const voiceMgr = new VoiceProcessManager({ port: 8808 });
 *   voiceMgr.start();                      // auto-start at boot
 *   const { coldStart } = await voiceMgr.ensureAwake();
 *   if (coldStart) bot.sendMessage(chatId, "🎙️ Waking up voice engine…");
 *   const wav = await ai.textToSpeech(text); // will also call ensureAwake/markActivity
 *   voiceMgr.markActivity();               // reset the 2-min idle timer
 */

import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const DEFAULT_IDLE_MS = 2 * 60 * 1000;          // 2 minutes
const DEFAULT_WAKE_TIMEOUT_MS = 60 * 1000;       // give uvicorn up to 60s to bind
const DEFAULT_HEALTH_POLL_MS = 250;              // poll /health every 250ms
const DEFAULT_KILL_GRACE_MS = 5 * 1000;          // SIGTERM → wait → SIGKILL

export class VoiceProcessManager extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.host='127.0.0.1']
   * @param {number} [opts.port=8808]
   * @param {string} [opts.pythonBin]        — override interpreter (default: env.PYTHON_BIN || 'python3' || 'python')
   * @param {string} [opts.appModule='services.tts.server:app']
   * @param {string} [opts.cwd=process.cwd()] — working dir for the child (project root)
   * @param {number} [opts.idleMs]           — idle shutdown threshold
   * @param {number} [opts.wakeTimeoutMs]
   * @param {boolean}[opts.logPrefix=true]   — prepend '[voice-py]' to child output
   * @param {boolean}[opts.autoStart=true]   — whether start() should spawn immediately
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || process.env.VOICE_HOST || '127.0.0.1';
    this.port = Number(opts.port || process.env.VOICE_PORT || 8808);
    this.pythonBin = opts.pythonBin || process.env.PYTHON_BIN || process.env.PYTHON || 'python3';
    this.appModule = opts.appModule || 'services.tts.server:app';
    this.cwd = opts.cwd || process.cwd();
    this.idleMs = Number(opts.idleMs ?? process.env.VOICE_IDLE_MS ?? DEFAULT_IDLE_MS);
    this.wakeTimeoutMs = Number(opts.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS);
    this.healthPollMs = Number(opts.healthPollMs ?? DEFAULT_HEALTH_POLL_MS);
    this.killGraceMs = Number(opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    this.logPrefix = opts.logPrefix !== false;
    this.autoStart = opts.autoStart !== false;

    this.child = null;             // ChildProcess | null
    this._wakePromise = null;      // single in-flight wake promise
    this._idleTimer = null;
    this._shuttingDown = false;
    this._resolvedPython = null;   // cached after first successful resolution
    this._stderrBuf = '';          // short rolling buffer of recent child stderr
  }

  /**
   * Find a usable Python interpreter. Tries, in order:
   *   1) whatever the user configured (opts.pythonBin / PYTHON_BIN / PYTHON)
   *   2) python3
   *   3) python
   *   4) py       (Windows launcher)
   * Resolution is cached after the first success.
   */
  _resolvePython() {
    if (this._resolvedPython) return this._resolvedPython;
    const candidates = [this.pythonBin, 'python3', 'python', 'py']
      .filter(Boolean)
      // de-duplicate while preserving order
      .filter((v, i, a) => a.indexOf(v) === i);

    for (const bin of candidates) {
      try {
        const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
        if (r.status === 0) {
          this._resolvedPython = bin;
          if (bin !== this.pythonBin) {
            this._log(`python binary '${this.pythonBin}' not runnable, using '${bin}'`);
          }
          return bin;
        }
      } catch { /* try next */ }
    }
    throw new Error(
      `No Python interpreter found (tried: ${candidates.join(', ')}). ` +
      `Install Python 3 or set PYTHON_BIN in your .env.`
    );
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  /** Returns true iff a spawned child is currently alive. */
  get isRunning() {
    return !!(this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  // ─────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────

  /** Boot the Python service (auto-start path). Safe to call multiple times. */
  async start() {
    if (!this.autoStart) {
      this._log('auto-start disabled; service will be spawned on first request');
      return;
    }
    if (this.isRunning) return;
    this._log(`spawning voice service (idle shutdown: ${Math.round(this.idleMs / 1000)}s)`);
    await this.ensureAwake();
    // Initial boot counts as activity so we don't instantly sleep.
    this.markActivity();
  }

  /**
   * Guarantee the voice service is reachable. Returns `{ coldStart }`:
   *   • coldStart=false when the child was already alive and /health responded.
   *   • coldStart=true  when we had to (re-)spawn and/or wait for uvicorn to bind.
   * Concurrent callers during a cold start share the same wake promise.
   */
  async ensureAwake() {
    if (this._shuttingDown) throw new Error('VoiceProcessManager is shutting down');

    // Fast path: child is alive AND we already saw a healthy ping recently.
    if (this.isRunning && await this._pingOnce()) {
      return { coldStart: false, baseUrl: this.baseUrl };
    }

    // Slow path: coalesce concurrent cold starts.
    if (!this._wakePromise) {
      this._wakePromise = this._coldStart().finally(() => {
        this._wakePromise = null;
      });
    }
    await this._wakePromise;
    return { coldStart: true, baseUrl: this.baseUrl };
  }

  /** Reset the idle-shutdown timer. Call this on every successful voice request. */
  markActivity() {
    if (this._shuttingDown) return;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this.idleMs > 0) {
      this._idleTimer = setTimeout(() => this._idleSleep(), this.idleMs);
      // Node default unref'd timers would let the process exit even while the
      // idle timer is running. We intentionally DON'T unref here — a pending
      // idle-shutdown should not keep the process alive on its own, but also
      // shouldn't be cancelled silently. The caller controls lifetime via SIGINT.
    }
  }

  /** Tear down the child; safe to call from signal handlers. */
  async shutdown({ reason = 'shutdown' } = {}) {
    this._shuttingDown = true;
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    await this._killChild(reason);
  }

  // ─────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────

  async _coldStart() {
    this.emit('waking');
    // If there's a stale child that's exited unexpectedly, drop it first.
    if (this.child && !this.isRunning) this.child = null;

    if (!this.isRunning) {
      this._spawnChild();
    }
    await this._waitForHealth();
    this.emit('awake');
  }

  _spawnChild() {
    const pythonBin = this._resolvePython();
    // We use `python -m uvicorn …` rather than `uvicorn` directly so that the
    // binary is always resolved from the Python environment we're told to use.
    // --host/--port override any defaults inside server.py.
    const args = [
      '-u',                        // unbuffered stdout so logs stream live
      '-m', 'uvicorn',
      this.appModule,
      '--host', this.host,
      '--port', String(this.port),
      '--log-level', process.env.VOICE_LOG_LEVEL || 'info',
    ];

    this._log(`${pythonBin} ${args.join(' ')}`);
    this._stderrBuf = '';
    const child = spawn(pythonBin, args, {
      cwd: this.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // `detached:false` keeps the child bound to this process group so a
      // parent SIGKILL cleans it up. On Windows we still rely on shutdown().
    });

    child.stdout.on('data', (b) => this._pipeLog('stdout', b));
    child.stderr.on('data', (b) => {
      // Keep a short rolling buffer so _waitForHealth can include the real
      // error (e.g. "No module named 'uvicorn'") when the child dies before
      // binding the port. Cap at ~4KB so we don't grow unbounded.
      this._stderrBuf = (this._stderrBuf + b.toString('utf8')).slice(-4096);
      this._pipeLog('stderr', b);
    });

    child.on('error', (err) => {
      console.error(`  ✗ [voice-py] spawn error: ${err.message}`);
      this.emit('error', err);
    });

    child.on('exit', (code, signal) => {
      const how = signal ? `signal=${signal}` : `code=${code}`;
      this._log(`child exited (${how})`);
      this.child = null;
      this.emit('exit', { code, signal });
    });

    this.child = child;
  }

  async _waitForHealth() {
    const deadline = Date.now() + this.wakeTimeoutMs;
    while (Date.now() < deadline) {
      // If the child died before we got a healthy response, fail fast with
      // whatever Python wrote to stderr so the user can fix the real cause
      // (missing uvicorn, ModuleNotFoundError, wrong cwd, etc.).
      if (!this.isRunning) {
        throw new Error(
          `voice service exited during cold start. ` +
          this._buildDiagnosisHint() +
          (this._stderrBuf ? `\nLast stderr:\n${this._stderrBuf.trim()}` : '')
        );
      }
      if (await this._pingOnce()) return;
      await sleep(this.healthPollMs);
    }
    // Timeout: kill whatever we started so we don't leak a wedged uvicorn.
    await this._killChild('wake-timeout');
    throw new Error(
      `voice service did not become healthy within ${this.wakeTimeoutMs}ms. ` +
      this._buildDiagnosisHint() +
      (this._stderrBuf ? `\nLast stderr:\n${this._stderrBuf.trim()}` : '')
    );
  }

  _buildDiagnosisHint() {
    const stderr = this._stderrBuf || '';
    if (/No module named ['"]?uvicorn/.test(stderr)) {
      return `Python uvicorn is not installed. Run:\n  pip install fastapi uvicorn python-multipart faster-whisper voxcpm soundfile numpy`;
    }
    if (/No module named ['"]?fastapi/.test(stderr)) {
      return `Python fastapi is not installed. Run:\n  pip install fastapi uvicorn python-multipart faster-whisper voxcpm soundfile numpy`;
    }
    if (/No module named ['"]?services/.test(stderr) || /Error loading ASGI app/.test(stderr)) {
      return `'services.tts.server:app' could not be imported — make sure you ran npm start from the project root (cwd=${this.cwd}).`;
    }
    if (/\[Errno 98\]|address already in use|address in use/i.test(stderr)) {
      return `Port ${this.port} is already in use. Set VOICE_PORT to a free port in .env.`;
    }
    return `Check that Python is installed and that \`${this.pythonBin} -m uvicorn --help\` works from this terminal.`;
  }

  async _pingOnce() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(`${this.baseUrl}/health`, { signal: ctl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async _idleSleep() {
    if (!this.isRunning) return;
    this._log(`idle for ${Math.round(this.idleMs / 1000)}s — sleeping voice service to free RAM`);
    this.emit('sleeping');
    await this._killChild('idle');
    this.emit('slept');
  }

  async _killChild(reason) {
    const child = this.child;
    if (!child) return;

    this._log(`killing voice child (reason=${reason}, pid=${child.pid})`);
    try { child.kill('SIGTERM'); } catch { /* ignore */ }

    // Wait for graceful exit, then escalate to SIGKILL.
    const exited = await this._awaitExit(child, this.killGraceMs);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      await this._awaitExit(child, 2000);
    }
    this.child = null;
  }

  _awaitExit(child, ms) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), ms);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  _pipeLog(stream, buf) {
    const text = buf.toString('utf8').replace(/\s+$/, '');
    if (!text) return;
    const prefix = this.logPrefix ? (stream === 'stderr' ? '\x1b[33m[voice-py]\x1b[0m ' : '\x1b[90m[voice-py]\x1b[0m ') : '';
    // Uvicorn writes its access log to stderr by default — that's normal,
    // not an error, so don't color it red.
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      (stream === 'stderr' ? console.error : console.log)(`${prefix}${line}`);
    }
  }

  _log(msg) {
    console.log(`\x1b[35m  [VoiceMgr]\x1b[0m ${msg}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default VoiceProcessManager;

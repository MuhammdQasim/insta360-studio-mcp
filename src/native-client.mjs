import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

function nativeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  if (cause?.code) error.native_code = cause.code;
  return error;
}

export class NativeClient {
  constructor(rootDir, { spawnFn = spawn } = {}) {
    this.rootDir = rootDir;
    this.spawnFn = spawnFn;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.generation = 0;
    this.active = null;
    this.closed = false;
  }
  isGenerationLive(generation) {
    return Boolean(!this.closed && this.active?.live && this.active.generation === generation
      && this.child === this.active.child && !this.child.killed && !this.child.stdin.destroyed);
  }
  start() {
    if (this.closed) throw nativeError('NATIVE_CLOSED', 'The native client is closed.');
    if (this.active?.live && this.isGenerationLive(this.active.generation)) return this.child;
    // A failed request is never replayed. Only a subsequent request can start a new adapter.
    if (this.active?.live) {
      this.retire(this.active, nativeError('NATIVE_EXITED', 'Native adapter is no longer writable. Observe before continuing.'), true);
    }
    const generation = ++this.generation;
    let child;
    try {
      child = this.spawnFn(join(this.rootDir, '.venv', 'Scripts', 'python.exe'),
        ['-u', join(this.rootDir, 'native', 'studio_bridge.py')],
        { cwd: this.rootDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (cause) {
      throw nativeError('NATIVE_SPAWN_ERROR', `Cannot start the native adapter: ${cause.message}`, cause);
    }
    const record = { child, generation, live: true, lines: null };
    this.child = child;
    this.active = record;
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    record.lines = createInterface({ input: child.stdout });
    const protocolReadFailed = cause => {
      this.retire(record, nativeError('NATIVE_PROTOCOL_ERROR', `Cannot read the native adapter protocol: ${cause.message}. Outcome is unknown; observe before continuing.`, cause), true);
    };
    record.lines.on('error', protocolReadFailed);
    record.lines.on('line', line => {
      if (!record.live) return;
      let message;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)
          || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.ok !== 'boolean') {
          throw new Error('Response must contain an integer request ID and boolean ok.');
        }
      } catch (cause) {
        this.retire(record, nativeError('NATIVE_PROTOCOL_ERROR', 'Native adapter returned invalid protocol data. Outcome is unknown; observe before continuing.', cause), true);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending || pending.generation !== generation) {
        this.retire(record, nativeError('NATIVE_PROTOCOL_ERROR', 'Native adapter returned an unexpected request ID. Outcome is unknown; observe before continuing.'), true);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.error?.message || 'Native adapter failed.'), { code: message.error?.code || 'NATIVE_ERROR' }));
    });
    child.once('error', cause => {
      this.retire(record, nativeError('NATIVE_SPAWN_ERROR', `Native adapter process failed: ${cause.message}. Observe before continuing.`, cause), true);
    });
    child.once('exit', (code, signal) => {
      this.retire(record, nativeError('NATIVE_EXITED', `Native adapter exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}). An interrupted input has an unknown outcome; observe before continuing.`));
    });
    // Failed spawns may emit error and close without ever emitting exit.
    child.once('close', () => {
      this.retire(record, nativeError('NATIVE_EXITED', 'Native adapter closed. An interrupted input has an unknown outcome; observe before continuing.'));
    });
    child.stdin.on('error', cause => {
      this.retire(record, nativeError('NATIVE_WRITE_ERROR', `Cannot write to the native adapter: ${cause.message}. Outcome is unknown; observe before continuing.`, cause), true);
    });
    child.stdout.on('error', protocolReadFailed);
    // Retain a listener so a peripheral stderr failure cannot crash the MCP server.
    child.stderr.on('error', cause => {
      if (record.live) process.stderr.write(`Native adapter diagnostic stream failed: ${cause.message}\n`);
    });
    return child;
  }
  failGeneration(generation, error) {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
  retire(record, error, kill = false) {
    if (!record.live) return;
    record.live = false;
    if (this.active === record) {
      this.active = null;
      this.child = null;
    }
    record.lines?.close();
    this.failGeneration(record.generation, error);
    if (kill && !record.child.killed) {
      try { record.child.kill(); } catch { /* The adapter may already have exited. */ }
    }
  }
  request(method, params = {}, timeoutMs = 30000) {
    let child;
    try { child = this.start(); }
    catch (error) { return Promise.reject(error); }
    const record = this.active;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.retire(record, nativeError('NATIVE_TIMEOUT', `Native ${method} timed out. Outcome is unknown; do not repeat input without observing.`), true);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, generation: record.generation });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, cause => {
          if (!cause) return;
          this.retire(record, nativeError('NATIVE_WRITE_ERROR', `Cannot send native ${method}: ${cause.message}. Outcome is unknown; observe before continuing.`, cause), true);
        });
      } catch (cause) {
        this.retire(record, nativeError('NATIVE_WRITE_ERROR', `Cannot send native ${method}: ${cause.message}. Outcome is unknown; observe before continuing.`, cause), true);
      }
    });
  }
  async close() {
    this.closed = true;
    if (this.active) this.retire(this.active, nativeError('NATIVE_CLOSED', 'Server is closing. An interrupted input has an unknown outcome.'), true);
  }
}

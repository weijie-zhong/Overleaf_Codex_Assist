const os = require('os');

let pty = null;
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (err) {
  try {
    pty = require('node-pty');
  } catch (innerErr) {
    pty = null;
  }
}

class TerminalManager {
  constructor(options = {}) {
    this.getCommand = typeof options.getCommand === 'function' ? options.getCommand : async () => ({
      command: process.platform === 'win32' ? 'codex.cmd' : 'codex',
      args: [],
    });
    this.cwd = options.cwd || os.homedir();
    this.maxBufferChars = Number.isFinite(Number(options.maxBufferChars))
      ? Math.max(4096, Math.floor(Number(options.maxBufferChars)))
      : 200000;
    this.proc = null;
    this.listeners = new Set();
    this.buffer = '';
    this.state = {
      available: Boolean(pty),
      running: false,
      pid: null,
      exit_code: null,
      signal: null,
      error: '',
      started_at: 0,
    };
  }

  emit(event, payload) {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch (err) {
        // ignore listener failures so terminal flow stays live
      }
    }
  }

  onEvent(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot() {
    return {
      ...this.state,
      buffer: this.buffer,
    };
  }

  async start() {
    if (!pty) {
      const error = new Error('node-pty is not installed');
      error.code = 'pty_unavailable';
      throw error;
    }
    if (this.proc) {
      return this.getSnapshot();
    }

    const commandInfo = (await this.getCommand()) || {};
    const command =
      typeof commandInfo.command === 'string' && commandInfo.command.trim()
        ? commandInfo.command.trim()
        : process.platform === 'win32'
          ? 'codex.cmd'
          : 'codex';
    const args = Array.isArray(commandInfo.args) ? commandInfo.args.map((arg) => String(arg)) : [];
    const cwd =
      typeof commandInfo.cwd === 'string' && commandInfo.cwd.trim()
        ? commandInfo.cwd.trim()
        : this.cwd;
    const env = {
      ...process.env,
      ...(commandInfo.env && typeof commandInfo.env === 'object' ? commandInfo.env : {}),
    };

    this.buffer = '';
    this.state = {
      available: true,
      running: true,
      pid: null,
      exit_code: null,
      signal: null,
      error: '',
      started_at: Date.now(),
    };
    this.emit('reset', this.getSnapshot());

    try {
      this.proc = pty.spawn(command, args, {
        name: 'xterm-color',
        cols: 120,
        rows: 36,
        cwd,
        env,
      });
    } catch (err) {
      this.state.running = false;
      this.state.error = err && err.message ? err.message : 'Failed to start terminal';
      this.emit('state', this.getSnapshot());
      throw err;
    }

    this.state.pid = Number.isFinite(Number(this.proc.pid))
      ? Math.max(0, Math.floor(Number(this.proc.pid)))
      : null;
    this.emit('state', this.getSnapshot());

    this.proc.onData((chunk) => {
      const text = String(chunk || '');
      if (!text) {
        return;
      }
      this.buffer += text;
      if (this.buffer.length > this.maxBufferChars) {
        this.buffer = this.buffer.slice(this.buffer.length - this.maxBufferChars);
      }
      this.emit('data', text);
    });

    this.proc.onExit((event) => {
      this.proc = null;
      this.state.running = false;
      this.state.exit_code = Number.isFinite(Number(event && event.exitCode))
        ? Math.max(0, Math.floor(Number(event.exitCode)))
        : null;
      this.state.signal = Number.isFinite(Number(event && event.signal))
        ? Math.max(0, Math.floor(Number(event.signal)))
        : null;
      this.emit('exit', this.getSnapshot());
      this.emit('state', this.getSnapshot());
    });

    return this.getSnapshot();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async stop() {
    if (!this.proc) {
      return this.getSnapshot();
    }
    try {
      this.proc.kill();
    } catch (err) {
      // ignore kill failures while shutting down
    }
    return this.getSnapshot();
  }

  write(data) {
    if (!this.proc) {
      return false;
    }
    try {
      this.proc.write(String(data || ''));
      return true;
    } catch (err) {
      return false;
    }
  }

  resize(cols, rows) {
    if (!this.proc) {
      return false;
    }
    const nextCols = Number.isFinite(Number(cols)) ? Math.max(20, Math.floor(Number(cols))) : 120;
    const nextRows = Number.isFinite(Number(rows)) ? Math.max(5, Math.floor(Number(rows))) : 36;
    try {
      this.proc.resize(nextCols, nextRows);
      return true;
    } catch (err) {
      return false;
    }
  }
}

module.exports = {
  TerminalManager,
};

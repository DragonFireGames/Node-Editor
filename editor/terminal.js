(function () {
  class NodeConsoleTerminal {
    constructor(output, input, send, prompt, ensureRunner) {
      this.output = output;
      this.input = input;
      this.send = send;
      this.prompt = prompt;
      this.ensureRunner = typeof ensureRunner === 'function' ? ensureRunner : null;
      this.runner = null;
      this.boundConsole = null;
      this.console = new BrowserConsole(output, {
        urlCache: {}
      });
      send?.addEventListener('click', () => this.run());
      input?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.run();
        }
      });
    }
    attach(runner) {
      if (this.runner && this.boundConsole) this.runner.removeEventListener?.('console', this.boundConsole);
      this.runner = runner;
      this.boundConsole = null;
      if (runner) {
        this.boundConsole = (method, args) => {
          if (method === 'error') this.console.error(...args || []);
          else if (method === 'warn') this.console.warn(...args || []);
          else if (method === 'logText') this.console.logText(...args || []);
          else this.console.log(...args || []);
        };
        runner.addEventListener?.('console', this.boundConsole);
      }
      this.updatePrompt();
    }
    async runCommand(cmd) {
      cmd = String(cmd || '').trim();
      if (!cmd) return;
      if (!this.runner && this.ensureRunner) await this.ensureRunner();
      if (!this.runner) throw new Error('Node runtime is not ready.');
      this.console.add(this.console.styledSpan('$ ' + cmd, 'log-command'));
      try {
        return await this.runner.terminalCommand(cmd);
      } finally {
        this.updatePrompt();
      }
    }
    async run() {
      const cmd = this.input?.value.trim();
      if (!cmd) return;
      if (!this.runner && this.ensureRunner) await this.ensureRunner();
      if (!this.runner) {
        this.console.error('Node runtime is not ready.');
        return;
      }
      this.input.value = '';
      try {
        await this.runCommand(cmd);
      } catch (e) {
        this.console.error(e?.message || e);
      }
    }
    updatePrompt() {
      if (this.prompt) this.prompt.textContent = this.runner?.cwd ? `${this.runner.cwd} $` : '$';
    }
    clear() {
      this.console.clear();
    }
    dispose() {
      if (this.runner && this.boundConsole) this.runner.removeEventListener?.('console', this.boundConsole);
      this.boundConsole = null;
      this.runner = null;
    }
  }
  window.NodeConsoleTerminal = NodeConsoleTerminal;
  window.NodeTerminal = NodeConsoleTerminal;
})();

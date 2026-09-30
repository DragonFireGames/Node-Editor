(function() {
  const factories = window.EditorBuiltinFactories = window.EditorBuiltinFactories || {};
  factories.terminal = function(ctx) {
    const state = ctx.state;
    function renderTerminal(g, t) {
    const wrap = document.createElement('div');
    wrap.className = 'builtin-terminal';
    const out = document.createElement('div');
    out.className = 'builtin-terminal-output';
    const row = document.createElement('div');
    row.className = 'builtin-terminal-input';
    const prompt = document.createElement('span');
    prompt.textContent = '$';
    const input = document.createElement('input');
    input.placeholder = 'node / npm / shell command';
    const send = document.createElement('button');
    send.textContent = 'Send';
    row.append(prompt, input, send);
    wrap.append(out, row);
    g.viewBody.appendChild(wrap);
    let terminal = state.terminalTabs.get(t.id);
    if (!terminal) {
      terminal = new NodeConsoleTerminal(out, input, send, prompt);
      state.terminalTabs.set(t.id, terminal);
    }
    terminal.attach(state.nodeEmulator);
    terminal.updatePrompt();
  }
    function getOrOpenTerminal() {
    for (const g of state.workbench.groups.values()) {
      const t = g.tabs.find(x => x.kind === 'builtin' && x.builtin === 'terminal');
      if (t) {
        state.workbench.activateTab(g, t.id);
        return t;
      }
    }
    return ctx.openBuiltin('terminal', state.workbench.getFirstLeaf());
  }
    return {
      title: 'Terminal',
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m7 9 3 3-3 3M12 15h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      render: renderTerminal,
      getOrOpenTerminal
    };
  };
})();

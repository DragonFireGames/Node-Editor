(function() {
  const factories = window.EditorBuiltinFactories = window.EditorBuiltinFactories || {};
  factories.environment = function(ctx) {
    const state = ctx.state;
    function environmentStorageKey() {
      return 'editor.environment.' + (state.projectKey || 'default');
    }
    function loadEnvironment() {
    state.environment = {};
    // Projects created before the opt-in existed may already contain
    // .editor/process.env. Preserve their existing behavior; new projects
    // remain local-only until the user explicitly enables project saving.
    try {
      const explicit = state.deploymentSettings?.saveEnvironmentVariablesExplicit === true;
      if (!explicit && state.fs?.existsSync?.('/.editor/process.env')) {
        state.deploymentSettings.saveEnvironmentVariables = true;
        state.deploymentSettings.saveEnvironmentVariablesExplicit = true;
      }
    } catch (_) {}
    if (!ctx.loadProcessEnv()) {
      const legacy = ctx.readLegacyEditorConfig();
      if (legacy?.environment && typeof legacy.environment === 'object' && !Array.isArray(legacy.environment)) {
        ctx.applyEditorEnvironment(legacy.environment);
      } else {
        try {
          const v = JSON.parse(localStorage.getItem(environmentStorageKey()) || '{}');
          state.environment = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
        } catch (_) {
          state.environment = {};
        }
      }
    }
    saveEnvironmentToRuntime();
  }
    function saveEnvironmentToRuntime() {
    if (state.nodeEmulator?.env) {
      const env = state.nodeEmulator.env;
      for (const key of Object.keys(env)) {
        if (key !== 'NODE_ENV' && key !== 'USER') delete env[key];
      }
      Object.assign(env, state.environment);
    }
  }
    function saveEnvironment() {
    ctx.saveProcessEnv();
    saveEnvironmentToRuntime();
  }
    function renderEnvironment(g) {
    const div = document.createElement('div');
    div.className = 'editor-environment-page';
    div.innerHTML = '<div class="editor-environment-header"><h2>Environment Variables</h2><p>Variables are available through <code>process.env</code> when running a Node project in this workspace.</p></div><div class="editor-environment-persistence"><label><input class="editor-environment-save-toggle" type="checkbox"> Save environment variables in the project</label><div class="editor-environment-save-warning">Warning: saving environment variables stores their values in the project files. Anyone who can access the repository can see them. Do not save passwords, API keys, tokens, or other secrets.</div></div><div class="editor-environment-toolbar"><button class="editor-environment-add">Add Variable</button><button class="editor-environment-import">Import</button><button class="editor-environment-export">Export .env</button><button class="editor-environment-clear">Clear All</button><input class="editor-environment-import-input" type="file" accept=".env,.txt,.json,application/json,text/plain" hidden></div><div class="editor-environment-table"><div class="editor-environment-row editor-environment-heading"><div>Name</div><div>Value</div><div></div></div><div class="editor-environment-rows"></div></div>';
    const saveToggle = div.querySelector('.editor-environment-save-toggle');
    saveToggle.checked = state.deploymentSettings?.saveEnvironmentVariables === true;
    saveToggle.addEventListener('change', () => {
      if (saveToggle.checked) {
        const confirmed = confirm(
          'Warning: saving environment variables makes them part of the project files and public to anyone who can access the repository. Do not store secrets here. Enable project saving?'
        );
        if (!confirmed) {
          saveToggle.checked = false;
          return;
        }
      }
      state.deploymentSettings.saveEnvironmentVariables = saveToggle.checked;
      state.deploymentSettings.saveEnvironmentVariablesExplicit = true;
      try { ctx.saveProjectMetadata(); } catch (e) { ctx.logError(e); }
      ctx.markDirty?.('editor/project.json');
      saveEnvironment();
    });

    const rows = div.querySelector('.editor-environment-rows');
    const renderRows = () => {
      rows.innerHTML = '';
      const entries = Object.entries(state.environment).sort((a,b) => a[0].localeCompare(b[0]));
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'editor-environment-empty';
        empty.textContent = 'No environment variables configured.';
        rows.appendChild(empty);
        return;
      }
      for (const [key, value] of entries) {
        const row = document.createElement('div');
        row.className = 'editor-environment-row';
        const name = document.createElement('input');
        const val = document.createElement('input');
        const remove = document.createElement('button');
        name.value = key;
        val.value = String(value ?? '');
        name.placeholder = 'VARIABLE_NAME';
        val.placeholder = 'value';
        remove.textContent = '×';
        remove.title = 'Remove variable';
        const saveRow = () => {
          const nextKey = name.value.trim();
          const nextValue = val.value;
          if (!nextKey) return;
          if (nextKey !== key) delete state.environment[key];
          state.environment[nextKey] = nextValue;
          saveEnvironment();
          renderRows();
        };
        name.addEventListener('change', saveRow);
        val.addEventListener('input', () => {
          state.environment[key] = val.value;
          saveEnvironment();
        });
        remove.onclick = () => {
          delete state.environment[key];
          saveEnvironment();
          renderRows();
        };
        row.append(name, val, remove);
        rows.appendChild(row);
      }
    };
    div.querySelector('.editor-environment-add').onclick = () => {
      let key = 'NEW_VARIABLE', i = 1;
      while (Object.prototype.hasOwnProperty.call(state.environment, key)) key = 'NEW_VARIABLE_' + i++;
      state.environment[key] = '';
      saveEnvironment();
      renderRows();
      const last = rows.querySelector('.editor-environment-row:last-child input');
      last?.focus();
      last?.select();
    };
    div.querySelector('.editor-environment-clear').onclick = () => {
      if (!Object.keys(state.environment).length || confirm('Clear all environment variables?')) {
        state.environment = {};
        saveEnvironment();
        renderRows();
      }
    };
    const importInput = div.querySelector('.editor-environment-import-input');
    div.querySelector('.editor-environment-import').onclick = () => importInput?.click();
    div.querySelector('.editor-environment-export').onclick = () => {
      const lines = Object.entries(state.environment).map(([key, value]) => {
        const safe = String(value ?? '').replace(/\r?\n/g, '\\n');
        return `${key}=${safe}`;
      });
      const blob = new Blob([lines.join('\n') + (lines.length ? '\n' : '')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '.env';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    importInput.onchange = async () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        let imported = {};
        if (/\.json$/i.test(file.name)) {
          const value = JSON.parse(text || '{}');
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Environment JSON must be an object.');
          imported = Object.fromEntries(Object.entries(value).map(([k,v]) => [k, String(v ?? '')]));
        } else {
          for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const body = line.startsWith('export ') ? line.slice(7).trim() : line;
            const i = body.indexOf('=');
            if (i <= 0) continue;
            const key = body.slice(0, i).trim();
            let value = body.slice(i + 1).trim();
            if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
            imported[key] = value.replace(/\\n/g, '\n');
          }
        }
        Object.assign(state.environment, imported);
        saveEnvironment();
        renderRows();
      } catch (e) {
        ctx.logError(e);
      }
    };
    renderRows();
    g.viewBody.appendChild(div);
  }
    return {
      title: 'Environment Variables',
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      render: renderEnvironment,
      load: loadEnvironment,
      save: saveEnvironment,
      saveToRuntime: saveEnvironmentToRuntime
    };
  };
})();

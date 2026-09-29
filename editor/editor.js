(function () {
  // One Network owned by the editor/workbench and shared by every Browser iframe.
  // Keeping ownership here prevents a Browser iframe from taking the network down
  // when its workbench tab is replaced or destroyed.
  if (!window.__sharedBrowserNetwork && typeof Network === 'function') {
    try {
      const sharedNetwork = new Network();
      if (typeof ProxyNetworkEndpoint === 'function' && typeof NetworkEndpoint === 'function') {
        const primaryProxy = new ProxyNetworkEndpoint('https://proxy.dragonfire7z.workers.dev/', true);
        const fallbackProxy = new ProxyNetworkEndpoint('', true, false);
        const defaultFallback = new NetworkEndpoint();
        const directFallbackRequest = defaultFallback.handleRequest.bind(defaultFallback);
        defaultFallback.handleRequest = async function(request, type) {
          try {
            const url = new URL(request.url);
            if (url.protocol === 'http:' || url.protocol === 'https:') return null;
          } catch (_) {}
          return await directFallbackRequest(request, type);
        };
        defaultFallback.__browserDefaultFallback = true;
        sharedNetwork.appendEndpoint(primaryProxy);
        sharedNetwork.appendEndpoint(fallbackProxy);
        sharedNetwork.appendEndpoint(defaultFallback);
        sharedNetwork.__browserBaseEndpoints = {
          primary: primaryProxy,
          fallback: fallbackProxy,
          defaultFallback
        };
      }
      window.__sharedBrowserNetwork = sharedNetwork;
    } catch (_) {}
  }
  const state = {
    fs: null,
    fileManager: null,
    browserNetwork: window.__sharedBrowserNetwork || null,
    browserFrame: null,
    nodeEmulator: null,
    staticEndpoint: null,
    nodeRoot: '',
    projectName: 'Workspace',
    projectKey: 'workspace',
    runConfig: null,
    workbench: null,
    dirty: false,
    monacoPromise: null,
    terminalTabs: new Map(),
    browserTabs: new Map(),
    environment: {},
    behavior: {
      autoSaveOnRun: false,
      autoClearTerminal: false,
      confirmBeforeReplace: true,
      confirmBeforeDelete: true,
      showHiddenFolders: false
    }
  };
  const $ = id => document.getElementById(id);
  const normalize = p => {
    const out = [];
    for (const x of String(p ?? '').replace(/\\/g, '/').split('/')) {
      if (!x || x === '.') continue;
      if (x === '..') {
        out.pop();
        continue;
      }
      out.push(x);
    }
    return out.join('/');
  };
  const basename = p => {
    p = normalize(p);
    return p.slice(p.lastIndexOf('/') + 1);
  };
  const mime = path => EditorInferMime(basename(path));
  const language = path => {
    const e = basename(path).split('.').pop().toLowerCase();
    return ({
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      jsx: 'javascript',
      json: 'json',
      html: 'html',
      htm: 'html',
      css: 'css',
      md: 'markdown',
      xml: 'xml',
      yaml: 'yaml',
      yml: 'yaml',
      wgsl: 'plaintext'
    })[e] || 'plaintext';
  };
  const isText = path => {
    const m = mime(path);
    return m.startsWith('text/') || ['application/json', 'application/javascript', 'application/typescript', 'application/xml', 'model/gltf+json'].includes(m);
  };
  const EDITOR_DIR = '.editor';
  const EDITOR_CONFIG_PATH = EDITOR_DIR + '/config.json';
  const EDITOR_SETTINGS_PATH = EDITOR_DIR + '/settings.json';
  const EDITOR_ENV_PATH = EDITOR_DIR + '/process.env';
  function readEditorJson(path, fs = state.fs) {
    try {
      if (!fs?.existsSync(path)) return null;
      const raw = fs.readFileSync(path, 'utf8');
      const value = JSON.parse(raw || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_) {
      return null;
    }
  }
  function readLegacyEditorConfig(fs = state.fs) {
    return readEditorJson(EDITOR_CONFIG_PATH, fs);
  }
  function applyEditorSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    state.behavior = { ...state.behavior, ...settings };
  }
  function applyEditorEnvironment(environment) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return;
    state.environment = { ...environment };
  }
  function loadEditorConfig() {
    const config = readEditorJson(EDITOR_CONFIG_PATH);
    const legacy = config && (config.runConfig || config.settings || config.environment) ? config : null;
    const settings = readEditorJson(EDITOR_SETTINGS_PATH) || legacy?.settings;
    applyEditorSettings(settings);
    return config;
  }
  function saveEditorConfig() {
    if (!state.fs) return;
    try {
      state.fs.mkdirSync?.(EDITOR_DIR);
      state.fs.writeFileSync(EDITOR_CONFIG_PATH, JSON.stringify(state.runConfig?.config || {}, null, 2));
      state.dirty = false;
    } catch (e) {
      console.error('Failed to save editor configuration:', e);
    }
  }
  function saveEditorSettings() {
    if (!state.fs) return;
    try {
      state.fs.mkdirSync?.(EDITOR_DIR);
      state.fs.writeFileSync(EDITOR_SETTINGS_PATH, JSON.stringify(state.behavior || {}, null, 2));
      state.dirty = false;
    } catch (e) {
      console.error('Failed to save editor settings:', e);
    }
  }
  function parseProcessEnv(text) {
    const env = {};
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const body = line.startsWith('export ') ? line.slice(7).trim() : line;
      const i = body.indexOf('=');
      if (i <= 0) continue;
      const key = body.slice(0, i).trim();
      let value = body.slice(i + 1).trim();
      if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[key] = value.replace(/\\n/g, '\n');
    }
    return env;
  }
  function loadProcessEnv() {
    try {
      if (state.fs?.existsSync(EDITOR_ENV_PATH)) {
        applyEditorEnvironment(parseProcessEnv(state.fs.readFileSync(EDITOR_ENV_PATH, 'utf8')));
        return true;
      }
    } catch (_) {}
    return false;
  }
  function saveProcessEnv() {
    if (!state.fs) return;
    try {
      state.fs.mkdirSync?.(EDITOR_DIR);
      const lines = Object.entries(state.environment || {}).map(([key, value]) => {
        const safe = String(value ?? '').replace(/\r?\n/g, '\\n');
        return `${key}=${safe}`;
      });
      state.fs.writeFileSync(EDITOR_ENV_PATH, lines.length ? lines.join('\n') + '\n' : '');
      state.dirty = false;
    } catch (e) {
      console.error('Failed to save process.env:', e);
    }
  }
  function logError(e) {
    try {
      console.error(e?.stack || e);
      state.fileManager?.report(e);
    } catch (_) {
      console.error(e);
    }
  }
  function updateStatus() {
    if ($('statusLeft')) $('statusLeft').textContent = state.fs ? `FileSystem: ${state.fs.listFilesSync().length} files` : 'FileSystem: loading…';
    if ($('statusRight')) $('statusRight').textContent = `CWD: ${state.nodeEmulator?.cwd || '/'}` + (state.dirty ? ' • Unsaved' : '');
    if ($('projectName')) $('projectName').textContent = state.projectName || 'Workspace';
  }
  function renameProject() {
    const el = $('projectName');
    const next = prompt('Rename project:', state.projectName || el?.textContent || 'Workspace');
    if (next && next.trim()) {
      state.projectName = next.trim();
      state.projectKey = next.trim();
      if (el) el.textContent = state.projectName;
      state.runConfig?.save();
      updateStatus();
    }
  }
  async function ensureMonaco() {
    if (state.monacoPromise) return state.monacoPromise;
    state.monacoPromise = new Promise((resolve, reject) => {
      if (typeof require !== 'function') return reject(new Error('Monaco loader unavailable'));
      require.config({
        paths: {
          vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs'
        }
      });
      require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    }).catch(e => {
      state.monacoPromise = null;
      throw e;
    });
    return state.monacoPromise;
  }
  function fileIcon(path) {
    let icon = '';
    try {
      icon = typeof EditorRenderIcon === 'function' ? String(EditorRenderIcon(basename(path), false) || '') : '';
      return icon.replace(/^\s*<\?xml[^>]*>\s*/i, '');
    } catch (_) {
      return '';
    }
  }
  function makeFileTab(path) {
    return {
      id: 'file:' + path,
      title: basename(path),
      icon: fileIcon(path),
      kind: 'file',
      path,
      view: 'edit',
      model: null,
      editor: null,
      listener: null
    };
  }
  function builtinIcon(kind) {
    const icons = {
      browser: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 8h18M7 12h10M7 16h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      terminal: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m7 9 3 3-3 3M12 15h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      run: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7 5v14l11-7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
      environment: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      settings: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      welcome: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 9h10M7 13h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    };
    return icons[kind] || '';
  }
  function makeBuiltinTab(kind) {
    return {
      id: 'builtin:' + kind + ':' + Math.random().toString(36).slice(2),
      kind: 'builtin',
      builtin: kind,
      title: kind === 'browser' ? 'Browser' : kind === 'terminal' ? 'Terminal' : kind === 'run' ? 'Run Configuration' : kind === 'settings' ? 'Settings' : kind === 'environment' ? 'Environment Variables' : 'Welcome',
      icon: builtinIcon(kind),
      view: 'edit'
    };
  }
  function clearView(g) {
    g.viewBar.innerHTML = '';
    const previous = g.__renderedTab;
    if (previous?.kind === 'builtin' && previous._viewElement?.parentNode === g.viewBody) {
      previous._viewElement.remove();
      return;
    }
    g.viewBody.innerHTML = '';
  }
  function renderViewBar(g, t) {
    g.viewBar.innerHTML = '';
    if (!t || t.kind !== 'file') {
      g.viewBar.style.display = 'none';
      return;
    }
    g.viewBar.style.display = '';
    const views = ['edit'];
    const m = mime(t.path);
    if (m === 'text/markdown') views.push('preview');
    if (m.startsWith('image/')) views.push('preview');
    views.push('raw');
    for (const v of views) {
      const b = document.createElement('button');
      b.className = 'view-button' + (t.view === v ? ' active' : '');
      b.textContent = v[0].toUpperCase() + v.slice(1);
      b.onclick = () => {
        t.view = v;
        activate(t, g);
      };
      g.viewBar.appendChild(b);
    }
  }
  function renderEmpty(g) {
    clearView(g);
    const wrap = document.createElement('div');
    wrap.className = 'workbench-empty';
    const card = document.createElement('div');
    card.className = 'workbench-empty-card';
    card.innerHTML = '<h2>Welcome</h2><p>Choose what you want to add to this pane.</p>';
    const actions = document.createElement('div');
    actions.className = 'workbench-empty-actions';
    for (const [k, label] of [['browser', 'Browser'], ['terminal', 'Terminal'], ['run', 'Run Configuration'], ['environment', 'Environment Variables'], ['welcome', 'Welcome']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => openBuiltin(k, g);
      actions.appendChild(b);
    }
    card.appendChild(actions);
    wrap.appendChild(card);
    g.viewBody.appendChild(wrap);
  }
  function disposeTabView(t) {
    if (!t) return;
    if (t.editor) {
      try {
        t.editor.dispose();
      } catch (_) {}
    }
    t.editor = null;
  }
  async function activate(t, g) {
    g.active = t?.id || null;
    state.workbench.renderGroup(g);
    if (!t) {
      renderEmpty(g);
      return;
    }
    disposeTabView(t);
    clearView(g);
    renderViewBar(g, t);
    if (t.kind === 'builtin') {
      if (t._viewElement) {
        g.viewBody.appendChild(t._viewElement);
        g.__renderedTab = t;
        if (t.builtin === 'terminal') {
          const terminal = state.terminalTabs.get(t.id);
          terminal?.attach(state.nodeEmulator);
          terminal?.updatePrompt();
        }
        return;
      }
      if (t.builtin === 'browser') renderBrowser(g, t);
      else if (t.builtin === 'terminal') renderTerminal(g, t);
      else if (t.builtin === 'run') renderRunConfig(g);
      else if (t.builtin === 'environment') renderEnvironment(g);
      else renderWelcome(g);
      t._viewElement = g.viewBody.lastElementChild || null;
      g.__renderedTab = t;
      return;
    }
    g.__renderedTab = t;
    if (t.view === 'preview') return renderPreview(t, g);
    if (t.view === 'raw') return renderRaw(t, g);
    return renderEdit(t, g);
  }
  async function renderEdit(t, g) {
    const host = document.createElement('div');
    host.className = 'editor-view active';
    g.viewBody.appendChild(host);
    const ta = document.createElement('textarea');
    ta.className = 'editor-textarea';
    ta.spellcheck = false;
    ta.value = state.fs.readFileSync(t.path, 'utf8') || '';
    host.appendChild(ta);
    const apply = text => {
      if (state.fs.readFileSync(t.path, 'utf8') !== text) {
        state.fs.writeFileSync(t.path, text);
        state.dirty = true;
        updateStatus();
      }
    };
    ta.addEventListener('input', () => apply(ta.value));
    try {
      const monaco = await ensureMonaco();
      if (g.active !== t.id || !g.viewBody.contains(host)) return;
      const model = t.model && !t.model.isDisposed() ? t.model : monaco.editor.createModel(ta.value, language(t.path));
      if (model.getValue() !== ta.value) {
        model.setValue(ta.value);
      }
      t.model = model;
      const ed = monaco.editor.create(host, {
        model,
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: {
          enabled: false
        },
        fontSize: 13,
        scrollBeyondLastLine: false
      });
      t.editor = ed;
      ta.classList.add('hidden');
      if (!t.listener) t.listener = model.onDidChangeContent(() => {
        apply(model.getValue());
      });
    } catch (e) {}
  }
  function renderRaw(t, g) {
    const host = document.createElement('div');
    host.className = 'editor-view active';
    g.viewBody.appendChild(host);
    const ta = document.createElement('textarea');
    ta.className = 'editor-textarea';
    ta.spellcheck = false;
    ta.value = state.fs.readFileSync(t.path, 'utf8') || '';
    host.appendChild(ta);
    ta.addEventListener('input', () => {
      state.fs.writeFileSync(t.path, ta.value);
      state.dirty = true;
      updateStatus();
    });
  }
  async function renderPreview(t, g) {
    const m = mime(t.path);
    if (m === 'text/markdown') {
      const host = document.createElement('div');
      host.className = 'editor-view active editor-markdown';
      host.textContent = state.fs.readFileSync(t.path, 'utf8') || '';
      g.viewBody.appendChild(host);
      return;
    }
    if (m.startsWith('image/')) {
      const data = state.fs.readFileSync(t.path, 'binary');
      const url = URL.createObjectURL(new Blob([data], {
        type: m
      }));
      const img = document.createElement('img');
      img.className = 'editor-image';
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      g.viewBody.appendChild(img);
      return;
    }
    const pre = document.createElement('pre');
    pre.className = 'editor-binary';
    pre.textContent = 'Preview not available for this file type.';
    g.viewBody.appendChild(pre);
  }
  function openFile(path, target) {
    path = normalize(path);
    if (!state.fs?.existsSync(path)) return;
    let g = target || state.workbench.getFirstLeaf(), t = null;
    for (const gg of state.workbench.groups.values()) {
      const found = gg.tabs.find(x => x.kind === 'file' && x.path === path);
      if (found) {
        g = gg;
        t = found;
        break;
      }
    }
    if (!t) {
      t = makeFileTab(path);
      state.workbench.addTab(t, g);
    } else state.workbench.activateTab(g, t.id);
  }
  function openBuiltin(kind, g = state.workbench.getFirstLeaf(), options = {}) {
    if (options.replace) {
      const t = makeBuiltinTab(kind);
      return state.workbench.replaceTab(g, t);
    }
    if (kind === 'welcome') {
      const t = makeBuiltinTab(kind);
      state.workbench.addTab(t, g);
      return t;
    }
    let t = g.tabs.find(x => x.kind === 'builtin' && x.builtin === kind);
    if (!t) {
      t = makeBuiltinTab(kind);
      state.workbench.addTab(t, g);
    } else state.workbench.activateTab(g, t.id);
    return t;
  }
  function renderBrowser(g, t) {
    const wrap = document.createElement('div');
    wrap.className = 'builtin-browser';
    const frame = document.createElement('iframe');
    frame.id = 'browser-frame-' + g.id;
    const initialBrowserUrl = state.runConfig?.publicUrl?.() || 'http://localhost:3000/';
    frame.src = 'browser/browser.html?start=' + encodeURIComponent(initialBrowserUrl) + '&default=' + encodeURIComponent(initialBrowserUrl) + '&defer=1';
    const bar = document.createElement('div');
    bar.className = 'builtin-browser-toolbar';
    const status = document.createElement('span');
    status.className = 'browser-status';
    status.textContent = 'Starting browser…';
    const run = document.createElement('button');
    run.textContent = 'Run';
    run.onclick = () => runConfigured().catch(logError);
    const full = document.createElement('button');
    full.textContent = 'Fullscreen';
    full.onclick = () => {
      const active = wrap.classList.toggle('fullscreen');
      full.textContent = active ? 'Exit Fullscreen' : 'Fullscreen';
    };
    bar.append(status, run, full);
    wrap.append(frame, bar);
    g.viewBody.appendChild(wrap);
    const info = {
      frame,
      network: null,
      ready: null
    };
    state.browserTabs.set(t.id, info);
    let resolveReady, rejectReady;
    info.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let done = false;
    const finish = () => {
      try {
        const win = frame.contentWindow;
        const net = win?.browserNetwork;
        if (!net || typeof win.loadBrowserURL !== 'function') return;
        state.browserFrame = frame;
        state.browserNetwork = net;
        info.network = net;
        try {
          window.__sharedBrowserNetwork = net;
        } catch (_) {}
        state.runConfig?.bindNetwork?.(net);
        try {
          const defaultUrl = state.runConfig?.publicUrl?.() || state.runConfig?.config?.domain || 'http://localhost:3000/';
          win.setBrowserDefaultTab?.(defaultUrl);
          // The Browser's very first tab is created with defer=1 so it cannot
          // race the runtime endpoint during startup. If a static runtime is
          // already installed (for example when reopening the Browser tab),
          // start that deferred tab now. Node waits until its server is live
          // and is navigated by runConfigured after terminalCommand.
          if (state.staticEndpoint && typeof win.loadBrowserURL === 'function') {
            void win.loadBrowserURL(defaultUrl, true).catch(() => {});
          }
        } catch (_) {}
        state.runDebugRefresh?.();
        status.textContent = 'Browser ready';
        if (!done) {
          done = true;
          resolveReady(net);
        }
      } catch (e) {
        if (!done) {
          done = true;
          rejectReady(e);
        }
      }
    };
    frame.addEventListener('load', finish);
    const readyPoll = setInterval(() => {
      if (done) {
        clearInterval(readyPoll);
        return;
      }
      finish();
    }, 50);
    setTimeout(() => {
      clearInterval(readyPoll);
      if (!done) {
        done = true;
        status.textContent = 'Browser failed to initialize';
        rejectReady(new Error('Browser emulator did not initialize within 10 seconds.'));
      }
    }, 10000);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && wrap.classList.contains('fullscreen')) {
        wrap.classList.remove('fullscreen');
        full.textContent = 'Fullscreen';
      }
    });
  }
  function isBrowserFrameReady(frame) {
    try {
      return !!frame && !!frame.contentWindow && typeof frame.contentWindow.loadBrowserURL === 'function';
    } catch (_) {
      return false;
    }
  }
  async function ensureBrowser() {
    if (state.browserFrame && state.browserNetwork && isBrowserFrameReady(state.browserFrame)) return state.browserNetwork;

    for (const [tabId, info] of state.browserTabs.entries()) {
      if (!info) continue;
      let net = info.network || null;
      if (!net && info.ready) {
        try {
          net = await info.ready;
        } catch (e) {
          continue;
        }
      }
      if (!net || !info.frame || !info.frame.contentWindow) continue;
      state.browserNetwork = net;
      state.browserFrame = info.frame;

      // A workbench switch detaches the Browser view from the DOM without
      // destroying it. Reattach that existing tab instead of creating another
      // Browser and, importantly, keep its shared Network object.
      for (const g of state.workbench.groups.values()) {
        const t = g.tabs.find(x => x.id === tabId);
        if (!t) continue;
        if (t._viewElement && t._viewElement.parentNode !== g.viewBody) {
          try {
            state.workbench.activateTab(g, t.id);
          } catch (_) {}
        }
        break;
      }
      if (isBrowserFrameReady(info.frame)) return net;
    }

    const g = state.workbench.getFirstLeaf();
    const t = openBuiltin('browser', g);
    const info = state.browserTabs.get(t.id);
    if (!info) throw new Error('Browser tab could not be created.');
    const net = await info.ready;
    state.browserFrame = info.frame;
    state.browserNetwork = net;
    if (!isBrowserFrameReady(info.frame)) {
      for (let i = 0; i < 100 && !isBrowserFrameReady(info.frame); i++) await new Promise(r => setTimeout(r, 50));
    }
    if (!isBrowserFrameReady(info.frame)) throw new Error('Browser tab was created but its load API is not ready.');
    return net;
  }
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
  function renderRunConfig(g) {
    const div = document.createElement('div');
    div.className = 'run-config-page';
    g.viewBody.appendChild(div);
    state.runConfig.render(div, () => runConfigured().catch(logError));
  }
  function loadBehaviorSettings() {
    try {
      const v = JSON.parse(localStorage.getItem('editor.behaviorSettings') || 'null');
      if (v) applyEditorSettings(v);
    } catch (e) {}
  }
  function saveBehaviorSettings() {
    saveEditorSettings();
  }
  function environmentStorageKey() {
    return 'editor.environment.' + (state.projectKey || 'default');
  }
  function loadEnvironment() {
    state.environment = {};
    if (!loadProcessEnv()) {
      const legacy = readLegacyEditorConfig();
      if (legacy?.environment && typeof legacy.environment === 'object' && !Array.isArray(legacy.environment)) {
        applyEditorEnvironment(legacy.environment);
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
    saveProcessEnv();
    saveEnvironmentToRuntime();
  }
  function renderEnvironment(g) {
    const div = document.createElement('div');
    div.className = 'editor-environment-page';
    div.innerHTML = '<div class="editor-environment-header"><h2>Environment Variables</h2><p>Variables are available through <code>process.env</code> when running a Node project in this workspace.</p></div><div class="editor-environment-toolbar"><button class="editor-environment-add">Add Variable</button><button class="editor-environment-import">Import</button><button class="editor-environment-export">Export .env</button><button class="editor-environment-clear">Clear All</button><input class="editor-environment-import-input" type="file" accept=".env,.txt,.json,application/json,text/plain" hidden></div><div class="editor-environment-table"><div class="editor-environment-row editor-environment-heading"><div>Name</div><div>Value</div><div></div></div><div class="editor-environment-rows"></div></div>';
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
        logError(e);
      }
    };
    renderRows();
    g.viewBody.appendChild(div);
  }
  function renderWelcome(g) {
    const div = document.createElement('div');
    div.className = 'builtin-welcome';
    const card = document.createElement('div');
    card.className = 'workbench-empty-card';
    card.innerHTML = '<h2>Welcome</h2><p>Create a new project from the toolbar or open a built-in tool here.</p>';
    const actions = document.createElement('div');
    actions.className = 'workbench-empty-actions';
    for (const [kind, label] of [['browser', 'Browser'], ['terminal', 'Terminal'], ['run', 'Run Configuration'], ['environment', 'Environment Variables']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => openBuiltin(kind, g);
      actions.appendChild(b);
    }
    card.appendChild(actions);
    div.appendChild(card);
    g.viewBody.appendChild(div);
  }
  async function navigatePreview() {
    const browser = state.browserFrame;
    if (!browser) throw new Error('Browser tab is not ready.');
    const c = state.runConfig?.config || ({});
    let domain = String(c.domain || 'http://localhost:3000').trim();
    if (!(/^[a-z][a-z0-9+.-]*:\/\//i).test(domain)) domain = 'http://' + domain;
    domain = domain.replace(/\/+$/, '');
    const publicPath = String(c.path || '/').trim() || '/';
    const p = publicPath.startsWith('/') ? publicPath : '/' + publicPath;
    const url = domain + (p === '/' ? '/' : p);
    const win = browser.contentWindow;
    const nav = win?.loadBrowserURL;
    if (typeof nav === 'function') {
      await nav(url, true);
      return;
    }
    throw new Error('Browser load API is not ready.');
  }
  function detachRuntime(net) {
    if (!net) return;
    for (const ep of [state.staticEndpoint, state.nodeEmulator?.endpoint]) {
      if (!ep) continue;
      try {
        net.removeEndpoint ? net.removeEndpoint(ep) : (() => {
          const i = net.endpoints.indexOf(ep);
          if (i >= 0) net.endpoints.splice(i, 1);
        })();
      } catch (e) {}
    }
    if (state.nodeEmulator) {
      try {
        state.nodeEmulator.destroy?.();
      } catch (e) {}
      state.nodeEmulator = null;
    }
    state.staticEndpoint = null;
  }
  async function setupRuntime(net) {
    if (!state.fs || !net) return;
    detachRuntime(net);
    const c = state.runConfig?.config || ({});
    let domain = String(c.domain || 'http://localhost:3000').trim();
    if (!(/^[a-z][a-z0-9+.-]*:\/\//i).test(domain)) domain = 'http://' + domain;
    domain = domain.replace(/\/+$/, '');
    const root = String(c.rootfolder || '/').replace(/^\/+|\/+$/g, '');
    if (c.serverType === 'static') {
      state.staticEndpoint = new StaticEndpoint({
        domain,
        path: c.path || '/',
        rootfolder: root,
        runfile: c.runfile || '/index.html',
        filesystem: state.fs
      });
      if (net.replaceRuntimeEndpoint) net.replaceRuntimeEndpoint(state.staticEndpoint); else net.prependEndpoint(state.staticEndpoint);
      await state.staticEndpoint.loading;
    } else {
      const emulator = new NodeEmulator({
        domain,
        rootfolder: root,
        pathPrefix: c.path || '/',
        filesystem: state.fs,
        fileSystemSync: false,
        network: net,
        cwd: c.cwd || '/',
        env: {
          NODE_ENV: 'development',
          USER: 'browser_user',
          ...state.environment
        }
      });
      state.nodeEmulator = emulator;
      if (net.replaceRuntimeEndpoint) net.replaceRuntimeEndpoint(emulator.endpoint); else net.prependEndpoint(emulator.endpoint);
      try {
        await emulator.ready;
      } catch (e) {
        try {
          net.removeEndpoint?.(emulator.endpoint);
          emulator.destroy?.();
        } catch (_) {}
        state.nodeEmulator = null;
        throw e;
      }
      for (const t of state.terminalTabs.values()) t.attach(emulator);
    }
    state.runConfig?.refreshEndpointList?.();
    state.runDebugRefresh?.();
    updateStatus();
  }
  function getOrOpenTerminal() {
    for (const g of state.workbench.groups.values()) {
      const t = g.tabs.find(x => x.kind === 'builtin' && x.builtin === 'terminal');
      if (t) {
        state.workbench.activateTab(g, t.id);
        return t;
      }
    }
    return openBuiltin('terminal', state.workbench.getFirstLeaf());
  }
  async function runConfigured() {
    if (!state.fs || !state.runConfig) return;
    state.runConfig.detect();
    const c = state.runConfig.config;
    const net = state.browserNetwork;
    if (!net) throw new Error('Browser network is not ready.');
    if (state.behavior.autoSaveOnRun) {
      try {
        const blob = await state.fs.exportZip();
        void blob;
      } catch (e) {
        logError(e);
      }
    }
    if (state.behavior.autoClearTerminal) for (const t of state.terminalTabs.values()) t.clear();
    let terminal = null;
    if (c.serverType === 'node') {
      terminal = getOrOpenTerminal();
    }
    await setupRuntime(net);
    if (c.serverType === 'node') {
      if (!state.nodeEmulator) throw new Error('Node runtime is not ready.');
      terminal = terminal || getOrOpenTerminal();
      const terminalView = state.terminalTabs.get(terminal.id);
      terminalView?.attach(state.nodeEmulator);
      if (c.nodeCommand) {
        await terminalView?.runCommand(c.nodeCommand);
      }
      const serverReady = await state.nodeEmulator.waitForServer?.(10000, 50);
      if (!serverReady) throw new Error('Node command finished, but no listening server was created.');
    }
    await ensureBrowser();
    await navigatePreview();
  }
  function onMove(oldPath, newPath, isDir) {
    for (const g of state.workbench.groups.values()) for (const t of g.tabs) {
      if (t.kind !== 'file') continue;
      const hit = isDir ? t.path === oldPath || t.path.startsWith(oldPath + '/') : t.path === oldPath;
      if (hit) {
        t.path = isDir ? newPath + t.path.slice(oldPath.length) : newPath;
        t.title = basename(t.path);
        t.icon = fileIcon(t.path);
        t.model?.dispose();
        t.editor?.dispose();
        t.model = null;
        t.editor = null;
      }
    }
    state.workbench.rebuild();
    updateStatus();
  }
  function onDelete(path, isDir) {
    for (const g of [...state.workbench.groups.values()]) for (const t of [...g.tabs]) if (t.kind === 'file' && (t.path === path || isDir && t.path.startsWith(path + '/'))) state.workbench.removeTab(g, t.id);
    updateStatus();
  }
  function setActiveActivity(id) {
    document.querySelectorAll('.activity-button').forEach(x => x.classList.toggle('active', x.id === id));
  }
  function renderSidebarPlaceholder(title) {
    const tree = $('tree');
    tree.classList.remove('activity-collapsed');
    if (title === 'Run and Debug') {
      renderRunDebugSidebar();
      return;
    }
    tree.innerHTML = `<div class="activity-sidebar-placeholder"><div class="activity-sidebar-title">${title}</div><div class="activity-sidebar-empty">No ${title.toLowerCase()} content yet.</div></div>`;
  }
  function renderRunDebugSidebar() {
    const tree = $('tree');
    tree.innerHTML = `<div class="run-debug-sidebar"><div class="activity-sidebar-title">Run and Debug</div><div class="run-debug-actions"><button id="sidebar-run" class="primary">Run</button><button id="sidebar-refresh-endpoints">Refresh</button></div><div class="run-debug-section"><div class="run-debug-section-title">Browser Network Endpoints</div><div id="endpoint-list"></div></div></div>`;
    const list = tree.querySelector('#endpoint-list');
    const render = () => {
      const net = state.browserNetwork;
      const info = net?.getEndpointInfo ? net.getEndpointInfo() : (net?.endpoints || []).map((ep, index) => ({
        index,
        name: ep?.constructor?.name || 'Endpoint',
        enabled: ep?.enabled !== false,
        runtime: !!ep?.__editorRuntimeEndpoint,
        proxy: ep?.proxy || null,
        domain: ep?.domain || null,
        path: ep?.path || null,
        rootfolder: ep?.rootfolder || null
      }));
      if (!info.length) {
        list.innerHTML = '<div class="endpoint-empty">Browser network is not ready.</div>';
        return;
      }
      list.innerHTML = info.map(ep => {
        const detail = ep.runtime ? ep.domain || 'Runtime' : ep.proxy || ep.domain || '';
        return `<div class="endpoint-row"><div class="endpoint-name"><span>${ep.index + 1}. ${ep.name}</span><span class="endpoint-status ${ep.enabled ? 'enabled' : 'disabled'}">${ep.enabled ? 'ON' : 'OFF'}</span></div><div class="endpoint-detail">${ep.runtime ? 'Runtime endpoint • ' : ''}${detail || 'Default browser endpoint'}</div></div>`;
      }).join('');
    };
    render();
    const net = state.browserNetwork;
    if (net?.addEventListener && !tree._endpointListener) {
      const listener = () => render();
      net.addEventListener('endpointschange', listener);
      tree._endpointListener = listener;
    }
    tree.querySelector('#sidebar-refresh-endpoints').onclick = render;
    tree.querySelector('#sidebar-run').onclick = () => runConfigured().catch(logError);
    state.runDebugRefresh = render;
  }
  function renderSidebarSettings() {
    const tree = $('tree');
    tree.classList.remove('activity-collapsed');
    tree.innerHTML = '<div class="editor-settings-page sidebar-settings"><div class="editor-settings-header"><h2>Settings</h2><p>Editor and workspace behavior.</p></div><div class="editor-settings-section"><h3>Saving</h3><label><input id="setting-auto-save" type="checkbox"> Save project before Run</label><label><input id="setting-auto-clear" type="checkbox"> Clear terminal before Run</label></div><div class="editor-settings-section"><h3>Workspace</h3><label><input id="setting-confirm-replace" type="checkbox"> Confirm before replacing the workspace</label><label><input id="setting-confirm-delete" type="checkbox"> Confirm before deleting files and folders</label><label><input id="setting-show-hidden" type="checkbox"> Show hidden folders</label></div></div>';
    const a = $('setting-auto-save'), c = $('setting-auto-clear'), r = $('setting-confirm-replace'), d = $('setting-confirm-delete'), h = $('setting-show-hidden');
    a.checked = state.behavior.autoSaveOnRun;
    c.checked = state.behavior.autoClearTerminal;
    r.checked = state.behavior.confirmBeforeReplace;
    d.checked = state.behavior.confirmBeforeDelete;
    h.checked = state.behavior.showHiddenFolders;
    a.onchange = () => {
      state.behavior.autoSaveOnRun = a.checked;
      saveBehaviorSettings();
    };
    c.onchange = () => {
      state.behavior.autoClearTerminal = c.checked;
      saveBehaviorSettings();
    };
    r.onchange = () => {
      state.behavior.confirmBeforeReplace = r.checked;
      saveBehaviorSettings();
    };
    d.onchange = () => {
      state.behavior.confirmBeforeDelete = d.checked;
      saveBehaviorSettings();
    };
    h.onchange = () => {
      state.behavior.showHiddenFolders = h.checked;
      state.fileManager?.setShowHiddenFolders(h.checked);
      saveBehaviorSettings();
    };
  }
  function showSidebar(kind) {
    state.sidebar = kind;
    const explorer = $('tree');
    explorer.classList.remove('activity-collapsed');
    if (kind === 'explorer') {
      setActiveActivity('activityExplorer');
      state.fileManager?.render();
      return;
    }
    if (kind === 'settings') {
      setActiveActivity('activitySettings');
      renderSidebarSettings();
      return;
    }
    const map = {
      Search: 'activitySearch',
      'Source Control': 'activitySource',
      'Run and Debug': 'activityRun',
      'Extensions': 'activityExtensions'
    };
    setActiveActivity(map[kind] || null);
    renderSidebarPlaceholder(kind || 'Activity');
  }
  function bindActivitySettings() {
    const button = $('activitySettings');
    button?.addEventListener('click', e => {
      e.stopPropagation();
      showSidebar('settings');
    });
  }
  async function openZipFile(f) {
    await replaceFileSystem(await FileSystem.create(f, {
      sync: false
    }), f.name.replace(/\.zip$/i, ''), true);
  }
  function setupDefaultNodeLayout() {
    const wb = state.workbench;
    wb.reset();
    const editorGroup = wb.getFirstLeaf();
    const browserGroup = wb.splitGroup(editorGroup, 'horizontal', false);
    const terminalGroup = wb.splitGroup(browserGroup, 'vertical', false);
    openFile('server.js', editorGroup);
    openBuiltin('browser', browserGroup);
    openBuiltin('run', browserGroup);
    openBuiltin('terminal', terminalGroup);
    const browserTab = browserGroup.tabs.find(t => t.builtin === 'browser');
    if (browserTab) wb.activateTab(browserGroup, browserTab.id);
    const serverTab = editorGroup.tabs.find(t => t.kind === 'file' && t.path === 'server.js');
    if (serverTab) wb.activateTab(editorGroup, serverTab.id);
  }
  async function createStarter(kind, options = {}) {
    const fs = await FileSystem.empty({
      sync: false
    });
    if (kind === 'static') {
      fs.writeFileSync('index.html', '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>Static Site</title><link rel="stylesheet" href="style.css"></head>\n<body><main><h1>Hello from Static Site</h1><p>Edit index.html, style.css, or script.js.</p><script src="script.js"></script></main></body></html>');
      fs.writeFileSync('style.css', 'body{margin:0;font-family:sans-serif;background:#111;color:#eee}main{max-width:700px;margin:12vh auto;padding:2rem}');
      fs.writeFileSync('script.js', 'console.log("Static site running");');
    } else {
      fs.writeFileSync('package.json', JSON.stringify({
        name: 'node-starter',
        version: '1.0.0',
        scripts: {
          start: 'node server.js'
        },
        main: 'server.js'
      }, null, 2));
      fs.writeFileSync('server.js', `const http=require('http');\nconst fs=require('fs');\nconst path=require('path');\nconst server=http.createServer((req,res)=>{\n  const file=req.url==='/'?'/index.html':req.url.split('?')[0];\n  const filename=path.join(process.cwd(),'public',file.replace(/^\\//,''));\n  try{res.end(fs.readFileSync(filename));}catch(e){res.statusCode=404;res.end('Not found');}\n});\nserver.listen(3000,'localhost',()=>console.log('Server listening on http://localhost:3000/'));\n`);
      fs.writeFileSync('public/index.html', '<!doctype html>\n<html><body><h1>Hello from Node Server</h1><p>Edit public/index.html.</p></body></html>');
    }
    await replaceFileSystem(fs, kind === 'static' ? 'Static Website' : 'Node Server', false);
    state.runConfig.config.serverType = kind === 'static' ? 'static' : 'node';
    state.runConfig.config.domain = 'http://localhost:3000/';
    state.runConfig.config.path = '/';
    state.runConfig.config.rootfolder = '/';
    state.runConfig.config.runfile = kind === 'static' ? '/index.html' : '/public/index.html';
    state.runConfig.config.cwd = '/';
    state.runConfig.config.nodeCommand = kind === 'node' ? 'npm run start' : 'node server.js';
    state.nodeRoot = '';
    state.runConfig.save();
    saveEditorConfig();
    if (options.initial && kind === 'node') {
      setupDefaultNodeLayout();
    } else {
      const g = state.workbench.getFirstLeaf();
      openBuiltin('welcome', g, {
        replace: !!g?.active
      });
    }
  }
  async function newProject() {
    showNewProjectDialog();
  }
  function showNewProjectDialog() {
    let old = document.getElementById('newProjectModal');
    if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'newProjectModal';
    modal.className = 'editor-modal';
    modal.innerHTML = '<div class=editor-modal-content><button class=editor-modal-close aria-label=Close>×</button><h2>New Project</h2><p>Choose the type of workspace to create.</p><div class=editor-modal-actions><button data-kind=static>Static Website</button><button data-kind=node>Node Server</button></div></div>';
    document.body.appendChild(modal);
    modal.querySelector('.editor-modal-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => {
      const kind = e.target.closest('[data-kind]')?.dataset.kind;
      if (!kind) return;
      modal.remove();
      createStarter(kind).catch(logError);
    });
    requestAnimationFrame(() => modal.classList.add('show'));
  }
  async function replaceFileSystem(fs, name, openFirst = true) {
    state.fs = fs;
    state.projectName = name;
    state.projectKey = name;
    state.dirty = false;
    loadEditorConfig();
    loadEnvironment();
    state.fileManager.setFileSystem(fs);
    state.fileManager.setShowHiddenFolders?.(state.behavior.showHiddenFolders);
    state.fileManager.refresh();
    state.browserFrame = null;
    for (const info of state.browserTabs.values()) {
      try { info?.frame?.remove(); } catch (_) {}
    }
    state.browserTabs.clear();
    state.runConfig = new EditorRunConfig(state);
    state.runConfig.detect();
    saveEditorSettings();
    saveProcessEnv();
    state.workbench.reset();
    if (openFirst) {
      const first = fs.listFilesSync().find(p => isText(p) && !p.endsWith('.piskel')) || fs.listFilesSync()[0];
      if (first) openFile(first);
    } else {
      openBuiltin('welcome', state.workbench.getFirstLeaf());
    }
    updateStatus();
  }
  function closeImportModal() {
    document.getElementById('importModal')?.remove();
  }
  async function importFileSystemSource(source, name) {
    try {
      const fs = await FileSystem.create(source, {
        sync: false
      });
      await replaceFileSystem(fs, name || 'Workspace', true);
      closeImportModal();
    } catch (e) {
      logError(e);
    }
  }
  async function openImportModal() {
    if (document.getElementById('importModal')) return;
    const modal = document.createElement('div');
    modal.id = 'importModal';
    modal.className = 'editor-modal';
    modal.innerHTML = `<div class="editor-modal-content import-source-modal">
    <button class="editor-modal-close" aria-label="Close">×</button>
    <h2>Open Workspace</h2><p>Drop a ZIP, files, or a folder here, or choose a source.</p>
    <div class="import-dropzone">Drop ZIP / files / folder here</div>
    <div class="editor-modal-actions">
      <button data-source="zip">ZIP File</button>
      <button data-source="files">Files</button>
      <button data-source="folder">Folder</button>
    </div>
    <input class="import-input-zip" type="file" accept=".zip,application/zip" hidden>
    <input class="import-input-files" type="file" multiple hidden>
  </div>`;
    document.body.appendChild(modal);
    const cleanup = () => closeImportModal();
    modal.querySelector('.editor-modal-close').onclick = cleanup;
    const zipInput = modal.querySelector('.import-input-zip');
    const filesInput = modal.querySelector('.import-input-files');
    modal.querySelector('[data-source="zip"]').onclick = () => zipInput.click();
    modal.querySelector('[data-source="files"]').onclick = () => filesInput.click();
    modal.querySelector('[data-source="folder"]').onclick = async () => {
      if (window.showDirectoryPicker) {
        try {
          const h = await showDirectoryPicker();
          await importFileSystemSource(h, h.name);
        } catch (e) {
          if (e?.name !== 'AbortError') logError(e);
        }
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.webkitdirectory = true;
        input.hidden = true;
        document.body.appendChild(input);
        input.onchange = () => {
          if (input.files?.length) importFileSystemSource(input.files, input.files[0].webkitRelativePath?.split('/')[0] || 'Workspace');
          input.remove();
        };
        input.click();
      }
    };
    zipInput.onchange = () => {
      const f = zipInput.files?.[0];
      if (f) importFileSystemSource(f, f.name.replace(/\\.zip$/i, ''));
    };
    filesInput.onchange = () => {
      const files = filesInput.files;
      if (files?.length) importFileSystemSource(files, 'Workspace');
    };
    const drop = modal.querySelector('.import-dropzone');
    drop.addEventListener('dragover', e => {
      e.preventDefault();
      drop.classList.add('dragover');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', async e => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const items = [...e.dataTransfer?.items || []];
      try {
        const handleItem = items.find(i => typeof i.getAsFileSystemHandle === 'function');
        if (handleItem) {
          const h = await handleItem.getAsFileSystemHandle();
          if (h) {
            await importFileSystemSource(h, h.name);
            return;
          }
        }
      } catch (err) {
        logError(err);
      }
      const files = e.dataTransfer?.files;
      if (files?.length) {
        const onlyZip = files.length === 1 && (/\.zip$/i).test(files[0].name);
        await importFileSystemSource(onlyZip ? files[0] : files, onlyZip ? files[0].name.replace(/\.zip$/i, '') : 'Workspace');
      }
    });
    modal.addEventListener('click', e => {
      if (e.target === modal) closeImportModal();
    });
    requestAnimationFrame(() => modal.classList.add('show'));
  }
  function bindUI() {
    const explorerButton = $('activityExplorer');
    const explorer = $('tree');
    state.sidebar = 'explorer';
    explorerButton?.addEventListener('click', e => {
      e.stopPropagation();
      if (state.sidebar === 'explorer' && !explorer.classList.contains('activity-collapsed')) {
        explorer.classList.add('activity-collapsed');
        explorerButton.classList.remove('active');
        return;
      }
      showSidebar('explorer');
    });
    const sidebarKinds = {
      activitySearch: 'Search',
      activitySource: 'Source Control',
      activityRun: 'Run and Debug',
      activityExtensions: 'Extensions'
    };
    for (const [id, title] of Object.entries(sidebarKinds)) {
      const button = $(id);
      button?.addEventListener('click', e => {
        e.stopPropagation();
        showSidebar(title);
      });
    }
    explorer?.addEventListener('contextmenu', e => e.stopPropagation());
    state.workbench = new Workbench($('editorWorkbench'), {
      onActivate: activate,
      onBuiltin: (kind, g) => openBuiltin(kind, g),
      onClose: (t, g) => {
        t.model?.dispose();
        t.editor?.dispose();
        state.workbench.removeTab(g, t.id);
      }
    });
    state.fileManager = new FileManager({
      tree: $('tree'),
      contextMenu: $('contextMenu'),
      fileInput: $('fileUploader'),
      onOpen: openFile,
      onMove,
      onDelete,
      onChange: updateStatus,
      showHiddenFolders: state.behavior.showHiddenFolders
    });
    state.runConfig = new EditorRunConfig(state);
    $('uploadZipBtn').onclick = () => openImportModal();
    $('projectName').onclick = () => renameProject();
    $('projectName').ondblclick = () => renameProject();
    $('zipInput')?.addEventListener('change', e => {
      const f = e.target.files?.[0];
      if (f) openZipFile(f).catch(logError);
    });
    $('newZipBtn').onclick = () => newProject().catch(logError);
    $('saveZipBtn').onclick = async () => {
      try {
        const blob = await state.fs.exportZip();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (state.projectName || 'workspace') + '.zip';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        state.dirty = false;
        updateStatus();
      } catch (e) {
        logError(e);
      }
    };
    $('runBtn').onclick = () => runConfigured().catch(logError);
    $('runConfigBtn').onclick = () => openBuiltin('run');
    bindActivitySettings();
  }
  async function start() {
    loadBehaviorSettings();
    bindUI();
    try {
      await createStarter('node', {initial: true});
    } catch (e) {
      logError(e);
    }
  }
  state.saveEditorConfig = saveEditorConfig;
  state.saveEditorSettings = saveEditorSettings;
  state.applyEditorSettings = applyEditorSettings;
  state.applyEditorEnvironment = applyEditorEnvironment;
  window.EditorApp = {
    start,
    openFile,
    openBuiltin,
    runConfigured,
    logError
  };
})();

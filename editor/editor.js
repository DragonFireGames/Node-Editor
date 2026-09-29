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
    projectId: null,
    projectTemplate: false,
    lastSavedAt: 0,
    lastCachedAt: 0,
    cacheTimer: null,
    cacheWritePromises: new Map(),
    layoutTimer: null,
    loading: false,
    runConfig: null,
    workbench: null,
    dirty: false,
    monacoPromise: null,
    ensureMonaco,
    previews: null,
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
  const EDITOR_PROJECT_PATH = EDITOR_DIR + '/project.json';
  const PROJECT_CACHE_NAME = 'node-editor-project-cache';
  const RECENT_PROJECTS_KEY = 'editor.recentProjects';
  const LAYOUT_KEY_PREFIX = 'editor.projectLayout.';
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
  function makeProjectId() {
    return crypto.randomUUID?.() || 'project-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  function loadProjectMetadata() {
    const meta = readEditorJson(EDITOR_PROJECT_PATH);
    if (meta?.id && String(meta.id).trim()) state.projectId = String(meta.id).trim();
    if (meta?.name && String(meta.name).trim()) {
      state.projectName = String(meta.name).trim();
      state.projectKey = state.projectName;
    }
    if (!state.projectId) state.projectId = makeProjectId();
    return meta;
  }
  function saveProjectMetadata() {
    if (!state.fs) return;
    if (!state.projectId) state.projectId = makeProjectId();
    state.fs.mkdirSync?.(EDITOR_DIR);
    state.fs.writeFileSync(EDITOR_PROJECT_PATH, JSON.stringify({id: state.projectId, name: state.projectName}, null, 2));
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
      if (!state.loading) state.markDirty?.('editor/config.json');
    } catch (e) {
      console.error('Failed to save editor configuration:', e);
    }
  }
  function saveEditorSettings() {
    if (!state.fs) return;
    try {
      state.fs.mkdirSync?.(EDITOR_DIR);
      state.fs.writeFileSync(EDITOR_SETTINGS_PATH, JSON.stringify(state.behavior || {}, null, 2));
      if (!state.loading) state.markDirty?.('editor/settings.json');
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
      if (!state.loading) state.markDirty?.('editor/process.env');
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
  function formatSavedTime(timestamp) {
    if (!timestamp) return 'Saved: —';
    return 'Saved: ' + new Date(timestamp).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  }
  function updateStatus() {
    if ($('statusLeft')) $('statusLeft').textContent = state.fs ? `FileSystem: ${state.fs.listFilesSync().length} files` : 'FileSystem: loading…';
    if ($('statusSaved')) $('statusSaved').textContent = formatSavedTime(state.lastSavedAt);
    if ($('statusRight')) $('statusRight').textContent = `CWD: ${state.nodeEmulator?.cwd || '/'}` + (state.dirty ? ' • Unsaved' : '');
    const projectEl = $('projectName');
    if (projectEl && projectEl.tagName !== 'INPUT') projectEl.textContent = state.projectName || 'Workspace';
    const save = $('saveProjectBtn');
    if (save) {
      const hasHandle = !!state.fs?.canSave?.();
      const canCreateHandle = !hasHandle && typeof showSaveFilePicker === 'function';
      const canSave = hasHandle ? state.saveProjectPermission !== 'denied' : canCreateHandle;
      save.disabled = !canSave;
      save.title = hasHandle ? 'Save changes to the project file' : canCreateHandle ? 'Save project and choose a writable project file' : 'Save Project is unavailable for this workspace';
    }
  }
  async function refreshSaveProjectState() {
    state.saveProjectPermission = state.fs?.canSave?.() ? await state.fs.permissionState?.() : (typeof showSaveFilePicker === 'function' ? 'new' : 'denied');
    updateStatus();
  }
  function recentProjects() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) || '[]');
      return Array.isArray(list) ? list.filter(x => x && x.id && x.name) : [];
    } catch (_) {
      return [];
    }
  }
  function writeRecentProjects(list) {
    try { localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list.slice(0, 10))); } catch (_) {}
  }
  function rememberRecentProject(extra = {}) {
    const id = String(extra.id || state.projectId || '').trim();
    if (!id) return null;
    const list = recentProjects();
    const index = list.findIndex(x => x.id === id);
    const existing = index >= 0 ? list[index] : {};
    const record = {
      id,
      name: extra.name ?? state.projectName ?? existing.name ?? 'Workspace',
      type: extra.type ?? state.runConfig?.config?.serverType ?? existing.type ?? 'static',
      lastOpenedAt: extra.lastOpenedAt ?? existing.lastOpenedAt ?? 0,
      lastSavedAt: extra.lastSavedAt ?? state.lastSavedAt ?? existing.lastSavedAt ?? 0,
      lastCachedAt: extra.lastCachedAt ?? existing.lastCachedAt ?? 0,
      unsaved: extra.unsaved ?? state.dirty ?? false
    };
    if (index < 0) list.unshift(record);
    else {
      list[index] = record;
      if (extra.lastOpenedAt !== undefined) {
        list.splice(index, 1);
        list.unshift(record);
      }
    }
    writeRecentProjects(list);
    return record;
  }
  function cacheRequest(id) {
    return new Request(new URL('./__editor_cache__/' + encodeURIComponent(id), location.href).href);
  }
  async function saveProjectCache(force = false) {
    if (!state.fs || !state.projectId || state.loading) return false;
    if (!force && !state.dirty) return false;
    if (!('caches' in window)) return false;
    const fs = state.fs;
    const projectId = state.projectId;
    const projectName = state.projectName || 'Workspace';
    const projectType = state.runConfig?.config?.serverType || 'static';
    const dirty = !!state.dirty;
    const lastSavedAt = state.lastSavedAt || 0;
    const existingPromise = state.cacheWritePromises.get(projectId);
    if (existingPromise) return existingPromise;
    const promise = (async () => {
      try {
        try {
          fs.mkdirSync?.(EDITOR_DIR);
          fs.writeFileSync(EDITOR_PROJECT_PATH, JSON.stringify({id: projectId, name: projectName}, null, 2));
        } catch (_) {}
        const blob = await fs.exportZip();
        const cache = await caches.open(PROJECT_CACHE_NAME);
        await cache.put(cacheRequest(projectId), new Response(blob, {headers: {'content-type': 'application/zip'}}));
        const lastCachedAt = Date.now();
        rememberRecentProject({
          id: projectId,
          name: projectName,
          type: projectType,
          lastSavedAt,
          lastCachedAt,
          unsaved: dirty
        });
        if (state.projectId === projectId) {
          state.lastCachedAt = lastCachedAt;
          updateStatus();
        }
        return true;
      } catch (_) {
        return false;
      } finally {
        state.cacheWritePromises.delete(projectId);
      }
    })();
    state.cacheWritePromises.set(projectId, promise);
    return promise;
  }
  function markDirty(path) {
    if (state.loading) return;
    state.dirty = true;
    updateStatus();
    clearTimeout(state.cacheTimer);
    state.cacheTimer = setTimeout(() => { void saveProjectCache(); }, 1500);
  }

  function layoutKey() { return LAYOUT_KEY_PREFIX + (state.projectId || 'default'); }
  function saveWorkspaceLayout() {
    if (state.loading || !state.projectId || !state.workbench) return;
    try {
      localStorage.setItem(layoutKey(), JSON.stringify({
        workbench: state.workbench.serialize(),
        sidebar: state.sidebar || 'explorer',
        explorerCollapsed: !!$('tree')?.classList.contains('activity-collapsed'),
        collapsedPaths: [...(state.fileManager?.collapsedPaths || [])],
        activeActivity: document.querySelector('.activity-button.active')?.id || 'activityExplorer'
      }));
    } catch (_) {}
  }
  function scheduleWorkspaceLayoutSave() {
    if (state.loading) return;
    clearTimeout(state.layoutTimer);
    state.layoutTimer = setTimeout(saveWorkspaceLayout, 250);
  }
  function loadWorkspaceLayout() {
    try { return JSON.parse(localStorage.getItem(layoutKey()) || 'null'); } catch (_) { return null; }
  }
  function noteSaved() {
    state.lastSavedAt = Date.now();
    state.dirty = false;
    rememberRecentProject({lastSavedAt: state.lastSavedAt, unsaved: false});
    updateStatus();
    void saveProjectCache(true);
  }
  async function saveProjectNow() {
    if (!state.fs) return false;
    try {
      saveProjectMetadata();
      if (!state.fs.canSave?.()) {
        if (typeof showSaveFilePicker !== 'function') return false;
        const saved = await state.fs.saveAs((state.projectName || 'workspace') + '.zip');
        if (!saved) return false;
        state.saveProjectPermission = 'granted';
      } else {
        const permission = await state.fs.permissionState?.();
        if (permission === 'denied') {
          state.saveProjectPermission = 'denied';
          updateStatus();
          return false;
        }
        await state.fs.save();
      }
      noteSaved();
      await refreshSaveProjectState();
      return true;
    } catch (e) {
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
        state.saveProjectPermission = 'denied';
        updateStatus();
      }
      if (e?.name !== 'AbortError') logError(e);
      return false;
    }
  }
  async function confirmWorkspaceSwitch(action) {
    if (!state.dirty) return true;
    return await new Promise(resolve => {
      const modal = document.createElement('div');
      modal.className = 'editor-modal';
      modal.innerHTML = `<div class="editor-modal-content workspace-warning-modal"><h2>Unsaved Changes</h2><p>You have unsaved changes. What would you like to do before ${action}?</p><div class="editor-modal-actions"><button data-action="save">Save & Continue</button><button data-action="discard">Continue Without Saving</button><button data-action="cancel">Cancel</button></div></div>`;
      document.body.appendChild(modal);
      const save = modal.querySelector('[data-action="save"]');
      save.disabled = !!$('saveProjectBtn')?.disabled;
      const finish = value => { modal.remove(); resolve(value); };
      modal.querySelector('[data-action="cancel"]').onclick = () => finish(false);
      modal.querySelector('[data-action="discard"]').onclick = async () => { await saveProjectCache(true); finish(true); };
      save.onclick = async () => { if (await saveProjectNow()) finish(true); };
      modal.onclick = e => { if (e.target === modal) finish(false); };
      requestAnimationFrame(() => modal.classList.add('show'));
    });
  }
  function renameProject() {
    const el = $('projectName');
    if (!el || el.tagName === 'INPUT') return;
    const input = document.createElement('input');
    input.id = 'projectName';
    input.className = 'project-name-input';
    input.type = 'text';
    input.value = state.projectName || el.textContent || 'Workspace';
    el.replaceWith(input);
    const finish = save => {
      if (input.dataset.done) return;
      input.dataset.done = '1';
      const value = input.value.trim();
      if (save && value) {
        state.projectName = value;
        state.projectKey = value;
        try { saveProjectMetadata(); } catch (e) { logError(e); }
        state.runConfig?.save();
        state.fileManager?.setProjectName?.(value);
        state.markDirty?.('editor/project.json');
      }
      const span = document.createElement('span');
      span.id = 'projectName';
      span.textContent = state.projectName || 'Workspace';
      input.replaceWith(span);
      span.onclick = () => renameProject();
      updateStatus();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(!!input.value.trim()));
    input.focus();
    input.select();
  }
  async function ensureMonaco() {
    if (state.monacoPromise) return state.monacoPromise;
    state.monacoPromise = new Promise((resolve, reject) => {
      if (typeof require !== 'function') return reject(new Error('Monaco loader unavailable'));
      const monacoRoot = new URL('editor/previews/vendor/monaco/', document.baseURI).href;
      const monacoVs = new URL('vs/', monacoRoot).href;
      window.MonacoEnvironment = window.MonacoEnvironment || {};
      window.MonacoEnvironment.getWorkerUrl = () => new URL('monaco-worker.js', monacoRoot).href;
      require.config({ paths: { vs: monacoVs } });
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
      view: null,
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
      previous._viewElement.style.display = 'none';
      return;
    }
    g.viewBody.innerHTML = '';
  }
  function renderViewBar(g, t) {
    g.viewBar.innerHTML = '';
    if (!t || t.kind !== 'file' || !state.previews) {
      g.viewBar.style.display = 'none';
      return;
    }
    g.viewBar.style.display = '';
    const file = { path: t.path, name: basename(t.path), mime: mime(t.path), id: t.id };
    const views = state.previews.getViews(file);
    for (const view of views) {
      const b = document.createElement('button');
      b.className = 'view-button' + (t.view === view.id ? ' active' : '');
      b.textContent = view.label || view.id;
      b.onclick = () => {
        t.view = view.id;
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
    state.previews?.dispose(t);
  }
  async function activate(t, g) {
    g.active = t?.id || null;
    if (t) t._viewActivation = (t._viewActivation || 0) + 1;
    state.workbench.renderGroup(g);
    if (!t) {
      renderEmpty(g);
      return;
    }
    disposeTabView(t);
    clearView(g);
    if (t.kind === 'file') {
      const file = { path: t.path, name: basename(t.path), mime: mime(t.path), id: t.id };
      const views = state.previews?.getViews(file) || [];
      if (!t.view || !views.some(v => v.id === t.view)) t.view = state.previews?.getDefaultView(file)?.id || null;
    }
    renderViewBar(g, t);
    if (t.kind === 'builtin') {
      if (t._viewElement) {
        if (t._viewElement.parentNode !== g.viewBody) g.viewBody.appendChild(t._viewElement);
        t._viewElement.style.display = '';
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
    const file = { path: t.path, name: basename(t.path), mime: mime(t.path), id: t.id };
    if (state.previews?.getView(file, t.view)) {
      return state.previews.render(file, t.view, g.viewBody, g);
    }
    const fallback = document.createElement('div');
    fallback.className = 'editor-binary';
    fallback.textContent = `No editor or preview available for ${file.name}`;
    g.viewBody.appendChild(fallback);
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
      scheduleWorkspaceLayoutSave();
      return;
    }
    if (kind === 'settings') {
      setActiveActivity('activitySettings');
      renderSidebarSettings();
      scheduleWorkspaceLayoutSave();
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
    scheduleWorkspaceLayoutSave();
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
  function setupDefaultStaticLayout() {
    const wb = state.workbench;
    wb.reset();
    const editorGroup = wb.getFirstLeaf();
    const browserGroup = wb.splitGroup(editorGroup, 'horizontal', false);
    openFile('index.html', editorGroup);
    openBuiltin('browser', browserGroup);
    openBuiltin('run', browserGroup);
    const browserTab = browserGroup.tabs.find(t => t.builtin === 'browser');
    if (browserTab) wb.activateTab(browserGroup, browserTab.id);
  }
  function makeLayoutTab(data, serverType) {
    if (!data) return null;
    if (data.kind === 'file') {
      if (!state.fs?.existsSync(data.path)) return null;
      const t = makeFileTab(data.path);
      t.view = data.view || null;
      return t;
    }
    if (data.kind === 'builtin') {
      const t = makeBuiltinTab(data.builtin);
      return t;
    }
    return null;
  }
  function restoreWorkspaceLayout(layout) {
    if (!layout?.workbench || !state.workbench.restore) return false;
    const restored = state.workbench.restore(layout.workbench, data => makeLayoutTab(data, state.runConfig?.config?.serverType));
    if (!restored) return false;
    if (state.fileManager) {
      state.fileManager.collapsedPaths = new Set(layout.collapsedPaths || []);
      state.fileManager.render();
    }
    if (layout.sidebar === 'explorer' || layout.sidebar === 'settings' || layout.sidebar === 'Search' || layout.sidebar === 'Source Control' || layout.sidebar === 'Run and Debug' || layout.sidebar === 'Extensions') {
      showSidebar(layout.sidebar);
    } else {
      showSidebar('explorer');
    }
    if (layout.activeActivity && $(layout.activeActivity)) setActiveActivity(layout.activeActivity);
    const tree = $('tree');
    if (tree) tree.classList.toggle('activity-collapsed', !!layout.explorerCollapsed);
    if (layout.explorerCollapsed) document.querySelector('#activityExplorer')?.classList.remove('active');
    return true;
  }
  function applyProjectLayout(forceDefault = false) {
    if (!forceDefault) {
      const saved = loadWorkspaceLayout();
      if (saved && restoreWorkspaceLayout(saved)) return;
    }
    const type = state.runConfig?.config?.serverType === 'node' ? 'node' : 'static';
    if (type === 'node') setupDefaultNodeLayout();
    else setupDefaultStaticLayout();
  }
  async function createStarter(kind, options = {}) {
    const fs = await FileSystem.empty({ sync: false });
    const isNode = kind === 'node';
    const projectName = isNode ? 'Node Server' : 'Static Website';
    const projectId = makeProjectId();
    const config = {
      serverType: isNode ? 'node' : 'static',
      domain: 'http://localhost:3000/',
      path: '/',
      rootfolder: '/',
      runfile: isNode ? '/public/index.html' : '/index.html',
      nodeCommand: isNode ? 'npm run start' : 'node server.js',
      cwd: '/',
      autoClear: true
    };
    if (kind === 'static') {
      fs.writeFileSync('index.html', '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>Static Site</title><link rel="stylesheet" href="style.css"></head>\n<body><main><h1>Hello from Static Site</h1><p>Edit index.html, style.css, or script.js.</p><script src="script.js"></script></main></body></html>');
      fs.writeFileSync('style.css', 'body{margin:0;font-family:sans-serif;background:#111;color:#eee}main{max-width:700px;margin:12vh auto;padding:2rem}');
      fs.writeFileSync('script.js', 'console.log("Static site running");');
    } else {
      fs.writeFileSync('package.json', JSON.stringify({name:'node-starter',version:'1.0.0',scripts:{start:'node server.js'},main:'server.js'}, null, 2));
      fs.writeFileSync('server.js', `const http=require('http');\nconst fs=require('fs');\nconst path=require('path');\nconst server=http.createServer((req,res)=>{\n  const file=req.url==='/'?'/index.html':req.url.split('?')[0];\n  const filename=path.join(process.cwd(),'public',file.replace(/^\\//,''));\n  try{res.end(fs.readFileSync(filename));}catch(e){res.statusCode=404;res.end('Not found');}\n});\nserver.listen(3000,'localhost',()=>console.log('Server listening on http://localhost:3000/'));\n`);
      fs.writeFileSync('public/index.html', '<!doctype html>\n<html><body><h1>Hello from Node Server</h1><p>Edit public/index.html.</p></body></html>');
    }
    fs.mkdirSync(EDITOR_DIR);
    fs.writeFileSync(EDITOR_PROJECT_PATH, JSON.stringify({id: projectId, name: projectName}, null, 2));
    fs.writeFileSync(EDITOR_CONFIG_PATH, JSON.stringify(config, null, 2));
    await replaceFileSystem(fs, projectName, false, {projectId, isTemplate:true, forceDefaultLayout:true});
  }
  async function newProject() {
    if (!(await confirmWorkspaceSwitch('starting a new project'))) return;
    showProjectChooser({canClose:true});
  }
  function resetRunContext() {
    const net = state.browserNetwork;
    detachRuntime(net);
    for (const terminal of state.terminalTabs.values()) { try { terminal.dispose?.(); } catch (_) {} }
    state.terminalTabs.clear();
    state.browserFrame = null;
    for (const info of state.browserTabs.values()) { try { info?.frame?.remove(); } catch (_) {} }
    state.browserTabs.clear();
  }
  async function replaceFileSystem(fs, name, openFirst = true, options = {}) {
    saveWorkspaceLayout();
    clearTimeout(state.cacheTimer);
    state.cacheTimer = null;
    resetRunContext();
    state.loading = true;
    state.fs = fs;
    state.saveProjectPermission = 'denied';
    state.projectId = options.projectId || null;
    state.projectTemplate = !!options.isTemplate;
    state.projectName = name || 'Workspace';
    state.projectKey = state.projectName;
    state.dirty = false;
    state.lastSavedAt = 0;
    state.lastCachedAt = 0;
    loadEditorConfig();
    loadProjectMetadata();
    loadEnvironment();
    state.fileManager.setFileSystem(fs);
    state.fileManager.setShowHiddenFolders?.(state.behavior.showHiddenFolders);
    state.fileManager.refresh();
    state.runConfig = new EditorRunConfig(state);
    state.runConfig.detect();
    saveProjectMetadata();
    if (!options.isTemplate) {
      const recent = recentProjects().find(x => x.id === state.projectId);
      state.lastSavedAt = Number(options.lastSavedAt || recent?.lastSavedAt || 0);
    }
    state.workbench.reset();
    if (options.isTemplate || options.forceDefaultLayout) {
      applyProjectLayout(true);
    } else if (!openFirst) {
      applyProjectLayout(false);
    } else if (!restoreWorkspaceLayout(loadWorkspaceLayout())) {
      const first = fs.listFilesSync().find(p => isText(p) && !p.endsWith('.piskel')) || fs.listFilesSync()[0];
      const type = state.runConfig.config.serverType === 'node' ? 'node' : 'static';
      if (type === 'static' && fs.existsSync('index.html')) {
        setupDefaultStaticLayout();
      } else if (type === 'node' && fs.existsSync('server.js')) {
        setupDefaultNodeLayout();
      } else if (first) {
        openFile(first);
      }
    }
    if (options.fromCache) state.dirty = !!options.cachedDirty;
    state.loading = false;
    rememberRecentProject({
      lastOpenedAt: Date.now(),
      lastSavedAt: state.lastSavedAt || 0,
      unsaved: !!state.dirty
    });
    void saveProjectCache(true);
    await refreshSaveProjectState();
    updateStatus();
    scheduleWorkspaceLayoutSave();
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
  async function openImportModal(options = {}) {
    if (!options.skipGuard && !(await confirmWorkspaceSwitch('opening another workspace'))) return;
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
    const close = () => {
      closeImportModal();
      if (options.returnToChooser) showProjectChooser(options.chooserOptions || {}).catch(logError);
    };
    modal.querySelector('.editor-modal-close').onclick = close;
    const zipInput = modal.querySelector('.import-input-zip');
    const filesInput = modal.querySelector('.import-input-files');
    modal.querySelector('[data-source="zip"]').onclick = async () => {
      if (window.showOpenFilePicker) {
        try {
          const [handle] = await showOpenFilePicker({
            multiple: false,
            types: [{ description: 'ZIP project', accept: { 'application/zip': ['.zip'] } }]
          });
          if (handle) await importFileSystemSource(handle, handle.name.replace(/\.zip$/i, ''));
          return;
        } catch (e) {
          if (e?.name === 'AbortError') return;
        }
      }
      zipInput.click();
    };
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
      if (e.target === modal) close();
    });
    requestAnimationFrame(() => modal.classList.add('show'));
  }
  async function cacheHasProject(id) {
    if (!('caches' in window)) return false;
    try {
      const cache = await caches.open(PROJECT_CACHE_NAME);
      return !!(await cache.match(cacheRequest(id)));
    } catch (_) { return false; }
  }
  async function removeRecentProject(id) {
    const record = recentProjects().find(x => x.id === id);
    writeRecentProjects(recentProjects().filter(x => x.id !== id));
    try { localStorage.removeItem(LAYOUT_KEY_PREFIX + id); } catch (_) {}
    if ('caches' in window) {
      try {
        const cache = await caches.open(PROJECT_CACHE_NAME);
        await cache.delete(cacheRequest(id));
      } catch (_) {}
    }
    return !!record;
  }
  async function clearRecentProjectCache() {
    writeRecentProjects([]);
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(LAYOUT_KEY_PREFIX)) localStorage.removeItem(key);
      }
    } catch (_) {}
    if ('caches' in window) {
      try { await caches.delete(PROJECT_CACHE_NAME); } catch (_) {}
    }
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));
  }
  function formatRecent(record) {
    const time = record.lastOpenedAt ? new Date(record.lastOpenedAt).toLocaleDateString([], {month:'short', day:'numeric'}) : '';
    const type = record.type === 'node' ? 'Node.js' : 'Static';
    return `<strong>${escapeHTML(record.name)}</strong><span>${type}${time ? ' • ' + time : ''}${record.unsaved ? ' • Unsaved' : ''}</span>`;
  }
  async function loadCachedRecent(record) {
    try {
      const cache = await caches.open(PROJECT_CACHE_NAME);
      const response = await cache.match(cacheRequest(record.id));
      if (!response) return false;
      const blob = await response.blob();
      const file = new File([blob], (record.name || 'Workspace') + '.zip', {type:'application/zip'});
      await replaceFileSystem(await FileSystem.create(file, {sync:false}), record.name, true, {
        projectId: record.id,
        fromCache: true,
        cachedDirty: !!record.unsaved,
        lastSavedAt: record.lastSavedAt || 0
      });
      return true;
    } catch (e) {
      logError(e);
      return false;
    }
  }
  async function showProjectChooser(options = {}) {
    const canClose = !!options.canClose;
    const modal = document.createElement('div');
    modal.className = 'editor-modal startup-modal';
    modal.innerHTML = `<div class="editor-modal-content startup-content">${canClose ? '<button class="editor-modal-close startup-close" aria-label="Close">×</button>' : ''}<h2>Projects</h2><p>Create a new project, continue working on a recent project, or open a project file.</p><div class="startup-templates"><button data-kind="node"><strong>Node.js</strong><span>Node server + browser + terminal</span></button><button data-kind="static"><strong>Static</strong><span>Static site + browser</span></button></div><div class="startup-section"><div class="startup-section-header"><h3>Recent Projects</h3><button class="startup-clear" data-clear>Clear Cache</button></div><div class="startup-list" data-recent-list></div></div><div class="editor-modal-actions"><button data-open>Open Project…</button></div></div>`;
    document.body.appendChild(modal);
    const listEl = modal.querySelector('[data-recent-list]');
    const clearButton = modal.querySelector('[data-clear]');
    let busy = false;
    const render = async () => {
      const records = [];
      for (const record of recentProjects()) {
        if (await cacheHasProject(record.id)) records.push(record);
        else {
          writeRecentProjects(recentProjects().filter(x => x.id !== record.id));
          try { localStorage.removeItem(LAYOUT_KEY_PREFIX + record.id); } catch (_) {}
        }
      }
      if (!records.length) {
        listEl.innerHTML = '<div class="startup-empty">No recent projects yet.</div>';
      } else {
        listEl.innerHTML = records.map(record => `<div class="startup-recent-item"><button class="startup-recent-open" data-recent="${encodeURIComponent(record.id)}">${formatRecent(record)}</button><button class="startup-recent-remove" data-remove="${encodeURIComponent(record.id)}" title="Remove from Recent Projects" aria-label="Remove ${escapeHTML(record.name)}">×</button></div>`).join('');
      }
      clearButton.disabled = !records.length;
      listEl.querySelectorAll('[data-recent]').forEach(button => {
        button.onclick = async () => {
          if (busy) return;
          const id = decodeURIComponent(button.dataset.recent);
          const record = records.find(x => x.id === id);
          if (!record) return;
          busy = true;
          button.disabled = true;
          await loadCachedRecent(record);
          modal.remove();
        };
      });
      listEl.querySelectorAll('[data-remove]').forEach(button => {
        button.onclick = async e => {
          e.stopPropagation();
          if (busy) return;
          busy = true;
          button.disabled = true;
          await removeRecentProject(decodeURIComponent(button.dataset.remove));
          busy = false;
          await render();
        };
      });
    };
    modal.querySelectorAll('[data-kind]').forEach(button => button.onclick = () => {
      if (busy) return;
      busy = true;
      modal.remove();
      createStarter(button.dataset.kind, {initial:true}).catch(logError);
    });
    modal.querySelector('[data-open]').onclick = () => {
      if (busy) return;
      busy = true;
      modal.remove();
      openImportModal({skipGuard:true, returnToChooser:true, chooserOptions:{canClose}}).catch(logError);
    };
    if (canClose) {
      modal.querySelector('.startup-close').onclick = () => {
        if (busy) return;
        modal.remove();
      };
    }
    clearButton.onclick = async () => {
      if (busy || clearButton.disabled) return;
      busy = true;
      clearButton.disabled = true;
      await clearRecentProjectCache();
      busy = false;
      await render();
    };
    await render();
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
    state.previews = new EditorPreviewManager(state);
    for (const provider of window.EditorPreviewProviders || []) state.previews.register(provider);
    state.workbench = new Workbench($('editorWorkbench'), {
      onActivate: activate,
      onBuiltin: (kind, g) => openBuiltin(kind, g),
      onLayoutChange: () => scheduleWorkspaceLayoutSave(),
      onClose: (t, g) => {
        state.previews?.dispose(t);
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
      onChange: () => { state.markDirty?.(); updateStatus(); },
      projectName: () => state.projectName,
      showHiddenFolders: state.behavior.showHiddenFolders
    });
    state.runConfig = new EditorRunConfig(state);
    $('uploadZipBtn').onclick = () => openImportModal();
    $('projectName').onclick = () => renameProject();
    $('zipInput')?.addEventListener('change', e => {
      const f = e.target.files?.[0];
      if (f) openZipFile(f).catch(logError);
    });
    $('newZipBtn').onclick = () => newProject().catch(logError);
    $('saveProjectBtn').onclick = () => saveProjectNow();
    $('saveZipBtn').onclick = async () => {
      try {
        const blob = await state.fs.exportZip();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (state.projectName || 'workspace') + '.zip';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        noteSaved();
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
    if (!state._lifecycleBound) {
      state._lifecycleBound = true;
      window.addEventListener('beforeunload', event => {
        saveWorkspaceLayout();
        void saveProjectCache(true);
        if (!state.dirty) return;
        event.preventDefault();
        event.returnValue = '';
      });
      window.addEventListener('pagehide', () => { saveWorkspaceLayout(); void saveProjectCache(true); });
      document.addEventListener('visibilitychange', () => { if (document.hidden) { saveWorkspaceLayout(); void saveProjectCache(true); } });
      setInterval(() => void saveProjectCache(), 60 * 1000);
    }
    try {
      await showProjectChooser();
    } catch (e) {
      logError(e);
    }
  }
  state.saveEditorConfig = saveEditorConfig;
  state.markDirty = markDirty;
  state.updateStatus = updateStatus;
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

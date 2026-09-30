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
    sidebarController: null,
    dirty: false,
    monacoPromise: null,
    builtins: {},
    ensureMonaco,
    previews: null,
    terminalTabs: new Map(),
    browserTabs: new Map(),
    peerServers: new Map(),
    peerRuntimeEndpoint: null,
    peerSettings: {layer: '', pagePath: '/'},
    environment: {},
    behavior: {
      autoSaveOnRun: false,
      autoClearTerminal: false,
      confirmBeforeReplace: true,
      confirmBeforeDelete: true,
      showHiddenFolders: false,
      hideBrowserBar: true
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
  function makePeerLayer() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    if (crypto.getRandomValues) {
      const values = new Uint32Array(6);
      crypto.getRandomValues(values);
      return Array.from(values, value => chars[value % chars.length]).join('');
    }
    return Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }
  function normalizePeerPagePath(value) {
    let path = String(value ?? '').trim();
    if (!path) return '/';
    if (!path.startsWith('/')) path = '/' + path;
    return path;
  }
  function loadProjectMetadata() {
    const meta = readEditorJson(EDITOR_PROJECT_PATH);
    if (meta?.id && String(meta.id).trim()) state.projectId = String(meta.id).trim();
    if (meta?.name && String(meta.name).trim()) {
      state.projectName = String(meta.name).trim();
      state.projectKey = state.projectName;
    }
    state.peerSettings = {
      layer: String(meta?.peerLayer || '').trim() || makePeerLayer(),
      pagePath: normalizePeerPagePath(meta?.pagePath)
    };
    if (!state.projectId) state.projectId = makeProjectId();
    return meta;
  }
  function saveProjectMetadata() {
    if (!state.fs) return;
    if (!state.projectId) state.projectId = makeProjectId();
    if (!state.peerSettings) state.peerSettings = {layer: makePeerLayer(), pagePath: '/'};
    state.peerSettings.layer = String(state.peerSettings.layer || makePeerLayer()).trim();
    state.peerSettings.pagePath = normalizePeerPagePath(state.peerSettings.pagePath);
    state.fs.mkdirSync?.(EDITOR_DIR);
    state.fs.writeFileSync(EDITOR_PROJECT_PATH, JSON.stringify({
      id: state.projectId,
      name: state.projectName,
      peerLayer: state.peerSettings.layer,
      pagePath: state.peerSettings.pagePath
    }, null, 2));
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
          const peerSettings = state.projectId === projectId && state.peerSettings ? {
            layer: String(state.peerSettings.layer || makePeerLayer()).trim(),
            pagePath: normalizePeerPagePath(state.peerSettings.pagePath)
          } : {layer: makePeerLayer(), pagePath: '/'};
          fs.writeFileSync(EDITOR_PROJECT_PATH, JSON.stringify({
            id: projectId,
            name: projectName,
            peerLayer: peerSettings.layer,
            pagePath: peerSettings.pagePath
          }, null, 2));
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
        sidebarWidth: parseInt($('tree')?.style.flexBasis || $('tree')?.getBoundingClientRect().width || 180, 10),
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
  async function exportProject() {
    if (!state.fs) return false;
    try {
      const blob = await state.fs.exportZip();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.projectName || 'workspace') + '.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      noteSaved();
      return true;
    } catch (e) {
      logError(e);
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
  
  function getBuiltin(kind) {
    state.builtins ||= {};
    if (state.builtins[kind]) return state.builtins[kind];
    const factory = window.EditorBuiltinFactories?.[kind];
    if (!factory) return null;
    const ctx = {
      state,
      $,
      basename,
      mime,
      fileIcon,
      runConfigured,
      logError,
      openBuiltin,
      setupRuntime,
      getBuiltin,
      makePeerLayer,
      normalizePeerPagePath,
      saveProjectMetadata,
      readLegacyEditorConfig,
      loadProcessEnv,
      saveProcessEnv,
      applyEditorEnvironment,
      markDirty,
      ensureBrowser: () => getBuiltin('browser')?.ensure(),
      getOrOpenTerminal: () => getBuiltin('terminal')?.getOrOpenTerminal()
    };
    return state.builtins[kind] = factory(ctx);
  }
  function makeBuiltinTab(kind) {
    const builtin = getBuiltin(kind);
    const titles = { welcome: 'Welcome', browser: 'Browser', peer: 'Peer Server', terminal: 'Terminal', run: 'Run Configuration', environment: 'Environment Variables' };
    const welcomeIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 9h10M7 13h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    return {
      id: 'builtin:' + kind + ':' + Math.random().toString(36).slice(2),
      kind: 'builtin',
      builtin: kind,
      title: builtin?.title || titles[kind] || kind,
      icon: builtin?.icon || (kind === 'welcome' ? welcomeIcon : ''),
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
    for (const [k, label] of [['browser', 'Browser'], ['peer', 'Peer Server'], ['terminal', 'Terminal'], ['run', 'Run Configuration'], ['environment', 'Environment Variables'], ['welcome', 'Welcome']]) {
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
      const builtin = getBuiltin(t.builtin);
      if (builtin?.render) builtin.render(g, t);
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
    if (kind === 'settings') {
      state.sidebarController.show('settings');
      return null;
    }
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
  
  
  
  
  
  
  
  
  
  
  
  function loadBehaviorSettings() {
    try {
      const v = JSON.parse(localStorage.getItem('editor.behaviorSettings') || 'null');
      if (v) applyEditorSettings(v);
    } catch (e) {}
  }
  function saveBehaviorSettings() {
    saveEditorSettings();
  }

  function renderWelcome(g) {
    const div = document.createElement('div');
    div.className = 'builtin-welcome';
    const card = document.createElement('div');
    card.className = 'workbench-empty-card';
    card.innerHTML = '<h2>Welcome</h2><p>Create a new project from the toolbar or open a built-in tool here.</p>';
    const actions = document.createElement('div');
    actions.className = 'workbench-empty-actions';
    for (const [kind, label] of [['browser', 'Browser'], ['peer', 'Peer Server'], ['terminal', 'Terminal'], ['run', 'Run Configuration'], ['environment', 'Environment Variables']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => openBuiltin(kind, g);
      actions.appendChild(b);
    }
    card.appendChild(actions);
    div.appendChild(card);
    g.viewBody.appendChild(div);
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
  state.ensureNodeRuntime = async function() {
    if (state.nodeEmulator) return state.nodeEmulator;
    if (!state.fs || !state.browserNetwork) throw new Error('Node runtime is not ready.');
    state.runConfig?.detect?.();
    if (state.runConfig?.config?.serverType !== 'node') throw new Error('This project is not configured for Node.');
    await setupRuntime(state.browserNetwork);
    return state.nodeEmulator;
  };
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
      emulator.addEventListener?.('filesystemchange', () => {
        state.fileManager?.refresh?.();
        state.markDirty?.();
        updateStatus();
      });
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
    // A runtime restart invalidates WebSocket backends created by the old runtime.
    // Keep the PeerServer itself alive, but make existing peer sockets reconnect
    // against the newly-created runtime endpoint.
    for (const info of state.peerServers.values()) {
      try { info.server?.resetRuntime?.(); } catch (_) {}
    }
    state.runConfig?.refreshEndpointList?.();
    state.runDebugRefresh?.();
    updateStatus();
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
      terminal = getBuiltin('terminal')?.getOrOpenTerminal();
    }
    await setupRuntime(net);
    if (c.serverType === 'node') {
      if (!state.nodeEmulator) throw new Error('Node runtime is not ready.');
      terminal = terminal || getBuiltin('terminal')?.getOrOpenTerminal();
      const terminalView = state.terminalTabs.get(terminal.id);
      terminalView?.attach(state.nodeEmulator);
      if (c.nodeCommand) {
        await terminalView?.runCommand(c.nodeCommand);
      }
      const serverReady = await state.nodeEmulator.waitForServer?.(10000, 50);
      if (!serverReady) throw new Error('Node command finished, but no listening server was created.');
    }
    await getBuiltin('browser')?.ensure();
    await getBuiltin('browser')?.navigatePreview();
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
      if (data.builtin === 'settings') return null;
      return makeBuiltinTab(data.builtin);
    }
    return null;
  }
  function restoreWorkspaceLayout(layout) {
    if (!layout?.workbench || !state.workbench.restore) return false;
    const restored = state.workbench.restore(layout.workbench, data => makeLayoutTab(data, state.runConfig?.config?.serverType));
    if (!restored) return false;
    state.sidebarController.restoreCollapsed(layout.collapsedPaths || []);
    if (layout.sidebar === 'explorer' || layout.sidebar === 'settings' || layout.sidebar === 'Search' || layout.sidebar === 'Source Control' || layout.sidebar === 'Run and Debug' || layout.sidebar === 'Extensions') {
      state.sidebarController.show(layout.sidebar);
    } else {
      state.sidebarController.show('explorer');
    }
    if (layout.activeActivity && $(layout.activeActivity)) state.sidebarController.setActiveActivity(layout.activeActivity);
    const tree = $('tree');
    if (tree && layout.sidebarWidth) state.sidebarController.setWidth(layout.sidebarWidth);
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
    for (const info of state.peerServers.values()) {
      try { void info?.server?.close?.(); } catch (_) {}
      try { info?.frame?.remove(); } catch (_) {}
    }
    state.peerServers.clear();
    try { window.keepAlive?.disable?.(); } catch (_) {}
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
    getBuiltin('environment')?.load();
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

  function openSearchResult(path, line, column) {
    openFile(path);
    let attempts = 0;
    const reveal = () => {
      attempts++;
      for (const g of state.workbench.groups.values()) {
        const tab = g.tabs.find(t => t.kind === 'file' && t.path === normalize(path));
        if (!tab) continue;
        if (tab.editor) {
          tab.editor.setPosition({lineNumber: line, column: column});
          tab.editor.revealPositionInCenter({lineNumber: line, column: column});
          tab.editor.focus();
          return;
        }
      }
      if (attempts < 40) setTimeout(reveal, 50);
    };
    reveal();
  }

  function bindUI() {
    state.sidebarController = EditorSidebar.create({
      state,
      $,
      tree: $('tree'),
      resizer: $('resizer'),
      contextMenu: $('contextMenu'),
      fileInput: $('fileUploader'),
      FileManager,
      runConfigured,
      logError,
      saveBehaviorSettings,
      scheduleWorkspaceLayoutSave,
      updateStatus,
      onOpen: openFile,
      onMove,
      onDelete,
      markDirty,
      onOpenResult: openSearchResult
    });
    state.sidebar = 'explorer';
    state.previews = new EditorPreviewManager(state);
    for (const provider of window.EditorPreviewProviders || []) state.previews.register(provider);
    state.workbench = new Workbench($('editorWorkbench'), {
      onActivate: activate,
      onBuiltin: (kind, g) => openBuiltin(kind, g),
      onLayoutChange: () => scheduleWorkspaceLayoutSave(),
      onClose: (t, g) => {
        if (t?.builtin === 'peer') void getBuiltin('peer')?.stop(t);
        state.previews?.dispose(t);
        t.model?.dispose();
        t.editor?.dispose();
        state.workbench.removeTab(g, t.id);
      }
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
    $('saveZipBtn').onclick = () => exportProject();
    $('saveProjectBtn').title += ' (Ctrl+S)';
    $('saveZipBtn').title = 'Export project as a ZIP (Ctrl+E)';
    $('runBtn').onclick = () => runConfigured().catch(logError);
    $('runBtn').title = 'Run project (Ctrl+Enter or F5)';
    $('runConfigBtn').onclick = () => openBuiltin('run');
    $('runConfigBtn').title = 'Open Run Configuration';
    if (!state._keybindingsBound) {
      state._keybindingsBound = true;
      document.addEventListener('keydown', e => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod && e.key !== 'F5') return;
        if (e.key === 'F5') {
          e.preventDefault();
          runConfigured().catch(logError);
          return;
        }
        if (e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          saveProjectNow();
          return;
        }
        if (e.key.toLowerCase() === 'e' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          exportProject();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          runConfigured().catch(logError);
          return;
        }
        if (e.shiftKey && !e.altKey) {
          const key = e.key.toLowerCase();
          if (key === 'e') {
            e.preventDefault();
            state.sidebarController.show('explorer');
            return;
          }
          if (key === 'f') {
            e.preventDefault();
            state.sidebarController.show('Search');
            return;
          }
          if (key === 'd') {
            e.preventDefault();
            state.sidebarController.show('Run and Debug');
            return;
          }
        }
        if (e.key === '`' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          openBuiltin('terminal');
        }
      });
    }
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
    saveProjectNow,
    exportProject,
    logError
  };
})();

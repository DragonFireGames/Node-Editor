// Short-lived bridge for transferring actual files between the editor and its embedded browser.
// Tokens travel through DataTransfer; the bytes stay in memory and are only read when a drop target accepts them.
if (!window.__editorFileDropBridge) {
  const pendingEditorDropFiles = new Map();
  let editorDropTokenId = 0;
  const editorDropLifetime = 5 * 60 * 1000;
  const isTransferableFile = file => !!file && typeof file.name === 'string' && typeof file.arrayBuffer === 'function';
  const registerPayload = payload => {
    if (typeof payload !== 'function') {
      const files = Array.isArray(payload) ? payload : [payload];
      if (!files.length || !files.every(isTransferableFile)) return '';
    }
    const token = 'wk-file-' + Date.now().toString(36) + '-' + (++editorDropTokenId) + '-' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => pendingEditorDropFiles.delete(token), editorDropLifetime);
    pendingEditorDropFiles.set(token, {payload, timer});
    return token;
  };
  window.__editorFileDropBridge = {
    register(file) {
      return registerPayload(file);
    },
    registerFiles(files) {
      return registerPayload(Array.isArray(files) ? files.slice() : []);
    },
    registerProvider(provider) {
      return typeof provider === 'function' ? registerPayload(provider) : '';
    },
    take(token) {
      token = String(token || '');
      const entry = pendingEditorDropFiles.get(token);
      if (!entry) return null;
      pendingEditorDropFiles.delete(token);
      clearTimeout(entry.timer);
      return typeof entry.payload === 'function' ? entry.payload() : entry.payload;
    },
    release(token) {
      token = String(token || '');
      const entry = pendingEditorDropFiles.get(token);
      if (!entry) return;
      pendingEditorDropFiles.delete(token);
      clearTimeout(entry.timer);
    }
  };
}

window.__editorInitPromise = (async function () {
  const workers = await (window.__workersConfigReady || Promise.resolve(window.WorkerConfig || {}));
  // One Network owned by the editor/workbench and shared by every Browser iframe.
  // Keeping ownership here prevents a Browser iframe from taking the network down
  // when its workbench tab is replaced or destroyed.
  if (!window.__sharedBrowserNetwork && typeof Network === 'function') {
    try {
      const sharedNetwork = new Network();
      if (typeof ProxyNetworkEndpoint === 'function' && typeof NetworkEndpoint === 'function') {
        const primaryProxy = new ProxyNetworkEndpoint(String(workers.proxy || ''), true);
        const configuredFallbackProxy = typeof workers.fallbackProxy === 'string' ? workers.fallbackProxy.trim() : '';
        const fallbackProxy = new ProxyNetworkEndpoint(configuredFallbackProxy, true, !!configuredFallbackProxy);
        const defaultFallback = new NetworkEndpoint();
        defaultFallback.__browserDefaultFallback = true;
        sharedNetwork.appendEndpoint(defaultFallback);
        sharedNetwork.appendEndpoint(primaryProxy);
        sharedNetwork.appendEndpoint(fallbackProxy);
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
    projectOwner: true,
    gitEnabled: true,
    gitRemote: null,
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
    deploymentSettings: {thirdParty: false, externalUrl: '', branch: '', commit: 'latest', path: '/'},
    ai: null,
    environment: {},
    browserSettings: {
      primaryProxy: String(workers.proxy || '').trim(),
      fallbackProxy: (typeof workers.fallbackProxy === 'string' ? workers.fallbackProxy.trim() : ''),
      searchEngine: 'https://mojeek.com/search?q=',
      useFallback: typeof workers.fallbackProxy === 'string' && workers.fallbackProxy.trim().length > 0,
      obscureURL: true,
      defaultTab: 'https://example.com',
      clearDevToolsOnReload: true,
      autoDownload: false
    },
    behavior: {
      autoSaveOnRun: false,
      autoClearTerminal: false,
      confirmBeforeReplace: true,
      confirmBeforeDelete: true,
      showHiddenFolders: false,
      ignoreNodeModules: true,
      hideBrowserBar: true
    }
  };
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Global editor theme
  // ---------------------------------------------------------------------------
  // One mutable theme object is shared by the whole editor, including nested
  // tab-group workbenches. Embedding pages/extensions can update it after the
  // editor has loaded and the change is applied to both CSS and Monaco.
  const defaultTheme = {
    id: 'node-editor',
    css: {
      bg: '#111',
      surface: '#222',
      surface2: '#1e1e1e',
      tabs: '#181818',
      tab: '#1f1f1f',
      tabActive: '#252526',
      text: '#eee',
      textSecondary: '#ddd',
      muted: '#aaa',
      muted2: '#888',
      border: '#333',
      borderStrong: '#555',
      hover: '#444',
      divider: '#2b2b2b',
      accent: '#2563a6',
      accentStrong: '#4a86bd',
      status: '#007acc'
    },
    monaco: {
      base: 'vs-dark',
      inherit: true,
      semanticHighlighting: true,
      semanticTokenColors: {},
      colors: {},
      rules: []
    }
  };

  function cloneTheme(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const themeStyleMap = {
    '--editor-bg': 'css.bg',
    '--editor-surface': 'css.surface',
    '--editor-surface-2': 'css.surface2',
    '--editor-tabs': 'css.tabs',
    '--editor-tab': 'css.tab',
    '--editor-tab-active': 'css.tabActive',
    '--editor-text': 'css.text',
    '--editor-text-secondary': 'css.textSecondary',
    '--editor-muted': 'css.muted',
    '--editor-muted-2': 'css.muted2',
    '--editor-border': 'css.border',
    '--editor-border-strong': 'css.borderStrong',
    '--editor-hover': 'css.hover',
    '--editor-divider': 'css.divider',
    '--editor-accent': 'css.accent',
    '--editor-accent-strong': 'css.accentStrong',
    '--editor-status': 'css.status'
  };

  function getPath(root, path) {
    return path.split('.').reduce((value, key) => value?.[key], root);
  }

  function applyThemeCSS(theme) {
    const root = document.documentElement;
    for (const [variable, path] of Object.entries(themeStyleMap)) {
      const value = getPath(theme, path);
      if (value != null) root.style.setProperty(variable, String(value));
    }
  }

  function applyThemeMonaco(theme, monaco = window.monaco) {
    if (!monaco?.editor) return false;
    const name = String(theme.id || theme.monaco?.name || 'node-editor');
    const semanticTokenColors = {...(theme.monaco?.semanticTokenColors || {})};
    const rules = [...(theme.monaco?.rules || [])];
    // Keep both semantic token colors and token-theme rules populated. Older
    // bundled Monaco builds use the latter while newer builds prefer semantic
    // token colors for language-service classifications such as functions.
    monaco.editor.defineTheme(name, {
      base: theme.monaco?.base || 'vs-dark',
      inherit: theme.monaco?.inherit !== false,
      semanticHighlighting: theme.monaco?.semanticHighlighting !== false,
      semanticTokenColors,
      colors: {...(theme.monaco?.colors || {})},
      rules
    });
    monaco.editor.setTheme(name);
    if (typeof monaco.editor.getEditors === 'function') {
      const enabled = theme.monaco?.semanticHighlighting !== false;
      for (const instance of monaco.editor.getEditors()) {
        try { instance.updateOptions({'semanticHighlighting.enabled': enabled, theme: name}); } catch (_) {}
      }
    }
    return true;
  }

  function applyTheme() {
    applyThemeCSS(window.EditorTheme);
    applyThemeMonaco(window.EditorTheme, window.monaco);
    editorEventListeners?.get?.('themeChange')?.forEach?.(listener => {
      try { listener({theme: window.EditorTheme}); } catch (error) { console.error('Editor event themeChange failed', error); }
    });
  }

  const themeObject = cloneTheme(defaultTheme);
  themeObject.set = patch => {
    const source = patch && typeof patch === 'object' ? patch : {};
    const merge = (target, value) => {
      for (const [key, entry] of Object.entries(value)) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
          merge(target[key], entry);
        } else target[key] = entry;
      }
    };
    merge(themeObject, source);
    applyTheme();
    return themeObject;
  };
  themeObject.setColor = (key, value) => themeObject.set({css: {[key]: value}});
  themeObject.setMonacoColor = (key, value) => themeObject.set({monaco: {colors: {[key]: value}}});
  themeObject.setTokenColor = (token, foreground, fontStyle) => {
    const rules = [...(themeObject.monaco?.rules || [])];
    const index = rules.findIndex(rule => rule.token === token);
    const rule = {token, foreground};
    if (fontStyle != null) rule.fontStyle = fontStyle;
    if (index >= 0) rules[index] = {...rules[index], ...rule};
    else rules.push(rule);
    themeObject.set({monaco: {rules}});
  };
  themeObject.apply = applyTheme;

  // Keep EditorTheme as a stable API object. Embedding pages historically
  // assigned a complete theme object (for example, from an extension) instead
  // of calling EditorTheme.set(). Intercept that assignment so those themes
  // are merged into the live theme object rather than replacing its methods.
  // This preserves EditorTheme.apply()/set*() and lets Monaco receive the
  // assigned theme through the normal applyThemeMonaco() path.
  Object.defineProperty(window, 'EditorTheme', {
    configurable: true,
    enumerable: true,
    get: () => themeObject,
    set: value => {
      if (!value || typeof value !== 'object' || value === themeObject) {
        if (value === themeObject) applyTheme();
        return;
      }
      const merge = (target, source) => {
        for (const [key, entry] of Object.entries(source)) {
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
              target[key] = {};
            }
            merge(target[key], entry);
          } else {
            target[key] = entry;
          }
        }
      };
      merge(themeObject, value);
      applyTheme();
    }
  });
  applyThemeCSS(window.EditorTheme);

  // ---------------------------------------------------------------------------
  // Editor event bus
  // ---------------------------------------------------------------------------
  // Embedding pages/extensions can observe semantic editor events without
  // reaching into internal handlers. DOM-related callbacks are scheduled after
  // the relevant mutation has been applied.
  const editorEventListeners = new Map();
  let editorDomObserver = null;
  let editorDomObserverStarted = false;

  function onEditorEvent(name, listener) {
    const key = String(name || '').trim();
    if (!key || typeof listener !== 'function') return () => {};
    let set = editorEventListeners.get(key);
    if (!set) editorEventListeners.set(key, set = new Set());
    set.add(listener);
    return () => set.delete(listener);
  }

  function offEditorEvent(name, listener) {
    const set = editorEventListeners.get(String(name || '').trim());
    return !!set?.delete(listener);
  }

  function emitEditorEvent(name, detail = {}, afterDom = true) {
    const key = String(name || '').trim();
    const set = editorEventListeners.get(key);
    if (!set?.size) return;
    const payload = detail && typeof detail === 'object' ? detail : { value: detail };
    const fire = () => {
      for (const listener of [...set]) {
        try { listener(payload); } catch (error) { console.error(`Editor event ${key} failed`, error); }
      }
    };
    if (afterDom) queueMicrotask(fire);
    else fire();
  }

  function startEditorDOMObserver() {
    if (editorDomObserverStarted || typeof MutationObserver !== 'function' || !document.body) return;
    editorDomObserverStarted = true;
    editorDomObserver = new MutationObserver(records => {
      const addedNodes = [];
      for (const record of records) {
        for (const node of record.addedNodes || []) addedNodes.push(node);
      }
      if (!addedNodes.length) return;
      emitEditorEvent('domAdded', {
        records,
        nodes: addedNodes,
        elements: addedNodes.filter(node => node.nodeType === 1),
        targets: [...new Set(records.map(record => record.target).filter(Boolean))]
      }, true);
    });
    editorDomObserver.observe(document.body, { childList: true, subtree: true });
  }

  window.EditorEvents = window.EditorEvents || {};
  window.EditorEvents.on = onEditorEvent;
  window.EditorEvents.off = offEditorEvent;
  window.EditorEvents.emit = emitEditorEvent;
  window.EditorEvents.startDOMObserver = startEditorDOMObserver;
  for (const eventName of ['sidebarChange','tabOpen','tabActivate','tabClose','builtinRender','viewRender','domAdded','workbenchRebuild','themeChange']) {
    const method = 'on' + eventName.charAt(0).toUpperCase() + eventName.slice(1);
    window.EditorEvents[method] = listener => onEditorEvent(eventName, listener);
  }
  startEditorDOMObserver();

  const BROWSER_SETTINGS_KEY = 'editor.browserSettings';
  const browserSettingSubscribers = new Set();
  const browserSettingDefaults = { ...state.browserSettings };
  const workerBrowserDefaults = {
    primaryProxy: String(workers.proxy || '').trim(),
    fallbackProxy: typeof workers.fallbackProxy === 'string' ? workers.fallbackProxy.trim() : '',
    useFallback: typeof workers.fallbackProxy === 'string' && workers.fallbackProxy.trim().length > 0
  };
  function normalizeBrowserSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const out = { ...browserSettingDefaults };
    for (const key of Object.keys(browserSettingDefaults)) {
      if (input[key] !== undefined) out[key] = input[key];
    }
    out.primaryProxy = String(out.primaryProxy || '');
    out.fallbackProxy = String(out.fallbackProxy || '');
    out.searchEngine = String(out.searchEngine || browserSettingDefaults.searchEngine);
    out.defaultTab = String(out.defaultTab || browserSettingDefaults.defaultTab);
    out.useFallback = !!out.useFallback;
    out.obscureURL = !!out.obscureURL;
    out.clearDevToolsOnReload = !!out.clearDevToolsOnReload;
    out.autoDownload = !!out.autoDownload;
    return out;
  }
  function loadBrowserSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(BROWSER_SETTINGS_KEY) || 'null');
      if (saved && typeof saved === 'object') state.browserSettings = normalizeBrowserSettings(saved);
    } catch (_) {}
  }
  function saveBrowserSettings(value, notify = true) {
    const previous = state.browserSettings;
    const next = normalizeBrowserSettings({ ...previous, ...(value || {}) });
    const changed = Object.keys(browserSettingDefaults).some(key => previous[key] !== next[key]);
    state.browserSettings = next;
    try { localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(state.browserSettings)); } catch (_) {}
    try {
      const base = state.browserNetwork?.__browserBaseEndpoints;
      if (base?.primary) {
        base.primary.proxy = state.browserSettings.primaryProxy;
        base.primary.enabled = !!state.browserSettings.primaryProxy;
        base.primary.obscureURL = state.browserSettings.obscureURL;
      }
      if (base?.fallback) {
        base.fallback.proxy = state.browserSettings.fallbackProxy;
        base.fallback.enabled = !!state.browserSettings.useFallback && !!state.browserSettings.fallbackProxy;
        base.fallback.obscureURL = state.browserSettings.obscureURL;
      }
    } catch (_) {}
    try { saveEditorSettings(); } catch (_) {}
    if (notify && changed) {
      for (const listener of [...browserSettingSubscribers]) {
        try { listener({ ...state.browserSettings }); } catch (_) {}
      }
    }
    return { ...state.browserSettings };
  }
  function installBrowserStateBridge() {
    window.__editorBrowserStateBridge = {
      read() {
        return { settings: { ...state.browserSettings } };
      },
      write(next) {
        const settings = next?.settings && typeof next.settings === 'object' ? next.settings : next;
        return { settings: saveBrowserSettings(settings) };
      },
      subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        browserSettingSubscribers.add(listener);
        return () => browserSettingSubscribers.delete(listener);
      }
    };
  }
  loadBrowserSettings();
  installBrowserStateBridge();

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
    const { browserSettings, ...behaviorSettings } = settings;
    state.behavior = { ...state.behavior, ...behaviorSettings };
    if (browserSettings && typeof browserSettings === 'object' && !Array.isArray(browserSettings)) {
      state.browserSettings = normalizeBrowserSettings({ ...state.browserSettings, ...browserSettings });
    }
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
  function normalizeDeploymentPath(value) {
    let raw = String(value ?? '').trim();
    if (!raw) return '/';
    try {
      const base = String(state.runConfig?.config?.domain || 'http://localhost:3000/');
      const url = new URL(raw, base);
      let path = url.pathname || '/';
      if (!path.startsWith('/')) path = '/' + path;
      const suffix = (url.search || '') + (url.hash || '');
      return (path === '/' ? '/' : path.replace(/\/+$/, '')) + suffix;
    } catch (_) {
      if (!raw.startsWith('/')) raw = '/' + raw;
      return raw === '/' ? '/' : raw.replace(/\/+$/, '');
    }
  }
  function normalizePeerPagePath(value) {
    let path = String(value ?? '').trim();
    if (!path) return '/';
    if (!path.startsWith('/')) path = '/' + path;
    return path;
  }
  function hydrateGitRemoteFromSavedSelection() {
    if (state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo) return true;
    const projectId = String(state.projectId || '').trim();
    if (!projectId) return false;

    try {
      const saved = JSON.parse(localStorage.getItem('editor.github.project.' + encodeURIComponent(projectId)) || 'null');
      if (saved?.owner && saved?.repo) {
        state.gitRemote = {
          provider: 'github',
          owner: String(saved.owner),
          repo: String(saved.repo),
          branch: String(saved.branch || 'main')
        };
        return true;
      }
    } catch (_) {}

    const match = projectId.match(/^github:([^/]+)\/([^@]+)@(.+)$/);
    if (match) {
      state.gitRemote = {provider:'github', owner:String(match[1]), repo:String(match[2]), branch:String(match[3] || 'main')};
      return true;
    }
    return false;
  }

  function loadProjectMetadata() {
    const meta = readEditorJson(EDITOR_PROJECT_PATH);
    if (meta?.id && String(meta.id).trim()) state.projectId = String(meta.id).trim();
    if (meta?.gitRemote?.provider === 'github' && meta.gitRemote.owner && meta.gitRemote.repo) {
      state.gitRemote = {provider:'github', owner:String(meta.gitRemote.owner), repo:String(meta.gitRemote.repo), branch:String(meta.gitRemote.branch || 'main')};
    }
    if (meta?.name && String(meta.name).trim()) {
      state.projectName = String(meta.name).trim();
      state.projectKey = state.projectName;
    }
    const legacyDeployment = meta?.deployment || {};
    const legacyPeerLayer = String(meta?.peerLayer || '').trim();
    const legacyUsePeerServer = legacyDeployment.usePeerServer === true;
    const legacySaveEnvironmentVariables = legacyDeployment.saveEnvironmentVariables === true;
    if (!String(state.runConfig?.config?.peerLayer || '').trim() && legacyPeerLayer) {
      state.runConfig.config.peerLayer = legacyPeerLayer;
    }
    if (!Object.prototype.hasOwnProperty.call(state.runConfig?.config || {}, 'usePeerServer')) {
      state.runConfig.config.usePeerServer = legacyUsePeerServer;
    }
    if (!Object.prototype.hasOwnProperty.call(state.runConfig?.config || {}, 'saveEnvironmentVariables')) {
      state.runConfig.config.saveEnvironmentVariables = legacySaveEnvironmentVariables;
    }
    state.peerSettings = {
      layer: String(state.runConfig?.config?.peerLayer || legacyPeerLayer).trim() || makePeerLayer(),
      pagePath: normalizePeerPagePath(meta?.pagePath)
    };
    state.runConfig.config.peerLayer = state.peerSettings.layer;
    state.deploymentSettings = {
      thirdParty: legacyDeployment.thirdParty === true || String(legacyDeployment.mode || 'editor').trim() === 'third-party',
      externalUrl: String(legacyDeployment.externalUrl || '').trim(),
      branch: String(legacyDeployment.branch || state.gitRemote?.branch || '').trim(),
      commit: String(legacyDeployment.commit || 'latest').trim() || 'latest',
      path: normalizeDeploymentPath((legacyDeployment.path ?? legacyDeployment.url ?? state.runConfig?.config?.path) || '/')
    };
    if (!state.projectId) state.projectId = makeProjectId();
    hydrateGitRemoteFromSavedSelection();
    return meta;
  }
  function saveProjectMetadata() {
    if (!state.fs) return;
    if (!state.projectId) state.projectId = makeProjectId();
    if (!state.peerSettings) state.peerSettings = {layer: makePeerLayer(), pagePath: '/'};
    state.peerSettings.layer = String(state.peerSettings.layer || makePeerLayer()).trim();
    state.peerSettings.pagePath = normalizePeerPagePath(state.peerSettings.pagePath);
    state.fs.mkdirSync?.(EDITOR_DIR);
    if (state.runConfig?.config) {
      state.runConfig.config.peerLayer = String(state.peerSettings?.layer || '').trim() || makePeerLayer();
      state.runConfig.config.usePeerServer = state.runConfig.config.usePeerServer === true;
      state.runConfig.config.saveEnvironmentVariables = state.runConfig.config.saveEnvironmentVariables === true;
      state.runConfig.save?.();
    }
    const deployment = {
      thirdParty: state.deploymentSettings?.thirdParty === true || state.deploymentSettings?.mode === 'third-party',
      externalUrl: String(state.deploymentSettings?.externalUrl || '').trim(),
      branch: String(state.deploymentSettings?.branch || '').trim(),
      commit: String(state.deploymentSettings?.commit || 'latest').trim() || 'latest',
      path: normalizeDeploymentPath(state.deploymentSettings?.path || state.deploymentSettings?.url || '/')
    };
    state.fs.writeFileSync(EDITOR_PROJECT_PATH, JSON.stringify({
      id: state.projectId,
      name: state.projectName,
      pagePath: state.peerSettings.pagePath,
      deployment,
      ...(state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo ? {gitRemote: state.gitRemote} : {})
    }, null, 2));
    state.fs.writeFileSync('/.editor/deployment.json', JSON.stringify({
      ...deployment,
      ...(state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo ? {repo:{owner:state.gitRemote.owner,name:state.gitRemote.repo}} : {})
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
      const data = { ...(state.behavior || {}) };
      const browserOverrides = {};
      for (const key of ['primaryProxy', 'fallbackProxy', 'useFallback']) {
        if (state.browserSettings[key] !== workerBrowserDefaults[key]) browserOverrides[key] = state.browserSettings[key];
      }
      if (Object.keys(browserOverrides).length) data.browserSettings = browserOverrides;
      state.fs.mkdirSync?.(EDITOR_DIR);
      state.fs.writeFileSync(EDITOR_SETTINGS_PATH, JSON.stringify(data, null, 2));
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
      if (state.runConfig?.config?.saveEnvironmentVariables !== true) return false;
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
      const lines = Object.entries(state.environment || {}).map(([key, value]) => {
        const safe = String(value ?? '').replace(/\r?\n/g, '\\n');
        return `${key}=${safe}`;
      });
      if (state.runConfig?.config?.saveEnvironmentVariables === true) {
        state.fs.mkdirSync?.(EDITOR_DIR);
        state.fs.writeFileSync(EDITOR_ENV_PATH, lines.length ? lines.join('\n') + '\n' : '');
        if (!state.loading) state.markDirty?.('editor/process.env');
      } else {
        try {
          localStorage.setItem('editor.environment.' + (state.projectKey || 'default'), JSON.stringify(state.environment || {}));
        } catch (_) {}
        if (state.fs.existsSync?.(EDITOR_ENV_PATH)) {
          state.fs.deleteFileSync?.(EDITOR_ENV_PATH);
          if (!state.loading) state.markDirty?.('editor/process.env');
        }
      }
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
    const exportZip = $('saveZipBtn');
    if (exportZip) {
      const canExport = !!state.fs && (state.projectOwner === false || !state.projectId);
      exportZip.hidden = !canExport;
      exportZip.disabled = !canExport;
      exportZip.title = canExport ? 'Export project as a ZIP (Ctrl+E)' : '';
    }
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
      unsaved: extra.unsaved ?? state.dirty ?? false,
      gitConnected: extra.gitConnected ?? (state.gitRemote?.provider === 'github') ?? existing.gitConnected ?? false,
      gitRemote: extra.gitRemote ?? (state.gitRemote?.provider === 'github' ? {
        provider: 'github',
        owner: String(state.gitRemote.owner || ''),
        repo: String(state.gitRemote.repo || ''),
        branch: String(state.gitRemote.branch || 'main')
      } : existing.gitRemote ?? null)
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
    // A new template with no user changes should stay ephemeral. Do not create
    // a local cache/recent-project entry until it is edited or explicitly saved.
    if (state.projectTemplate && !state.dirty && !state.lastSavedAt) return false;
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
    if (!state.fs || state.projectOwner !== false) return false;
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
      require(['vs/editor/editor.main'], () => {
        try {
          // Monaco is loaded lazily. The global theme may have been configured
          // before Monaco existed, so define/apply it now as well as on later
          // theme changes.
          applyThemeMonaco(window.EditorTheme, window.monaco);
        } catch (_) {}
        resolve(window.monaco);
      }, reject);
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
      openRemoteProject: options => openRemoteImportModal(options),
      setupRuntime,
      getBuiltin,
      theme: window.EditorTheme,
      makePeerLayer,
      normalizePeerPagePath,
      saveProjectMetadata,
      readLegacyEditorConfig,
      loadProcessEnv,
      saveProcessEnv,
      applyEditorEnvironment,
      markDirty,
      ensureBrowser: () => getBuiltin('browser')?.ensure(),
      getOrOpenTerminal: () => getBuiltin('terminal')?.getOrOpenTerminal(),
      openFile,
      updateStatus
    };
    return state.builtins[kind] = factory(ctx);
  }
  function makeBuiltinTab(kind, options = {}) {
    const builtin = getBuiltin(kind);
    const titles = { welcome: 'Welcome', browser: 'Browser', peer: 'Peer Server', terminal: 'Terminal', run: 'Run Configuration', environment: 'Environment Variables', ai: 'AI', 'github-repository': 'GitHub Repository', group: 'Group' };
    const welcomeIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 9h10M7 13h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const groupIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3.5" y="4" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="8.5" y="13" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    const groupName = kind === 'group' ? String(options.groupName ?? options.name ?? '').trim() || 'Group' : '';
    return {
      id: 'builtin:' + kind + ':' + Math.random().toString(36).slice(2),
      kind: 'builtin',
      builtin: kind,
      title: kind === 'group' ? groupName : (builtin?.title || titles[kind] || kind),
      icon: builtin?.icon || (kind === 'welcome' ? welcomeIcon : kind === 'group' ? groupIcon : ''),
      view: 'edit',
      ...(kind === 'group' ? { groupName, groupLayout: options.groupLayout || null } : {})
    };
  }
  function clearView(g) {
    g.viewBar.innerHTML = '';

    // Keep live tab views attached to the document. Removing an iframe from
    // the DOM unloads its browsing context, which resets stateful previews
    // such as Piskel and browser-based tools every time the user switches tabs.
    // Persistent tab surfaces are hidden instead; temporary render elements
    // are still removed.
    const persistent = new Set();
    for (const tab of g.tabs || []) {
      if (tab._previewHost) persistent.add(tab._previewHost);
      if (tab._viewElement) persistent.add(tab._viewElement);
      // Preserve every live preview surface, not only the currently active
      // one. Switching from Piskel to another preview must not remove the
      // Piskel iframe from the DOM, or its browsing context will reset.
      for (const instance of tab._previewInstances?.values?.() || []) {
        if (instance?.host) persistent.add(instance.host);
      }
    }

    for (const child of [...g.viewBody.children]) {
      if (persistent.has(child)) {
        child.style.display = 'none';
      } else {
        child.remove();
      }
    }
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
    for (const [k, label] of [['browser', 'Browser'], ['peer', 'Peer Server'], ['terminal', 'Terminal'], ['run', 'Run Configuration'], ['environment', 'Environment Variables'], ['ai', 'AI'], ['welcome', 'Welcome']]) {
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
    if (!t || t._previewHost) return;
    if (t.editor) {
      try {
        t.editor.dispose();
      } catch (_) {}
    }
    t.editor = null;
  }
  function renderGroupEmpty(g) {
    g.viewBody.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'group-drag-empty';
    empty.textContent = 'drag tab here';
    g.viewBody.appendChild(empty);
  }
  function closeWorkbenchTab(t, g) {
    if (!t || !g) return;
    if (t?.builtin === 'peer') void getBuiltin('peer')?.stop(t);
    if (t?.builtin === 'group') t._groupWorkbench?.dispose?.();
    if (t?.kind === 'builtin') {
      try { getBuiltin(t.builtin)?.dispose?.(t); } catch (_) {}
    }
    state.previews?.dispose(t);
    t.model?.dispose?.();
    t.editor?.dispose?.();
    const wb = g.ownerWorkbench || state.workbench;
    wb.removeTab(g, t.id);
    emitEditorEvent('tabClose', {
      tab:t, group:g, workbench:wb,
      builtin:t.kind === 'builtin' ? t.builtin : null,
      kind:t.kind, path:t.kind === 'file' ? t.path : null
    }, true);
  }
  function renderGroupBuiltin(g, t) {
    const wrap = document.createElement('div');
    wrap.className = 'builtin-group';
    const surface = document.createElement('div');
    surface.className = 'builtin-group-surface';
    wrap.appendChild(surface);
    g.viewBody.appendChild(wrap);
    t._viewElement = wrap;
    const nested = new Workbench(surface, {
      hostTab: t,
      keepEmpty: true,
      onActivate: (innerT, innerG, lifecycle) => activate(innerT, innerG, lifecycle),
      onBuiltin: (kind, innerG) => openBuiltin(kind, innerG),
      onClose: (innerT, innerG) => closeWorkbenchTab(innerT, innerG),
      onLayoutChange: () => scheduleWorkspaceLayoutSave()
    });
    t._groupWorkbench = nested;
    if (t.groupLayout?.root) {
      const restored = nested.restore(t.groupLayout, data => makeLayoutTab(data, state.runConfig?.config?.serverType));
      if (!restored) nested.rebuild();
    } else nested.rebuild();
  }
  function emitTabLifecycle(t, g, eventName) {
    if (!t || !g) return;
    emitEditorEvent(eventName, {
      tab: t,
      group: g,
      workbench: g.ownerWorkbench || state.workbench,
      tabElement: [...(g.tabBar?.querySelectorAll?.('.workbench-tab') || [])].find(el => el.dataset.tabId === t.id) || null,
      viewElement: t._viewElement || g.viewBody?.lastElementChild || null,
      builtin: t.kind === 'builtin' ? t.builtin : null,
      kind: t.kind,
      path: t.kind === 'file' ? t.path : null
    }, true);
  }

  async function activate(t, g, lifecycle = {}) {
    g.active = t?.id || null;
    if (t) t._viewActivation = (t._viewActivation || 0) + 1;
    const wb = g?.ownerWorkbench || state.workbench;
    // Keep the global active-group pointer aligned with nested/workbench groups.
    // Explorer/search/AI file opens rely on Workbench.getActiveGroup().
    if (!lifecycle.preserveActive) wb.setActiveGroup?.(g);
    wb.renderGroup(g);
    if (!t) {
      if (wb.hostTab) renderGroupEmpty(g);
      else renderEmpty(g);
      emitEditorEvent('viewRender', { tab:null, group:g, workbench:wb, element:g.viewBody?.lastElementChild || null }, true);
      return;
    }

    // Preview instances are persistent per tab/view. Switching tabs, moving
    // a tab between groups, or changing between Piskel and another view must
    // not dispose the embedded editor.
    disposeTabView(t);
    clearView(g);
    if (t.kind === 'file') {
      state.lastTextTab = t;
      const file = { path: t.path, name: basename(t.path), mime: mime(t.path), id: t.id };
      const views = state.previews?.getViews(file) || [];
      if (!t.view || !views.some(v => v.id === t.view)) t.view = state.previews?.getDefaultView(file)?.id || null;
    }
    renderViewBar(g, t);

    const finish = (kind, element, extra = {}) => {
      if (!t._tabOpenEventFired) {
        t._tabOpenEventFired = true;
        emitTabLifecycle(t, g, 'tabOpen');
      }
      emitTabLifecycle(t, g, 'tabActivate');
      emitEditorEvent(kind, { tab:t, group:g, workbench:wb, element:element || null, ...extra }, true);
    };

    if (t.kind === 'builtin') {
      if (t.builtin === 'group') {
        if (t._viewElement) {
          if (t._viewElement.parentNode !== g.viewBody) g.viewBody.appendChild(t._viewElement);
          t._viewElement.style.display = '';
          g.__renderedTab = t;
          if (!t._groupWorkbench) renderGroupBuiltin(g, t);
          finish('builtinRender', t._viewElement, { builtin:t.builtin });
          return;
        }
        renderGroupBuiltin(g, t);
        g.__renderedTab = t;
        finish('builtinRender', t._viewElement, { builtin:t.builtin });
        return;
      }
      if (t._viewElement) {
        if (t._viewElement.parentNode !== g.viewBody) g.viewBody.appendChild(t._viewElement);
        t._viewElement.style.display = '';
        g.__renderedTab = t;
        if (t.builtin === 'terminal') {
          const terminal = state.terminalTabs.get(t.id);
          terminal?.attach(state.nodeEmulator);
          terminal?.updatePrompt();
        }
        finish('builtinRender', t._viewElement, { builtin:t.builtin });
        return;
      }
      const builtin = getBuiltin(t.builtin);
      const renderResult = builtin?.render ? builtin.render(g, t) : renderWelcome(g);
      if (renderResult && typeof renderResult.then === 'function') await renderResult;
      t._viewElement = g.viewBody.lastElementChild || null;
      g.__renderedTab = t;
      finish('builtinRender', t._viewElement, { builtin:t.builtin });
      return;
    }

    g.__renderedTab = t;
    const file = { path: t.path, name: basename(t.path), mime: mime(t.path), id: t.id };
    if (state.previews?.getView(file, t.view)) {
      const renderResult = state.previews.render(file, t.view, g.viewBody, g);
      if (renderResult && typeof renderResult.then === 'function') await renderResult;

      // Reattach a preserved preview surface without rebuilding the embedded
      // document. The surface was hidden by clearView while another tab was
      // active.
      const previewElement = t._previewHost || g.viewBody.lastElementChild;
      if (previewElement) previewElement.style.display = '';

      finish('viewRender', previewElement, { path:t.path, view:t.view });
      return;
    }
    const fallback = document.createElement('div');
    fallback.className = 'editor-binary';
    fallback.textContent = `No editor or preview available for ${file.name}`;
    g.viewBody.appendChild(fallback);
    finish('viewRender', fallback, { path:t.path, view:t.view });
  }
  function getAllWorkbenchGroups() {
    const groups = [];
    for (const wb of Workbench.getInstances?.() || []) {
      for (const g of wb.groups?.values?.() || []) groups.push(g);
    }
    return groups;
  }

  function openFile(path, target) {
    path = normalize(path);
    if (!state.fs?.existsSync(path)) return;

    // A file opened from Explorer/Search should target the currently active
    // leaf even when that leaf belongs to a nested tab-group Workbench.
    let g = target?.ownerWorkbench ? target : Workbench.getActiveGroup?.();
    if (!g || !g.ownerWorkbench?.groups?.has?.(g.id)) {
      g = state.workbench?.getActiveGroup?.() || state.workbench?.getFirstLeaf?.();
    }
    if (!g) return;

    const wb = g.ownerWorkbench || state.workbench;
    let t = g.tabs.find(x => x.kind === 'file' && x.path === path);
    if (!t) {
      t = makeFileTab(path);
      wb.addTab(t, g);
    } else wb.activateTab(g, t.id);
  }
  function installExtensionAPI() {
    if (window.EditorExtensionAPI?.__nodeEditorAPI) return window.EditorExtensionAPI;
    const extensions = new Map();
    const aiTools = new Map();
    const aiHooks = new Map();
    const listeners = new Set();
    const normalizeTool = (tool, extensionId) => {
      if (!tool || typeof tool !== 'object') throw new TypeError('AI tool must be an object.');
      const name = String(tool.name || '').trim();
      if (!name) throw new Error('AI tool name is required.');
      if (typeof tool.execute !== 'function') throw new Error(`AI tool ${name} must define execute(args).`);
      return {
        name,
        description: String(tool.description || `AI tool provided by ${extensionId}`),
        parameters: tool.parameters || {type:'object',properties:{}},
        permission: String(tool.permission || 'extensionActions'),
        execute: tool.execute
      };
    };
    const addExtensionAITools = (extensionId, tools) => {
      for (const tool of Array.isArray(tools) ? tools : []) {
        const clean = normalizeTool(tool, extensionId);
        aiTools.set(clean.name, {...clean, extensionId});
      }
    };
    const removeExtensionAITools = extensionId => {
      for (const [name, tool] of aiTools) if (tool.extensionId === extensionId) aiTools.delete(name);
    };
    const addExtensionAIHooks = (extensionId, hooks) => {
      if (!hooks || typeof hooks !== 'object') return;
      for (const [name, hook] of Object.entries(hooks)) {
        if (typeof hook !== 'function') continue;
        const list = aiHooks.get(name) || [];
        list.push({extensionId, hook});
        aiHooks.set(name, list);
      }
    };
    const removeExtensionAIHooks = extensionId => {
      for (const [name, list] of aiHooks) {
        const next = list.filter(x => x.extensionId !== extensionId);
        if (next.length) aiHooks.set(name, next); else aiHooks.delete(name);
      }
    };
    const notify = () => {
      listeners.forEach(fn => { try { fn(api.list()); } catch (_) {} });
      try {
        for (const g of state.workbench?.groups?.values?.() || []) {
          const active = g.tabs.find(t => t.id === g.active);
          if (active?.kind === 'builtin' && active.builtin === 'welcome') state.workbench.activateTab(g, active.id);
        }
      } catch (_) {}
    };
    const api = {
      __nodeEditorAPI: true,
      register(extension) {
        if (!extension || typeof extension !== 'object') throw new TypeError('Extension must be an object.');
        const id = String(extension.id || '').trim();
        if (!id) throw new Error('Extension id is required.');
        removeExtensionAITools(id);
        removeExtensionAIHooks(id);
        const ai = extension.ai && typeof extension.ai === 'object' ? extension.ai : {};
        const entry = {
          id,
          name: String(extension.name || id),
          description: String(extension.description || ''),
          icon: String(extension.icon || ''),
          open: typeof extension.open === 'function' ? extension.open : null,
          ai: {tools:Array.isArray(extension.aiTools) ? extension.aiTools : (Array.isArray(ai.tools) ? ai.tools : []), hooks:ai.hooks || extension.aiHooks || {}}
        };
        extensions.set(id, entry);
        addExtensionAITools(id, entry.ai.tools);
        addExtensionAIHooks(id, entry.ai.hooks);
        notify();
        return api.createHandle(id);
      },
      unregister(id) {
        const key = String(id);
        removeExtensionAITools(key);
        removeExtensionAIHooks(key);
        const removed = extensions.delete(key);
        if (removed) notify();
        return removed;
      },
      list() {
        return [...extensions.values()].map(x => ({id:x.id,name:x.name,description:x.description,icon:x.icon,ai:{tools:x.ai.tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters,permission:t.permission})),hooks:Object.keys(x.ai.hooks || {})}}));
      },
      get(id) {
        const x = extensions.get(String(id));
        if (!x) return null;
        return {id:x.id,name:x.name,description:x.description,icon:x.icon,open:x.open,ai:{tools:x.ai.tools.map(t=>({...t})),hooks:{...x.ai.hooks}}};
      },
      async open(id) {
        const x = extensions.get(String(id));
        if (!x || typeof x.open !== 'function') return null;
        return await x.open({state, api, extensionId:x.id});
      },
      getAITools() { return [...aiTools.values()].map(x => ({...x})); },
      getAIHooks(name) { return name ? [...(aiHooks.get(String(name)) || [])] : Object.fromEntries([...aiHooks].map(([k,v]) => [k,[...v]])); },
      async runAIHook(name, payload) {
        const hooks = aiHooks.get(String(name)) || [];
        let value = payload;
        for (const entry of hooks) value = await entry.hook(value, {state,api,extensionId:entry.extensionId});
        return value;
      },
      registerAITool(extensionId, tool) {
        const id = String(extensionId || '').trim();
        const clean = normalizeTool(tool, id || 'extension');
        clean.extensionId = id || null;
        aiTools.set(clean.name, clean);
        return clean.name;
      },
      unregisterAITool(name) { return aiTools.delete(String(name)); },
      onChange(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      createHandle(id) {
        const key = String(id);
        return {
          id: key,
          update(patch = {}) {
            const ext = extensions.get(key);
            if (!ext) return false;
            removeExtensionAITools(key);
            removeExtensionAIHooks(key);
            for (const k of ['name','description','icon']) if (patch[k] != null) ext[k] = String(patch[k]);
            if (typeof patch.open === 'function') ext.open = patch.open;
            if (patch.ai || patch.aiTools || patch.aiHooks) {
              const ai = patch.ai && typeof patch.ai === 'object' ? patch.ai : {};
              ext.ai = {
                tools:Array.isArray(patch.aiTools) ? patch.aiTools : (Array.isArray(ai.tools) ? ai.tools : ext.ai.tools || []),
                hooks:ai.hooks || patch.aiHooks || ext.ai.hooks || {}
              };
            }
            addExtensionAITools(key, ext.ai.tools);
            addExtensionAIHooks(key, ext.ai.hooks);
            notify();
            return true;
          },
          open() { return api.open(key); },
          unregister() { return api.unregister(key); }
        };
      }
    };
    window.EditorExtensionAPI = api;
    return api;
  }
  const extensionAPI = installExtensionAPI();

  function openBuiltin(kind, g, options = {}) {
    const wb = g?.ownerWorkbench || state.workbench;
    g = g || wb.getFirstLeaf();
    if (kind === 'group') {
      const t = makeBuiltinTab('group', {groupName: options.groupName ?? options.name});
      wb.addTab(t, g);
      return t;
    }
    if (options.replace) {
      const t = makeBuiltinTab(kind);
      return wb.replaceTab(g, t);
    }
    if (kind === 'welcome') {
      const t = makeBuiltinTab(kind);
      wb.addTab(t, g);
      return t;
    }
    let t = g?.tabs.find(x => x.kind === 'builtin' && x.builtin === kind);
    if (!t) {
      t = makeBuiltinTab(kind);
      wb.addTab(t, g);
    } else wb.activateTab(g, t.id);
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

  const welcomeBuiltins = new Map();

  function addWelcomeBuiltin(kind, label) {
    const key = String(kind || '').trim();
    if (!key) throw new Error('Welcome builtin kind is required.');
    welcomeBuiltins.set(key, String(label || key));
    try {
      for (const g of state.workbench?.groups?.values?.() || []) {
        const active = g.tabs.find(t => t.id === g.active);
        if (active?.kind === 'builtin' && active.builtin === 'welcome') state.workbench.activateTab(g, active.id);
      }
    } catch (_) {}
    return true;
  }

  function removeWelcomeBuiltin(kind) {
    const removed = welcomeBuiltins.delete(String(kind));
    if (removed) {
      try {
        for (const g of state.workbench?.groups?.values?.() || []) {
          const active = g.tabs.find(t => t.id === g.active);
          if (active?.kind === 'builtin' && active.builtin === 'welcome') state.workbench.activateTab(g, active.id);
        }
      } catch (_) {}
    }
    return removed;
  }

  function renderWelcome(g) {
    const div = document.createElement('div');
    div.className = 'builtin-welcome';
    const card = document.createElement('div');
    card.className = 'workbench-empty-card';
    card.innerHTML = '<h2>Welcome</h2><p>Create a new project from the toolbar or open a built-in tool here.</p>';
    const groupCreate = document.createElement('div');
    groupCreate.className = 'welcome-group-create';
    const groupInput = document.createElement('input');
    groupInput.type = 'text';
    groupInput.placeholder = 'Group name';
    groupInput.setAttribute('aria-label', 'Group name');
    const groupButton = document.createElement('button');
    groupButton.textContent = 'Create Group';
    groupButton.disabled = true;
    const syncGroupButton = () => { groupButton.disabled = !groupInput.value.trim(); };
    groupInput.addEventListener('input', syncGroupButton);
    const createGroup = () => {
      const name = groupInput.value.trim();
      if (!name) return;
      openBuiltin('group', g, {groupName:name});
    };
    groupButton.onclick = createGroup;
    groupInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createGroup(); } });
    groupCreate.append(groupInput, groupButton);
    card.appendChild(groupCreate);
    const actions = document.createElement('div');
    actions.className = 'workbench-empty-actions';
    for (const [kind, label] of [['browser', 'Browser'], ['peer', 'Peer Server'], ['terminal', 'Terminal'], ['run', 'Run Configuration'], ['environment', 'Environment Variables'], ['ai', 'AI Chat'], ['github-repository', 'GitHub Repository']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => openBuiltin(kind, g);
      actions.appendChild(b);
    }
    for (const [kind, label] of welcomeBuiltins) {
      if (!window.EditorBuiltinFactories?.[kind]) continue;
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
  function nodeRuntimePath(root, relative) {
    const base = String(root || '/').replace(/^\/+|\/+$/g, '');
    const name = String(relative || '').replace(/^\/+/, '');
    return '/' + [base, name].filter(Boolean).join('/');
  }

  function hasNodeDependencies(fs, root) {
    if (!fs) return false;
    const nodeModulesPath = nodeRuntimePath(root, 'node_modules');
    if (fs.isDirectorySync?.(nodeModulesPath) || fs.existsSync?.(nodeModulesPath)) return true;
    const prefix = nodeModulesPath.replace(/\/+$/, '') + '/';
    try {
      return fs.listFilesSync().some(path => String(path || '').startsWith(prefix));
    } catch (_) {
      return false;
    }
  }

  function nodeDependencyManifest(fs, config) {
    const root = String(config?.rootfolder || '/').replace(/^\/+|\/+$/g, '');
    const packageJson = nodeRuntimePath(root, 'package.json');
    const packageLock = nodeRuntimePath(root, 'package-lock.json');
    return {
      root,
      packageJson,
      packageLock,
      hasPackageJson: !!fs?.existsSync?.(packageJson),
      hasLockfile: !!fs?.existsSync?.(packageLock)
    };
  }

  async function installNodeDependencies(runtime, config) {
    const fs = state.fs;
    const manifest = nodeDependencyManifest(fs, config);
    if (!manifest.hasPackageJson || hasNodeDependencies(fs, manifest.root)) return false;

    let useCi = false;
  if (manifest.hasLockfile) {
    try {
      const lock = JSON.parse(state.fs.readFileSync(manifest.packageLock, 'utf8') || '{}');
      useCi = !!lock?.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages);
    } catch (_) {}
  }
  const command = useCi ? 'npm ci' : 'npm install';
    if (remoteLoadProgress) {
      updateRemoteLoadProgress(
        'Installing Node dependencies…',
        null,
        manifest.hasLockfile ? 'Running npm ci from package-lock.json' : 'Running npm install from package.json'
      );
    }

    await runtime.terminalCommand(command);
    return true;
  }

  async function preloadNodeDependencies() {
    const config = state.runConfig?.config;
    if (!state.fs || config?.serverType !== 'node') return false;

    const manifest = nodeDependencyManifest(state.fs, config);
    if (!manifest.hasPackageJson || hasNodeDependencies(state.fs, manifest.root)) return false;

    let net = state.browserNetwork;
    if (!net) {
      for (const info of state.browserTabs.values()) {
        if (!info?.ready) continue;
        try {
          net = await info.ready;
        } catch (_) {}
        if (net) break;
      }
    }
    if (!net) return false;

    if (remoteLoadProgress) {
      updateRemoteLoadProgress(
        'Installing Node dependencies…',
        null,
        manifest.hasLockfile ? 'Running npm ci from package-lock.json' : 'Running npm install from package.json'
      );
    }

    const emulator = new NodeEmulator({
      domain: String(config.domain || 'http://localhost:3000').replace(/\/+$/, ''),
      rootfolder: manifest.root,
      pathPrefix: config.path || '/',
      filesystem: state.fs,
      fileSystemSync: false,
      network: net,
      cwd: config.cwd || '/',
      env: {
        NODE_ENV: 'development',
        USER: 'browser_user',
        ...state.environment
      }
    });

    try {
      await emulator.ready;
      const installed = await installNodeDependencies(emulator, config);
      if (installed) {
        state.fileManager?.refresh?.();
        updateStatus();
      }
      return installed;
    } finally {
      try { emulator.destroy?.(); } catch (_) {}
    }
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
      try {
        await emulator.ready;
        await installNodeDependencies(emulator, c);
        if (net.replaceRuntimeEndpoint) net.replaceRuntimeEndpoint(emulator.endpoint); else net.prependEndpoint(emulator.endpoint);
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
    for (const g of getAllWorkbenchGroups()) for (const t of g.tabs) {
      if (t.kind !== 'file') continue;
      const hit = isDir ? t.path === oldPath || t.path.startsWith(oldPath + '/') : t.path === oldPath;
      if (!hit) continue;
      const oldId = t.id;
      t.path = isDir ? newPath + t.path.slice(oldPath.length) : newPath;
      t.id = 'file:' + t.path;
      t.title = basename(t.path);
      t.icon = fileIcon(t.path);
      if (g.active === oldId) g.active = t.id;
      state.previews?.dispose?.(t);
      t.model?.dispose?.();
      t.editor?.dispose?.();
      t.model = null;
      t.editor = null;
      t.listener = null;
    }
    state.workbench.rebuild();
    updateStatus();
  }
  function onDelete(path, isDir) {
    for (const g of getAllWorkbenchGroups()) {
      for (const t of [...g.tabs]) {
        if (!g.ownerWorkbench?.groups?.has?.(g.id)) continue;
        if (t.kind !== 'file' || !(t.path === path || isDir && t.path.startsWith(path + '/'))) continue;
        closeWorkbenchTab(t, g);
      }
    }
    updateStatus();
  }
  async function openZipFile(f) {
    showRemoteLoadProgress('Opening local project');
    try {
      updateRemoteLoadProgress('Inspecting project archive…', 8, formatProgressBytes(f?.size || 0) + ' received');
      const flattened = await flattenProjectZip(f);
      updateRemoteLoadProgress('Building workspace…', 90, 'Creating virtual file system');
      const fs = await FileSystem.create(flattened, { sync: false });
      updateRemoteLoadProgress('Starting workspace…', 97, stripZipProjectName(f.name));
      await replaceFileSystem(fs, stripZipProjectName(f.name), true);
      updateRemoteLoadProgress('Local project ready', 100, 'Workspace loaded');
      const modal = remoteLoadProgress?.modal;
      remoteLoadProgress = null;
      setTimeout(() => modal?.remove(), 180);
    } catch (e) {
      failRemoteLoadProgress(e);
      throw e;
    }
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
      const builtin = String(data.builtin || '');
      if (!builtin || (builtin !== 'group' && builtin !== 'welcome' && !window.EditorBuiltinFactories?.[builtin])) return null;
      return makeBuiltinTab(builtin, data);
    }
    return null;
  }
  function restoreWorkspaceLayout(layout) {
    if (!layout?.workbench || !state.workbench.restore) return false;
    const restored = state.workbench.restore(layout.workbench, data => makeLayoutTab(data, state.runConfig?.config?.serverType));
    if (!restored) return false;
    state.sidebarController.restoreCollapsed(layout.collapsedPaths || []);
    state.sidebarController.syncSourceControlActivity?.();
    if (layout.sidebar === 'Source Control' && state.gitEnabled === false) layout.sidebar = 'explorer';
    if (layout.sidebar === 'explorer' || layout.sidebar === 'settings' || layout.sidebar === 'Search' || layout.sidebar === 'Source Control' || layout.sidebar === 'Run and Debug' || layout.sidebar === 'Extensions' || layout.sidebar === 'Profile') {
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
  const TEMPLATE_MANIFEST_URL = 'templates/templates.json';
  let templateCatalogPromise = null;
  async function loadTemplateCatalog() {
    if (!templateCatalogPromise) {
      templateCatalogPromise = fetch(TEMPLATE_MANIFEST_URL, {cache:'no-store'}).then(async response => {
        if (!response.ok) throw new Error(`Failed to load templates (${response.status}).`);
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Template manifest must contain an array.');
        return data.map(item => ({
          title: String(item?.title || '').trim(),
          description: String(item?.description || '').trim(),
          file: String(item?.file || '').trim()
        })).filter(item => item.title && item.file);
      });
    }
    return templateCatalogPromise;
  }
  async function createTemplateProject(template) {
    try {
      const manifestURL = new URL(TEMPLATE_MANIFEST_URL, document.baseURI);
      const fileURL = new URL(template.file, manifestURL).href;
      const response = await fetch(fileURL, {cache:'no-store'});
      if (!response.ok) throw new Error(`Failed to load template "${template.title}" (${response.status}).`);
      const blob = await response.blob();
      const file = new File([blob], basename(template.file) || 'template.zip', {type:'application/zip'});

      updateRemoteLoadProgress('Building workspace…', 90, 'Creating virtual file system');

      const fs = await FileSystem.create(file, {sync:false});

      updateRemoteLoadProgress('Starting workspace…', 97, template.title || 'Workspace');

      const projectId = makeProjectId();
      const projectName = template.title || 'Workspace';

      fs.mkdirSync(EDITOR_DIR);
      fs.writeFileSync(EDITOR_PROJECT_PATH, JSON.stringify({id:projectId, name:projectName}, null, 2));

      await replaceFileSystem(fs, projectName, false, {
        projectId,
        isTemplate: true,
        forceDefaultLayout: true
      });

      updateRemoteLoadProgress('Project ready', 100, 'Workspace created');

      const modal = remoteLoadProgress?.modal;
      remoteLoadProgress = null;

      setTimeout(() => modal?.remove(), 180);
    } catch (e) {
      failRemoteLoadProgress(e);
      throw e;
    }
  }

  async function createStarter(kind, options = {}) {
    const templates = await loadTemplateCatalog();
    const wanted = kind === 'node' ? /node/i : /static/i;
    const template = templates.find(item => wanted.test(item.title)) || templates.find(item => item.title.toLowerCase() === kind);
    if (!template) throw new Error(`No ${kind} template is defined in templates/templates.json.`);
    return await createTemplateProject(template);
  }
  async function newProject() {
    if (!(await confirmWorkspaceSwitch('starting a new project'))) return;
    showProjectChooser({canClose:true});
  }
  function disposeAllWorkbenchTabs() {
    const seen = new Set();
    for (const wb of Workbench.getInstances?.() || []) {
      for (const g of [...(wb.groups?.values?.() || [])]) {
        for (const t of [...(g.tabs || [])]) {
          if (seen.has(t)) continue;
          seen.add(t);
          if (t.builtin === 'group') {
            try { t._groupWorkbench?.dispose?.(); } catch (_) {}
          }
          try { state.previews?.dispose?.(t); } catch (_) {}
          try { t.editor?.dispose?.(); } catch (_) {}
          try { t.model?.dispose?.(); } catch (_) {}
          t.editor = null;
          t.model = null;
        }
      }
    }
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
    disposeAllWorkbenchTabs();
    state.loading = true;
    state.fs = fs;
    state.saveProjectPermission = 'denied';
    state.projectId = options.projectId || null;
    state.projectOwner = options.projectOwner !== false;
    state.gitEnabled = options.gitEnabled !== false;
    state.gitRemote = state.gitEnabled ? (options.gitRemote || null) : null;
    state.deploymentSettings = {thirdParty:false, externalUrl:'', branch:String(state.gitRemote?.branch || '').trim(), commit:'latest', path:'/'};
    state.projectTemplate = !!options.isTemplate;
    state.projectName = name || 'Workspace';
    state.projectKey = state.projectName;
    state.dirty = false;
    state.lastSavedAt = 0;
    state.lastCachedAt = 0;
    loadEditorConfig();
    state.runConfig = new EditorRunConfig(state);
    loadProjectMetadata();
    // URL/project metadata can describe the original GitHub source, but a
    // detached remix workspace must not inherit that repository.
    if (options.projectId) state.projectId = String(options.projectId);
    if (options.gitEnabled === false) state.gitRemote = null;
    state.projectOwner = options.projectOwner !== false;
    state.gitEnabled = options.gitEnabled !== false;
    getBuiltin('environment')?.load();
    state.fileManager.setFileSystem(fs);
    state.fileManager.setShowHiddenFolders?.(state.behavior.showHiddenFolders);
    state.fileManager.refresh();
    state.runConfig.detect();
    state.sidebarController?.syncSourceControlActivity?.();
    // Warm Source Control while the remote workspace finishes loading so opening
    // the sidebar does not have to wait for the repository/branch requests.
    if (state.gitRemote?.provider === 'github') void state.sidebarController?.sourceControl?.preload?.();
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
    if (state.runConfig?.config?.serverType === 'node') {
      try {
        await preloadNodeDependencies();
      } catch (e) {
        // Dependency installation is retried by setupRuntime when Run is pressed.
        // Keep the editor usable if npm is temporarily unavailable while loading.
        state.nodeDependenciesError = e;
        console.error('Failed to pre-install Node dependencies:', e);
      }
    }
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
  function stripZipProjectName(name) {
    return String(name || '').replace(/\.zip$/i, '');
  }
  function isZipSource(source) {
    if (!source) return false;
    if (Array.isArray(source)) return source.length === 1 && /\.zip$/i.test(source[0]?.name || '');
    return source.kind === 'file' && /\.zip$/i.test(source.name || '');
  }
  async function importFileSystemSource(source, name) {
    const zipSource = isZipSource(source);
    if (zipSource) {
      // The source picker should disappear before the actual archive-loading progress UI appears.
      closeImportModal();
      showRemoteLoadProgress('Opening local project');
    }
    try {
      let filesystemSource = source;

      if (zipSource) {
        let zipFile = null;
        if (source instanceof File || source instanceof Blob) {
          zipFile = source;
        } else if (Array.isArray(source) && source.length === 1 && source[0] instanceof File) {
          zipFile = source[0];
        } else if (source instanceof FileSystemFileHandle) {
          zipFile = await source.getFile();
        }
        if (zipFile) {
          updateRemoteLoadProgress('Inspecting project archive…', 8, formatProgressBytes(zipFile.size || 0) + ' received');
          filesystemSource = await flattenProjectZip(zipFile);
        }
      }

      if (zipSource) updateRemoteLoadProgress('Building workspace…', 90, 'Creating virtual file system');
      const fs = await FileSystem.create(filesystemSource, {
        sync: false
      });
      const projectName = zipSource ? stripZipProjectName(name) : (name || 'Workspace');
      if (zipSource) updateRemoteLoadProgress('Starting workspace…', 97, projectName || 'Workspace');
      await replaceFileSystem(fs, projectName || 'Workspace', true);
      closeImportModal();
      if (zipSource && remoteLoadProgress) {
        updateRemoteLoadProgress('Local project ready', 100, 'Workspace loaded');
        const modal = remoteLoadProgress.modal;
        remoteLoadProgress = null;
        setTimeout(() => modal.remove(), 180);
      }
    } catch (e) {
      if (zipSource) failRemoteLoadProgress(e);
      logError(e);
    }
  }
  function remoteProjectName(url, fallback = 'Remote Project') {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      let name;
      if (/^(www\.)?github\.com$/i.test(u.hostname) && parts.length >= 2) name = parts[1];
      else name = parts[parts.length - 1];
      name = String(name || fallback).replace(/\.git$/i, '').replace(/\.zip$/i, '');
      return decodeURIComponent(name) || fallback;
    } catch (_) {
      return fallback;
    }
  }
  function githubArchiveCandidates(input) {
    let u;
    try { u = new URL(input); } catch (_) { return []; }
    if (!/^https?:$/i.test(u.protocol) || !/^(www\.)?github\.com$/i.test(u.hostname)) return [];
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return [];
    const owner = parts[0];
    let repo = parts[1].replace(/\.git$/i, '');
    if (!owner || !repo) return [];
    let branch = '';
    if (parts[2] === 'tree' && parts[3]) branch = parts.slice(3).join('/');
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const out = [];
    if (branch) out.push(`https://codeload.github.com/${encodedOwner}/${encodedRepo}/zip/refs/heads/${branch}`);
    out.push(`https://codeload.github.com/${encodedOwner}/${encodedRepo}/zip/refs/heads/main`);
    out.push(`https://codeload.github.com/${encodedOwner}/${encodedRepo}/zip/refs/heads/master`);
    return [...new Set(out)];
  }
  function githubRepositoryFromUrl(input) {
    let u;
    try { u = new URL(input); } catch (_) { return null; }
    if (!/^https?:$/i.test(u.protocol) || !/^(www\.)?github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    let branch = '';
    if (parts[2] === 'tree' && parts[3]) branch = parts.slice(3).join('/');
    if (!owner || !repo) return null;
    return {owner, repo, branch};
  }
  function remoteProjectCandidates(input) {
    const raw = String(input || '').trim();
    if (!raw) return [];
    let url;
    try {
      url = new URL(raw, document.baseURI);
    } catch (_) {
      return [];
    }
    if (!/^https?:$/i.test(url.protocol)) return [];
    const github = githubArchiveCandidates(raw);
    if (github.length) return github;
    return [url.href];
  }
  let remoteLoadProgress = null;
  function formatProgressBytes(value) {
    const n = Number(value) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  function showRemoteLoadProgress(title = 'Opening remote project') {
    document.getElementById('remoteLoadProgressModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'remoteLoadProgressModal';
    modal.className = 'editor-modal remote-load-progress-modal show';
    modal.innerHTML = `<div class="editor-modal-content remote-load-progress-content">
      <div class="remote-load-progress-title">${escapeHTML(title)}</div>
      <div class="remote-load-progress-stage" data-progress-stage>Starting…</div>
      <div class="remote-load-progress-track"><div class="remote-load-progress-bar indeterminate" data-progress-bar></div></div>
      <div class="remote-load-progress-meta"><span data-progress-detail>Preparing…</span><span data-progress-percent></span></div>
    </div>`;
    document.body.appendChild(modal);
    remoteLoadProgress = {
      modal,
      stage: modal.querySelector('[data-progress-stage]'),
      bar: modal.querySelector('[data-progress-bar]'),
      detail: modal.querySelector('[data-progress-detail]'),
      percent: modal.querySelector('[data-progress-percent]')
    };
    return remoteLoadProgress;
  }
  function updateRemoteLoadProgress(stage, percent = null, detail = '') {
    const p = remoteLoadProgress || showRemoteLoadProgress();
    p.stage.textContent = stage || '';
    p.detail.textContent = detail || '';
    if (percent == null || !Number.isFinite(Number(percent))) {
      p.bar.classList.add('indeterminate');
      p.percent.textContent = '';
      return;
    }
    const value = Math.max(0, Math.min(100, Number(percent)));
    p.bar.classList.remove('indeterminate');
    p.bar.style.width = `${value}%`;
    p.percent.textContent = `${Math.round(value)}%`;
  }
  function finishRemoteLoadProgress() {
    if (!remoteLoadProgress) return;
    updateRemoteLoadProgress('Remote project ready', 100, 'Workspace loaded');
    const modal = remoteLoadProgress.modal;
    const state = remoteLoadProgress;
    remoteLoadProgress = null;
    setTimeout(() => {
      if (state.modal === modal) modal.remove();
      else modal.remove();
    }, 180);
  }
  function failRemoteLoadProgress(error) {
    if (!remoteLoadProgress) return;
    const p = remoteLoadProgress;
    p.stage.textContent = 'Unable to open remote project';
    p.detail.textContent = error?.message || String(error || 'Unknown error');
    p.bar.classList.remove('indeterminate');
    p.bar.style.width = '100%';
    p.bar.style.background = '#a94b4b';
    p.percent.textContent = '';
    const err = document.createElement('div');
    err.className = 'remote-load-progress-error';
    err.textContent = error?.message || String(error || 'Unknown error');
    p.modal.querySelector('.remote-load-progress-content').appendChild(err);
    const modal = p.modal;
    remoteLoadProgress = null;
    setTimeout(() => modal.remove(), 900);
  }
  async function responseToBlobWithEditorProgress(response, startPercent, endPercent, label) {
    const total = Number(response?.headers?.get?.('content-length')) || 0;
    if (!response?.body?.getReader) {
      updateRemoteLoadProgress(label, total ? startPercent : null, total ? `0 B / ${formatProgressBytes(total)}` : 'Receiving archive…');
      const blob = await response.blob();
      updateRemoteLoadProgress(label, endPercent, total ? `${formatProgressBytes(blob.size)} downloaded` : 'Archive downloaded');
      return blob;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    updateRemoteLoadProgress(label, total ? startPercent : null, total ? `0 B / ${formatProgressBytes(total)}` : 'Receiving archive…');
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength || value.length || 0;
      }
      const ratio = total ? received / total : 0;
      const percent = total ? startPercent + (endPercent - startPercent) * ratio : null;
      updateRemoteLoadProgress(label, percent, total ? `${formatProgressBytes(received)} / ${formatProgressBytes(total)}` : `${formatProgressBytes(received)} downloaded`);
    }
    const contentType = response.headers?.get?.('content-type') || 'application/zip';
    const blob = new Blob(chunks, {type: contentType});
    updateRemoteLoadProgress(label, endPercent, total ? `${formatProgressBytes(received)} / ${formatProgressBytes(total)}` : `${formatProgressBytes(received)} downloaded`);
    return blob;
  }

  async function flattenProjectZip(file) {
    if (typeof JSZip === 'undefined') return file;
    updateRemoteLoadProgress('Inspecting project archive…', 60, formatProgressBytes(file?.size || 0) + ' received');
    const zip = await JSZip.loadAsync(file, {
      onUpdate(meta) {
        const pct = 60 + ((Number(meta?.percent) || 0) / 100) * 8;
        const currentFile = meta?.currentFile ? ` — ${meta.currentFile}` : '';
        updateRemoteLoadProgress('Reading project archive…', pct, `${Math.round(Number(meta?.percent) || 0)}%${currentFile}`);
      }
    });
    updateRemoteLoadProgress('Reading project files…', 68, `${Object.keys(zip.files || {}).length} archive entries`);
    const entries = [];
    const topLevels = new Set();
    let hasRootFile = false;

    zip.forEach((relativePath, entry) => {
      const path = relativePath.replace(/^\/+|\/+$/g, '');
      if (!path) return;
      const parts = path.split('/');
      if (parts.length === 1) {
        if (!entry.dir) hasRootFile = true;
        return;
      }
      topLevels.add(parts[0]);
      entries.push({path, entry});
    });

    // Only remove a wrapper when the archive is unambiguously wrapped:
    // no files at the ZIP root, and exactly one top-level folder.
    if (hasRootFile || topLevels.size !== 1 || !entries.length) return file;

    const root = [...topLevels][0];
    if (!entries.some(item => item.path.startsWith(root + '/'))) return file;

    const out = new JSZip();
    for (const item of entries) {
      if (!item.path.startsWith(root + '/')) continue;
      const target = item.path.slice(root.length + 1);
      if (!target) continue;
      if (item.entry.dir) out.folder(target);
      else out.file(target, await item.entry.async('uint8array'));
    }

    updateRemoteLoadProgress('Rebuilding project archive…', 76, 'Removing wrapper folder');
    const blob = await out.generateAsync({type:'blob', streamFiles:true}, meta => {
      const value = 76 + (Number(meta?.percent) || 0) * 0.12;
      updateRemoteLoadProgress('Rebuilding project archive…', value, `${Math.round(Number(meta?.percent) || 0)}%`);
    });
    updateRemoteLoadProgress('Project archive ready…', 88, formatProgressBytes(blob.size));
    return new File([blob], file.name, {type:'application/zip'});
  }
  async function fetchRemoteProject(url) {
    if (!state.browserNetwork?.request) throw new Error('Network is not initialized.');
    showRemoteLoadProgress();
    updateRemoteLoadProgress('Preparing remote project…', 2, url);
    const github = githubRepositoryFromUrl(url);
    if (github && window.GitHubService?.isSignedIn?.()) {
      try {
        const info = await window.GitHubService.getRepository(github.owner, github.repo);
        const branch = github.branch || info.default_branch || 'main';
        updateRemoteLoadProgress('Downloading project archive…', 5, 'GitHub');
        const blob = await window.GitHubService.downloadArchive(github.owner, github.repo, branch, {
          onProgress(received, total) {
            const pct = total ? 5 + (received / total) * 50 : null;
            updateRemoteLoadProgress('Downloading project archive…', pct, total ? `${formatProgressBytes(received)} / ${formatProgressBytes(total)}` : `${formatProgressBytes(received)} downloaded`);
          }
        });
        if (!blob?.size) throw new Error('GitHub returned an empty project archive.');
        const name = info.name || github.repo;
        let file = new File([blob], name + '.zip', {type:'application/zip'});
        file = await flattenProjectZip(file);
        return {file, name, source:`github:${github.owner}/${github.repo}@${branch}`, gitRemote:{provider:'github',owner:github.owner,repo:github.repo,branch}, projectId:`github:${github.owner}/${github.repo}@${branch}`};
      } catch (e) {
        if (e?.status !== 404 && e?.status !== 401) throw e;
      }
    }
    const candidates = remoteProjectCandidates(url);
    if (!candidates.length) throw new Error('Enter a GitHub repository URL or an HTTP(S) URL to a ZIP file.');
    let lastStatus = '';
    for (const candidate of candidates) {
      try {
        const response = await state.browserNetwork.request(candidate, location.origin, {}, 'project-import');
        if (!response) continue;
        if (!response.ok) {
          lastStatus = `${response.status} ${response.statusText || ''}`.trim();
          continue;
        }
        const blob = await responseToBlobWithEditorProgress(response, 5, 55, 'Downloading project archive…');
        if (!blob.size) {
          lastStatus = 'empty response';
          continue;
        }
        const name = remoteProjectName(url);
        let file = new File([blob], name + '.zip', {type:'application/zip'});
        file = await flattenProjectZip(file);
        return {file, name, source: candidate, gitRemote:null, projectId:null};
      } catch (e) {
        lastStatus = e?.message || String(e);
      }
    }
    throw new Error(`Failed to load remote project${lastStatus ? ` (${lastStatus})` : ''}.`);
  }

  function closeRemoteImportModal(options = {}) {
    document.getElementById('remoteImportModal')?.remove();
    if (options.returnToChooser && !document.querySelector('.startup-modal')) {
      showProjectChooser(options.chooserOptions || {}).catch(logError);
    }
  }
  function finishRemoteImport(options = {}) {
    document.getElementById('remoteImportModal')?.remove();
    if (options.returnToChooser) {
      document.querySelectorAll('.startup-modal').forEach(modal => modal.remove());
    }
  }
  async function importRemoteProject(input, options = {}) {
    try {
      // Replace the repository/source chooser with the loading progress UI immediately.
      finishRemoteImport({returnToChooser:options.returnToChooser});
      const remote = await fetchRemoteProject(input);
      updateRemoteLoadProgress('Building workspace…', 90, 'Creating virtual file system');
      const fs = await FileSystem.create(remote.file, {sync:false});
      updateRemoteLoadProgress('Starting workspace…', 97, remote.name || 'Remote Project');
      await replaceFileSystem(fs, remote.name || 'Remote Project', true, {projectId:remote.projectId || undefined, gitRemote:remote.gitRemote || null});
      finishRemoteImport({returnToChooser:options.returnToChooser});
      finishRemoteLoadProgress();
      return true;
    } catch (e) {
      failRemoteLoadProgress(e);
      options.onError?.(e);
      return false;
    }
  }
  async function openGithubRevision(input, revision = '', options = {}) {
    showRemoteLoadProgress();
    const parsed = githubRepositoryFromUrl(input);
    if (!parsed) {
      const error = new Error('Enter a valid GitHub repository URL.');
      failRemoteLoadProgress(error);
      throw error;
    }

    const requestedRevision = String(revision || '').trim();

    // A project owner needs GitHub authentication because opening their project
    // from a project URL is an authenticated editing flow. Non-owners, however,
    // must be able to view the public repository anonymously, just like the
    // "Open Remote Project" URL flow below.
    if (options.projectOwner !== false && !window.GitHubService?.isSignedIn?.()) {
      const github = window.GitHubService;
      if (!github?.startLogin) {
        const error = new Error('Sign in to GitHub to open your project.');
        failRemoteLoadProgress(error);
        throw error;
      }

      const shouldSignIn = window.confirm(
        'This is your project. Please sign in to GitHub to continue.'
      );
      if (!shouldSignIn) {
        const error = new Error('GitHub sign-in is required to open your project.');
        failRemoteLoadProgress(error);
        throw error;
      }

      await new Promise(async (resolve, reject) => {
        let settled = false;
        let unsubscribe = null;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          unsubscribe?.();
          error ? reject(error) : resolve();
        };

        unsubscribe = github.onChange?.(() => {
          if (github.isSignedIn?.()) finish();
        });

        try {
          await github.startLogin();
          if (github.isSignedIn?.()) finish();
        } catch (error) {
          finish(error);
        }
      });
    }

    let info = null;
    if (window.GitHubService?.isSignedIn?.()) {
      try {
        info = await window.GitHubService.getRepository(parsed.owner, parsed.repo);
      } catch (e) {
        if (e?.status !== 404 && e?.status !== 401) throw e;
      }
    }

    const branch = String(options.branch || parsed.branch || info?.default_branch || 'main').trim() || 'main';
    let ref = requestedRevision || branch;

    // "latest" is stored as a symbolic project revision. Resolve it to the
    // current HEAD of the selected branch each time the project is opened.
    if (requestedRevision === 'latest') {
      // Signed-in owners can resolve the symbolic "latest" revision to a SHA,
      // preserving the existing authenticated project behavior. For anonymous
      // non-owner viewers, the public codeload endpoint can resolve the branch
      // directly, so do not make an authenticated API request just to determine
      // its current HEAD.
      if (window.GitHubService?.isSignedIn?.()) {
        let commits = [];
        try {
          commits = await window.GitHubService.listCommits(parsed.owner, parsed.repo, branch, 1) || [];
        } catch (e) {
          if (e?.status !== 404 && e?.status !== 401) throw e;
        }
        if (!commits[0]?.sha) {
          throw new Error(`No commits are available on GitHub branch "${branch}".`);
        }
        ref = commits[0].sha;
      } else {
        ref = branch;
      }
    }

    let blob = null;
    if (window.GitHubService?.isSignedIn?.()) {
      try {
        blob = await window.GitHubService.downloadArchive(parsed.owner, parsed.repo, ref, {
          onProgress(received, total) {
            const pct = total ? 5 + (received / total) * 50 : null;
            updateRemoteLoadProgress(
              'Downloading project archive…',
              pct,
              total ? `${formatProgressBytes(received)} / ${formatProgressBytes(total)}` : `${formatProgressBytes(received)} downloaded`
            );
          }
        });
      } catch (e) {
        if (e?.status !== 404 && e?.status !== 401) throw e;
      }
    }

    if (!blob) {
      if (!state.browserNetwork?.request) throw new Error('Network is not initialized.');
      const codeload = `https://codeload.github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/zip/${encodeURIComponent(ref).replace(/%2F/g, '/')}`;
      const response = await state.browserNetwork.request(codeload, location.origin, {}, 'project-import');
      if (!response?.ok) throw new Error(`GitHub archive download failed (${response?.status || 'no response'}).`);
      blob = await responseToBlobWithEditorProgress(response, 5, 55, 'Downloading project archive…');
    }

    if (!blob?.size) throw new Error('GitHub returned an empty project archive.');
    const name = info?.name || parsed.repo;
    let file = new File([blob], name + '.zip', {type:'application/zip'});
    file = await flattenProjectZip(file);
    updateRemoteLoadProgress('Building workspace…', 90, 'Creating virtual file system');
    const fs = await FileSystem.create(file, {sync:false});
    updateRemoteLoadProgress('Starting workspace…', 97, name || 'Remote Project');

    const projectId = options.projectId || `github:${parsed.owner}/${parsed.repo}@${ref}`;
    await replaceFileSystem(fs, name || 'Remote Project', true, {
      projectId,
      gitEnabled: options.gitEnabled !== false,
      projectOwner: options.projectOwner !== false,
      gitRemote: {
        provider:'github',
        owner:parsed.owner,
        repo:parsed.repo,
        branch,
        revision:requestedRevision === 'latest' ? 'latest' : ref
      }
    });
    finishRemoteImport();
    finishRemoteLoadProgress();
    return true;
  }

  async function openGithubRepository(repo, options = {}) {
    showRemoteLoadProgress();
    const github = window.GitHubService;
    if (!github?.isSignedIn?.()) { failRemoteLoadProgress(new Error('Sign in to GitHub to open a repository.')); throw new Error('Sign in to GitHub to open a repository.'); }
    if (!repo?.owner || !repo?.repo) throw new Error('Invalid GitHub repository.');
    const branch = String(repo.branch || repo.defaultBranch || 'main');
    const info = repo.defaultBranch ? repo : await github.getRepository(repo.owner, repo.repo);
    updateRemoteLoadProgress('Downloading project archive…', 5, 'GitHub');
    const blob = await github.downloadArchive(repo.owner, repo.repo, branch, {
      onProgress(received, total) {
        const pct = total ? 5 + (received / total) * 50 : null;
        updateRemoteLoadProgress('Downloading project archive…', pct, total ? `${formatProgressBytes(received)} / ${formatProgressBytes(total)}` : `${formatProgressBytes(received)} downloaded`);
      }
    });
    if (!blob?.size) throw new Error('GitHub returned an empty project archive.');
    let file = new File([blob], (info.name || repo.repo) + '.zip', {type:'application/zip'});
    file = await flattenProjectZip(file);
    const fs = await FileSystem.create(file, {sync:false});
    const projectId = `github:${repo.owner}/${repo.repo}@${branch}`;
    await replaceFileSystem(fs, info.name || repo.repo || 'Remote Project', true, {projectId, gitRemote:{provider:'github',owner:repo.owner,repo:repo.repo,branch}});
    finishRemoteImport();
    finishRemoteLoadProgress();
    return true;
  }
  async function openRemoteImportModal(options = {}) {
    if (!options.skipGuard && !(await confirmWorkspaceSwitch('opening another workspace'))) return;
    if (document.getElementById('remoteImportModal')) return;
    const modal = document.createElement('div');
    modal.id = 'remoteImportModal';
    modal.className = 'editor-modal';
    modal.innerHTML = `<div class="editor-modal-content remote-import-modal">
    <button class="editor-modal-close" aria-label="Close">×</button>
    <h2>Open Remote Project</h2><p>Open a GitHub repository or enter any HTTP(S) project URL.</p>
    <section class="remote-github-section"><div class="remote-section-heading"><strong>GitHub</strong><span data-github-account></span></div><div data-github-content></div></section>
    <div class="remote-import-divider"><span>or use a remote URL</span></div>
    <section class="remote-url-section"><label class="remote-import-label">Project URL<input class="remote-import-input" type="text" placeholder="https://github.com/user/repository or https://example.com/project.zip" spellcheck="false" autocomplete="off"></label><div class="remote-import-hint">You can use this without signing in. Public GitHub repositories work anonymously; signed-in GitHub users can also open private repositories.</div></section>
    <div class="editor-modal-actions"><button class="remote-import-cancel">Cancel</button><button class="remote-import-open primary" disabled>Open Remote Project</button></div>
  </div>`;
    document.body.appendChild(modal);
    const input = modal.querySelector('.remote-import-input');
    const open = modal.querySelector('.remote-import-open');
    const cancel = modal.querySelector('.remote-import-cancel');
    const githubContent = modal.querySelector('[data-github-content]');
    const githubAccount = modal.querySelector('[data-github-account]');
    let busy = false, repos = [], branches = [], repoLoading = false, branchLoading = false, repoFilter = '';
    let selectedRepo = null, selectedBranch = '';
    const close = () => closeRemoteImportModal({returnToChooser: options.returnToChooser, chooserOptions: options.chooserOptions});
    const showError = e => {
      modal.querySelector('.remote-import-error')?.remove();
      const error = document.createElement('div'); error.className = 'remote-import-error'; error.textContent = e?.message || String(e);
      modal.querySelector('.remote-url-section')?.after(error);
    };
    const setBusy = (value, label = 'Open Remote Project') => {
      busy = !!value;
      open.disabled = busy || !input.value.trim();
      cancel.disabled = busy;
      open.textContent = busy ? label : 'Open Remote Project';
    };
    const updateOpenState = () => {
      open.disabled = busy || !input.value.trim();
    };
    const setProjectUrl = (repo, branch) => {
      if (!repo?.owner || !repo?.repo) return;
      const encodedOwner = encodeURIComponent(String(repo.owner));
      const encodedRepo = encodeURIComponent(String(repo.repo));
      const encodedBranch = branch ? String(branch).split('/').map(part => encodeURIComponent(part)).join('/') : '';
      input.value = `https://github.com/${encodedOwner}/${encodedRepo}${encodedBranch ? `/tree/${encodedBranch}` : ''}`;
      updateOpenState();
    };
    const renderRepoList = () => {
      const list = githubContent.querySelector('[data-github-repos]');
      if (!list) return;
      const filtered = repos.filter(repo => !repoFilter || repo.fullName.toLowerCase().includes(repoFilter.toLowerCase()));
      list.innerHTML = filtered.length ? filtered.map(repo => `<button class="remote-github-repo${selectedRepo?.fullName === repo.fullName ? ' selected' : ''}" data-repo="${encodeURIComponent(repo.fullName)}"><strong>${escapeHTML(repo.name)}</strong><span>${escapeHTML(repo.owner)} · ${repo.private ? 'private' : 'public'} · ${escapeHTML(repo.defaultBranch)}</span></button>`).join('') : '<div class="remote-github-empty">No matching repositories.</div>';
      list.querySelectorAll('[data-repo]').forEach(button => button.onclick = () => selectRepo(decodeURIComponent(button.dataset.repo)));
    };
    const renderBranchState = () => {
      const panel = githubContent.querySelector('[data-github-selection]');
      if (!panel) return;
      const select = panel.querySelector('[data-github-branch]');
      const name = panel.querySelector('[data-selected-repo]');
      name.textContent = selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : '';
      select.disabled = branchLoading || !selectedRepo;
      select.innerHTML = branchLoading ? '<option>Loading branches…</option>' : branches.length ? branches.map(branch => `<option value="${escapeHTML(branch)}" ${branch === selectedBranch ? 'selected' : ''}>${escapeHTML(branch)}</option>`).join('') : '<option value="">No branches found</option>';
      updateOpenState();
    };
    const renderGithub = () => {
      const github = window.GitHubService, user = github?.getUser?.();
      githubAccount.textContent = user ? `@${user.login}` : '';
      if (!github?.isSignedIn?.()) {
        githubContent.innerHTML = '<div class="remote-github-empty">Sign in to browse your GitHub repositories, or use the URL field below without signing in.</div><button class="github-primary-button" data-github-signin>Sign in with GitHub</button>';
        githubContent.querySelector('[data-github-signin]').onclick = async () => {
          const button = githubContent.querySelector('[data-github-signin]'); button.disabled = true; button.textContent = 'Opening GitHub…';
          try { await github.startLogin(); } catch (e) { button.disabled = false; button.textContent = 'Sign in with GitHub'; showError(e); }
        };
        return;
      }
      githubContent.innerHTML = `<div class="remote-github-toolbar"><input data-github-filter type="text" placeholder="Search repositories…" spellcheck="false"><button data-github-refresh title="Refresh repositories">↻</button></div><div class="remote-github-repos" data-github-repos></div><div class="remote-github-selection" data-github-selection><strong>Repository</strong><span data-selected-repo>Select a repository</span><label>Branch<select data-github-branch disabled><option value="">Select a repository first</option></select></label></div><div class="remote-github-actions"><button data-github-new>New repository</button></div><div class="remote-github-create" data-github-create hidden><label>Name<input data-new-name type="text" placeholder="my-game" spellcheck="false"></label><label>Description<input data-new-description type="text" placeholder="Optional"></label><label class="remote-github-private"><input data-new-private type="checkbox"> Private repository</label><div class="remote-github-create-actions"><button data-new-cancel>Cancel</button><button data-new-create class="primary">Create repository</button></div></div>`;
      const filter = githubContent.querySelector('[data-github-filter]');
      filter.value = repoFilter;
      filter.addEventListener('input', e => { repoFilter = e.target.value; renderRepoList(); });
      githubContent.querySelector('[data-github-refresh]').onclick = () => loadRepoList(true);
      githubContent.querySelector('[data-github-branch]').onchange = e => {
        selectedBranch = e.target.value;
        setProjectUrl(selectedRepo, selectedBranch);
      };
      renderRepoList(); renderBranchState();
      const newButton = githubContent.querySelector('[data-github-new]'), createPanel = githubContent.querySelector('[data-github-create]');
      newButton.onclick = () => { createPanel.hidden = !createPanel.hidden; if (!createPanel.hidden) createPanel.querySelector('[data-new-name]').focus(); };
      githubContent.querySelector('[data-new-cancel]').onclick = () => { createPanel.hidden = true; };
      githubContent.querySelector('[data-new-create]').onclick = async () => {
        const name = createPanel.querySelector('[data-new-name]').value.trim(), description = createPanel.querySelector('[data-new-description]').value.trim(), privateRepo = createPanel.querySelector('[data-new-private]').checked;
        if (!name) { createPanel.querySelector('[data-new-name]').focus(); return; }
        const button = createPanel.querySelector('[data-new-create]'); button.disabled = true; button.textContent = 'Creating…';
        try { const created = await github.createRepository({name, description, privateRepo}); await selectRepoObject({owner:created.owner?.login || github.getUser()?.login, repo:created.name, name:created.name, defaultBranch:created.default_branch || 'main'}); createPanel.hidden = true; }
        catch (e) { button.disabled = false; button.textContent = 'Create repository'; showError(e); }
      };
    };
    const selectRepoObject = async repo => {
      if (!repo?.owner || !repo?.repo) { showError(new Error('Invalid GitHub repository.')); return; }
      selectedRepo = repo; selectedBranch = repo.defaultBranch || 'main'; branches = [];
      setProjectUrl(selectedRepo, selectedBranch);
      renderRepoList(); renderBranchState();
      branchLoading = true; renderBranchState();
      try { branches = await window.GitHubService.listBranches(repo.owner, repo.repo); if (!branches.length) branches = [selectedBranch]; if (!branches.includes(selectedBranch)) selectedBranch = branches.includes(repo.defaultBranch) ? repo.defaultBranch : branches[0]; }
      catch (e) { branches = [selectedBranch]; showError(e); }
      finally {
        branchLoading = false;
        setProjectUrl(selectedRepo, selectedBranch);
        renderBranchState();
      }
    };
    const selectRepo = async fullName => {
      const repo = repos.find(x => x.fullName === fullName);
      if (repo) await selectRepoObject({owner:repo.owner, repo:repo.name, name:repo.name, fullName:repo.fullName, defaultBranch:repo.defaultBranch, private:repo.private});
    };
    const loadRepoList = async (force = false) => {
      const github = window.GitHubService; if (!github?.isSignedIn?.() || repoLoading) return;
      repoLoading = true;
      const list = githubContent.querySelector('[data-github-repos]'); if (list) list.innerHTML = '<div class="remote-github-loading">Loading repositories…</div>';
      try { repos = await github.listRepositories(); if (!selectedRepo && repos.length === 1) await selectRepo(repos[0].fullName); else renderRepoList(); }
      catch (e) { if (list) list.innerHTML = `<div class="remote-github-error">${escapeHTML(e?.message || String(e))}</div><button data-github-retry>Retry</button>`; githubContent.querySelector('[data-github-retry]')?.addEventListener('click', () => loadRepoList(true)); }
      finally { repoLoading = false; }
    };
    const unsubscribe = window.GitHubService?.onChange?.(() => { selectedRepo = null; selectedBranch = ''; branches = []; repos = []; repoFilter = ''; renderGithub(); if (window.GitHubService.isSignedIn()) void loadRepoList(); });
    const submit = async () => {
      if (busy) return;
      const value = input.value.trim();
      if (!value) { input.focus(); return; }
      setBusy(true, 'Loading…');
      input.disabled = true;
      modal.querySelector('.remote-import-error')?.remove();
      modal.querySelectorAll('[data-github-content] button,[data-github-content] input,[data-github-content] select').forEach(el => el.disabled = true);
      const ok = await importRemoteProject(value, {onError:showError, returnToChooser:options.returnToChooser, chooserOptions:options.chooserOptions});
      if (!ok) {
        setBusy(false);
        input.disabled = false;
        modal.querySelectorAll('[data-github-content] button,[data-github-content] input,[data-github-content] select').forEach(el => el.disabled = false);
        input.focus();
      }
    };
    const cleanup = () => unsubscribe?.();
    modal.querySelector('.editor-modal-close').onclick = () => { cleanup(); close(); };
    cancel.onclick = () => { cleanup(); close(); };
    open.onclick = submit;
    input.addEventListener('input', () => {
      updateOpenState();
    });
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); cleanup(); close(); } };
    modal.addEventListener('click', e => { if (e.target === modal) { cleanup(); close(); } });
    renderGithub();
    updateOpenState();
    if (window.GitHubService?.isSignedIn?.()) void loadRepoList();
    requestAnimationFrame(() => modal.classList.add('show'));
  }

  async function openImportModal(options = {}) {
    if (!options.skipGuard && !(await confirmWorkspaceSwitch('opening another workspace'))) return;
    if (document.getElementById('importModal')) return;
    const modal = document.createElement('div');
    modal.id = 'importModal';
    modal.className = 'editor-modal';
    modal.innerHTML = `<div class="editor-modal-content import-source-modal">
    <button class="editor-modal-close" aria-label="Close">×</button>
    <h2>Open Local Project</h2><p>Drop a ZIP, files, or a folder here, or choose a source.</p>
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
          if (handle) await importFileSystemSource(handle, stripZipProjectName(handle.name));
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
      if (f) importFileSystemSource(f, stripZipProjectName(f.name));
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
        await importFileSystemSource(onlyZip ? files[0] : files, onlyZip ? stripZipProjectName(files[0].name) : 'Workspace');
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
    const git = record.gitConnected ? ' • Git connected' : '';
    return `<strong>${escapeHTML(record.name)}</strong><span>${type}${time ? ' • ' + time : ''}${git}${record.unsaved ? ' • Unsaved' : ''}</span>`;
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
        lastSavedAt: record.lastSavedAt || 0,
        gitRemote: record.gitConnected ? record.gitRemote : null,
        gitEnabled: record.gitConnected ? true : false
      });
      if (record.gitConnected && state.gitRemote?.provider === 'github') {
        void state.sidebarController?.sourceControl?.preload?.();
      }
      return true;
    } catch (e) {
      logError(e);
      return false;
    }
  }

  async function loadTopCachedRecent() {
    // Recent Projects is the authoritative ordering for the local project
    // cache. Try entries from the top until we find the first cache entry that
    // still exists, so a stale record cannot prevent WK extension startup.
    const records = recentProjects();
    for (const record of records) {
      if (!(await cacheHasProject(record.id))) continue;
      if (await loadCachedRecent(record)) return true;
    }
    return false;
  }
  async function showProjectChooser(options = {}) {
    const canClose = !!options.canClose;
    const modal = document.createElement('div');
    modal.className = 'editor-modal startup-modal';
    modal.innerHTML = `<div class="editor-modal-content startup-content">${canClose ? '<button class="editor-modal-close startup-close" aria-label="Close">×</button>' : ''}<h2>Projects</h2><p>Create a new project, continue working on a recent project, or open a project file.</p><div class="startup-templates" data-templates></div><div class="startup-section"><div class="startup-section-header"><h3>GitHub</h3></div><div class="startup-github" data-startup-github></div></div><div class="startup-section"><div class="startup-section-header"><h3>Recent Projects</h3><button class="startup-clear" data-clear>Clear Cache</button></div><div class="startup-list" data-recent-list></div></div><div class="startup-open-actions"><button data-open>Open Local Project…</button><button data-open-remote>Open Remote Project…</button></div></div>`;
    document.body.appendChild(modal);
    const listEl = modal.querySelector('[data-recent-list]');
    const clearButton = modal.querySelector('[data-clear]');
    const githubEl = modal.querySelector('[data-startup-github]');
    let busy = false;
    const renderGithubStatus = () => {
      const github = window.GitHubService;
      if (!github?.isSignedIn?.()) {
        githubEl.innerHTML = '<span class="startup-github-status">Not signed in</span><button data-startup-github-signin>Sign in with GitHub</button>';
        githubEl.querySelector('[data-startup-github-signin]').onclick = async () => { try { await github.startLogin(); } catch (e) { logError(e); } };
        return;
      }
      const user = github.getUser?.();
      githubEl.innerHTML = `<span class="startup-github-status">Signed in as <strong>@${escapeHTML(user?.login || 'GitHub user')}</strong></span><button data-startup-github-open>Open Remote Project…</button>`;
      githubEl.querySelector('[data-startup-github-open]').onclick = () => openRemoteImportModal({skipGuard:true, returnToChooser:true, chooserOptions:{canClose}}).catch(logError);
    };
    renderGithubStatus();
    const githubUnsubscribe = window.GitHubService?.onChange?.(renderGithubStatus);
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
          githubUnsubscribe?.(); modal.remove();
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
    const templatesEl = modal.querySelector('[data-templates]');
    const renderTemplates = async () => {
      try {
        const templates = await loadTemplateCatalog();
        if (!templates.length) throw new Error('No templates are defined in templates/templates.json.');
        templatesEl.innerHTML = templates.map((item, index) => `<button data-template-index="${index}"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.description)}</span></button>`).join('');
        templatesEl.querySelectorAll('[data-template-index]').forEach(button => button.onclick = async () => {
          if (busy) return;
          const template = templates[Number(button.dataset.templateIndex)];
          if (!template) return;
          busy = true;
          templatesEl.querySelectorAll('button').forEach(b => b.disabled = true);
          try {
            await createTemplateProject(template);
            githubUnsubscribe?.(); modal.remove();
          } catch (e) {
            busy = false;
            templatesEl.querySelectorAll('button').forEach(b => b.disabled = false);
            logError(e);
          }
        });
      } catch (e) {
        templatesEl.innerHTML = `<div class="startup-empty">${escapeHTML(e?.message || e)}</div>`;
      }
    };
    void renderTemplates();
    modal.querySelector('[data-open]').onclick = () => {
      if (busy) return;
      busy = true;
      githubUnsubscribe?.(); modal.remove();
      openImportModal({skipGuard:true, returnToChooser:true, chooserOptions:{canClose}}).catch(logError);
    };
    modal.querySelector('[data-open-remote]').onclick = () => {
      if (busy) return;
      busy = true;
      githubUnsubscribe?.(); modal.remove();
      openRemoteImportModal({skipGuard:true, returnToChooser:true, chooserOptions:{canClose}}).catch(logError);
    };
    if (canClose) {
      modal.querySelector('.startup-close').onclick = () => {
        if (busy) return;
        githubUnsubscribe?.(); modal.remove();
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
    const active = Workbench.getActiveGroup?.();
    const allGroups = getAllWorkbenchGroups();
    const groups = active ? [active, ...allGroups.filter(group => group !== active)] : allGroups;
    let attempts = 0;
    const reveal = () => {
      attempts++;
      for (const g of groups) {
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
      getBrowserSettings: () => ({ ...state.browserSettings }),
      saveBrowserSettings,
      subscribeBrowserSettings: listener => {
        if (typeof listener !== 'function') return () => {};
        browserSettingSubscribers.add(listener);
        return () => browserSettingSubscribers.delete(listener);
      },
      scheduleWorkspaceLayoutSave,
      updateStatus,
      extensionAPI,
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
      onClose: (t, g) => closeWorkbenchTab(t, g)
    });
    state.runConfig = new EditorRunConfig(state);
    $('uploadZipBtn').onclick = () => openImportModal();
    $('loadRemoteBtn').onclick = () => openRemoteImportModal();
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
          if (state.projectOwner === false || !state.projectId) {
            e.preventDefault();
            exportProject();
          }
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
          if (key === 'a') {
            e.preventDefault();
            openBuiltin('ai');
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
  async function loadProjectFromURLParams() {
    const params = new URLSearchParams(location.search);
    const githubURL = params.get('github') || params.get('githubUrl') || '';
    if (!githubURL) return false;
    const gitEnabled = params.get('git') !== '0' && params.get('git') !== 'disabled';
    const projectOwner = params.get('projectOwner') !== '0' && params.get('projectOwner') !== 'false';
    const projectId = params.get('projectId') || undefined;
    if (!(await confirmWorkspaceSwitch('opening the project from the URL'))) return false;
    const commit = params.get('commit') || params.get('sha') || '';
    const branch = params.get('branch') || '';
    try {
      await openGithubRevision(githubURL, commit, {fromURL:true, gitEnabled, projectOwner, projectId, branch});
      return true;
    } catch (e) {
      logError(e);
      return false;
    }
  }

  async function start() {
    startEditorDOMObserver();
    loadBehaviorSettings();
    await window.__workersConfigReady?.catch?.(() => {});
    await window.GitHubService?.init?.();
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
      if (await loadProjectFromURLParams()) return;

      const params = new URLSearchParams(location.search);
      if (params.get('wkExtension') === '1') {
        if (await loadTopCachedRecent()) return;
      }

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
    showSidebar: name => state.sidebarController?.show?.(name),
    openRemoteProject: options => openRemoteImportModal(options),
    getWorkspaceInfo: () => ({
      loading: !!state.loading,
      projectId: state.projectId || null,
      projectName: state.projectName || 'Workspace',
      gitRemote: state.gitRemote ? { ...state.gitRemote } : null,
      gitEnabled: state.gitEnabled !== false,
      projectOwner: state.projectOwner !== false,
      hasGitHubRepository: !!(state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo)
    }),
    getDeploymentPreview: () => {
      if (typeof state.getDeploymentPreview !== 'function') {
        throw new Error('Deployment Preview is not available.');
      }
      return state.getDeploymentPreview();
    },
    addWelcomeBuiltin,
    removeWelcomeBuiltin,
    runConfigured,
    saveProjectNow,
    exportProject,
    logError,
    extensionAPI,
    on: onEditorEvent,
    off: offEditorEvent,
    emit: emitEditorEvent,
    onSidebarChange: listener => onEditorEvent('sidebarChange', listener),
    onTabOpen: listener => onEditorEvent('tabOpen', listener),
    onTabActivate: listener => onEditorEvent('tabActivate', listener),
    onTabClose: listener => onEditorEvent('tabClose', listener),
    onBuiltinRender: listener => onEditorEvent('builtinRender', listener),
    onViewRender: listener => onEditorEvent('viewRender', listener),
    onDOMAdded: listener => onEditorEvent('domAdded', listener),
    onWorkbenchRebuild: listener => onEditorEvent('workbenchRebuild', listener),
    onThemeChange: listener => onEditorEvent('themeChange', listener),
    theme: window.EditorTheme,
    events: { on: onEditorEvent, off: offEditorEvent }
  };
})();

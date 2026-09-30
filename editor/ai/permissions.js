(function() {
  const root = window.EditorAI = window.EditorAI || {};
  const STORAGE_KEY = 'editor.aiPermissions.v1';
  const DEFAULTS = {
    readFiles: 'always', searchFiles: 'always', createFiles: 'ask', modifyFiles: 'ask', deleteFiles: 'ask',
    runCommands: 'ask', runScripts: 'ask', runProject: 'ask', readOutput: 'always',
    readEditor: 'always', modifyEditor: 'ask', browser: 'ask'
  };
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return {...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {})};
    } catch (_) { return {...DEFAULTS}; }
  }
  function save(values) {
    const next = {...DEFAULTS, ...(values || {})};
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (_) {}
    return next;
  }
  class PermissionManager {
    constructor(values) { this.values = {...DEFAULTS, ...(values || load())}; }
    get(name) { return this.values[name] || 'ask'; }
    set(name, value) { this.values[name] = ['always','ask','never'].includes(value) ? value : 'ask'; save(this.values); }
    all() { return {...this.values}; }
    reset() { this.values = {...DEFAULTS}; save(this.values); }
    allows(name) { return this.get(name) === 'always'; }
  }
  root.PermissionManager = PermissionManager;
  root.loadPermissions = load;
  root.savePermissions = save;
  root.permissionDefaults = DEFAULTS;
})();

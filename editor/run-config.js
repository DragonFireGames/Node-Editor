(function () {
  class RunConfig {
    constructor(state) {
      this.state = state;
      this.config = {
        serverType: 'static',
        domain: 'http://localhost:3000/',
        path: '/',
        rootfolder: '/',
        runfile: '/index.html',
        nodeCommand: 'node server.js',
        cwd: '/',
        autoClear: true,
        usePeerServer: false,
        peerLayer: '',
        saveEnvironmentVariables: false
      };
      this.load();
    }
    key() {
      return 'editor.runConfig.' + (this.state.projectKey || 'default');
    }
    load() {
      let v = null;
      try {
        const fs = this.state.fs;
        if (fs?.existsSync('.editor/config.json')) {
          const stored = JSON.parse(fs.readFileSync('.editor/config.json', 'utf8') || '{}');
          if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            // New format: config.json is the run configuration itself.
            v = stored.serverType || stored.domain || stored.rootfolder || stored.nodeCommand ? stored : null;
            // Legacy format: config.json wrapped runConfig/settings/environment together.
            if (stored.runConfig && typeof stored.runConfig === 'object') v = stored.runConfig;
          }
        }
      } catch (e) {}
      if (!v) {
        try {
          v = JSON.parse(localStorage.getItem(this.key()) || 'null');
        } catch (e) {}
      }
      if (v) {
        this.config = {
          ...this.config,
          ...v
        };
        if (v.runPath && !v.runfile) {
          const old = String(v.runPath);
          const i = old.lastIndexOf('/');
          this.config.runfile = i >= 0 ? '/' + old.slice(i + 1) : '/index.html';
          if (!v.rootfolder && i > 0) this.config.rootfolder = '/' + old.slice(0, i).replace(/^\/+/, '');
        }
        if (v.nodeRoot && !v.rootfolder) this.config.rootfolder = v.nodeRoot;
        if (v.runPath && !v.path) this.config.path = '/';
        if (v.mode && !v.serverType) this.config.serverType = v.mode === 'browser' ? 'static' : 'node';
      }
    }
    save() {
      this.state.saveEditorConfig?.();
    }
    normalizeRoot(v) {
      return '/' + String(v || '/').replace(/^\/+|\/+$/g, '');
    }
    normalizeFile(v) {
      return '/' + String(v || '/index.html').replace(/^\/+/, '');
    }
    normalizePath(v) {
      let s = String(v || '/').trim();
      if (!s.startsWith('/')) s = '/' + s;
      return s === '/' ? '/' : s.replace(/\/+$/, '') + '/';
    }
    normalizeDomain(v) {
      let s = String(v || 'http://localhost:3000/').trim();
      if (!(/^[a-z][a-z0-9+.-]*:\/\//i).test(s)) s = 'http://' + s;
      try {
        return new URL(s).origin + '/';
      } catch (e) {
        return 'http://localhost:3000/';
      }
    }
    detect() {
      const fs = this.state.fs;
      if (!fs) return;
      const files = fs.listFilesSync().filter(Boolean);
      let root = this.normalizeRoot(this.config.rootfolder || '/').replace(/^\//, '');

      // The project root comes from Run Configuration. Detection only inspects that root.
      let prefix = root ? root + '/' : '';
      let pkgPath = prefix + 'package.json';
      let pkg = null;
      try {
        if (fs.existsSync(pkgPath)) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8') || '{}');
      } catch (e) {}


      const hasRootIndex = root ? files.includes(root + '/index.html') || files.includes(root + '/index.htm') : files.some(p => (/^index\.(html|htm)$/i).test(p));
      if (this.config.serverType === 'static' && hasRootIndex && (!this.config.runfile || this.config.runfile === '/index.html')) this.config.runfile = '/index.html';

      if (this.config.serverType === 'node' && pkg?.scripts?.start && (!this.config.nodeCommand || this.config.nodeCommand === 'node server.js')) {
        this.config.nodeCommand = 'npm run start';
      } else if (this.config.serverType === 'node' && pkg?.main && !this.config.nodeCommand) {
        this.config.nodeCommand = 'node ' + pkg.main;
      }
      if (!this.config.nodeCommand) {
        const server = prefix + 'server.js', index = prefix + 'index.js';
        if (fs.existsSync(server)) this.config.nodeCommand = 'node ' + server; else if (fs.existsSync(index)) this.config.nodeCommand = 'node ' + index;
      }
      this.state.nodeRoot = this.config.rootfolder.replace(/^\/+/, '');
      this.config.domain = this.normalizeDomain(this.config.domain);
      this.config.path = this.normalizePath(this.config.path);
      this.config.rootfolder = this.normalizeRoot(this.config.rootfolder);
      this.config.runfile = this.normalizeFile(this.config.runfile);
      this.save();
    }
    inferForRoot(root) {
      const value = this.normalizeRoot(root);
      this.config.rootfolder = value;
      this.state.nodeRoot = value.replace(/^\/+/, '');
      const fs = this.state.fs, base = value.replace(/^\//, '').replace(/\/$/, '');
      const html = base ? base + '/index.html' : 'index.html';
      const pub = base ? base + '/public/index.html' : 'public/index.html';
      if (fs?.existsSync(html)) this.config.runfile = '/index.html'; else if (fs?.existsSync(pub)) this.config.runfile = '/public/index.html';
      const pkgPath = base ? base + '/package.json' : 'package.json';
      try {
        if (fs?.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8') || '{}');
          if (pkg.scripts?.start) this.config.nodeCommand = 'npm run start'; else if (pkg.main) this.config.nodeCommand = 'node ' + pkg.main;
        }
      } catch (e) {}
      this.save();
    }
    publicUrl() {
      const d = this.normalizeDomain(this.config.domain).replace(/\/+$/, '');
      const p = this.normalizePath(this.config.path);
      return d + (p === '/' ? '/' : p);
    }
    command() {
      const url = this.publicUrl();
      return this.config.serverType === 'node' ? `Start: ${this.config.nodeCommand || '(configure a server command)'} → ${url}` : `Open: ${url}`;
    }
    bindNetwork(net) {
      this.network = net;
      if (net?.addEventListener && !this._networkListener) {
        this._networkListener = () => this.refreshEndpointList();
        net.addEventListener('endpointschange', this._networkListener);
      }
      this.refreshEndpointList();
    }
    endpointListHtml(list) {
      return list.map(ep => {
        const detail = ep.runtime ? ep.domain || 'Runtime' : ep.proxy || ep.domain || '';
        return `<div class="endpoint-row"><div class="endpoint-name"><span>${ep.index + 1}. ${ep.name}</span><span class="endpoint-status ${ep.enabled ? 'enabled' : 'disabled'}">${ep.enabled ? 'ON' : 'OFF'}</span></div><div class="endpoint-detail">${ep.runtime ? 'Runtime endpoint • ' : ''}${detail || 'Default browser endpoint'}</div></div>`;
      }).join('');
    }
    refreshEndpointList() {
      const el = this.endpointList;
      if (!el) return;
      const net = this.network || this.state.browserNetwork;
      const list = net?.getEndpointInfo ? net.getEndpointInfo() : (net?.endpoints || []).map((ep, index) => ({
        index,
        name: ep?.constructor?.name || 'Endpoint',
        enabled: ep?.enabled !== false,
        runtime: !!ep?.__editorRuntimeEndpoint,
        proxy: ep?.proxy || null,
        domain: ep?.domain || null
      }));
      el.innerHTML = list.length ? this.endpointListHtml(list) : '<div class="endpoint-empty">Browser network is not ready.</div>';
    }
    render(container, runFn) {
      this.detect();
      container.innerHTML = `<h2>Run Configuration</h2><p>Run uses the public URL separately from the files it serves.</p><div class="run-grid">
<label>Server type</label><select id="rc-type"><option value="static">Static Files</option><option value="node">Node Server</option></select>
<label>Domain</label><input id="rc-domain" placeholder="http://localhost:3000/">
<label>Path</label><input id="rc-path" placeholder="/">
<label>Project root</label><input id="rc-root" placeholder="/Project">
<label class="run-node-hideable run-static-only">Run file</label><input class="run-node-hideable run-static-only" id="rc-runfile" placeholder="/index.html">
<label class="run-node-hideable run-node-only">Working directory</label><input class="run-node-hideable run-node-only" id="rc-cwd" placeholder="/">
<label class="run-node-hideable run-node-only">Node command</label><input class="run-node-hideable run-node-only" id="rc-cmd" placeholder="node server.js or npm run start">
<label>Clear terminal</label><input id="rc-clear" type="checkbox">
<div class="run-command"><span id="rc-command"></span></div>
<div class="run-actions"><button class="primary" id="rc-run">Run</button><button id="rc-detect">Detect</button><button id="rc-save">Save</button></div><div class="run-endpoints"><h3>Browser Network Endpoints</h3><div id="rc-endpoints"></div></div></div>`;
      this.endpointList = container.querySelector('#rc-endpoints');
      this.bindNetwork(this.state.browserNetwork);
      const type = container.querySelector('#rc-type'), domain = container.querySelector('#rc-domain'), path = container.querySelector('#rc-path'), root = container.querySelector('#rc-root'), runfile = container.querySelector('#rc-runfile'), cwd = container.querySelector('#rc-cwd'), cmd = container.querySelector('#rc-cmd'), clear = container.querySelector('#rc-clear'), command = container.querySelector('#rc-command');
      type.value = this.config.serverType;
      domain.value = this.config.domain;
      path.value = this.config.path;
      root.value = this.config.rootfolder;
      runfile.value = this.config.runfile;
      cwd.value = this.config.cwd;
      cmd.value = this.config.nodeCommand;
      clear.checked = this.config.autoClear;
      const syncModeVisibility = () => {
        const isNode = type.value === 'node';
        container.querySelectorAll('.run-node-hideable').forEach(el => {
          const nodeOnly = el.classList.contains('run-node-only');
          const staticOnly = el.classList.contains('run-static-only');
          el.hidden = (isNode && staticOnly) || (!isNode && nodeOnly);
        });
        cmd.disabled = !isNode;
      };
      const sync = () => {
        this.config.serverType = type.value;
        this.config.domain = this.normalizeDomain(domain.value);
        this.config.path = this.normalizePath(path.value);
        this.config.rootfolder = this.normalizeRoot(root.value);
        this.config.runfile = this.normalizeFile(runfile.value);
        this.config.cwd = String(cwd.value || '/').trim() || '/';
        this.config.nodeCommand = cmd.value.trim();
        this.config.autoClear = clear.checked;
        this.state.nodeRoot = this.config.rootfolder.replace(/^\/+/, '');
        this.save();
        command.textContent = this.command();
        syncModeVisibility();
      };
      for (const el of [type, domain, path, root, runfile, cwd, cmd, clear]) for (const ev of ['input', 'change']) el.addEventListener(ev, sync);
      container.querySelector('#rc-detect').onclick = () => {
        this.inferForRoot(root.value);
        domain.value = this.config.domain;
        path.value = this.config.path;
        runfile.value = this.config.runfile;
        cwd.value = this.config.cwd;
        cmd.value = this.config.nodeCommand;
        sync();
      };
      container.querySelector('#rc-save').onclick = sync;
      container.querySelector('#rc-run').onclick = () => {
        sync();
        runFn();
      };
      sync();
    }
  }
  window.EditorRunConfig = RunConfig;
})();

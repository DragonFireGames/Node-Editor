(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.RunDebug = function(options) {
    const {state, tree, runConfigured, logError} = options;
    let render = () => {};
    let deployment = {repo:null,branches:[],commits:[],loading:false};
    let commitLoadToken = 0;
    let overrides = {
      thirdParty:null,
      branch:null,
      commit:null,
      usePeerServer:null,
      path:null,
      externalUrl:null,
      hookUrl:null,
      saveEnvironmentVariables:null
    };
    const github = window.GitHubService;

    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[ch]));

    function normalizeEditorPath(value) {
      const raw = String(value ?? '').trim();
      if (!raw) return '/';
      try {
        const url = new URL(raw, state.runConfig?.config?.domain || 'http://localhost:3000/');
        let path = url.pathname || '/';
        if (!path.startsWith('/')) path = '/' + path;
        const suffix = (url.search || '') + (url.hash || '');
        return (path === '/' ? '/' : path.replace(/\/+$/, '')) + suffix;
      } catch (_) {
        let path = raw;
        if (!path.startsWith('/')) path = '/' + path;
        return path === '/' ? '/' : path.replace(/\/+$/, '');
      }
    }

    function editorDomain() {
      const raw = String(state.runConfig?.config?.domain || 'http://localhost:3000/').trim();
      try { return new URL(raw).origin; } catch (_) { return raw.replace(/\/+$/, ''); }
    }

    function editorDeploymentURL(path) {
      const normalized = normalizeEditorPath(path);
      const base = editorDomain().replace(/\/+$/, '');
      return base + (normalized === '/' ? '/' : (normalized.startsWith('/') ? normalized : '/' + normalized));
    }

    function syncRemote() {
      if (state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo) return state.gitRemote;
      const projectId = String(state.projectId || 'workspace');
      try {
        const value = JSON.parse(localStorage.getItem('editor.github.project.' + encodeURIComponent(projectId)) || 'null');
        if (value?.owner && value?.repo) {
          state.gitRemote = {
            provider:'github',
            owner:String(value.owner),
            repo:String(value.repo),
            branch:String(value.branch || 'main')
          };
          state.deploymentSettings = {
            ...(state.deploymentSettings || {}),
            branch:state.deploymentSettings?.branch || state.gitRemote.branch
          };
          state.saveProjectMetadata?.();
        }
      } catch (_) {}
      return state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo
        ? state.gitRemote
        : null;
    }

    function remote() { return syncRemote(); }

    function hookStorageKey() {
      const projectId = String(state.projectId || 'workspace');
      return 'editor.deployment.hook.' + encodeURIComponent(projectId);
    }

    function readLocalHook() {
      try { return String(localStorage.getItem(hookStorageKey()) || '').trim(); } catch (_) { return ''; }
    }

    function savedDeployment() {
      const d = state.deploymentSettings || {};
      return {
        thirdParty: d.thirdParty === true || d.mode === 'third-party',
        path: normalizeEditorPath(d.path || d.url || (state.runConfig?.config?.path || '/')),
        usePeerServer: state.runConfig?.config?.usePeerServer === true,
        branch: String(d.branch || remote()?.branch || ''),
        commit: String(d.commit || 'latest').trim() || 'latest',
        externalUrl: String(d.externalUrl || ''),
        hookUrl: readLocalHook(),
        saveEnvironmentVariables: state.runConfig?.config?.saveEnvironmentVariables === true
      };
    }

    function effective() {
      const saved = savedDeployment();
      return {
        thirdParty: overrides.thirdParty === null ? saved.thirdParty : overrides.thirdParty,
        path: overrides.path === null ? saved.path : overrides.path,
        usePeerServer: overrides.usePeerServer === null ? saved.usePeerServer : overrides.usePeerServer,
        branch: overrides.branch === null ? saved.branch : overrides.branch,
        commit: overrides.commit === null ? saved.commit : overrides.commit,
        externalUrl: overrides.externalUrl === null ? saved.externalUrl : overrides.externalUrl,
        hookUrl: overrides.hookUrl === null ? saved.hookUrl : overrides.hookUrl,
        saveEnvironmentVariables: overrides.saveEnvironmentVariables === null
          ? saved.saveEnvironmentVariables
          : overrides.saveEnvironmentVariables
      };
    }

    function selectedCommit(e) {
      return String(e.commit || 'latest').trim() || 'latest';
    }

    async function resolvePreviewConfig() {
      const e = effective();
      if (e.thirdParty) {
        const externalUrl = String(e.externalUrl || '').trim();
        if (!externalUrl) throw new Error('Set a third-party deployment URL before opening Deployment Preview.');
        try {
          const target = new URL(externalUrl);
          if (!/^https?:$/i.test(target.protocol)) throw new Error();
          return {url:target.href, thirdParty:true};
        } catch (_) {
          throw new Error('The third-party deployment URL is invalid.');
        }
      }
      const r = remote();
      if (!r) throw new Error('Open a GitHub repository before opening Deployment Preview.');
      const branch = String(e.branch || '').trim();
      if (!branch) throw new Error('Select a GitHub branch before opening Deployment Preview.');
      return {
        github: `https://github.com/${r.owner}/${r.repo}`,
        branch,
        commit: selectedCommit(e),
        usePeerServer: e.usePeerServer,
        path: normalizeEditorPath(e.path)
      };
    }

    function deploymentUrl(config) {
      if (config.thirdParty) return config.url;
      const url = new URL('./deployment.html', location.href);
      for (const [key,value] of Object.entries(config)) {
        if (typeof value === 'boolean') url.searchParams.set(key, value ? '1' : '0');
        else url.searchParams.set(key, String(value ?? ''));
      }
      return url.href;
    }

    async function openDeployment() {
      const config = await resolvePreviewConfig();
      window.open(deploymentUrl(config), '_blank', 'noopener');
    }

    function resetOverrides() {
      overrides = {
        thirdParty:null,
        branch:null,
        commit:null,
        usePeerServer:null,
        path:null,
        externalUrl:null,
        hookUrl:null,
        saveEnvironmentVariables:null
      };
    }

    function renderDeployment() {
      const section = tree.querySelector('[data-deployment]');
      if (!section) return;
      const r = remote();
      if (!github?.isSignedIn?.() || !r) {
        section.innerHTML = '';
        return;
      }

      const saved = savedDeployment();
      const e = effective();
      const branch = e.branch || deployment.branches[0] || '';
      const selectedCommit = e.commit;
      const latestLabel = deployment.commits[0]
        ? `Latest — ${esc(deployment.commits[0].message || deployment.commits[0].sha.slice(0, 7))}`
        : 'Latest';

       section.innerHTML = `<div class="run-debug-section-title">Preview Deployment</div>
         <div class="run-debug-field"><label>Preview Deployment</label><select data-deploy-mode><option value="editor" ${e.thirdParty?'':'selected'}>Editor</option><option value="third-party" ${e.thirdParty?'selected':''}>Third Party</option></select></div>
         <div data-deploy-editor-fields>
           <div class="run-debug-field"><label>Branch</label><select data-deploy-branch ${deployment.branches.length ? '' : 'disabled'}><option value="" disabled ${!branch?'selected':''}>${deployment.branches.length ? 'Select branch…' : 'Loading branches…'}</option>${deployment.branches.map(b => `<option value="${esc(b)}" ${b===branch?'selected':''}>${esc(b)}</option>`).join('')}</select></div>
           <div class="run-debug-field"><label>Commit</label><select data-deploy-commit ${deployment.commits.length || selectedCommit ? '' : 'disabled'}><option value="latest" ${selectedCommit === 'latest' || !selectedCommit ? 'selected':''}>${latestLabel}</option>${deployment.commits.map(c => `<option value="${esc(c.sha)}" ${c.sha===selectedCommit?'selected':''}>${esc(c.message || c.sha.slice(0, 12))}</option>`).join('')}</select></div>
           <div class="run-debug-field"><label>Deployment Path</label><input data-deploy-path type="text" value="${esc(e.path || '/')}" placeholder="/" /></div>
           <label class="run-debug-toggle"><input data-deploy-peer type="checkbox" ${e.usePeerServer?'checked':''}> Use peerServer</label>
         </div>
         <div data-deploy-third-fields>
           <div class="run-debug-field"><label>External URL</label><input data-deploy-external-url type="text" value="${esc(e.externalUrl)}" placeholder="https://example.com/" /></div>
           <div class="run-debug-hook-field"><label>Deployment Hook</label><div class="run-debug-hook-row"><input data-deploy-hook type="text" value="${esc(e.hookUrl)}" placeholder="https://example.com/deploy-hook" /><button data-deploy-hook-trigger ${e.hookUrl?'':'disabled'}>Trigger</button></div></div>
         </div>
         <div class="run-debug-deploy-actions"><button data-deploy-save>Save Preview Deployment Settings</button><button data-deploy-open class="primary">Open Preview Deployment</button></div>`;
      const mode = section.querySelector('[data-deploy-mode]');
      const editorFields = section.querySelector('[data-deploy-editor-fields]');
      const thirdFields = section.querySelector('[data-deploy-third-fields]');
      const pathInput = section.querySelector('[data-deploy-path]');
      const externalUrl = section.querySelector('[data-deploy-external-url]');
      const branchInput = section.querySelector('[data-deploy-branch]');
      const commitInput = section.querySelector('[data-deploy-commit]');
      const peer = section.querySelector('[data-deploy-peer]');
      const hook = section.querySelector('[data-deploy-hook]');
      const trigger = section.querySelector('[data-deploy-hook-trigger]');

      const syncModeUI = () => {
        const third = mode.value === 'third-party';
        editorFields.hidden = third;
        thirdFields.hidden = !third;
      };

      syncModeUI();
      mode.onchange = () => {
        overrides.thirdParty = mode.value === 'third-party';
        syncModeUI();
      };
      pathInput.oninput = () => { overrides.path = normalizeEditorPath(pathInput.value); };
      externalUrl.oninput = () => { overrides.externalUrl = externalUrl.value.trim(); };
      branchInput.onchange = async () => {
        overrides.branch = branchInput.value;
        overrides.commit = null;
        await loadCommits(branchInput.value);
        renderDeployment();
      };
      commitInput.onchange = () => { overrides.commit = commitInput.value; };
      if (peer) peer.onchange = () => { overrides.usePeerServer = peer.checked; };
      hook.oninput = () => {
        overrides.hookUrl = hook.value.trim();
        trigger.disabled = !hook.value.trim();
      };

      trigger.onclick = async () => {
        const href = hook.value.trim();
        if (!href) return;
        trigger.disabled = true;
        try {
          await fetch(href, {method:'GET', mode:'no-cors', cache:'no-store'});
          trigger.textContent = 'Triggered';
        } catch (e2) {
          trigger.textContent = 'Failed';
          logError(e2);
        } finally {
          setTimeout(() => {
            trigger.textContent = 'Trigger';
            trigger.disabled = !hook.value.trim();
          }, 1200);
        }
      };

      section.querySelector('[data-deploy-save]').onclick = () => {
        const d = state.deploymentSettings || (state.deploymentSettings = {});
        d.thirdParty = mode.value === 'third-party';
        d.externalUrl = externalUrl.value.trim();
        d.branch = branchInput.value || branch;
        d.commit = commitInput.value || 'latest';
        d.path = normalizeEditorPath(pathInput.value);
        if (state.runConfig?.config) {
          state.runConfig.config.usePeerServer = peer ? peer.checked : false;
          state.runConfig.config.peerLayer = String(state.peerSettings?.layer || state.runConfig.config.peerLayer || 'peer').trim() || 'peer';
        }
        state.saveProjectMetadata?.();
        state.markDirty?.('editor/project.json');
        state.markDirty?.('editor/deployment.json');
        resetOverrides();
        renderDeployment();
      };

      section.querySelector('[data-deploy-open]').onclick = () => {
        openDeployment().catch(logError);
      };
      section.querySelector('[data-deploy-save]').title = 'Save the preview deployment configuration into .editor/deployment.json';
    }

    async function loadBranches() {
      const r = remote();
      if (!r || !github?.isSignedIn?.()) return;
      try {
        deployment.branches = await github.listBranches(r.owner, r.repo);
        if (!deployment.branches.length && r.branch) deployment.branches = [r.branch];
      } catch (e) {
        deployment.branches = r.branch ? [r.branch] : [];
      }
    }

    async function loadCommits(branch) {
      const r = remote();
      const token = ++commitLoadToken;
      if (!r || !branch) {
        deployment.commits = [];
        return;
      }
      const owner = r.owner;
      const repo = r.repo;
      try {
        const commits = await github.listCommits(owner, repo, branch, 30);
        if (token !== commitLoadToken || remote()?.owner !== owner || remote()?.repo !== repo) return;
        deployment.commits = commits;
      } catch (e) {
        if (token === commitLoadToken) deployment.commits = [];
      }
    }

    async function loadDeployment() {
      if (!github?.isSignedIn?.() || !remote()) {
        deployment = {repo:null,branches:[],commits:[],loading:false};
        renderDeployment();
        return;
      }
      deployment.loading = true;
      renderDeployment();
      await loadBranches();
      const branch = effective().branch || deployment.branches[0] || remote()?.branch || '';
      await loadCommits(branch);
      deployment.loading = false;
      renderDeployment();
    }

    function getDeploymentPreview() {
      return resolvePreviewConfig();
    }

    state.getDeploymentPreview = getDeploymentPreview;

    function show() {
      syncRemote();
      tree.classList.remove('activity-collapsed');
      tree.innerHTML = '<div class="run-debug-sidebar"><div class="activity-sidebar-title">Run and Debug</div><div class="run-debug-actions"><button id="sidebar-run" class="primary">Run</button><button id="sidebar-refresh-endpoints">Refresh</button></div><div class="run-debug-section"><div class="run-debug-section-title">Browser Network Endpoints</div><div id="endpoint-list"></div></div><div class="run-debug-section" data-deployment></div></div>';
      const list = tree.querySelector('#endpoint-list');

      render = () => {
        const net = state.browserNetwork;
        const info = net?.getEndpointInfo
          ? net.getEndpointInfo()
          : (net?.endpoints || []).map((ep,index) => ({
              index,
              name:ep?.constructor?.name || 'Endpoint',
              enabled:ep?.enabled !== false,
              runtime:!!ep?.__editorRuntimeEndpoint,
              proxy:ep?.proxy || null,
              domain:ep?.domain || null
            }));
        list.innerHTML = info.length
          ? info.map(ep => {
              const detail = ep.runtime ? ep.domain || 'Runtime' : ep.proxy || ep.domain || '';
              return `<div class="endpoint-row"><div class="endpoint-name"><span>${ep.index+1}. ${ep.name}</span><span class="endpoint-status ${ep.enabled?'enabled':'disabled'}">${ep.enabled?'ON':'OFF'}</span></div><div class="endpoint-detail">${ep.runtime?'Runtime endpoint • ':''}${detail || 'Default browser endpoint'}</div></div>`;
            }).join('')
          : '<div class="endpoint-empty">Browser network is not ready.</div>';
      };

      render();
      renderDeployment();
      void loadDeployment();

      const net = state.browserNetwork;
      if (net?.addEventListener && !tree._endpointListener) {
        const listener = () => render();
        net.addEventListener('endpointschange', listener);
        tree._endpointListener = listener;
      }

      tree.querySelector('#sidebar-refresh-endpoints').onclick = () => {
        render();
        void loadDeployment();
      };
      tree.querySelector('#sidebar-run').onclick = () => runConfigured().catch(logError);
      state.runDebugRefresh = () => {
        render();
        void loadDeployment();
      };
    }

    return {
      show,
      refresh: () => {
        render();
        void loadDeployment();
      }
    };
  };
})();

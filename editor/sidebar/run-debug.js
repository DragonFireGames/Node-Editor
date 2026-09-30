(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.RunDebug = function(options) {
    const {state, tree, runConfigured, logError} = options;
    const github = window.GitHubService;
    let render = () => {};
    let deploymentBusy = false;
    let deploymentBranches = [];
    let deploymentCommits = [];
    let deploymentRepoKey = null;
    function deploymentRepo() {
      const repo = state.gitRepository;
      return repo?.provider === 'github' && repo?.owner && repo?.repo ? repo : null;
    }
    function canDeploy() { return !!(github?.isSignedIn?.() && deploymentRepo()); }
    function deploymentSettings() {
      state.deploymentSettings ||= {branch:state.gitRepository?.branch || 'main', commit:'latest', usePeerNetwork:false};
      state.deploymentSettings.branch = String(state.deploymentSettings.branch || state.gitRepository?.branch || 'main').trim() || 'main';
      state.deploymentSettings.commit = String(state.deploymentSettings.commit || 'latest').trim() || 'latest';
      state.deploymentSettings.usePeerNetwork = !!state.deploymentSettings.usePeerNetwork;
      return state.deploymentSettings;
    }
    function saveDeploymentSettings() { try { state.saveProjectMetadata?.(); } catch (_) {} }
    function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
    function deploymentUrl(branch, commitSha, usePeerNetwork) {
      const repo = deploymentRepo();
      const url = new URL('deployment.html', location.href);
      url.searchParams.set('github', `https://github.com/${repo.owner}/${repo.repo}`);
      url.searchParams.set('branch', branch || repo.branch || 'main');
      url.searchParams.set('commit', commitSha || 'latest');
      url.searchParams.set('usePeerNetwork', usePeerNetwork && state.runConfig?.config?.serverType === 'node' ? 'true' : 'false');
      const config = state.runConfig?.config || {};
      let domain = String(config.domain || 'http://localhost:3000/').trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(domain)) domain = 'http://' + domain;
      try { domain = new URL(domain).origin; } catch (_) { domain = 'http://localhost:3000'; }
      let path = String(config.path || '/').trim() || '/';
      if (!path.startsWith('/')) path = '/' + path;
      url.searchParams.set('url', domain.replace(/\/+$/, '') + (path === '/' ? '/' : path));
      return url.href;
    }
    function renderDeploymentBranches() {
      const select = tree.querySelector('#sidebar-deployment-branch');
      const refreshButton = tree.querySelector('#sidebar-deployment-branch-refresh');
      if (!select) return;
      if (!canDeploy()) {
        select.innerHTML = '<option>Sign in and select a GitHub repository</option>';
        select.disabled = true;
        if (refreshButton) refreshButton.disabled = true;
        return;
      }
      const settings = deploymentSettings();
      const sourceBranch = deploymentRepo()?.branch || 'main';
      if (!settings.branch) settings.branch = sourceBranch;
      const branches = deploymentBranches.length ? deploymentBranches : [settings.branch || sourceBranch];
      const options = branches.map(branch => `<option value="${escapeHTML(branch)}">${escapeHTML(branch)}</option>`);
      select.innerHTML = options.join('');
      if (!branches.includes(settings.branch)) {
        settings.branch = sourceBranch;
        saveDeploymentSettings();
      }
      select.value = settings.branch;
      select.disabled = false;
      if (refreshButton) refreshButton.disabled = false;
    }
    function renderDeploymentCommits() {
      const select = tree.querySelector('#sidebar-deployment-commit');
      const refreshButton = tree.querySelector('#sidebar-deployment-refresh');
      if (!select) return;
      if (!canDeploy()) {
        select.innerHTML = '<option>Sign in and select a GitHub repository</option>';
        select.disabled = true;
        if (refreshButton) refreshButton.disabled = true;
        return;
      }
      const settings = deploymentSettings();
      const options = ['<option value="latest">Latest — selected branch</option>', ...deploymentCommits.map(commit => `<option value="${escapeHTML(commit.sha)}">${escapeHTML(commit.message || '(no message)')} — ${escapeHTML(commit.sha.slice(0, 7))}</option>` )];
      select.innerHTML = options.join('');
      const value = deploymentCommits.some(c => c.sha === settings.commit) ? settings.commit : 'latest';
      if (value !== settings.commit) { settings.commit = value; saveDeploymentSettings(); }
      select.value = value;
      select.disabled = false;
      if (refreshButton) refreshButton.disabled = false;
    }
    async function loadDeploymentBranches() {
      if (!canDeploy()) { deploymentBranches = []; deploymentCommits = []; renderDeploymentBranches(); renderDeploymentCommits(); return; }
      const repo = deploymentRepo();
      const select = tree.querySelector('#sidebar-deployment-branch');
      if (select) { select.disabled = true; select.innerHTML = '<option>Loading branches…</option>'; }
      try {
        deploymentBranches = await github.listBranches(repo.owner, repo.repo);
        if (!deploymentBranches.length) deploymentBranches = [deploymentSettings().branch || repo.branch || 'main'];
        const settings = deploymentSettings();
        if (!deploymentBranches.includes(settings.branch)) { settings.branch = repo.branch || deploymentBranches[0]; saveDeploymentSettings(); }
        renderDeploymentBranches();
        deploymentCommits = [];
        await loadDeploymentCommits();
      } catch (e) {
        deploymentBranches = [];
        if (select) { select.disabled = false; select.innerHTML = `<option value="${escapeHTML(deploymentSettings().branch || repo.branch || 'main')}">${escapeHTML(deploymentSettings().branch || repo.branch || 'main')} — branch list unavailable</option>`; }
        const status = tree.querySelector('#sidebar-deployment-status');
        if (status) { status.textContent = e?.message || String(e); status.classList.add('error'); }
      }
    }
    async function loadDeploymentCommits() {
      if (!canDeploy()) { deploymentCommits = []; renderDeploymentCommits(); return; }
      const repo = deploymentRepo();
      const select = tree.querySelector('#sidebar-deployment-commit');
      if (select) { select.disabled = true; select.innerHTML = '<option>Loading commits…</option>'; }
      try {
        const branch = deploymentSettings().branch || repo.branch || 'main';
        deploymentCommits = await github.listCommits(repo.owner, repo.repo, branch, 50);
        renderDeploymentCommits();
      } catch (e) {
        deploymentCommits = [];
        if (select) { select.disabled = false; select.innerHTML = `<option value="latest">Latest — commit list unavailable</option>`; }
        const status = tree.querySelector('#sidebar-deployment-status');
        if (status) { status.textContent = e?.message || String(e); status.classList.add('error'); }
      }
    }
    async function checkoutDeployment() {
      if (deploymentBusy || !canDeploy()) return;
      const repo = deploymentRepo();
      const settings = deploymentSettings();
      deploymentBusy = true;
      const button = tree.querySelector('#sidebar-checkout-deployment');
      const status = tree.querySelector('#sidebar-deployment-status');
      if (button) { button.disabled = true; button.textContent = 'Preparing…'; }
      if (status) { status.textContent = ''; status.classList.remove('error'); }
      try {
        const branch = settings.branch || repo.branch || 'main';
        let commitSha = settings.commit;
        if (!commitSha || commitSha === 'latest') {
          commitSha = await github.getBranchCommit(repo.owner, repo.repo, branch);
          if (!commitSha) throw new Error(`No commits were found on ${branch}.`);
        }
        const href = deploymentUrl(branch, commitSha, settings.usePeerNetwork);
        const tab = window.open(href, '_blank', 'noopener,noreferrer');
        if (!tab) throw new Error('The deployment tab was blocked by the browser.');
        if (status) status.textContent = `Opened ${commitSha.slice(0, 7)}.`;
      } catch (e) {
        if (status) { status.textContent = e?.message || String(e); status.classList.add('error'); }
        else logError(e);
      } finally {
        deploymentBusy = false;
        const current = tree.querySelector('#sidebar-checkout-deployment');
        if (current) { current.disabled = false; current.textContent = 'Checkout Deployment'; }
      }
    }
    function renderDeploymentControls() {
      const wrap = tree.querySelector('#deployment-controls');
      if (!wrap) return;
      if (!canDeploy()) { wrap.hidden = true; return; }
      wrap.hidden = false;
      const node = state.runConfig?.config?.serverType === 'node';
      const repo = deploymentRepo();
      const repoKey = repo ? `${repo.owner}/${repo.repo}` : null;
      const settings = deploymentSettings();
      if (repoKey && deploymentRepoKey === null) deploymentRepoKey = repoKey;
      else if (repoKey && deploymentRepoKey !== repoKey) {
        settings.branch = repo.branch || 'main';
        settings.commit = 'latest';
        deploymentRepoKey = repoKey;
        deploymentBranches = [];
        deploymentCommits = [];
        saveDeploymentSettings();
      }
      const branchSelect = tree.querySelector('#sidebar-deployment-branch');
      const networkSelect = tree.querySelector('#sidebar-deployment-network');
      if (branchSelect) {
        const sourceBranch = repo?.branch || 'main';
        if (!settings.branch) settings.branch = sourceBranch;
        if (deploymentBranches.length && !deploymentBranches.includes(settings.branch)) { settings.branch = sourceBranch; settings.commit = 'latest'; saveDeploymentSettings(); }
        branchSelect.value = settings.branch;
      }
      if (networkSelect) {
        networkSelect.disabled = !node;
        networkSelect.value = node && settings.usePeerNetwork ? 'peer' : 'local';
        if (!node && settings.usePeerNetwork) { settings.usePeerNetwork = false; saveDeploymentSettings(); }
      }
      renderDeploymentCommits();
    }
    function show() {
      tree.classList.remove('activity-collapsed');
      tree.innerHTML = '<div class="run-debug-sidebar"><div class="activity-sidebar-title">Run and Debug</div><div class="run-debug-actions"><button id="sidebar-run" class="primary">Run</button><button id="sidebar-refresh-endpoints">Refresh</button></div><div id="deployment-controls" class="run-debug-deployment" hidden><div class="run-debug-deployment-title">Deployment</div><div class="run-debug-deployment-row"><select id="sidebar-deployment-branch" aria-label="Deployment branch"><option value="main">main</option></select><button id="sidebar-deployment-branch-refresh" title="Refresh branches">↻</button></div><div class="run-debug-deployment-row"><select id="sidebar-deployment-commit" aria-label="Deployment commit"><option value="latest">Latest — selected branch</option></select><button id="sidebar-deployment-refresh" title="Refresh commits">↻</button></div><div class="run-debug-deployment-row"><label class="run-debug-deployment-label">Network<select id="sidebar-deployment-network" aria-label="Deployment network"><option value="local">Local instance</option><option value="peer">Peer server</option></select></label><button id="sidebar-checkout-deployment">Checkout Deployment</button></div><span id="sidebar-deployment-status" class="run-debug-deployment-status"></span></div><div class="run-debug-section"><div class="run-debug-section-title">Browser Network Endpoints</div><div id="endpoint-list"></div></div></div>';
      const list = tree.querySelector('#endpoint-list');
      render = () => {
        const net = state.browserNetwork;
        const info = net?.getEndpointInfo ? net.getEndpointInfo() : (net?.endpoints || []).map((ep, index) => ({index,name:ep?.constructor?.name || 'Endpoint',enabled:ep?.enabled !== false,runtime:!!ep?.__editorRuntimeEndpoint,proxy:ep?.proxy || null,domain:ep?.domain || null,path:ep?.path || null,rootfolder:ep?.rootfolder || null}));
        if (!info.length) list.innerHTML = '<div class="endpoint-empty">Browser network is not ready.</div>';
        else list.innerHTML = info.map(ep => { const detail = ep.runtime ? ep.domain || 'Runtime' : ep.proxy || ep.domain || ''; return `<div class="endpoint-row"><div class="endpoint-name"><span>${ep.index + 1}. ${ep.name}</span><span class="endpoint-status ${ep.enabled ? 'enabled' : 'disabled'}">${ep.enabled ? 'ON' : 'OFF'}</span></div><div class="endpoint-detail">${ep.runtime ? 'Runtime endpoint • ' : ''}${detail || 'Default browser endpoint'}</div></div>`; }).join('');
      };
      render();
      renderDeploymentControls();
      void loadDeploymentBranches();
      const net = state.browserNetwork;
      if (net?.addEventListener && !tree._endpointListener) { const listener = () => render(); net.addEventListener('endpointschange', listener); tree._endpointListener = listener; }
      tree.querySelector('#sidebar-refresh-endpoints').onclick = render;
      tree.querySelector('#sidebar-run').onclick = () => runConfigured().catch(logError);
      tree.querySelector('#sidebar-checkout-deployment').onclick = () => void checkoutDeployment();
      tree.querySelector('#sidebar-deployment-branch-refresh').onclick = () => void loadDeploymentBranches();
      tree.querySelector('#sidebar-deployment-refresh').onclick = () => void loadDeploymentCommits();
      tree.querySelector('#sidebar-deployment-branch').onchange = e => { deploymentSettings().branch = e.target.value || deploymentRepo()?.branch || 'main'; deploymentSettings().commit = 'latest'; saveDeploymentSettings(); deploymentCommits = []; renderDeploymentCommits(); void loadDeploymentCommits(); };
      tree.querySelector('#sidebar-deployment-commit').onchange = e => { deploymentSettings().commit = e.target.value || 'latest'; saveDeploymentSettings(); };
      tree.querySelector('#sidebar-deployment-network').onchange = e => { deploymentSettings().usePeerNetwork = e.target.value === 'peer'; saveDeploymentSettings(); };
      if (github?.onChange && !tree._githubListener) tree._githubListener = github.onChange(() => { renderDeploymentControls(); void loadDeploymentBranches(); });
      if (!tree._gitSelectionListener) { tree._gitSelectionListener = () => { renderDeploymentControls(); void loadDeploymentBranches(); }; window.addEventListener('editor-git-selection-changed', tree._gitSelectionListener); }
      if (!tree._gitBranchListener) { tree._gitBranchListener = () => { if (!deploymentRepoKey && deploymentRepo()) deploymentRepoKey = `${deploymentRepo().owner}/${deploymentRepo().repo}`; deploymentCommits = []; renderDeploymentControls(); if (deploymentBranches.includes(deploymentSettings().branch)) void loadDeploymentCommits(); }; window.addEventListener('editor-git-branch-changed', tree._gitBranchListener); }
      state.runDebugRefresh = render;
    }
    return {show, refresh: () => { render(); renderDeploymentControls(); }};
  };
})();

(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.RunDebug = function(options) {
    const {state, tree, runConfigured, logError} = options;
    const github = window.GitHubService;
    let renderEndpoints = () => {};
    let deploymentCommits = [];
    let deploymentBranches = [];
    let deploymentLoading = false;

    function esc(value) { return String(value ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\':'&#39;'}[ch])); }
    function isGitProject() { return github?.isSignedIn?.() && state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo; }
    function deploymentState() {
      state.deployment ||= {branch:'', commit:'latest', usePeerNetwork:false};
      if (!state.deployment.commit) state.deployment.commit = 'latest';
      return state.deployment;
    }
    function saveDeployment() { state.saveProjectMetadata?.(); state.markDirty?.('editor/project.json'); }
    function currentRunUrl() { return state.runConfig?.publicUrl?.() || '/'; }
    function openDeployment() {
      const d = deploymentState();
      if (!isGitProject()) return;
      const owner = encodeURIComponent(state.gitRemote.owner), repo = encodeURIComponent(state.gitRemote.repo);
      const url = new URL('deployment.html', location.href);
      url.searchParams.set('github', `https://github.com/${state.gitRemote.owner}/${state.gitRemote.repo}`);
      url.searchParams.set('branch', d.branch || state.gitRemote.branch || 'main');
      url.searchParams.set('commit', d.commit || 'latest');
      url.searchParams.set('usePeerNetwork', d.usePeerNetwork ? 'true' : 'false');
      url.searchParams.set('url', currentRunUrl());
      window.open(url.href, '_blank', 'noopener');
    }
    function deploymentHTML() {
      if (!isGitProject()) return '';
      const d = deploymentState();
      const branch = d.branch || state.gitRemote.branch || 'main';
      const commit = d.commit || 'latest';
      const options = deploymentBranches.length ? deploymentBranches : [branch];
      return `<div class="run-debug-section deployment-debug-section"><div class="run-debug-section-title">Deployment</div><label class="run-debug-field">Branch<select data-deploy-branch ${deploymentLoading && !deploymentBranches.length ? 'disabled' : ''}><option value="">${deploymentLoading && !deploymentBranches.length ? 'Loading branches…' : 'Select branch…'}</option>${options.map(b => `<option value="${esc(b)}" ${b === branch ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></label><label class="run-debug-field">Commit<select data-deploy-commit ${deploymentLoading && !deploymentCommits.length ? 'disabled' : ''}><option value="latest" ${commit === 'latest' ? 'selected' : ''}>Latest — selected branch</option>${deploymentCommits.map(c => `<option value="${esc(c.sha)}" ${c.sha === commit ? 'selected' : ''}>${esc(c.message || '(no message)')} — ${esc(c.sha.slice(0,7))}</option>`).join('')}</select></label><label class="run-debug-field">URL<input data-deploy-url type="text" value="${esc(currentRunUrl())}" readonly></label><label class="run-debug-check"><input data-deploy-peer type="checkbox" ${d.usePeerNetwork ? 'checked' : ''} ${state.runConfig?.config?.serverType === 'node' ? '' : 'disabled'}> Use peer server</label><div class="run-debug-deploy-actions"><button data-deploy-refresh>↻</button><button data-checkout-deployment class="primary">Checkout Deployment</button></div><div data-deploy-status class="run-debug-deploy-status"></div></div>`;
    }
    function render() {
      const net = state.browserNetwork;
      const info = net?.getEndpointInfo ? net.getEndpointInfo() : (net?.endpoints || []).map((ep,index)=>({index,name:ep?.constructor?.name||'Endpoint',enabled:ep?.enabled!==false,runtime:!!ep?.__editorRuntimeEndpoint,proxy:ep?.proxy||null,domain:ep?.domain||null}));
      const list = tree.querySelector('#endpoint-list');
      if (!list) return;
      list.innerHTML = info.length ? info.map(ep => `<div class="endpoint-row"><div class="endpoint-name"><span>${ep.index+1}. ${esc(ep.name)}</span><span class="endpoint-status ${ep.enabled ? 'enabled':'disabled'}">${ep.enabled ? 'ON':'OFF'}</span></div><div class="endpoint-detail">${ep.runtime ? 'Runtime endpoint • ' : ''}${esc(ep.proxy || ep.domain || 'Default browser endpoint')}</div></div>`).join('') : '<div class="endpoint-empty">Browser network is not ready.</div>';
    }
    async function loadDeploymentBranches(force=false) {
      if (!isGitProject() || deploymentLoading && !force) return;
      deploymentLoading = true;
      try {
        const owner=state.gitRemote.owner, repo=state.gitRemote.repo;
        deploymentBranches = await github.listBranches(owner,repo);
        const d=deploymentState();
        if (!d.branch) d.branch = state.gitRemote.branch || deploymentBranches[0] || 'main';
        if (d.branch && deploymentBranches.length && !deploymentBranches.includes(d.branch)) d.branch = deploymentBranches.includes(state.gitRemote.branch) ? state.gitRemote.branch : deploymentBranches[0];
        saveDeployment();
        await loadDeploymentCommits(false);
      } catch(e) { tree.querySelector('[data-deploy-status]')?.replaceChildren(document.createTextNode(e.message||String(e))); }
      finally { deploymentLoading=false; renderDeploymentInPlace(); }
    }
    async function loadDeploymentCommits(force=false) {
      if (!isGitProject()) return;
      const d=deploymentState(); const branch=d.branch || state.gitRemote.branch || 'main';
      try {
        deploymentCommits = await github.listCommits(state.gitRemote.owner,state.gitRemote.repo,branch,50);
        renderDeploymentInPlace();
      } catch(e) { const el=tree.querySelector('[data-deploy-status]'); if(el) el.textContent=e.message||String(e); }
    }
    function renderDeploymentInPlace() {
      const container=tree.querySelector('.deployment-debug-section');
      if (!container) return;
      const old=container.outerHTML;
      const wrapper=document.createElement('div'); wrapper.innerHTML=deploymentHTML(); const fresh=wrapper.firstElementChild; container.replaceWith(fresh); bindDeployment(fresh);
    }
    function bindDeployment(section) {
      if (!section) return;
      const d=deploymentState();
      const branchSelect=section.querySelector('[data-deploy-branch]');
      const commitSelect=section.querySelector('[data-deploy-commit]');
      const peer=section.querySelector('[data-deploy-peer]');
      branchSelect?.addEventListener('change',async e=>{ d.branch=e.target.value || state.gitRemote.branch || 'main'; d.commit='latest'; saveDeployment(); deploymentCommits=[]; await loadDeploymentCommits(); });
      commitSelect?.addEventListener('change',e=>{ d.commit=e.target.value || 'latest'; saveDeployment(); });
      peer?.addEventListener('change',e=>{ d.usePeerNetwork=!!e.target.checked; saveDeployment(); });
      section.querySelector('[data-deploy-refresh]')?.addEventListener('click',()=>loadDeploymentBranches(true));
      section.querySelector('[data-checkout-deployment]')?.addEventListener('click',openDeployment);
    }
    function show() {
      tree.classList.remove('activity-collapsed');
      const canDeploy=isGitProject();
      tree.innerHTML = `<div class="run-debug-sidebar"><div class="activity-sidebar-title">Run and Debug</div><div class="run-debug-actions"><button id="sidebar-run" class="primary">Run</button><button id="sidebar-refresh-endpoints">Refresh</button></div>${canDeploy ? deploymentHTML() : ''}<div class="run-debug-section"><div class="run-debug-section-title">Browser Network Endpoints</div><div id="endpoint-list"></div></div></div>`;
      renderEndpoints=render;
      render();
      bindDeployment(tree.querySelector('.deployment-debug-section'));
      const net=state.browserNetwork;
      if (net?.addEventListener && !tree._endpointListener) { const listener=()=>render(); net.addEventListener('endpointschange',listener); tree._endpointListener=listener; }
      tree.querySelector('#sidebar-refresh-endpoints').onclick=render;
      tree.querySelector('#sidebar-run').onclick=()=>runConfigured().catch(logError);
      if (canDeploy) void loadDeploymentBranches(true);
    }
    return {show, refresh:()=>renderEndpoints()};
  };
})();

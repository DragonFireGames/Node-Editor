(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.RunDebug = function(options) {
    const {state, tree, runConfigured, logError} = options;
    let render = () => {};
    let deployment = {repo:null, branches:[], commits:[], loading:false};
    let overrides = {branch:'', commit:null, usePeerServer:null, url:''};
    const github = window.GitHubService;
    const esc = value => String(value ?? '').replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    function remote() { return state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo ? state.gitRemote : null; }
    function savedDeployment() {
      const d = state.deploymentSettings || {};
      const runUrl = state.runConfig?.publicUrl?.() || 'http://localhost:3000/';
      return {url:String(d.url || runUrl), usePeerServer:!!d.usePeerServer, branch:String(d.branch || remote()?.branch || ''), commit:String(d.commit || '')};
    }
    function effective() {
      const saved = savedDeployment();
      return {url:overrides.url || saved.url, usePeerServer:overrides.usePeerServer === null ? saved.usePeerServer : overrides.usePeerServer, branch:overrides.branch || saved.branch || deployment.branches[0] || remote()?.branch || 'main', commit:overrides.commit === null ? saved.commit : overrides.commit};
    }
    function deploymentUrl() {
      const r = remote();
      if (!r) return '';
      const saved = savedDeployment(), e = effective();
      const url = new URL('deployment.html', location.href);
      url.searchParams.set('github', `https://github.com/${r.owner}/${r.repo}`);
      if (overrides.branch) url.searchParams.set('branch', e.branch);
      if (overrides.commit !== null) url.searchParams.set('commit', overrides.commit || 'latest');
      if (overrides.url && overrides.url !== saved.url) url.searchParams.set('url', e.url);
      if (overrides.usePeerServer !== null && overrides.usePeerServer !== saved.usePeerServer) {
        url.searchParams.set('peerServer', e.usePeerServer ? '1' : '0');
        if (e.usePeerServer) url.searchParams.set('peerLayer', String(state.peerSettings?.layer || 'peer'));
      }
      return url.href;
    }
    function renderDeployment() {
      const section = tree.querySelector('[data-deployment]');
      if (!section) return;
      const r = remote();
      if (!github?.isSignedIn?.() || !r) { section.innerHTML = ''; return; }
      const saved = savedDeployment(), e = effective();
      section.innerHTML = `<div class="run-debug-section-title">Deployment</div>
        <div class="run-debug-field"><label>URL</label><input data-deploy-url type="text" value="${esc(e.url)}" placeholder="${esc(state.runConfig?.publicUrl?.() || 'http://localhost:3000/')}" /></div>
        <div class="run-debug-field"><label>Branch</label><select data-deploy-branch ${deployment.branches.length ? '' : 'disabled'}><option value="">${deployment.branches.length ? 'Latest branch' : 'Loading branches…'}</option>${deployment.branches.map(b => `<option value="${esc(b)}" ${b===e.branch?'selected':''}>${esc(b)}</option>`).join('')}</select></div>
        <div class="run-debug-field"><label>Commit</label><select data-deploy-commit ${deployment.commits.length ? '' : 'disabled'}><option value="" ${!e.commit?'selected':''}>Latest</option>${deployment.commits.map(c => `<option value="${esc(c.sha)}" ${c.sha===e.commit?'selected':''}>${esc(c.message || '(no message)')}</option>`).join('')}</select></div>
        <label class="run-debug-toggle"><input data-deploy-peer type="checkbox" ${e.usePeerServer?'checked':''}> Use peerServer</label>
        <div class="run-debug-deploy-actions"><button data-deploy-save>Save Deployment Settings</button><button data-deploy-open class="primary">Open Deployment</button></div>
        <div class="run-debug-hint">Saved settings affect the normal deployment after this project is committed. The controls above are also manual overrides for previewing another branch, commit, URL, or peerServer mode.</div>`;
      const urlInput=section.querySelector('[data-deploy-url]'), branch=section.querySelector('[data-deploy-branch]'), commit=section.querySelector('[data-deploy-commit]'), peer=section.querySelector('[data-deploy-peer]');
      urlInput.oninput=()=>{overrides.url=urlInput.value.trim();};
      branch.onchange=async()=>{overrides.branch=branch.value; overrides.commit=null; await loadCommits(branch.value); renderDeployment();};
      commit.onchange=()=>{overrides.commit=commit.value;};
      peer.onchange=()=>{overrides.usePeerServer=peer.checked;};
      section.querySelector('[data-deploy-save]').onclick=()=>{
        const d=state.deploymentSettings || (state.deploymentSettings={});
        d.url=urlInput.value.trim() || state.runConfig?.publicUrl?.() || 'http://localhost:3000/';
        d.usePeerServer=peer.checked; d.branch=branch.value || e.branch; d.commit=commit.value || '';
        state.saveProjectMetadata?.(); state.markDirty?.('editor/project.json'); overrides={branch:'',commit:null,usePeerServer:null,url:''}; renderDeployment();
      };
      section.querySelector('[data-deploy-open]').onclick=()=>{ const href=deploymentUrl(); if (href) window.open(href,'_blank','noopener'); };
      const saveButton=section.querySelector('[data-deploy-save]'); saveButton.title='Save the deployment configuration into .editor/project.json';
    }
    async function loadBranches() {
      const r=remote(); if (!r || !github?.isSignedIn?.()) return;
      try { deployment.branches=await github.listBranches(r.owner,r.repo); if (!deployment.branches.length) deployment.branches=[r.branch||'main']; } catch(e) { deployment.branches=[r.branch||'main']; }
    }
    async function loadCommits(branch) {
      const r=remote(); if (!r || !branch) { deployment.commits=[]; return; }
      try { deployment.commits=await github.listCommits(r.owner,r.repo,branch,30); } catch(e) { deployment.commits=[]; }
    }
    async function loadDeployment() {
      if (!github?.isSignedIn?.() || !remote()) { renderDeployment(); return; }
      deployment.loading=true; renderDeployment();
      await loadBranches();
      const branch=overrides.branch || savedDeployment().branch || deployment.branches[0] || remote().branch || 'main';
      if (!overrides.branch) overrides.branch=branch;
      await loadCommits(branch);
      deployment.loading=false; renderDeployment();
    }
    function show() {
      tree.classList.remove('activity-collapsed');
      tree.innerHTML = '<div class="run-debug-sidebar"><div class="activity-sidebar-title">Run and Debug</div><div class="run-debug-actions"><button id="sidebar-run" class="primary">Run</button><button id="sidebar-refresh-endpoints">Refresh</button></div><div class="run-debug-section"><div class="run-debug-section-title">Browser Network Endpoints</div><div id="endpoint-list"></div></div><div class="run-debug-section" data-deployment></div></div>';
      const list = tree.querySelector('#endpoint-list');
      render = () => {
        const net = state.browserNetwork;
        const info = net?.getEndpointInfo ? net.getEndpointInfo() : (net?.endpoints || []).map((ep,index)=>({index,name:ep?.constructor?.name||'Endpoint',enabled:ep?.enabled!==false,runtime:!!ep?.__editorRuntimeEndpoint,proxy:ep?.proxy||null,domain:ep?.domain||null}));
        list.innerHTML=info.length ? info.map(ep=>{const detail=ep.runtime?ep.domain||'Runtime':ep.proxy||ep.domain||'';return `<div class="endpoint-row"><div class="endpoint-name"><span>${ep.index+1}. ${ep.name}</span><span class="endpoint-status ${ep.enabled?'enabled':'disabled'}">${ep.enabled?'ON':'OFF'}</span></div><div class="endpoint-detail">${ep.runtime?'Runtime endpoint • ':''}${detail||'Default browser endpoint'}</div></div>`;}).join('') : '<div class="endpoint-empty">Browser network is not ready.</div>';
      };
      render(); renderDeployment(); void loadDeployment();
      const net=state.browserNetwork;
      if(net?.addEventListener&&!tree._endpointListener){const listener=()=>render();net.addEventListener('endpointschange',listener);tree._endpointListener=listener;}
      tree.querySelector('#sidebar-refresh-endpoints').onclick=()=>{render();void loadDeployment();};
      tree.querySelector('#sidebar-run').onclick=()=>runConfigured().catch(logError);
      state.runDebugRefresh=()=>{render();void loadDeployment();};
    }
    return {show,refresh:()=>{render();void loadDeployment();}};
  };
})();

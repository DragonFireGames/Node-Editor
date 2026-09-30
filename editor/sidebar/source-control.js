(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.SourceControl = function(options) {
    const {tree, state} = options;
    const github = window.GitHubService;
    let repos = [];
    let branches = [];
    let selected = {owner:'', repo:'', branch:'main'};
    let refreshToken = 0;
    let selectionProjectId = null;

    function esc(value) { return String(value ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\':'&#39;'}[ch])); }
    function syncSelection() {
      const current = String(state.projectId || 'workspace');
      if (selectionProjectId === current) return;
      selectionProjectId = current;
      if (state.gitRemote?.provider === 'github' && state.gitRemote.owner && state.gitRemote.repo) {
        selected = {owner:String(state.gitRemote.owner), repo:String(state.gitRemote.repo), branch:String(state.gitRemote.branch || 'main')};
      } else selected = {owner:'', repo:'', branch:'main'};
      branches = [];
    }
    function persistSelection() {
      if (state.gitRemote?.provider === 'github' && selected.owner && selected.repo) {
        state.gitRemote = {provider:'github', owner:selected.owner, repo:selected.repo, branch:selected.branch || 'main'};
        state.saveProjectMetadata?.();
      }
    }
    function isLocalProject() { return !state.gitRemote?.provider; }
    function renderShell() {
      tree.classList.remove('activity-collapsed');
      if (!github?.isSignedIn?.()) {
        tree.innerHTML = '<div class="source-control-sidebar"><div class="source-control-head"><div class="activity-sidebar-title">Source Control</div></div><div class="source-control-empty"><strong>Sign in to GitHub</strong><span>Source Control uses your GitHub account to load repositories and push commits.</span><button data-open-profile>Open Profile</button></div></div>';
        tree.querySelector('[data-open-profile]')?.addEventListener('click', () => state.sidebarController?.show('Profile'));
        return;
      }
      const local = isLocalProject();
      const hasRepo = !!selected.repo;
      tree.innerHTML = `<div class="source-control-sidebar">
        <div class="source-control-head"><div class="activity-sidebar-title">Source Control</div><button data-refresh title="Refresh">↻</button></div>
        ${local ? `<section class="source-control-section"><div class="source-control-section-title">GitHub repository</div><div class="source-control-local-hint">This project is local.</div><button data-create-local-repo class="source-control-create-repo">Create GitHub Repository</button><div class="source-control-create-panel" data-create-panel hidden><label>Repository name<input data-create-name type="text" placeholder="my-game" spellcheck="false"></label><label>Description<input data-create-description type="text" placeholder="Optional"></label><label class="source-control-private"><input data-create-private type="checkbox"> Private repository</label><div class="source-control-create-actions"><button data-create-cancel>Cancel</button><button data-create-confirm class="primary">Create Repository</button></div></div></section>` : ''}
        <section class="source-control-section">
          <div class="source-control-label">Repository <button data-create-repo class="source-control-inline-action">+ New</button></div>
          <div class="source-control-select-row"><select data-repo ${repos.length ? '' : 'disabled'}><option value="">${repos.length ? 'Select repository…' : 'Loading repositories…'}</option>${repos.map(r => `<option value="${esc(r.fullName)}" ${r.fullName === `${selected.owner}/${selected.repo}` ? 'selected' : ''}>${esc(r.fullName)}${r.private ? ' · private' : ''}</option>`).join('')}</select><button data-repo-refresh title="Refresh repositories">↻</button></div>
          <div class="source-control-label">Branch</div>
          <div class="source-control-select-row"><select data-branch ${branches.length ? '' : 'disabled'}><option value="">${branches.length ? 'Select branch…' : (hasRepo ? 'Loading branches…' : 'Select repository first')}</option>${branches.map(b => `<option value="${esc(b)}" ${b === selected.branch ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select><button data-branch-new title="Create branch" ${hasRepo && branches.length ? '' : 'disabled'}>+</button><button data-branch-refresh title="Refresh branches" ${hasRepo ? '' : 'disabled'}>↻</button></div>
          <div class="source-control-branch-status" data-branch-status></div>
        </section>
        ${hasRepo ? `<div class="source-control-create-panel" data-create-panel-remote hidden><label>Repository name<input data-create-name-remote type="text" placeholder="my-game" spellcheck="false"></label><label>Description<input data-create-description-remote type="text" placeholder="Optional"></label><label class="source-control-private"><input data-create-private-remote type="checkbox"> Private repository</label><div class="source-control-create-actions"><button data-create-cancel-remote>Cancel</button><button data-create-confirm-remote class="primary">Create Repository</button></div></div>` : ''}
        ${hasRepo ? `<section class="source-control-section"><div class="source-control-section-title">Changes</div><div data-changes class="source-control-changes"><div class="source-control-loading">Checking working tree…</div></div><textarea data-commit-message placeholder="Commit message" rows="3"></textarea><button class="source-control-commit" data-commit disabled>Commit & Push</button><div data-status class="source-control-status"></div></section><section class="source-control-section"><div class="source-control-section-title">History</div><div data-history class="source-control-history"><div class="source-control-loading">Loading commits…</div></div></section>` : `<div class="source-control-empty"><strong>Select a repository</strong><span>Once a repository is selected, the editor compares this workspace against the selected branch.</span></div>`}
      </div>`;

      tree.querySelector('[data-refresh]')?.addEventListener('click', () => refresh());
      tree.querySelector('[data-repo-refresh]')?.addEventListener('click', () => loadRepositories(true));
      tree.querySelector('[data-branch-refresh]')?.addEventListener('click', () => selected.repo && loadBranches(true));
      const createLocalButton = tree.querySelector('[data-create-local-repo]');
      const createRepoButton = tree.querySelector('[data-create-repo]');
      const createPanel = tree.querySelector('[data-create-panel]');
      const remoteCreatePanel = tree.querySelector('[data-create-panel-remote]');
      const openCreateRepo = () => {
        const panel = createPanel || remoteCreatePanel;
        if (!panel) return;
        panel.hidden = false;
        panel.querySelector('[data-create-name], [data-create-name-remote]')?.focus();
      };
      createLocalButton?.addEventListener('click', openCreateRepo);
      createRepoButton?.addEventListener('click', openCreateRepo);
      remoteCreatePanel?.querySelector('[data-create-cancel-remote]')?.addEventListener('click', () => { remoteCreatePanel.hidden = true; });
      remoteCreatePanel?.querySelector('[data-create-confirm-remote]')?.addEventListener('click', async e => {
        const name = remoteCreatePanel.querySelector('[data-create-name-remote]')?.value.trim();
        const description = remoteCreatePanel.querySelector('[data-create-description-remote]')?.value.trim();
        const privateRepo = !!remoteCreatePanel.querySelector('[data-create-private-remote]')?.checked;
        const button = e.currentTarget;
        if (!name) { remoteCreatePanel.querySelector('[data-create-name-remote]')?.focus(); return; }
        button.disabled = true; button.textContent = 'Creating…';
        try {
          const created = await github.createRepository({name, description, privateRepo, autoInit:false});
          const owner = created?.owner?.login || github.getUser()?.login;
          const repo = created?.name || name;
          const branch = created?.default_branch || 'main';
          if (!owner || !repo) throw new Error('GitHub did not return the new repository details.');
          state.gitRemote = {provider:'github', owner:String(owner), repo:String(repo), branch:String(branch)};
          state.saveProjectMetadata?.();
          selected = {owner:String(owner), repo:String(repo), branch:String(branch)};
          branches = [];
          remoteCreatePanel.hidden = true;
          await loadRepositories(true);
          await loadBranches(true);
          await refreshStatus();
          await loadHistory();
        } catch (e) { button.disabled = false; button.textContent = 'Create Repository'; showStatus(e.message || String(e), true); }
      });
      createPanel?.querySelector('[data-create-cancel]')?.addEventListener('click', () => { createPanel.hidden = true; });
      createPanel?.querySelector('[data-create-confirm]')?.addEventListener('click', async () => {
        const name = createPanel.querySelector('[data-create-name]')?.value.trim();
        const description = createPanel.querySelector('[data-create-description]')?.value.trim();
        const privateRepo = !!createPanel.querySelector('[data-create-private]')?.checked;
        const button = createPanel.querySelector('[data-create-confirm]');
        if (!name) { createPanel.querySelector('[data-create-name]')?.focus(); return; }
        button.disabled = true; button.textContent = 'Creating…';
        try {
          const created = await github.createRepository({name, description, privateRepo, autoInit:false});
          const owner = created?.owner?.login || github.getUser()?.login;
          const repo = created?.name || name;
          const branch = created?.default_branch || 'main';
          if (!owner || !repo) throw new Error('GitHub did not return the new repository details.');
          state.gitRemote = {provider:'github', owner:String(owner), repo:String(repo), branch:String(branch)};
          state.saveProjectMetadata?.();
          selected = {owner:String(owner), repo:String(repo), branch:String(branch)};
          branches = [];
          await loadRepositories(true);
          await loadBranches(true);
          renderShell();
          await refreshStatus();
          await loadHistory();
        } catch (e) { button.disabled = false; button.textContent = 'Create Repository'; showStatus(e.message || String(e), true); }
      });

      tree.querySelector('[data-repo]')?.addEventListener('change', async e => {
        const fullName = e.target.value;
        if (!fullName) {
          selected = {owner:'', repo:'', branch:'main'};
          state.gitRemote = null;
          branches = [];
          state.saveProjectMetadata?.();
          renderShell();
          return;
        }
        const [owner, ...parts] = fullName.split('/');
        selected = {owner, repo:parts.join('/'), branch:repos.find(r => r.fullName === fullName)?.defaultBranch || 'main'};
        state.gitRemote = {provider:'github', owner:selected.owner, repo:selected.repo, branch:selected.branch};
        state.saveProjectMetadata?.();
        branches = [];
        renderShell();
        await loadBranches(true);
        await refreshStatus();
      });
      tree.querySelector('[data-branch]')?.addEventListener('change', async e => {
        const value = e.target.value;
        if (!value) return;
        selected.branch = value;
        persistSelection();
        void refreshStatus(); void loadHistory();
      });
      tree.querySelector('[data-branch-new]')?.addEventListener('click', async e => {
        if (!selected.repo || !selected.owner) return;
        const button = e.currentTarget;
        const status = tree.querySelector('[data-branch-status]');
        const name = prompt(`Create a new branch from ${selected.branch || 'main'}:`);
        if (!name?.trim()) return;
        button.disabled = true;
        if (status) status.textContent = 'Creating branch…';
        try {
          const created = await github.createBranch(selected.owner, selected.repo, selected.branch || 'main', name.trim());
          const newBranch = created?.ref?.split('/').slice(2).join('/') || name.trim();
          selected.branch = newBranch;
          state.gitRemote = {provider:'github', owner:selected.owner, repo:selected.repo, branch:newBranch};
          state.saveProjectMetadata?.();
          branches = [];
          await loadBranches(true);
          await refreshStatus();
          await loadHistory();
        } catch (err) {
          if (status) status.textContent = err.message || String(err);
          showStatus(err.message || String(err), true);
        } finally { button.disabled = false; }
      });
      tree.querySelector('[data-commit]')?.addEventListener('click', () => void commit());
    }
    async function loadRepositories(force=false) {
      if (!github.isSignedIn()) return;
      try {
        syncSelection();
        if (!force && repos.length) return;
        repos = await github.listRepositories();
        if (selected.repo && !repos.some(r => r.fullName === `${selected.owner}/${selected.repo}`)) { selected = {owner:'', repo:'', branch:'main'}; state.gitRemote = null; state.saveProjectMetadata?.(); }
        renderShell();
        if (selected.repo) await loadBranches(false);
      } catch (e) { showStatus(e.message || String(e), true); }
    }
    async function loadBranches(force=false) {
      if (!selected.repo || !selected.owner) return;
      if (!force && branches.length) return;
      try {
        branches = await github.listBranches(selected.owner, selected.repo);
        if (!branches.length && selected.branch) branches = [selected.branch];
        if (branches.length && !branches.includes(selected.branch)) selected.branch = branches[0];
        state.gitRemote = {provider:'github', owner:selected.owner, repo:selected.repo, branch:selected.branch || 'main'};
        state.saveProjectMetadata?.();
        renderShell();
        await refreshStatus();
        await loadHistory();
      } catch (e) { showStatus(e.message || String(e), true); }
    }
    async function refresh() {
      const token = ++refreshToken;
      try {
        if (!github.isSignedIn()) { renderShell(); return; }
        await loadRepositories(true);
        if (token !== refreshToken || !selected.repo) return;
        if (!branches.length) await loadBranches(false);
        await refreshStatus(); await loadHistory();
      } catch (e) { if (token === refreshToken) showStatus(e.message || String(e), true); }
    }
    async function refreshStatus() {
      const changesEl = tree.querySelector('[data-changes]');
      if (!changesEl || !selected.repo || !state.fs) return;
      changesEl.innerHTML = '<div class="source-control-loading">Checking working tree…</div>';
      try {
        const repoInfo = repos.find(r => r.fullName === `${selected.owner}/${selected.repo}`);
        const canPush = repoInfo ? repoInfo.permissions?.push !== false : true;
        const remote = await github.getRemoteState(selected.owner, selected.repo, selected.branch || 'main');
        const changes = await github.compareWorkingTree(state.fs, remote.tree);
        changesEl.innerHTML = changes.length ? changes.map(c => `<div class="source-control-change"><span class="source-control-change-type source-${c.type}">${c.type === 'modified' ? 'M' : c.type === 'added' ? 'A' : 'D'}</span><span>${esc(c.path)}</span></div>`).join('') : '<div class="source-control-clean">No changes</div>';
        const button = tree.querySelector('[data-commit]');
        if (button) { button.disabled = !changes.length || !canPush; button.title = canPush ? '' : 'You do not have push permission for this repository.'; }
        if (!canPush) showStatus('This repository is read-only for your GitHub account.', true); else if (remote.truncated) showStatus('GitHub truncated the remote tree; large repositories may need a more focused sync later.', true); else clearStatus();
      } catch (e) { changesEl.innerHTML = `<div class="source-control-error">${esc(e.message || String(e))}</div>`; tree.querySelector('[data-commit]')?.setAttribute('disabled',''); }
    }
    async function loadHistory() {
      const historyEl = tree.querySelector('[data-history]');
      if (!historyEl || !selected.repo) return;
      historyEl.innerHTML = '<div class="source-control-loading">Loading commits…</div>';
      try {
        const commits = await github.listCommits(selected.owner, selected.repo, selected.branch || 'main', 20);
        historyEl.innerHTML = commits.length ? commits.map(c => `<a class="source-control-commit-row" href="${esc(c.url)}" target="_blank" rel="noopener"><div><strong>${esc(c.message || '(no message)')}</strong><span>${esc(c.author)} · ${c.date ? new Date(c.date).toLocaleString() : ''}</span></div><code>${esc(c.sha.slice(0,7))}</code></a>`).join('') : '<div class="source-control-empty-inline">No commits on this branch.</div>';
      } catch (e) { historyEl.innerHTML = `<div class="source-control-error">${esc(e.message || String(e))}</div>`; }
    }
    async function commit() {
      const button = tree.querySelector('[data-commit]');
      const message = tree.querySelector('[data-commit-message]')?.value || '';
      if (!button || button.disabled) return;
      button.disabled = true; button.textContent = 'Pushing…'; clearStatus();
      try {
        const result = await github.commitAndPush({owner:selected.owner, repo:selected.repo, branch:selected.branch || 'main', message, fs:state.fs});
        if (!result.changed) { showStatus('Nothing to commit.'); return; }
        tree.querySelector('[data-commit-message]').value = '';
        showStatus(`Committed ${result.commitSha.slice(0,7)} and pushed to ${selected.branch || 'main'}.`);
        await refreshStatus(); await loadHistory();
      } catch (e) { showStatus(e.message || String(e), true); await refreshStatus(); }
      finally { button.textContent = 'Commit & Push'; }
    }
    function showStatus(message,error=false) { const el=tree.querySelector('[data-status]'); if(!el)return; el.textContent=message||''; el.classList.toggle('error',!!error); }
    function clearStatus() { showStatus(''); }
    function show() { syncSelection(); renderShell(); void refresh(); }
    return {show, refresh};
  };
})();

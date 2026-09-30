(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.SourceControl = function(options) {
    const {tree, state} = options;
    const github = window.GitHubService;
    const configKey = () => 'editor.github.project.' + encodeURIComponent(state.projectId || 'workspace');
    let repos = [];
    let branches = [];
    let selected = loadConfig();
    let refreshToken = 0;
    let selectionProjectId = null;
    function esc(value) { return String(value ?? '').replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\':'&#39;'}[ch])); }
    function loadConfig() {
      try { const value = JSON.parse(localStorage.getItem(configKey()) || 'null'); if (value?.owner && value?.repo) return {...value}; } catch (_) {}
      return {owner:'', repo:'', branch:'main'};
    }
    function saveConfig() { try { localStorage.setItem(configKey(), JSON.stringify(selected)); } catch (_) {} }
    function syncSelection() {
      const currentProjectId = String(state.projectId || 'workspace');
      if (selectionProjectId === currentProjectId) return;
      selectionProjectId = currentProjectId;
      const remote = state.gitRemote?.provider === 'github' ? state.gitRemote : null;
      if (remote?.owner && remote?.repo) {
        selected = {owner:String(remote.owner), repo:String(remote.repo), branch:String(remote.branch || 'main')};
        saveConfig();
        branches = [];
        return;
      }
      const id = String(state.projectId || '');
      const match = id.match(/^github:([^/]+)\/([^@]+)@(.+)$/);
      if (match) {
        selected = {owner:match[1], repo:match[2], branch:match[3] || 'main'};
        saveConfig();
        branches = [];
        return;
      }
      selected = loadConfig();
    }
    function show() { syncSelection(); renderShell(); void refresh(); }
    function isLocalProject() { return !state.gitRemote?.provider; }
    function setLocalGitRemote(owner, repo, branch = 'main') {
      state.gitRemote = {provider:'github', owner:String(owner), repo:String(repo), branch:String(branch || 'main')};
      try { state.saveProjectMetadata?.(); } catch (_) {}
      selected = {owner:String(owner), repo:String(repo), branch:String(branch || 'main')};
      selectionProjectId = String(state.projectId || 'workspace');
      saveConfig();
    }
    function renderShell() {
      tree.classList.remove('activity-collapsed');
      if (!github?.isSignedIn?.()) {
        tree.innerHTML = `<div class="source-control-sidebar"><div class="activity-sidebar-title">Source Control</div><div class="source-control-empty"><strong>Sign in to GitHub</strong><span>Source Control uses your GitHub account to load repositories and push commits.</span><button data-open-profile>Open Profile</button></div></div>`;
        tree.querySelector('[data-open-profile]')?.addEventListener('click', () => state.sidebarController?.show('Profile'));
        return;
      }
      const localProject = isLocalProject();
      tree.innerHTML = `<div class="source-control-sidebar">
        <div class="source-control-head"><div class="activity-sidebar-title">Source Control</div><button data-refresh title="Refresh">↻</button></div>
        ${localProject ? `<section class="source-control-section"><div class="source-control-section-title">GitHub repository</div><div class="source-control-local-hint">This project is local. Connect it to a new GitHub repository to start tracking and pushing changes.</div><button data-create-local-repo class="source-control-create-repo">Create GitHub Repository</button><div class="source-control-create-panel" data-create-panel hidden><label>Repository name<input data-create-name type="text" placeholder="my-game" spellcheck="false"></label><label>Description<input data-create-description type="text" placeholder="Optional"></label><label class="source-control-private"><input data-create-private type="checkbox"> Private repository</label><div class="source-control-create-actions"><button data-create-cancel>Cancel</button><button data-create-confirm class="primary">Create Repository</button></div></div></section>` : ''}
        <section class="source-control-section">
          <div class="source-control-label">Repository</div>
          <div class="source-control-select-row"><select data-repo ${repos.length ? '' : 'disabled'}><option value="">${repos.length ? 'Select repository…' : 'Loading repositories…'}</option>${repos.map(r => `<option value="${esc(r.fullName)}" ${r.fullName === `${selected.owner}/${selected.repo}` ? 'selected' : ''}>${esc(r.fullName)}${r.private ? ' · private' : ''}</option>`).join('')}</select><button data-repo-refresh title="Refresh repositories">↻</button></div>
          <div class="source-control-select-row"><select data-branch ${branches.length ? '' : 'disabled'}><option value="">${branches.length ? 'Select branch…' : (selected.repo ? 'Loading branches…' : 'Select repository first')}</option>${branches.map(branch => `<option value="${esc(branch)}" ${branch === selected.branch ? 'selected' : ''}>${esc(branch)}</option>`).join('')}</select><button data-branch-refresh title="Refresh branches">↻</button></div>
        </section>
        ${selected.repo ? `<section class="source-control-section"><div class="source-control-section-title">Changes</div><div data-changes class="source-control-changes"><div class="source-control-loading">Checking working tree…</div></div><textarea data-commit-message placeholder="Commit message" rows="3"></textarea><button class="source-control-commit" data-commit disabled>Commit & Push</button><div data-status class="source-control-status"></div></section><section class="source-control-section"><div class="source-control-section-title">History</div><div data-history class="source-control-history"><div class="source-control-loading">Loading commits…</div></div></section>` : `<div class="source-control-empty"><strong>Select a repository</strong><span>Once a repository is selected, the editor compares this workspace against the selected branch.</span></div>`}
      </div>`;
      tree.querySelector('[data-refresh]')?.addEventListener('click', () => refresh());
      const createLocalButton = tree.querySelector('[data-create-local-repo]');
      const createPanel = tree.querySelector('[data-create-panel]');
      createLocalButton?.addEventListener('click', () => { createPanel.hidden = !createPanel.hidden; if (!createPanel.hidden) createPanel.querySelector('[data-create-name]')?.focus(); });
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
          setLocalGitRemote(owner, repo, branch);
          repos = []; branches = [];
          await loadRepositories(true);
          selected = {owner:String(owner), repo:String(repo), branch:String(branch)};
          saveConfig();
          renderShell();
          branches = [String(branch)];
          renderShell();
          await refreshStatus();
          await loadHistory();
        } catch (e) {
          button.disabled = false; button.textContent = 'Create Repository';
          showStatus(e.message || String(e), true);
        }
      });
      tree.querySelector('[data-repo-refresh]')?.addEventListener('click', () => loadRepositories(true));
      tree.querySelector('[data-branch-refresh]')?.addEventListener('click', () => selected.repo && loadBranches(true));
      tree.querySelector('[data-repo]')?.addEventListener('change', async e => {
        const fullName = e.target.value;
        if (!fullName) return;
        const [owner, ...repoParts] = fullName.split('/');
        selected = {owner, repo:repoParts.join('/'), branch:repos.find(r => r.fullName === fullName)?.defaultBranch || 'main'};
        saveConfig();
        branches = [];
        renderShell();
        await loadBranches(false);
        await refreshStatus();
      });
      tree.querySelector('[data-branch]')?.addEventListener('change', e => {
        selected.branch = e.target.value || 'main'; saveConfig(); void refreshStatus(); void loadHistory();
      });
      tree.querySelector('[data-commit]')?.addEventListener('click', () => void commit());
    }
    async function loadRepositories(force = false) {
      if (!github.isSignedIn()) return;
      try {
        syncSelection();
        if (!force && repos.length) return;
        repos = await github.listRepositories();
        if (selected.repo && !repos.some(r => r.fullName === `${selected.owner}/${selected.repo}`)) selected = {owner:'', repo:'', branch:'main'};
        saveConfig();
        renderShell();
        if (selected.repo) await loadBranches(false);
      } catch (e) { showStatus(e.message || String(e), true); }
    }
    async function loadBranches(force = false) {
      if (!selected.repo || !selected.owner) return;
      if (!force && branches.length) return;
      try {
        branches = await github.listBranches(selected.owner, selected.repo);
        if (!branches.length) branches = [selected.branch || 'main'];
        if (!branches.includes(selected.branch)) selected.branch = branches[0];
        saveConfig();
        renderShell();
        await refreshStatus();
        await loadHistory();
      } catch (e) {
        if (e?.status === 409 || e?.status === 404) {
          branches = [selected.branch || 'main'];
          renderShell();
          await refreshStatus();
          await loadHistory();
          return;
        }
        showStatus(e.message || String(e), true);
      }
    }
    async function refresh() {
      const token = ++refreshToken;
      try {
        if (!github.isSignedIn()) { renderShell(); return; }
        await loadRepositories(true);
        if (token !== refreshToken || !selected.repo) return;
        if (!branches.length) await loadBranches(false);
        await refreshStatus();
        await loadHistory();
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
        changesEl.dataset.count = String(changes.length);
        const button = tree.querySelector('[data-commit]');
        if (button) {
          button.disabled = !changes.length || !canPush;
          button.title = canPush ? '' : 'You do not have push permission for this repository.';
        }
        if (!canPush) showStatus('This repository is read-only for your GitHub account.', true);
        else if (remote.truncated) showStatus('GitHub truncated the remote tree; large repositories may need a more focused sync later.', true);
        else clearStatus();
      } catch (e) {
        changesEl.innerHTML = `<div class="source-control-error">${esc(e.message || String(e))}</div>`;
        const button = tree.querySelector('[data-commit]'); if (button) button.disabled = true;
      }
    }
    async function loadHistory() {
      const historyEl = tree.querySelector('[data-history]');
      if (!historyEl || !selected.repo) return;
      historyEl.innerHTML = '<div class="source-control-loading">Loading commits…</div>';
      try {
        const commits = await github.listCommits(selected.owner, selected.repo, selected.branch || 'main', 20);
        historyEl.innerHTML = commits.length ? commits.map(commit => `<a class="source-control-commit-row" href="${esc(commit.url)}" target="_blank" rel="noopener"><div><strong>${esc(commit.message || '(no message)')}</strong><span>${esc(commit.author)} · ${commit.date ? new Date(commit.date).toLocaleString() : ''}</span></div><code>${esc(commit.sha.slice(0, 7))}</code></a>`).join('') : '<div class="source-control-empty-inline">No commits on this branch.</div>';
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
        showStatus(`Committed ${result.commitSha.slice(0, 7)} and pushed to ${selected.branch || 'main'}.`);
        await refreshStatus();
        await loadHistory();
      } catch (e) {
        showStatus(e.message || String(e), true);
        await refreshStatus();
      } finally { button.textContent = 'Commit & Push'; }
    }
    function showStatus(message, error = false) {
      const el = tree.querySelector('[data-status]');
      if (!el) return;
      el.textContent = message || '';
      el.classList.toggle('error', !!error);
    }
    function clearStatus() { showStatus(''); }
    return {show};
  };
})();

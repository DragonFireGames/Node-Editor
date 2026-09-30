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
    function esc(value) { return String(value ?? '').replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\':'&#39;'}[ch])); }
    function loadConfig() {
      try { const value = JSON.parse(localStorage.getItem(configKey()) || 'null'); if (value?.owner && value?.repo) return {...value}; } catch (_) {}
      return {owner:'', repo:'', branch:'main'};
    }
    function saveConfig() { try { localStorage.setItem(configKey(), JSON.stringify(selected)); } catch (_) {} }
    function show() { renderShell(); void refresh(); }
    function renderShell() {
      tree.classList.remove('activity-collapsed');
      if (!github?.isSignedIn?.()) {
        tree.innerHTML = `<div class="source-control-sidebar"><div class="activity-sidebar-title">Source Control</div><div class="source-control-empty"><strong>Sign in to GitHub</strong><span>Source Control uses your GitHub account to load repositories and push commits.</span><button data-open-profile>Open Profile</button></div></div>`;
        tree.querySelector('[data-open-profile]')?.addEventListener('click', () => state.sidebarController?.show('Profile'));
        return;
      }
      tree.innerHTML = `<div class="source-control-sidebar">
        <div class="source-control-head"><div class="activity-sidebar-title">Source Control</div><button data-refresh title="Refresh">↻</button></div>
        <section class="source-control-section">
          <div class="source-control-label">Repository</div>
          <div class="source-control-select-row"><select data-repo ${repos.length ? '' : 'disabled'}><option value="">${repos.length ? 'Select repository…' : 'Loading repositories…'}</option>${repos.map(r => `<option value="${esc(r.fullName)}" ${r.fullName === `${selected.owner}/${selected.repo}` ? 'selected' : ''}>${esc(r.fullName)}${r.private ? ' · private' : ''}</option>`).join('')}</select><button data-repo-refresh title="Refresh repositories">↻</button></div>
          <div class="source-control-select-row"><select data-branch ${branches.length ? '' : 'disabled'}><option value="">${branches.length ? 'Select branch…' : (selected.repo ? 'Loading branches…' : 'Select repository first')}</option>${branches.map(branch => `<option value="${esc(branch)}" ${branch === selected.branch ? 'selected' : ''}>${esc(branch)}</option>`).join('')}${branches.length ? '<option value="__create_branch__">+ Create new branch…</option>' : ''}</select><button data-branch-refresh title="Refresh branches">↻</button></div>
        </section>
        ${selected.repo ? `<section class="source-control-section"><div class="source-control-section-title">Changes</div><div data-changes class="source-control-changes"><div class="source-control-loading">Checking working tree…</div></div><textarea data-commit-message placeholder="Commit message" rows="3"></textarea><button class="source-control-commit" data-commit disabled>Commit & Push</button><div data-status class="source-control-status"></div></section><section class="source-control-section"><div class="source-control-section-title">History</div><div data-history class="source-control-history"><div class="source-control-loading">Loading commits…</div></div></section>` : `<div class="source-control-empty"><strong>Select a repository</strong><span>Once a repository is selected, the editor compares this workspace against the selected branch.</span></div>`}
      </div>`;
      tree.querySelector('[data-refresh]')?.addEventListener('click', () => refresh());
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
      tree.querySelector('[data-branch]')?.addEventListener('change', async e => {
        const value = e.target.value;
        if (value === '__create_branch__') {
          e.target.value = selected.branch || 'main';
          await createBranch();
          return;
        }
        selected.branch = value || 'main'; saveConfig(); void refreshStatus(); void loadHistory();
      });
      tree.querySelector('[data-commit]')?.addEventListener('click', () => void commit());
    }
    async function loadRepositories(force = false) {
      if (!github.isSignedIn()) return;
      try {
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
      } catch (e) { showStatus(e.message || String(e), true); }
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
    async function createBranch() {
      if (!selected.repo) return;
      const base = selected.branch || 'main';
      const name = window.prompt(`Create a new branch from ${base}:`, base === 'main' ? 'feature/' : `${base}-copy`);
      if (name == null) return;
      const branch = String(name).trim();
      if (!branch) return showStatus('Enter a branch name.', true);
      showStatus(`Creating ${branch}…`);
      try {
        await github.createBranch(selected.owner, selected.repo, branch, base);
        branches = [];
        selected.branch = branch;
        saveConfig();
        await loadBranches(true);
        showStatus(`Created branch ${branch}.`);
      } catch (e) {
        showStatus(e.message || String(e), true);
        const select = tree.querySelector('[data-branch]'); if (select) select.value = base;
      }
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

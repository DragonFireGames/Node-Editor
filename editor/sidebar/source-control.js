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
    let branchLoadToken = 0;
    let statusToken = 0;
    let historyToken = 0;
    let commitBusy = false;
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
      if (selected.owner && selected.repo) {
        state.gitRemote = {provider:'github', owner:String(selected.owner), repo:String(selected.repo), branch:String(selected.branch || 'main')};
        state.deploymentSettings = {...(state.deploymentSettings || {}), branch: state.deploymentSettings?.branch || String(selected.branch || 'main')};
        try { state.saveProjectMetadata?.(); } catch (_) {}
      }
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
        ${!selected.repo ? `<section class="source-control-section"><div class="source-control-section-title">GitHub repository</div><div class="source-control-local-hint">No repository is selected. Connect this workspace to a new GitHub repository to start tracking and pushing changes.</div><button data-create-local-repo class="source-control-create-repo">Create GitHub Repository</button><div class="source-control-create-panel" data-create-panel hidden><label>Repository name<input data-create-name type="text" placeholder="my-game" spellcheck="false"></label><label>Description<input data-create-description type="text" placeholder="Optional"></label><label class="source-control-private"><input data-create-private type="checkbox"> Private repository</label><div class="source-control-create-actions"><button data-create-cancel>Cancel</button><button data-create-confirm class="primary">Create Repository</button></div></div></section>` : ''}
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
          // Bind the workspace to the newly-created repository immediately.
          // Do not make the user select the repo/branch again.
          setLocalGitRemote(owner, repo, branch);
          state.runDebugRefresh?.();
          selected = {owner:String(owner), repo:String(repo), branch:String(branch)};
          branches = [String(branch)];
          // The repository was created after the repository list was loaded.
          // Add it to the in-memory list immediately so the UI stays selected
          // on the new repo instead of falling back to "Select repository…".
          const fullName = String(owner) + '/' + String(repo);
          if (!repos.some(item => item.fullName === fullName)) {
            repos = [...repos, {
              id: created?.id,
              name: String(repo),
              fullName,
              owner: String(owner),
              private: !!created?.private,
              defaultBranch: String(branch),
              permissions: {push:true}
            }];
          }
          saveConfig();

          // GitHub may take a moment to provision the Git database after the
          // repository itself has been created. commitAndPush waits through
          // that transient 409 state before creating the initial commit.
          button.textContent = 'Initializing…';
          showStatus('Waiting for GitHub to initialize the repository…');
          const initialCommit = await github.commitAndPush({
            owner:String(owner),
            repo:String(repo),
            branch:String(branch),
            message:'Initialized Repository',
            fs:state.fs
          });
          if (!initialCommit.changed) {
            throw new Error('The new GitHub repository could not be initialized because the workspace has no files.');
          }

          // The repository is already selected. Refresh only the state that
          // changed instead of rebuilding the entire sidebar and racing
          // several independent repository/branch requests.
          selected = {owner:String(owner), repo:String(repo), branch:String(branch)};
          branches = [String(branch)];
          saveConfig();
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
        if (!fullName) { ++branchLoadToken; ++refreshToken; selected = {owner:'', repo:'', branch:'main'}; branches = []; state.gitRemote = null; state.deploymentSettings = {...(state.deploymentSettings || {}), branch:'', commit:''}; state.saveProjectMetadata?.(); saveConfig(); state.runDebugRefresh?.(); renderShell(); return; }
        const [owner, ...repoParts] = fullName.split('/');
        selected = {owner, repo:repoParts.join('/'), branch:repos.find(r => r.fullName === fullName)?.defaultBranch || 'main'};
        state.gitRemote = {provider:'github', owner, repo:selected.repo, branch:selected.branch};
        state.deploymentSettings = {...(state.deploymentSettings || {}), branch: state.deploymentSettings?.branch || selected.branch};
        state.saveProjectMetadata?.(); state.markDirty?.('editor/project.json');
        saveConfig();
        ++branchLoadToken;
        branches = [];
        renderShell();
        await loadBranches(false);
        await refreshStatus();
      });
      tree.querySelector('[data-branch]')?.addEventListener('change', e => {
        selected.branch = e.target.value || 'main';
        state.gitRemote = {provider:'github', owner:selected.owner, repo:selected.repo, branch:selected.branch};
        state.saveProjectMetadata?.(); state.markDirty?.('editor/project.json');
        saveConfig(); state.runDebugRefresh?.(); void refreshStatus(); void loadHistory();
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
      const token = ++branchLoadToken;
      const owner = selected.owner, repo = selected.repo, branch = selected.branch;
      try {
        const loaded = await github.listBranches(owner, repo);
        if (token !== branchLoadToken || selected.owner !== owner || selected.repo !== repo) return;
        branches = loaded.length ? loaded : [branch || 'main'];
        if (!branches.includes(selected.branch)) selected.branch = branches[0];
        saveConfig();
        renderShell();
        await refreshStatus();
        await loadHistory();
      } catch (e) {
        if (token !== branchLoadToken || selected.owner !== owner || selected.repo !== repo) return;
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
      const token = ++statusToken;
      const changesEl = tree.querySelector('[data-changes]');
      if (!changesEl || !selected.repo || !state.fs) return;
      changesEl.innerHTML = '<div class="source-control-loading">Checking working tree…</div>';
      try {
        const repoInfo = repos.find(r => r.fullName === `${selected.owner}/${selected.repo}`);
        const canPush = repoInfo ? repoInfo.permissions?.push !== false : true;
        const remote = await github.getRemoteState(selected.owner, selected.repo, selected.branch || 'main');
        if (token !== statusToken) return;
        if (remote.unavailable) {
          changesEl.innerHTML = '<div class="source-control-loading">GitHub is still initializing this repository…</div>';
          const button = tree.querySelector('[data-commit]');
          if (button) button.disabled = true;
          showStatus('GitHub is still initializing this repository…');
          return;
        }
        const changes = await github.compareWorkingTree(state.fs, remote.tree);
        if (token !== statusToken) return;
        const showHidden = !!state.behavior?.showHiddenFolders;
        const visibleChanges = [];
        let settingsChanged = false;
        for (const change of changes) {
          const path = String(change.path || '').replace(/^\/+/, '');
          if (path === '.editor' || path.startsWith('.editor/')) {
            settingsChanged = true;
            if (showHidden) visibleChanges.push(change);
          } else visibleChanges.push(change);
        }
        if (!showHidden && settingsChanged) visibleChanges.push({path:'.editor', type:'modified', settings:true});
        changesEl.innerHTML = visibleChanges.length ? visibleChanges.map(c => {
          if (c.settings) return `<div class="source-control-change"><span class="source-control-change-type source-modified">M</span><span>Settings changed</span></div>`;
          return `<div class="source-control-change"><span class="source-control-change-type source-${c.type}">${c.type === 'modified' ? 'M' : c.type === 'added' ? 'A' : 'D'}</span><span>${esc(c.path)}</span></div>`;
        }).join('') : '<div class="source-control-clean">No changes</div>';
        changesEl.dataset.count = String(changes.length);
        const button = tree.querySelector('[data-commit]');
        const isInitialCommit = !!remote.empty || !remote.commitSha;
        if (button) {
          button.disabled = commitBusy || !changes.length || !canPush;
          button.textContent = isInitialCommit ? 'Initial Commit & Push' : 'Commit & Push';
          button.title = canPush ? (isInitialCommit ? 'Create the first commit on this empty GitHub repository.' : '') : 'You do not have push permission for this repository.';
        }
        if (!canPush) showStatus('This repository is read-only for your GitHub account.', true);
        else if (remote.truncated) showStatus('GitHub truncated the remote tree; large repositories may need a more focused sync later.', true);
        else if (isInitialCommit && changes.length) showStatus('This GitHub repository has no commits yet. Your next commit will become its initial commit.');
        else clearStatus();
      } catch (e) {
        if (token !== statusToken) return;
        changesEl.innerHTML = `<div class="source-control-error">${esc(e.message || String(e))}</div>`;
        const button = tree.querySelector('[data-commit]');
        if (button) button.disabled = true;
      }
    }

    async function loadHistory() {
      const token = ++historyToken;
      const historyEl = tree.querySelector('[data-history]');
      if (!historyEl || !selected.repo) return;
      historyEl.innerHTML = '<div class="source-control-loading">Loading commits…</div>';
      try {
        const commits = await github.listCommits(selected.owner, selected.repo, selected.branch || 'main', 20);
        if (token !== historyToken) return;
        historyEl.innerHTML = commits.length ? commits.map(commit => `<button type="button" class="source-control-commit-row" data-commit-sha="${esc(commit.sha)}"><div><strong>${esc(commit.message || '(no message)')}</strong><span>${esc(commit.author)} · ${commit.date ? new Date(commit.date).toLocaleString() : ''}</span></div><code>${esc(commit.sha.slice(0, 7))}</code></button>`).join('') : '<div class="source-control-empty-inline">No commits on this branch.</div>';
        historyEl.querySelectorAll('[data-commit-sha]').forEach(row => row.addEventListener('click', () => openCommitRestore(row.dataset.commitSha)));
      } catch (e) {
        if (token === historyToken) historyEl.innerHTML = `<div class="source-control-error">${esc(e.message || String(e))}</div>`;
      }
    }

    async function openCommitRestore(commitSha) {
      if (!selected.repo || !commitSha) return;
      let commit = null;
      try {
        const commits = await github.listCommits(selected.owner, selected.repo, selected.branch || 'main', 100);
        commit = commits.find(item => item.sha === commitSha) || {sha:commitSha, message:'Selected commit', author:'Unknown', date:''};
      } catch (_) {
        commit = {sha:commitSha, message:'Selected commit', author:'Unknown', date:''};
      }

      const existing = document.querySelector('.source-control-restore-modal');
      existing?.remove();
      const modal = document.createElement('div');
      modal.className = 'source-control-restore-modal';
      modal.innerHTML = `<div class="source-control-restore-dialog" role="dialog" aria-modal="true">
        <div class="source-control-restore-title">Return workspace to this commit?</div>
        <div class="source-control-restore-info"><strong>${esc(commit.message || '(no message)')}</strong><span>${esc(commit.author || 'Unknown')} · ${commit.date ? new Date(commit.date).toLocaleString() : ''}</span><code>${esc(commit.sha.slice(0, 7))}</code></div>
        <p>This changes the local workspace to exactly match this commit. Nothing is pushed yet. You can review the changes and make a new commit to create an undo/revert commit on the branch.</p>
        <div class="source-control-restore-actions"><button data-restore-cancel>Cancel</button><button data-restore-confirm class="primary">Restore Workspace</button></div>
        <div data-restore-status class="source-control-restore-status"></div>
      </div>`;
      document.body.appendChild(modal);
      const close = () => modal.remove();
      modal.querySelector('[data-restore-cancel]').onclick = close;
      modal.addEventListener('click', e => { if (e.target === modal) close(); });
      const confirmButton = modal.querySelector('[data-restore-confirm]');
      const status = modal.querySelector('[data-restore-status]');
      confirmButton.onclick = async () => {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Restoring…';
        status.textContent = '';
        try {
          const snapshot = await github.getCommitState(selected.owner, selected.repo, commitSha);
          if (snapshot.truncated) throw new Error('GitHub truncated this commit tree, so the workspace cannot be restored safely.');

          const target = new Map();
          for (const entry of snapshot.tree) {
            target.set(entry.path, entry);
          }

          // Restoring a commit is a full filesystem replacement. Clear every
          // existing file and directory first so files that are absent from the
          // target commit cannot survive the restore.
          const localPaths = state.fs.listFilesSync().map(path => String(path).replace(/^\/+/, '')).filter(Boolean);
          for (const path of localPaths) {
            state.fs.deleteFileSync(path);
            state.markDirty?.(path);
          }
          const localDirs = typeof state.fs.listDirectoriesSync === 'function'
            ? state.fs.listDirectoriesSync().map(path => String(path).replace(/^\/+/, '')).filter(Boolean)
            : [];
          for (const dir of localDirs.sort((a,b) => b.split('/').length - a.split('/').length)) {
            state.fs.deleteDirectorySync?.(dir);
          }


          let index = 0;
          for (const entry of snapshot.tree) {
            status.textContent = `Restoring ${++index}/${snapshot.tree.length}…`;
            const bytes = await github.readBlob(selected.owner, selected.repo, entry.sha);
            state.fs.writeFileSync(entry.path, bytes);
            state.markDirty?.(entry.path);
          }
          state.runDebugRefresh?.();
          state.refreshExplorer?.();
          close();
          await refreshStatus();
          showStatus(`Workspace restored to ${commitSha.slice(0, 7)}. Review the changes and commit them to create a new revert point.`);
        } catch (e) {
          status.textContent = e.message || String(e);
          confirmButton.disabled = false;
          confirmButton.textContent = 'Restore Workspace';
        }
      };
    }

    async function commit() {
      const button = tree.querySelector('[data-commit]');
      const message = tree.querySelector('[data-commit-message]')?.value || '';
      if (!button || button.disabled || commitBusy) return;
      commitBusy = true;
      button.disabled = true;
      button.textContent = 'Pushing…';
      clearStatus();
      try {
        const result = await github.commitAndPush({owner:selected.owner, repo:selected.repo, branch:selected.branch || 'main', message, fs:state.fs});
        if (!result.changed) {
          showStatus('Nothing to commit.');
          return;
        }
        tree.querySelector('[data-commit-message]').value = '';
        showStatus(`Committed ${result.commitSha.slice(0, 7)} and pushed to ${selected.branch || 'main'}.`);
        // GitHub can briefly lag when the branch ref is read immediately after
        // a push. Wait for the new head before repainting the sidebar so the
        // changes/history view does not require leaving and reopening it.
        for (let attempt = 0; attempt < 8; attempt++) {
          const remote = await github.getRemoteState(selected.owner, selected.repo, selected.branch || 'main').catch(() => null);
          if (remote?.commitSha === result.commitSha) break;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
        await refreshStatus();
        await loadHistory();
      } catch (e) {
        showStatus(e.message || String(e), true);
        await refreshStatus();
      } finally {
        commitBusy = false;
        const currentButton = tree.querySelector('[data-commit]');
        if (currentButton) currentButton.textContent = 'Commit & Push';
        await refreshStatus();
      }
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

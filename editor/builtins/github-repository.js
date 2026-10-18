(function() {
  const factories = window.EditorBuiltinFactories = window.EditorBuiltinFactories || {};

  factories['github-repository'] = function(ctx) {
    const state = ctx.state;

    function repository() {
      const remote = state.gitRemote;
      if (!remote || remote.provider !== 'github' || !remote.owner || !remote.repo) return null;
      return {owner:String(remote.owner), repo:String(remote.repo), branch:String(remote.branch || 'main')};
    }

    function render(g) {
      const view = document.createElement('div');
      view.className = 'editor-github-repository-view';
      const root = document.createElement('div');
      const style = document.createElement('style');
      style.textContent = `
        .editor-github-repository-page { box-sizing:border-box; width:min(760px,100%); margin:0 auto; padding:36px; color:#eee; }
        .editor-github-repository-header { display:flex; align-items:center; gap:14px; margin-bottom:24px; }
        .editor-github-repository-logo { width:32px; height:32px; flex:0 0 32px; filter:invert(1); }
        .editor-github-repository-header h2 { margin:0 0 8px; font-size:28px; }
        .editor-github-repository-header p { margin:0 0 24px; color:#aaa; }
        .editor-github-repository-card { background:#1e1e1e; border:1px solid #333; border-radius:10px; padding:22px; }
        .editor-github-repository-status { color:#aaa; }
        .editor-github-repository-status.error { color:#f88; }
        .editor-github-repository-card label { display:block; margin:0 0 18px; color:#ddd; }
        .editor-github-repository-card input { display:block; width:100%; box-sizing:border-box; margin-top:7px; padding:10px 12px; background:#151515; color:#eee; border:1px solid #444; border-radius:5px; font:inherit; }
        .editor-github-repository-name { color:#aaa; margin-bottom:22px; font-family:monospace; }
        .editor-github-repository-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:8px; }
        .editor-github-repository-actions button { padding:9px 14px; background:#333; color:#eee; border:1px solid #555; border-radius:4px; cursor:pointer; }
        .editor-github-repository-actions button[type="submit"] { background:#176b4a; }
        .editor-github-repository-actions button:disabled { opacity:.5; cursor:default; }
        .editor-github-repository-message { margin-top:14px; color:#aaa; }
        .editor-github-repository-message.success { color:#6dca9a; }
        .editor-github-repository-message.error { color:#f88; }
        .editor-github-repository-open-title { font-size:18px; font-weight:600; margin-bottom:8px; }
        .editor-github-repository-open-copy { color:#aaa; line-height:1.5; margin-bottom:18px; }
        .editor-github-repository-card button { padding:9px 14px; background:#333; color:#eee; border:1px solid #555; border-radius:4px; cursor:pointer; }
        .editor-github-repository-card button:hover { background:#444; }
        @media (max-width:600px) { .editor-github-repository-page { padding:20px; } }
      `;
      root.className = 'editor-github-repository-page';
      root.innerHTML = `
        <div class="editor-github-repository-header">
          <h2>GitHub Repository</h2>
          <p>Edit the GitHub repository description and topics for the repository currently open in Source Control.</p>
        </div>
        <div class="editor-github-repository-card">
          <div class="editor-github-repository-status" data-status>Loading…</div>
          <form data-form hidden>
            <div class="editor-github-repository-name" data-name></div>
            <label>Repository Name<input type="text" data-repository-name placeholder="repository-name" spellcheck="false" autocomplete="off"></label>
            <div class="editor-github-repository-actions" style="margin-top:-8px;margin-bottom:22px;">
              <button type="button" data-rename-repository>Rename Repository</button>
            </div>
            <label>Website<input type="text" data-website placeholder="https://example.com" spellcheck="false" autocomplete="off"></label>
            <label>Description<input type="text" data-description placeholder="Repository description"></label>
            <label>Topics<input type="text" data-topics placeholder="comma, separated, topics"></label>
            <div class="editor-github-repository-actions">
              <button type="button" data-reload>Reload</button>
              <button type="submit">Save to GitHub</button>
            </div>
            <div class="editor-github-repository-message" data-message></div>
          </form>
        </div>
      `;
      // Keep the stylesheet inside the same lifecycle-managed element as the view.
      // Workbench reuses builtin elements when tabs are switched; having <style>
      // as a sibling of the view lets the lifecycle hide/remove it independently.
      view.appendChild(style);
      view.appendChild(root);
      g.viewBody.appendChild(view);

      const status = root.querySelector('[data-status]');
      const form = root.querySelector('[data-form]');
      const name = root.querySelector('[data-name]');
      const repositoryName = root.querySelector('[data-repository-name]');
      const renameRepository = root.querySelector('[data-rename-repository]');
      const website = root.querySelector('[data-website]');
      const description = root.querySelector('[data-description]');
      const topics = root.querySelector('[data-topics]');
      const message = root.querySelector('[data-message]');

      function setStatus(text, error = false) {
        status.hidden = !text;
        status.textContent = text || '';
        status.className = 'editor-github-repository-status' + (error ? ' error' : '');
      }

      function normalizeTopics(value) {
        return [...new Set(String(value || '')
          .split(',')
          .map(x => x.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''))
          .filter(Boolean))].slice(0, 20);
      }

      async function renameRepositoryOnGitHub() {
        const current = repository();
        if (!current) return;
        const nextName = String(repositoryName.value || '').trim();
        if (!nextName) {
          message.className = 'editor-github-repository-message error';
          message.textContent = 'Enter a repository name.';
          return;
        }
        if (!/^[A-Za-z0-9._-]+$/.test(nextName)) {
          message.className = 'editor-github-repository-message error';
          message.textContent = 'Repository names may only contain letters, numbers, ., _, and -.';
          return;
        }
        if (nextName === current.repo) {
          message.className = 'editor-github-repository-message';
          message.textContent = 'That is already the repository name.';
          return;
        }
        if (!window.confirm('Rename this GitHub repository from "' + current.repo + '" to "' + nextName + '"?')) return;
        renameRepository.disabled = true;
        setStatus('Renaming GitHub repository…');
        message.textContent = '';
        const oldRepositoryUrl = 'https://github.com/' + current.owner + '/' + current.repo;
        const newRepositoryUrl = 'https://github.com/' + current.owner + '/' + nextName;
        try {
          const data = await window.GitHubService.request('/repos/' + encodeURIComponent(current.owner) + '/' + encodeURIComponent(current.repo), {
            method:'PATCH',
            body:JSON.stringify({name:nextName})
          });
          const newRepo = String(data?.name || nextName);
          state.gitRemote = {provider:'github', owner:current.owner, repo:newRepo, branch:current.branch};
          state.projectId = 'github:' + current.owner + '/' + newRepo + '@' + current.branch;
          try { state.saveProjectMetadata?.(); } catch (_) {}
          repositoryName.value = newRepo;
          name.textContent = data.full_name || (current.owner + '/' + newRepo);
          try {
            const renameResponse = await fetch('/api/project/editor-repository-rename', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({oldRepository:oldRepositoryUrl,newRepository:newRepositoryUrl})
            });
            if (!renameResponse.ok) {
              console.warn('GitHub repository renamed, but published-project references could not be updated:', await renameResponse.text());
            }
          } catch (syncError) {
            console.warn('GitHub repository renamed, but published-project reference sync failed:', syncError);
          }
          setStatus('');
          message.className = 'editor-github-repository-message success';
          message.textContent = 'Repository renamed. Workspace metadata and published-project references were updated.';
          try { window.EditorEvents?.emit?.('githubRepositoryRenamed', {oldRepository:oldRepositoryUrl,newRepository:newRepositoryUrl,owner:current.owner,oldName:current.repo,newName:newRepo,branch:current.branch}); } catch (_) {}
        } catch (e) {
          setStatus('');
          message.className = 'editor-github-repository-message error';
          message.textContent = e?.message || String(e);
        } finally {
          renameRepository.disabled = false;
        }
      }

      async function load() {
        form.hidden = true;
        message.textContent = '';
        const repo = repository();
        if (!repo) {
          setStatus('Open a GitHub repository in Source Control first.', true);
          return;
        }
        if (!window.GitHubService?.isSignedIn?.()) {
          setStatus('Sign in to GitHub from Profile to edit repository metadata.', true);
          return;
        }
        setStatus('Loading GitHub repository…');
        try {
          const data = await window.GitHubService.request('/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo));
          name.textContent = data.full_name || (repo.owner + '/' + repo.repo);
          repositoryName.value = repo.repo;
          website.value = data.homepage || '';
          description.value = data.description || '';
          topics.value = Array.isArray(data.topics) ? data.topics.join(', ') : '';
          setStatus('');
          form.hidden = false;
        } catch (e) {
          setStatus(e?.message || String(e), true);
        }
      }

      root.querySelector('[data-reload]').onclick = load;
      renameRepository.onclick = renameRepositoryOnGitHub;

      form.onsubmit = async event => {
        event.preventDefault();
        const repo = repository();
        if (!repo) return;
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        message.className = 'editor-github-repository-message';
        message.textContent = 'Saving…';
        try {
          const names = normalizeTopics(topics.value);
          const homepage = String(website.value || '').trim();
          if (homepage) {
            let websiteUrl;
            try { websiteUrl = new URL(homepage); } catch (_) { throw new Error('Website must be a valid URL.'); }
            if (!/^https?:$/.test(websiteUrl.protocol)) throw new Error('Website must use http:// or https://.');
          }
          await window.GitHubService.request('/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo), {
            method:'PATCH',
            body:JSON.stringify({
              description:String(description.value || '').trim(),
              homepage:homepage || null
            })
          });
          await window.GitHubService.request('/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo) + '/topics', {
            method:'PUT',
            body:JSON.stringify({names})
          });
          topics.value = names.join(', ');
          message.className = 'editor-github-repository-message success';
          message.textContent = 'Saved to GitHub.';
        } catch (e) {
          message.className = 'editor-github-repository-message error';
          message.textContent = e?.message || String(e);
        } finally {
          button.disabled = false;
        }
      };

      load();
    }

    return {

      title: 'GitHub Repository',
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943z"/></svg>',
      render
    };
  };
})();
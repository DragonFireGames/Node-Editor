(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.Profile = function(options) {
    const {tree, state} = options;
    const github = window.GitHubService;
    let unsubscribe = null;
    let installation = null;
    const esc = value => String(value ?? '').replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\':'&#39;'}[ch]));
    function show() {
      unsubscribe?.();
      unsubscribe = github?.onChange?.(() => render()) || null;
      installation = github?.isSignedIn?.() ? null : false;
      render();
      if (github?.isSignedIn?.()) github.isAppInstalled?.().then(value => { installation = value; render(); }).catch(() => { installation = false; render(); });
    }
    function render() {
      tree.classList.remove('activity-collapsed');
      const user = github?.getUser?.();
      const config = github?.getConfig?.() || {workerUrl:''};
      const remember = github?.getRemember?.() || false;
      tree.innerHTML = `<div class="github-profile-sidebar">
        <div class="activity-sidebar-title">Profile</div>
        <section class="github-profile-section">
          <div class="github-profile-heading">GitHub</div>
          ${user ? `<div class="github-user-card">${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : '<div class="github-avatar-fallback">GH</div>'}<div class="github-user-main"><strong>${esc(user.name || user.login)}</strong><span>@${esc(user.login)}</span></div></div><div class="github-profile-actions"><button data-github-profile>Open GitHub Profile</button><button data-github-signout>Sign out</button></div>${state.gitEnabled === false ? `<div class="github-profile-hint">This project was opened without Git access because you are not its owner. Connect one of your own GitHub repositories to make changes publishable.</div><button class="github-primary-button" data-github-connect>Connect GitHub repository</button>` : ''}${installation === false ? `<div class="github-profile-hint">Node Editor is not installed on this GitHub account. Install it to grant repository access.</div><button class="github-primary-button" data-github-install>Install Node Editor GitHub App</button>` : installation === null ? `<div class="github-profile-hint">Checking GitHub App installation…</div>` : ''}` : `<div class="github-profile-empty">Not signed in</div><button class="github-primary-button" data-github-install>Install Node Editor GitHub App</button><button data-github-signin>Sign in with GitHub</button>`}
        </section>
        <section class="github-profile-section">
          <div class="github-profile-heading">Authentication Worker</div>
          <div class="github-profile-value">${esc(config.workerUrl || 'Not configured')}</div>
          
        </section>
        <section class="github-profile-section">
          <label class="github-remember"><input data-github-remember type="checkbox" ${remember ? 'checked' : ''}> Remember GitHub login on this device</label>
          <div class="github-profile-hint">Off keeps the access token in session storage. On keeps it in local storage.</div>
        </section>
      </div>`;
      tree.querySelector('[data-github-install]')?.addEventListener('click', async e => {
        const button = e.currentTarget;
        button.disabled = true;
        button.textContent = 'Waiting for installation…';
        installation = null;
        render();
        try {
          github.installApp();
          const installed = await github.waitForInstallation?.();
          installation = installed ? true : await github.isAppInstalled?.();
        } catch (_) { installation = false; }
        render();
      });
      const signIn = tree.querySelector('[data-github-signin]');
      signIn?.addEventListener('click', async () => {
        signIn.disabled = true; signIn.textContent = 'Opening GitHub…';
        try { await github.startLogin(); } catch (e) { signIn.disabled = false; signIn.textContent = 'Sign in with GitHub'; alert(e.message || String(e)); }
      });
      tree.querySelector('[data-github-signout]')?.addEventListener('click', () => github.signOut());
      tree.querySelector('[data-github-connect]')?.addEventListener('click', () => {
        state.gitEnabled = true;
        state.sidebarController?.syncSourceControlActivity?.();
        state.sidebarController?.show?.('Source Control');
      });
      tree.querySelector('[data-github-profile]')?.addEventListener('click', () => {
        const login = encodeURIComponent(user?.login || '');
        if (login) window.open(`https://github.com/${login}`, '_blank', 'noopener');
      });
      tree.querySelector('[data-github-remember]')?.addEventListener('change', e => github.setRemember(e.target.checked));
    }
    return {show};
  };
})();

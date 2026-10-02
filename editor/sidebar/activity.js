(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.create = function(options) {
    const {state, $, tree, resizer, scheduleWorkspaceLayoutSave} = options;
    const explorer = root.Explorer(options);
    const runDebug = root.RunDebug(options);
    const settings = root.Settings(options);
    const placeholders = root.Placeholders(options);
    const extensions = root.Extensions(options);
    const search = root.Search(options);
    const sourceControl = root.SourceControl(options);
    const profile = root.Profile(options);
    const github = window.GitHubService;
    function syncProfileButton() {
      const button = document.getElementById('activityProfile');
      if (!button) return;
      const user = github?.getUser?.();
      if (user?.avatar_url) {
        button.innerHTML = '';
        const img = document.createElement('img');
        img.src = user.avatar_url;
        img.alt = user.login ? `@${user.login}` : 'GitHub profile';
        button.appendChild(img);
        button.title = user.login ? `Profile — @${user.login}` : 'Profile';
        button.setAttribute('aria-label', user.login ? `Profile — @${user.login}` : 'Profile');
      } else {
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 20c.8-3.3 3.1-5 6.5-5s5.7 1.7 6.5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
        button.title = 'Profile';
        button.setAttribute('aria-label', 'Profile');
      }
    }
    const activities = {
      activitySearch: {kind: 'Search', show: () => search.show()},
      activitySource: {kind: 'Source Control', show: () => sourceControl.show()},
      activityRun: {kind: 'Run and Debug', show: () => runDebug.show()},
      activityExtensions: {kind: 'Extensions', show: () => extensions.show()},
      activitySettings: {kind: 'settings', show: () => settings.show()},
      activityExplorer: {kind: 'explorer', show: () => explorer.show()},
      activityProfile: {kind: 'Profile', show: () => profile.show()},
    };
    const MIN_WIDTH = 180;
    const MAX_WIDTH = 420;
    const HIDE_THRESHOLD = MIN_WIDTH / 2;
    let width = MIN_WIDTH;
    let resizing = false;
    function setWidth(value) {
      width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value));
      tree.style.flexBasis = width + 'px';
      tree.style.width = width + 'px';
      tree.style.minWidth = MIN_WIDTH + 'px';
      tree.style.maxWidth = MAX_WIDTH + 'px';
    }
    function collapse() {
      const previous = state.sidebar;
      tree.classList.add('activity-collapsed');
      document.querySelectorAll('.activity-button').forEach(x => x.classList.remove('active'));
      scheduleWorkspaceLayoutSave();
      window.EditorEvents?.emit?.('sidebarChange', {
        sidebar: null, previous, collapsed: true, tree, button: null
      }, true);
    }
    function expand() {
      tree.classList.remove('activity-collapsed');
      setWidth(width < MIN_WIDTH ? MIN_WIDTH : width);
    }
    function show(kind) {
      const entry = Object.values(activities).find(x => x.kind === kind);
      if (!entry) return;
      const button = Object.entries(activities).find(([, x]) => x === entry)?.[0];
      const same = state.sidebar === kind && !tree.classList.contains('activity-collapsed');
      if (same) { collapse(); return; }
      const previous = state.sidebar;
      expand();
      explorer.hideContextMenu?.();
      state.sidebar = kind;
      document.querySelectorAll('.activity-button').forEach(x => x.classList.toggle('active', x.id === button));
      entry.show();
      scheduleWorkspaceLayoutSave();
      window.EditorEvents?.emit?.('sidebarChange', {
        sidebar: kind, previous, collapsed: false, tree,
        button: document.getElementById(button) || null
      }, true);
    }
    for (const [id, entry] of Object.entries(activities)) {
      $(id)?.addEventListener('click', e => {
        e.stopPropagation();
        show(entry.kind);
      });
    }
    const githubUnsubscribe = github?.onChange?.(() => { syncProfileButton(); state.runDebugRefresh?.(); }) || null;
    syncProfileButton();
    resizer?.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (tree.classList.contains('activity-collapsed')) {
        expand();
        return;
      }
      resizing = true;
      document.body.classList.add('resizing');
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = tree.getBoundingClientRect().width;
      const overlay = document.createElement('div');
      overlay.className = 'sidebar-drag-overlay';
      document.body.appendChild(overlay);
      const move = ev => {
        if (!resizing) return;
        const next = startWidth + ev.clientX - startX;
        if (next < HIDE_THRESHOLD) {
          collapse();
          return;
        }
        if (tree.classList.contains('activity-collapsed')) expand();
        setWidth(next);
      };
      const up = () => {
        resizing = false;
        document.body.classList.remove('resizing');
        overlay.remove();
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        scheduleWorkspaceLayoutSave();
      };
      overlay.addEventListener('mousemove', move);
      overlay.addEventListener('mouseup', up);
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    tree.addEventListener('contextmenu', e => e.stopPropagation());
    setWidth(MIN_WIDTH);
    state.sidebar = 'explorer';
    return {
      explorer, runDebug, settings, extensions, search, sourceControl, profile, show, dispose() { extensions.dispose?.(); githubUnsubscribe?.(); },
      setActiveActivity(id) { document.querySelectorAll('.activity-button').forEach(x => x.classList.toggle('active', x.id === id)); },
      restoreCollapsed: paths => explorer.restoreCollapsed(paths),
      setWidth, collapse, expand, getWidth: () => width
    };
  };
})();

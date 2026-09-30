(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.create = function(options) {
    const {state, $, tree, resizer, scheduleWorkspaceLayoutSave} = options;
    const explorer = root.Explorer(options);
    const runDebug = root.RunDebug(options);
    const settings = root.Settings(options);
    const placeholders = root.Placeholders(options);
    const search = root.Search(options);
    const activities = {
      activitySearch: {kind: 'Search', show: () => search.show()},
      activitySource: {kind: 'Source Control', show: () => placeholders.show('Source Control')},
      activityRun: {kind: 'Run and Debug', show: () => runDebug.show()},
      activityExtensions: {kind: 'Extensions', show: () => placeholders.show('Extensions')},
      activitySettings: {kind: 'settings', show: () => settings.show()},
      activityExplorer: {kind: 'explorer', show: () => explorer.show()},
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
      tree.classList.add('activity-collapsed');
      document.querySelectorAll('.activity-button').forEach(x => x.classList.remove('active'));
      scheduleWorkspaceLayoutSave();
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
      expand();
      explorer.hideContextMenu?.();
      state.sidebar = kind;
      document.querySelectorAll('.activity-button').forEach(x => x.classList.toggle('active', x.id === button));
      entry.show();
      scheduleWorkspaceLayoutSave();
    }
    for (const [id, entry] of Object.entries(activities)) {
      $(id)?.addEventListener('click', e => {
        e.stopPropagation();
        show(entry.kind);
      });
    }
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
      explorer, runDebug, settings, search, show,
      setActiveActivity(id) { document.querySelectorAll('.activity-button').forEach(x => x.classList.toggle('active', x.id === id)); },
      restoreCollapsed: paths => explorer.restoreCollapsed(paths),
      setWidth, collapse, expand, getWidth: () => width
    };
  };
})();

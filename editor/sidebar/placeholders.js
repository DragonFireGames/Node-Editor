(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.Placeholders = function(options) {
    const {tree} = options;
    return {
      show(title) {
        tree.classList.remove('activity-collapsed');
        tree.innerHTML = `<div class="activity-sidebar-placeholder"><div class="activity-sidebar-title">${title}</div><div class="activity-sidebar-empty">No ${title.toLowerCase()} content yet.</div></div>`;
      }
    };
  };
})();

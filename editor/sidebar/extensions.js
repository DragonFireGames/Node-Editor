(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.Extensions = function(options) {
    const {tree, extensionAPI} = options;
    function show() {
      tree.classList.remove('activity-collapsed');
      const extensions = extensionAPI?.list?.() || [];
      tree.innerHTML = '';
      const page = document.createElement('div');
      page.className = 'extensions-page';
      const header = document.createElement('div');
      header.className = 'extensions-header';
      header.innerHTML = '<h2>Extensions</h2><p>Extensions provided by the embedding page.</p>';
      page.appendChild(header);
      const list = document.createElement('div');
      list.className = 'extensions-list';
      if (!extensions.length) {
        const empty = document.createElement('div');
        empty.className = 'activity-sidebar-empty';
        empty.textContent = 'No extensions available.';
        list.appendChild(empty);
      } else {
        for (const ext of extensions) {
          const button = document.createElement('button');
          button.className = 'extension-card';
          button.type = 'button';
          const icon = document.createElement('div');
          icon.className = 'extension-card-icon';
          icon.innerHTML = ext.icon || '<span>✦</span>';
          const copy = document.createElement('div');
          copy.className = 'extension-card-copy';
          const title = document.createElement('div');
          title.className = 'extension-card-title';
          title.textContent = ext.name || ext.id;
          const description = document.createElement('div');
          description.className = 'extension-card-description';
          description.textContent = ext.description || '';
          copy.append(title, description);
          button.append(icon, copy);
          button.addEventListener('click', () => extensionAPI?.open?.(ext.id));
          list.appendChild(button);
        }
      }
      page.appendChild(list);
      tree.appendChild(page);
    }
    const unsubscribe = extensionAPI?.onChange?.(() => {
      if (tree.querySelector('.extensions-page')) show();
    });
    return {show, dispose: () => unsubscribe?.()};
  };
})();

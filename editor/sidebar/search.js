(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.Search = function(options) {
    const {tree, state, onOpenResult, scheduleWorkspaceLayoutSave} = options;
    let timer = 0;
    const textExtensions = new Set(['js','mjs','cjs','ts','tsx','jsx','json','html','htm','css','md','txt','xml','svg','yaml','yml','py','java','c','h','cpp','hpp','cc','rs','go','wgsl','glsl','vert','frag','shader','toml','ini','env','sh','bat','ps1','vue','svelte']);
    function escape(value) {
      return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function isTextFile(path) {
      const name = String(path).split('/').pop() || '';
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      return textExtensions.has(ext) || !ext;
    }
    function search(query) {
      query = String(query || '').trim();
      if (!query) return render([], 'Type a search term to search the workspace.');
      const files = state.fs?.listFilesSync?.() || [];
      const results = [];
      const needle = query.toLowerCase();
      for (const path of files) {
        if (!isTextFile(path)) continue;
        try {
          const text = String(state.fs.readFileSync(path, 'utf8') || '');
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lower = line.toLowerCase();
            let from = 0;
            while (from < line.length) {
              const col = lower.indexOf(needle, from);
              if (col < 0) break;
              results.push({path, line: i + 1, column: col + 1, text: line});
              if (results.length >= 2000) break;
              from = col + Math.max(needle.length, 1);
            }
            if (results.length >= 2000) break;
          }
        } catch (_) {}
        if (results.length >= 2000) break;
      }
      render(results, results.length ? '' : `No results for “${query}”.`);
    }
    function render(results, message) {
      let input = tree.querySelector('.sidebar-search-input');
      let container = tree.querySelector('.sidebar-search-results');
      if (!input || !container) {
        tree.innerHTML = `<div class="sidebar-search"><input class="sidebar-search-input" type="search" placeholder="Search" spellcheck="false"><div class="sidebar-search-results"></div></div>`;
        input = tree.querySelector('.sidebar-search-input');
        container = tree.querySelector('.sidebar-search-results');
        input.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => search(input.value), 150);
        });
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(input.value); }
        });
      }
      container.innerHTML = '';
      if (message) {
        container.innerHTML = `<div class="sidebar-search-message">${escape(message)}</div>`;
        return;
      }
      const groups = new Map();
      for (const result of results) {
        if (!groups.has(result.path)) groups.set(result.path, []);
        groups.get(result.path).push(result);
      }
      for (const [path, matches] of groups) {
        const group = document.createElement('div');
        group.className = 'sidebar-search-file';
        group.innerHTML = `<div class="sidebar-search-file-name">${escape(path)}<span>${matches.length}</span></div>`;
        for (const result of matches) {
          const row = document.createElement('button');
          row.className = 'sidebar-search-result';
          row.title = `${path}:${result.line}:${result.column}`;
          const text = result.text.length > 180 ? result.text.slice(0, 180) + '…' : result.text;
          row.innerHTML = `<span class="sidebar-search-location">${result.line}</span><span class="sidebar-search-line">${escape(text.trim() || ' ')}</span>`;
          row.onclick = () => onOpenResult?.(result.path, result.line, result.column);
          group.appendChild(row);
        }
        container.appendChild(group);
      }
    }
    return {
      show() {
        tree.classList.remove('activity-collapsed');
        render([], 'Type a search term to search the workspace.');
        scheduleWorkspaceLayoutSave();
      }
    };
  };
})();

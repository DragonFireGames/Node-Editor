(function () {
  const textMimes = ['application/json','application/javascript','application/typescript','application/xml','model/gltf+json'];
  function match(file) {
    const mime = String(file.mime || '');
    return mime.startsWith('text/') || textMimes.includes(mime) || mime === 'image/svg+xml' || String(file.name || '').toLowerCase().endsWith('.obj');
  }
  function language(path) {
    const ext = String(path || '').split('/').pop().split('.').pop().toLowerCase();
    return ({
      js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',jsx:'javascript',json:'json',
      html:'html',htm:'html',css:'css',md:'markdown',xml:'xml',yaml:'yaml',yml:'yaml',py:'python',java:'java',
      c:'c',cpp:'cpp',svg:'html',gltf:'json',frag:'cpp',vert:'cpp',hlsl:'cpp',fx:'cpp',wgsl:'plaintext'
    })[ext] || 'plaintext';
  }
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'monaco',
    match,
    views: [{
      id: 'edit',
      label: 'Edit',
      default: true,
      priority: 50,
      async create(ctx) {
        const host = ctx.host;
        const initial = ctx.readText();
        const fallback = document.createElement('textarea');
        fallback.className = 'editor-textarea';
        fallback.value = initial;
        fallback.spellcheck = false;
        fallback.autocorrect = 'off';
        fallback.autocapitalize = 'off';
        host.appendChild(fallback);
        try {
          const monaco = await Promise.race([
            ctx.state.ensureMonaco(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Monaco timed out')), 4000))
          ]);
          if (!ctx.isActive()) return;
          const model = ctx.tab.model && !ctx.tab.model.isDisposed() ? ctx.tab.model : monaco.editor.createModel(initial, language(ctx.file.path));
          ctx.tab.model = model;
          if (model.getValue() !== ctx.readText()) model.setValue(ctx.readText());
          const editor = monaco.editor.create(host, {
            model,
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            folding: true,
            wordWrap: 'off'
          });
          ctx.tab.editor = editor;
          ctx.addCleanup?.(() => {
            try { editor.dispose(); } catch (_) {}
          });
          if (!ctx.tab.listener) ctx.tab.listener = model.onDidChangeContent(() => {
            if (ctx.tab.view !== 'edit' || !ctx.state.fs) return;
            ctx.writeText(model.getValue());
            ctx.state.updateStatus?.();
          });
          editor.onDidDispose(() => { if (ctx.tab.editor === editor) ctx.tab.editor = null; });
          fallback.remove();
        } catch (_) {}
      }
    }]
  });
})();

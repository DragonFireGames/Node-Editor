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
      html:'html',htm:'html',css:'css',scss:'scss',less:'less',md:'markdown',xml:'xml',yaml:'yaml',yml:'yaml',
      py:'python',pyw:'python',java:'java',kt:'kotlin',c:'c',h:'c',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'cpp',
      sh:'shell',bash:'shell',sql:'sql',ini:'ini',toml:'ini',svg:'html',gltf:'json',frag:'cpp',vert:'cpp',
      hlsl:'cpp',fx:'cpp',wgsl:'plaintext'
    })[ext] || 'plaintext';
  }
  function frame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }
  async function waitForUsableHost(host, maxFrames = 30) {
    for (let i = 0; i < maxFrames; i++) {
      if (!host?.isConnected) return false;
      const rect = host.getBoundingClientRect();
      if (rect.width > 1 && rect.height > 1) return true;
      await frame();
    }
    return !!host;
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
          // The workbench can attach a newly-created nested group during the
          // same activation turn. Do not create Monaco against a zero-sized
          // surface. Keep waiting for a real layout box rather than accepting
          // a connected-but-zero-sized host.
          const usable = await waitForUsableHost(host, 60);
          if (!usable || !ctx.isCurrent?.()) return;

          const monaco = await Promise.race([
            ctx.state.ensureMonaco(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Monaco timed out')), 10000))
          ]);
          if (!ctx.isCurrent?.()) return;

          const model = ctx.tab.model && !ctx.tab.model.isDisposed()
            ? ctx.tab.model
            : monaco.editor.createModel(initial, language(ctx.file.path));
          ctx.tab.model = model;

          const currentText = ctx.readText();
          if (model.getValue() !== currentText) model.setValue(currentText);

          const languageId = language(ctx.file.path);
          // Set the language explicitly both before and after editor creation.
          // The second pass covers startup races where a language contribution
          // registers after editor.main has initialized.
          monaco.editor.setModelLanguage(model, languageId);

          if (!ctx.isCurrent?.()) return;

          window.EditorTheme?.apply?.();
          const editor = monaco.editor.create(host, {
            model,
            theme: window.EditorTheme?.id || 'vs-dark',
            'semanticHighlighting.enabled': true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            folding: true,
            wordWrap: 'off'
          });
          ctx.tab.editor = editor;
          const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => { try { editor.layout(); } catch (_) {} })
            : null;
          ctx.addCleanup?.(() => {
            try { resizeObserver?.disconnect?.(); } catch (_) {}
            try { editor.dispose(); } catch (_) {}
          });
          if (!ctx.tab.listener) ctx.tab.listener = model.onDidChangeContent(() => {
            if (ctx.tab.view !== 'edit' || !ctx.state.fs) return;
            ctx.writeText(model.getValue());
            ctx.state.updateStatus?.();
          });
          editor.onDidDispose(() => { if (ctx.tab.editor === editor) ctx.tab.editor = null; });
          resizeObserver?.observe(host);

          fallback.remove();
          try { editor.layout(); } catch (_) {}
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
              try { monaco.editor.setModelLanguage(model, languageId); } catch (_) {}
              try { editor.layout(); } catch (_) {}
            });
            requestAnimationFrame(() => {
              try { editor.layout(); } catch (_) {}
            });
          }
        } catch (error) {
          // Keep the fallback editor visible and report the failure without
          // breaking the rest of the workbench.
          console.error('Monaco preview failed:', error);
        }
      }
    }]
  });
})();

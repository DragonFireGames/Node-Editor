(function () {
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'audio',
    match(file) { return String(file.mime || '').startsWith('audio/'); },
    views: [{
      id: 'audio-preview',
      label: 'Preview',
      default: true,
      priority: 100,
      create(ctx) {
        const el = document.createElement('audio');
        el.className = 'editor-media';
        el.controls = true;
        el.src = ctx.getURL();
        ctx.host.appendChild(el);
        ctx.addCleanup(() => {
          try { el.pause(); } catch (_) {}
          try { el.removeAttribute('src'); el.load(); } catch (_) {}
        });
      }
    }]
  });
})();

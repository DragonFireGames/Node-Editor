(function () {
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'video',
    match(file) { return String(file.mime || '').startsWith('video/'); },
    views: [{
      id: 'video-preview',
      label: 'Preview',
      default: true,
      priority: 100,
      create(ctx) {
        const el = document.createElement('video');
        el.className = 'editor-media';
        el.controls = true;
        el.src = ctx.getURL();
        ctx.host.appendChild(el);
      }
    }]
  });
})();

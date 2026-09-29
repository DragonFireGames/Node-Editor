(function () {
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'image',
    match(file) { return String(file.mime || '').startsWith('image/'); },
    views: [{
      id: 'image-preview',
      label: 'Preview',
      default: true,
      priority: 100,
      create(ctx) {
        const img = document.createElement('img');
        img.className = 'editor-image';
        img.src = ctx.getURL();
        ctx.host.appendChild(img);
      }
    }]
  });
})();

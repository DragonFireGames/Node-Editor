(function () {
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'image',
    match(file) {
      const mime = String(file.mime || '');
      return mime.startsWith('image/') && !['image/vnd.radiance', 'image/x-exr'].includes(mime);
    },
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

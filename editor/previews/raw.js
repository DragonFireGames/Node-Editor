(function () {
  const textMimes = ['application/json','application/javascript','application/typescript','application/xml','model/gltf+json'];
  function match(file) {
    const mime = String(file.mime || '');
    return mime.startsWith('text/') || textMimes.includes(mime) || mime === 'image/svg+xml';
  }
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'raw',
    match,
    views: [{
      id: 'raw',
      label: 'Raw',
      async create(ctx) {
        const textarea = document.createElement('textarea');
        textarea.className = 'editor-textarea';
        textarea.value = ctx.readText();
        textarea.spellcheck = false;
        textarea.autocorrect = 'off';
        textarea.autocapitalize = 'off';
        textarea.addEventListener('input', () => {
          ctx.writeText(textarea.value);
          ctx.state.updateStatus?.();
        });
        ctx.host.appendChild(textarea);
      }
    }]
  });
})();

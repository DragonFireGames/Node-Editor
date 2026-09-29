(function () {
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'markdown',
    match(file) { return file.mime === 'text/markdown'; },
    views: [{
      id: 'markdown-preview',
      label: 'Preview',
      default: true,
      priority: 100,
      create(ctx) {
        const body = document.createElement('div');
        body.className = 'editor-markdown';
        const text = ctx.readText();
        if (window.showdown?.Converter) body.innerHTML = new showdown.Converter().makeHtml(text);
        else body.textContent = text;
        ctx.host.appendChild(body);
      }
    }]
  });
})();

(function () {
  function internalPath(ctx, value) {
    if (!value || /^(?:[a-z]+:|\/\/|data:|#)/i.test(value)) return null;
    const path = ctx.resolvePath(value);
    return ctx.exists(path) ? path : null;
  }
  async function makeResourceURL(ctx, path, attr) {
    if (ctx.file.mime === 'text/css') return ctx.getURL(path, 'text/css');
    return ctx.getURL(path);
  }
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'html',
    match(file) { return file.mime === 'text/html' || file.mime === 'text/html; charset=utf-8'; },
    views: [{
      id: 'html-preview',
      label: 'Preview',
      priority: 10,
      async create(ctx) {
        const iframe = document.createElement('iframe');
        iframe.className = 'editor-html-preview';
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
        iframe.srcdoc = ctx.readText();
        ctx.host.appendChild(iframe);
        ctx.addCleanup(() => iframe.remove());
        iframe.addEventListener('load', async () => {
          try {
            const doc = iframe.contentDocument;
            if (!doc) return;
            for (const el of doc.querySelectorAll('[src],[href]')) {
              const attr = el.hasAttribute('src') ? 'src' : 'href';
              const path = internalPath(ctx, el.getAttribute(attr));
              if (path) el.setAttribute(attr, await makeResourceURL(ctx, path, attr));
            }
            for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
              const href = link.getAttribute('href');
              const path = internalPath(ctx, href);
              if (!path) continue;
              const css = ctx.readText(path).replace(/url\(([^)]+)\)/gi, (m, raw) => {
                const value = raw.trim().replace(/^['"]|['"]$/g, '');
                const asset = internalPath({ ...ctx, resolvePath: rel => new URL(rel, 'http://editor.local/' + path).pathname.replace(/^\//, '') }, value);
                return asset ? `url("${ctx.getURL(asset)}")` : m;
              });
              const style = doc.createElement('style');
              style.textContent = css;
              link.replaceWith(style);
            }
          } catch (_) {}
        });
      }
    }]
  });
})();

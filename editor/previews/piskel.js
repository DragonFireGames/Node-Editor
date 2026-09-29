(function () {
  function toFile(dataURL, filename) {
    const parts = String(dataURL || '').split(',');
    const header = parts.length > 1 ? parts[0] : 'data:image/png;base64';
    const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
    const binary = atob(parts.length > 1 ? parts[1] : parts[0]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
  }
  async function waitForPiskel(frame) {
    return await new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const pskl = frame.contentWindow?.pskl;
        if (pskl) { clearInterval(timer); resolve(pskl); return; }
        if (Date.now() - start > 15000) { clearInterval(timer); reject(new Error('Piskel failed to initialize')); }
      }, 25);
    });
  }
  async function loadExisting(ctx, pskl, sprite) {
    if (!sprite) {
      const dataURL = await ctx.dataURL();
      frameImport(ctx.host.querySelector('.editor-piskel'), toFile(dataURL, ctx.file.name));
      return;
    }
    try {
      const data = JSON.parse(sprite);
      const piskel = data.piskel;
      const descriptor = new pskl.model.piskel.Descriptor(piskel.name, piskel.description, true);
      pskl.utils.serialization.Deserializer.deserialize(data, value => {
        value.setDescriptor(descriptor);
        pskl.app.piskelController.setPiskel(value);
        pskl.app.previewController.setFPS(piskel.fps);
      });
    } catch (_) {
      const dataURL = await ctx.dataURL();
      frameImport(ctx.host.querySelector('.editor-piskel'), toFile(dataURL, ctx.file.name));
    }
  }
  function frameImport(frame, file) {
    const dollar = frame.contentWindow?.$;
    if (dollar?.publish) dollar.publish('DIALOG_DISPLAY', { dialogId: 'import-image', initArgs: file });
  }
  async function create(ctx) {
    const iframe = document.createElement('iframe');
    iframe.className = 'editor-piskel';
    iframe.src = new URL('editor/previews/piskel/index.html', location.href).href;
    ctx.host.appendChild(iframe);
    let saveFunction = null;
    const ready = waitForPiskel(iframe);
    ctx.addCleanup(() => { saveFunction = null; iframe.remove(); });
    const pskl = await ready;
    if (!ctx.isActive()) return;
    saveFunction = async () => {
      try {
        const settings = pskl.app.settingsController;
        settings._loadSetting.call(settings, 'export');
        const canvas = settings.currentController.pngExportController.getFramesheetAsCanvas();
        const dataURL = canvas.toDataURL();
        const comma = dataURL.indexOf(',');
        const binary = atob(dataURL.slice(comma + 1));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        ctx.writeBinary(bytes);
        const json = pskl.app.piskelController.serialize();
        ctx.writeText(json, ctx.file.path + '.piskel');
        settings.closeDrawer?.();
        ctx.state.fileManager?.refresh?.();
        ctx.markDirty();
      } catch (e) {
        console.error('Piskel save failed:', e);
      }
    };
    if (pskl.app.shortcutService?.addShortcut) pskl.app.shortcutService.addShortcut('ctrl+s', saveFunction);
    if (pskl.app.settingsController) {
      const settings = pskl.app.settingsController;
      const original = settings.loadSetting;
      if (typeof original === 'function') {
        settings.loadSetting = function (name) {
          if (name === 'save') return saveFunction();
          return original.call(settings, name);
        };
        ctx.addCleanup(() => { settings.loadSetting = original; });
      }
    }
    const sprite = ctx.exists(ctx.file.path + '.piskel') ? ctx.readText(ctx.file.path + '.piskel') : '';
    await loadExisting(ctx, pskl, sprite);
  }
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'piskel',
    match(file) {
      const mime = String(file.mime || '');
      return mime.startsWith('image/') && !['image/svg+xml','image/vnd.radiance','image/x-exr'].includes(mime);
    },
    views: [{ id: 'piskel', label: 'Piskel', priority: 30, create }]
  });
})();

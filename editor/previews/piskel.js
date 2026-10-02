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
        if (pskl) {
          clearInterval(timer);
          resolve(pskl);
          return;
        }
        if (Date.now() - start > 15000) {
          clearInterval(timer);
          reject(new Error('Piskel failed to initialize'));
        }
      }, 25);
    });
  }

  function isEmptyBinary(data) {
    if (data == null) return true;
    if (typeof data === 'string') return data.length === 0;
    return typeof data.length === 'number' && data.length === 0;
  }

  async function loadExisting(ctx, pskl, sprite, hasImageData) {
    // A newly-created empty image is deliberately left as Piskel's blank
    // canvas. Do not send an empty File through Piskel's image importer.
    if (!hasImageData) return;

    if (!sprite) {
      const dataURL = await ctx.dataURL();
      if (!dataURL) return;
      frameImport(ctx.host.querySelector('.editor-piskel'), toFile(dataURL, ctx.file.name));
      return;
    }

    try {
      const data = JSON.parse(sprite);
      const piskel = data.piskel;
      const descriptor = new pskl.model.piskel.Descriptor(
        piskel.name,
        piskel.description,
        true
      );
      pskl.utils.serialization.Deserializer.deserialize(data, value => {
        value.setDescriptor(descriptor);
        pskl.app.piskelController.setPiskel(value);
        pskl.app.previewController.setFPS(piskel.fps);
      });
    } catch (_) {
      const dataURL = await ctx.dataURL();
      if (!dataURL) return;
      frameImport(ctx.host.querySelector('.editor-piskel'), toFile(dataURL, ctx.file.name));
    }
  }

  function frameImport(frame, file) {
    const dollar = frame?.contentWindow?.$;
    if (dollar?.publish) {
      dollar.publish('DIALOG_DISPLAY', {
        dialogId: 'import-image',
        initArgs: file
      });
    }
  }

  function bytesFromDataURL(dataURL) {
    const comma = String(dataURL || '').indexOf(',');
    if (comma < 0) return new Uint8Array();
    const binary = atob(dataURL.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function getAutoSavePreference() {
    try {
      const stored = localStorage.getItem('node-editor.piskel.autoSave');
      return stored === null ? true : stored === 'true';
    } catch (_) {
      return false;
    }
  }

  function setAutoSavePreference(value) {
    try {
      localStorage.setItem('node-editor.piskel.autoSave', value ? 'true' : 'false');
    } catch (_) {}
  }

  async function create(ctx) {
    const shell = document.createElement('div');
    shell.style.cssText = 'position:relative;width:100%;height:100%;display:flex;flex-direction:column;min-height:0;';

    const iframe = document.createElement('iframe');
    iframe.className = 'editor-piskel';
    iframe.style.cssText = 'border:0;width:100%;height:100%;flex:1;min-height:0;display:block;';
    iframe.src = new URL('editor/previews/piskel/index.html', location.href).href;

    shell.appendChild(iframe);
    ctx.host.appendChild(shell);

    let saveFunction = null;
    let autoSaveTimer = null;
    let disposed = false;

    const ready = waitForPiskel(iframe);

    const cleanup = () => {
      disposed = true;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      saveFunction = null;
      iframe.remove();
      shell.remove();
    };

    ctx.addCleanup(cleanup);

    function scheduleAutoSave(delay = 750) {
      if (!getAutoSavePreference() || !saveFunction || disposed) return;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        saveFunction(true);
      }, delay);
    }

    const pskl = await ready;
    if (disposed) return;

    const settings = pskl.app.settingsController;
    const originalLoadSetting = settings?.loadSetting;

    saveFunction = async function (automatic = false) {
      if (disposed) return;

      try {
        // The old implementation called settings._loadSetting, but that
        // private alias is not guaranteed to exist in the packaged Piskel.
        // Keep the original method instead and call it with the correct
        // receiver before reading the PNG export controller.
        if (typeof originalLoadSetting === 'function') {
          originalLoadSetting.call(settings, 'export');
        }

        const canvas = settings?.currentController?.pngExportController?.getFramesheetAsCanvas?.();
        if (!canvas) throw new Error('Piskel PNG export controller is unavailable');

        const dataURL = canvas.toDataURL('image/png');
        const bytes = bytesFromDataURL(dataURL);
        if (!bytes.length) throw new Error('Piskel produced an empty PNG');

        ctx.writeBinary(bytes, ctx.file.path);

        const json = pskl.app.piskelController.serialize();
        ctx.writeText(json, ctx.file.path + '.piskel');
        ctx.markDirty(ctx.file.path);

        settings?.closeDrawer?.();
        saveStatus.textContent = automatic ? 'Auto-saved' : 'Saved';
        window.setTimeout(() => {
          if (!disposed) saveStatus.textContent = '';
        }, 1200);
      } catch (e) {
        saveStatus.textContent = 'Save failed';
        console.error('Piskel save failed:', e);
      }
    };

    if (pskl.app.shortcutService?.addShortcut) {
      pskl.app.shortcutService.addShortcut('ctrl+s', saveFunction);
    }

    if (settings && typeof originalLoadSetting === 'function') {
      settings.loadSetting = function (name) {
        if (name === 'save') return saveFunction(false);
        return originalLoadSetting.call(settings, name);
      };

      ctx.addCleanup(() => {
        settings.loadSetting = originalLoadSetting;
      });
    }

    const sprite = ctx.exists(ctx.file.path + '.piskel')
      ? ctx.readText(ctx.file.path + '.piskel')
      : '';

    const imageData = ctx.readBinary(ctx.file.path);
    const hasImageData = !isEmptyBinary(imageData);

    await loadExisting(ctx, pskl, sprite, hasImageData);

    // Piskel publishes PISKEL_RESET for drawing/editing changes. Subscribe
    // only after the initial image/project has been loaded so opening a file
    // doesn't immediately auto-save it back over itself.
    const dollar = iframe.contentWindow?.$;
    const events = iframe.contentWindow?.Events;
    if (dollar?.subscribe && events?.PISKEL_RESET) {
      const onChange = () => scheduleAutoSave();
      dollar.subscribe(events.PISKEL_RESET, onChange);
      ctx.addCleanup(() => {
        try { dollar.unsubscribe(events.PISKEL_RESET, onChange); } catch (_) {}
      });
    }
  }

  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'piskel',
    match(file) {
      const mime = String(file.mime || '');
      return mime.startsWith('image/') &&
        !['image/svg+xml', 'image/vnd.radiance', 'image/x-exr'].includes(mime);
    },
    views: [{ id: 'piskel', label: 'Piskel', priority: 30, create }]
  });
})();

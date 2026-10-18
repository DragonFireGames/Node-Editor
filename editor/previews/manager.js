(function () {
  class EditorPreviewManager {
    constructor(state) {
      this.state = state;
      this.providers = [];
    }
    register(provider) {
      if (!provider || typeof provider.match !== 'function' || !Array.isArray(provider.views)) return provider;
      this.providers.push(provider);
      return provider;
    }
    getViews(file) {
      const views = [];
      for (const provider of this.providers) {
        let matched = false;
        try { matched = !!provider.match(file, this.state); } catch (_) {}
        if (!matched) continue;
        for (const view of provider.views) {
          if (!view || !view.id || typeof view.create !== 'function') continue;
          try {
            if (typeof view.match === 'function' && !view.match(file, this.state)) continue;
          } catch (_) {
            continue;
          }
          views.push({ ...view, provider });
        }
      }
      return views.filter((view, i, all) => all.findIndex(x => x.id === view.id) === i);
    }
    getView(file, id) {
      return this.getViews(file).find(view => view.id === id) || null;
    }
    getDefaultView(file) {
      const views = this.getViews(file);
      const defaults = views.filter(view => view.default);
      return (defaults.length ? defaults : views).sort((a, b) => (b.priority || 0) - (a.priority || 0))[0] || null;
    }
    getLabels(file) {
      return this.getViews(file).map(view => ({ id: view.id, label: view.label || view.id }));
    }
    async render(file, id, host, group) {
      const view = this.getView(file, id);
      if (!view) return false;
      const tab = group?.tabs?.find(t => t.id === file.id) || file;

      // Keep a live preview instance for every view of a file. Switching tabs,
      // moving groups, or changing between preview views must detach/reattach
      // the existing DOM instead of destroying embedded editors such as Piskel.
      const instances = (tab._previewInstances ||= new Map());
      let instance = instances.get(id);

      if (instance?.host) {
        if (instance.host.parentNode !== host) host.appendChild(instance.host);
        const frame = instance.host.querySelector?.('iframe');
        if (frame?.contentWindow) {
          try { frame.contentWindow.dispatchEvent(new Event('resize')); } catch (_) {}
        }
        if (instance.promise) {
          try { await instance.promise; } catch (_) {}
        }
        tab._previewHost = instance.host;
        tab._previewViewId = id;
        return !instance.host.dataset.disposed;
      }

      const generation = (tab._previewGeneration ||= 0) + 1;
      tab._previewGeneration = generation;
      const previewHost = document.createElement('div');
      previewHost.className = 'editor-preview-surface';
      previewHost.style.cssText = 'position:relative;width:100%;height:100%;min-height:0;overflow:hidden;';
      host.appendChild(previewHost);

      instance = {
        id,
        host: previewHost,
        promise: null,
        cleanups: [],
        urls: [],
        generation
      };
      instances.set(id, instance);
      tab._previewHost = previewHost;
      tab._previewViewId = id;

      const activation = tab._viewActivation || 0;
      const context = {
        state: this.state,
        file,
        tab,
        host: previewHost,
        group,
        manager: this,
        readText: path => this.state.fs.readFileSync(path || file.path, 'utf8') || '',
        readBinary: path => this.state.fs.readFileSync(path || file.path, 'binary'),
        exists: path => !!this.state.fs?.existsSync(path || file.path),
        writeText: (value, path = file.path) => {
          this.state.fs.writeFileSync(path, value);
          this.state.markDirty?.(path);
        },
        writeBinary: (value, path = file.path) => {
          this.state.fs.writeFileSync(path, value);
          this.state.markDirty?.(path);
        },
        resolvePath: relative => {
          try { return new URL(relative, 'http://editor.local/' + file.path).pathname.replace(/^\//, ''); } catch (_) { return relative; }
        },
        dataURL: async path => {
          const p = path || file.path;
          const data = this.state.fs.readFileSync(p, 'binary');
          if (!data) return null;
          let binary = '';
          for (const byte of data) binary += String.fromCharCode(byte);
          return `data:${this.state.fs && EditorInferMime ? EditorInferMime(p) : 'application/octet-stream'};base64,${btoa(binary)}`;
        },
        getURL: (path = file.path, type) => {
          const data = this.state.fs.readFileSync(path, 'binary');
          if (!data) return null;
          const url = URL.createObjectURL(new Blob([data], { type: type || (EditorInferMime ? EditorInferMime(path) : 'application/octet-stream') }));
          instance.urls.push(url);
          return url;
        },
        markDirty: path => {
          this.state.markDirty?.(path || file.path);
          this.state.updateStatus?.();
        },
        isActive: () => group?.active === file.id && tab.view === id && tab._viewActivation === activation,
        isCurrent: () => instances.get(id) === instance && !previewHost.dataset.disposed,
        addCleanup: cleanup => {
          if (typeof cleanup !== 'function') return;
          instance.cleanups.push(cleanup);
        }
      };

      try {
        const promise = Promise.resolve().then(() => view.create(context));
        instance.promise = promise;
        await promise;
      } catch (error) {
        if (context.isCurrent()) this.dispose(tab, id);
        throw error;
      } finally {
        if (instances.get(id) === instance) instance.promise = null;
      }
      return context.isCurrent();
    }
    dispose(file, id = null) {
      if (!file) return;
      const instances = file._previewInstances;
      if (!instances) return;

      const disposeInstance = (key, instance) => {
        if (!instance) return;
        instance.host.dataset.disposed = '1';
        for (const cleanup of instance.cleanups || []) {
          try { cleanup(); } catch (_) {}
        }
        instance.cleanups = [];
        for (const url of instance.urls || []) {
          try { URL.revokeObjectURL(url); } catch (_) {}
        }
        instance.urls = [];
        try { instance.host.remove(); } catch (_) {}
        instances.delete(key);
      };

      if (id != null) {
        disposeInstance(id, instances.get(id));
      } else {
        for (const [key, instance] of [...instances]) disposeInstance(key, instance);
      }

      file._previewGeneration = (file._previewGeneration || 0) + 1;
      file._previewHost = null;
      file._previewViewId = null;
      file._previewPromise = null;
      if (!instances.size) delete file._previewInstances;
    }
  }
  window.EditorPreviewManager = EditorPreviewManager;
})();

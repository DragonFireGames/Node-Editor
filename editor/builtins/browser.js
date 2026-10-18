(function() {
  const factories = window.EditorBuiltinFactories = window.EditorBuiltinFactories || {};
  factories.browser = function(ctx) {
    const state = ctx.state;
    function renderBrowser(g, t) {
    const wrap = document.createElement('div');
    wrap.className = 'builtin-browser';
    const frame = document.createElement('iframe');
    frame.id = 'browser-frame-' + g.id;
    const initialBrowserUrl = state.runConfig?.publicUrl?.() || 'http://localhost:3000/';
    const browserParams = new URLSearchParams({start: initialBrowserUrl, default: initialBrowserUrl, defer: '1'});
    if (state.behavior.hideBrowserBar) browserParams.set('hideBrowserBar', '1');
    frame.src = 'browser/browser.html?' + browserParams.toString();
    const bar = document.createElement('div');
    bar.className = 'builtin-browser-toolbar';
    const status = document.createElement('span');
    status.className = 'browser-status';
    status.textContent = 'Starting browser…';
    const run = document.createElement('button');
    run.textContent = 'Run';
    run.onclick = () => ctx.runConfigured().catch(ctx.logError);
    const full = document.createElement('button');
    full.textContent = 'Fullscreen';
    full.onclick = () => {
      const active = wrap.classList.toggle('fullscreen');
      full.textContent = active ? 'Exit Fullscreen' : 'Fullscreen';
    };
    bar.append(status, run, full);
    wrap.append(frame, bar);
    g.viewBody.appendChild(wrap);
    const info = {
      frame,
      network: null,
      ready: null
    };
    state.browserTabs.set(t.id, info);
    let resolveReady, rejectReady;
    info.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let done = false;
    const finish = () => {
      try {
        const win = frame.contentWindow;
        const net = win?.browserNetwork;
        if (!net || typeof win.loadBrowserURL !== 'function') return;
        state.browserFrame = frame;
        state.browserNetwork = net;
        info.network = net;
        try {
          window.__sharedBrowserNetwork = net;
        } catch (_) {}
        state.runConfig?.bindNetwork?.(net);
        try {
          const defaultUrl = state.runConfig?.publicUrl?.() || state.runConfig?.config?.domain || 'http://localhost:3000/';
          win.setBrowserDefaultTab?.(defaultUrl);
          // The Browser's very first tab is created with defer=1 so it cannot
          // race the runtime endpoint during startup. If a static runtime is
          // already installed (for example when reopening the Browser tab),
          // start that deferred tab now. Node waits until its server is live
          // and is navigated by runConfigured after terminalCommand.
          if (state.staticEndpoint && typeof win.loadBrowserURL === 'function') {
            void win.loadBrowserURL(defaultUrl, true).catch(() => {});
          }
        } catch (_) {}
        state.runDebugRefresh?.();
        status.textContent = 'Browser ready';
        if (!done) {
          done = true;
          resolveReady(net);
        }
      } catch (e) {
        if (!done) {
          done = true;
          rejectReady(e);
        }
      }
    };
    frame.addEventListener('load', finish);
    const readyPoll = setInterval(() => {
      if (done) {
        clearInterval(readyPoll);
        return;
      }
      finish();
    }, 50);
    setTimeout(() => {
      clearInterval(readyPoll);
      if (!done) {
        done = true;
        status.textContent = 'Browser failed to initialize';
        rejectReady(new Error('Browser emulator did not initialize within 10 seconds.'));
      }
    }, 10000);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && wrap.classList.contains('fullscreen')) {
        wrap.classList.remove('fullscreen');
        full.textContent = 'Fullscreen';
      }
    });
  }
    function isBrowserFrameReady(frame) {
    try {
      return !!frame && !!frame.contentWindow && typeof frame.contentWindow.loadBrowserURL === 'function';
    } catch (_) {
      return false;
    }
  }
    async function ensureBrowser() {
    if (state.browserFrame && state.browserNetwork && isBrowserFrameReady(state.browserFrame)) return state.browserNetwork;

    for (const [tabId, info] of state.browserTabs.entries()) {
      if (!info) continue;
      let net = info.network || null;
      if (!net && info.ready) {
        try {
          net = await info.ready;
        } catch (e) {
          continue;
        }
      }
      if (!net || !info.frame || !info.frame.contentWindow) continue;
      state.browserNetwork = net;
      state.browserFrame = info.frame;

      // A workbench switch detaches the Browser view from the DOM without
      // destroying it. Reattach that existing tab instead of creating another
      // Browser and, importantly, keep its shared Network object.
      for (const instance of Workbench.getInstances?.() || [state.workbench]) for (const g of instance.groups.values()) {
        const t = g.tabs.find(x => x.id === tabId);
        if (!t) continue;
        if (t._viewElement && t._viewElement.parentNode !== g.viewBody) {
          try {
            (g.ownerWorkbench || state.workbench).activateTab(g, t.id);
          } catch (_) {}
        }
        break;
      }
      if (isBrowserFrameReady(info.frame)) return net;
    }

    const g = state.workbench.getFirstLeaf();
    const t = ctx.openBuiltin('browser', g);
    const info = state.browserTabs.get(t.id);
    if (!info) throw new Error('Browser tab could not be created.');
    const net = await info.ready;
    state.browserFrame = info.frame;
    state.browserNetwork = net;
    if (!isBrowserFrameReady(info.frame)) {
      for (let i = 0; i < 100 && !isBrowserFrameReady(info.frame); i++) await new Promise(r => setTimeout(r, 50));
    }
    if (!isBrowserFrameReady(info.frame)) throw new Error('Browser tab was created but its load API is not ready.');
    return net;
  }
    async function navigatePreview() {
    const browser = state.browserFrame;
    if (!browser) throw new Error('Browser tab is not ready.');
    const c = state.runConfig?.config || ({});
    let domain = String(c.domain || 'http://localhost:3000').trim();
    if (!(/^[a-z][a-z0-9+.-]*:\/\//i).test(domain)) domain = 'http://' + domain;
    domain = domain.replace(/\/+$/, '');
    const publicPath = String(c.path || '/').trim() || '/';
    const p = publicPath.startsWith('/') ? publicPath : '/' + publicPath;
    const url = domain + (p === '/' ? '/' : p);
    const win = browser.contentWindow;
    const nav = win?.loadBrowserURL;
    if (typeof nav === 'function') {
      await nav(url, true);
      return;
    }
    throw new Error('Browser load API is not ready.');
  }
    function dispose(t) {
      const info = t?.id ? state.browserTabs.get(t.id) : null;
      const frame = info?.frame || t?._viewElement?.querySelector?.('iframe');
      if (!frame) return;
      try {
        const win = frame.contentWindow;
        const stopMedia = doc => {
          try {
            doc?.querySelectorAll?.('audio,video').forEach(media => {
              try { media.pause(); } catch (_) {}
              try { media.removeAttribute('src'); media.load(); } catch (_) {}
              try { media.querySelectorAll?.('source').forEach(source => source.removeAttribute('src')); } catch (_) {}
            });
          } catch (_) {}
        };
        stopMedia(win?.document);
        for (const browserTab of win?.tabs || []) {
          try { stopMedia(browserTab?.iframe?.contentDocument || browserTab?.iframe?.contentWindow?.document); } catch (_) {}
          try { browserTab?.iframe?.removeAttribute('src'); } catch (_) {}
        }
      } catch (_) {}
      try { frame.removeAttribute('src'); } catch (_) {}
      try { frame.remove(); } catch (_) {}
      if (t?.id) state.browserTabs.delete(t.id);
      if (state.browserFrame === frame) {
        state.browserFrame = null;
        state.browserNetwork = null;
      }
    }

    return {
      title: 'Browser',
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 8h18M7 12h10M7 16h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      render: renderBrowser,
      isReady: isBrowserFrameReady,
      ensure: ensureBrowser,
      navigatePreview,
      dispose
    };
  };
})();

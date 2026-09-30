(function() {
  const factories = window.EditorBuiltinFactories = window.EditorBuiltinFactories || {};
  factories.peer = function(ctx) {
    const state = ctx.state;
    function peerServerDomain() {
    return String(state.runConfig?.config?.domain || 'http://localhost:3000/').trim();
  }
    function peerServerOrigin() {
    const domain = peerServerDomain();
    try { return new URL(domain).origin; } catch (_) { return domain.replace(/\/+$/, ''); }
  }
    function getPeerRuntimeEndpoint() {
    if (!state.peerRuntimeEndpoint) {
      state.peerRuntimeEndpoint = {
        enabled: true,
        __editorPeerRuntimeEndpoint: true,
        async handleRequest(request, type) {
          const endpoint = state.staticEndpoint || state.nodeEmulator?.endpoint;
          if (!endpoint || typeof endpoint.handleRequest !== 'function') return null;
          return await endpoint.handleRequest(request, type);
        },
        async handleSocket(url, protocols) {
          const endpoint = state.staticEndpoint || state.nodeEmulator?.endpoint;
          if (!endpoint || typeof endpoint.handleSocket !== 'function') return null;
          return await endpoint.handleSocket(url, protocols);
        }
      };
    }
    return state.peerRuntimeEndpoint;
  }
    async function preparePeerEndpoint() {
    const net = state.browserNetwork || await ctx.ensureBrowser();
    state.runConfig?.detect?.();
    const c = state.runConfig?.config || {};
    await ctx.setupRuntime(net);
    if (c.serverType === 'node') {
      if (!state.nodeEmulator) throw new Error('Node runtime is not ready.');
      const terminal = ctx.getOrOpenTerminal();
      const terminalView = state.terminalTabs.get(terminal.id);
      terminalView?.attach(state.nodeEmulator);
      if (c.nodeCommand) await terminalView?.runCommand(c.nodeCommand);
      const ready = await state.nodeEmulator.waitForServer?.(10000, 50);
      if (!ready) throw new Error('Node command finished, but no listening server was created.');
    }
    return getPeerRuntimeEndpoint();
  }
    async function stopPeerServer(t) {
    const info = state.peerServers.get(t?.id);
    if (!info) return;
    state.peerServers.delete(t.id);
    try { await info.server?.close?.(); } catch (_) {}
    if (!state.peerServers.size) { try { window.keepAlive?.disable?.(); } catch (_) {} }
    try { info.frame?.remove(); } catch (_) {}
    info.server = null;
    if (info.status) info.status.textContent = 'Stopped';
    if (info.runButton) info.runButton.disabled = false;
    if (info.stopButton) info.stopButton.disabled = true;
    if (info.openButton) info.openButton.disabled = true;
    if (info.layer) info.layer.disabled = false;
    if (info.pagePath) info.pagePath.disabled = false;
    if (info.result) info.result.value = '';
  }
    function renderPeerServer(g, t) {
    const wrap = document.createElement('div');
    wrap.className = 'builtin-peer-server';
    const title = document.createElement('h2');
    title.textContent = 'Peer Server';
    const description = document.createElement('p');
    description.textContent = 'Run this project as a PeerJS-backed server. Other browsers can open the generated Preview URL with the same peer layer.';
    const form = document.createElement('div');
    form.className = 'peer-server-form';
    const layerLabel = document.createElement('label');
    layerLabel.textContent = 'Peer Layer';
    const layer = document.createElement('input');
    layer.type = 'text'; layer.value = 'peer'; layer.placeholder = 'peer'; layer.autocomplete = 'off';
    const domainLabel = document.createElement('label');
    domainLabel.textContent = 'Project Domain';
    const domain = document.createElement('input');
    domain.type = 'text'; domain.readOnly = true;
    const pathLabel = document.createElement('label');
    pathLabel.textContent = 'Page Path';
    const pagePath = document.createElement('input');
    pagePath.type = 'text'; pagePath.placeholder = '/'; pagePath.autocomplete = 'off';
    const actions = document.createElement('div');
    actions.className = 'peer-server-actions';
    const run = document.createElement('button');
    run.textContent = 'Run Peer Server'; run.className = 'primary';
    const stop = document.createElement('button');
    stop.textContent = 'Stop'; stop.disabled = true;
    const open = document.createElement('button');
    open.textContent = 'Open Result in New Tab'; open.disabled = true;
    actions.append(run, stop, open);
    const status = document.createElement('div');
    status.className = 'peer-server-status'; status.textContent = 'Stopped';
    const result = document.createElement('input');
    result.className = 'peer-server-result'; result.readOnly = true; result.placeholder = 'Preview URL';
    form.append(layerLabel, layer, domainLabel, domain, pathLabel, pagePath, actions, status, result);
    wrap.append(title, description, form);
    g.viewBody.appendChild(wrap);
    const savedPeerLayer = String(state.peerSettings?.layer || '').trim() || ctx.makePeerLayer();
    const savedPagePath = ctx.normalizePeerPagePath(state.peerSettings?.pagePath);
    state.peerSettings = {layer: savedPeerLayer, pagePath: savedPagePath};
    ctx.saveProjectMetadata();
    const info = {server:null,frame:null,status,runButton:run,stopButton:stop,openButton:open,result,layer,domain,pagePath,layerValue:savedPeerLayer,resultUrl:''};
    layer.value = savedPeerLayer;
    pagePath.value = savedPagePath;
    const updateDomain = () => { domain.value = peerServerDomain(); };
    const buildResult = () => {
      const url = new URL('preview.html', location.href);
      const path = ctx.normalizePeerPagePath(pagePath.value);
      url.searchParams.set('peerLayer', layer.value.trim());
      url.searchParams.set('u', peerServerOrigin() + path);
      return url.href;
    };
    const savePeerSettings = () => {
      state.peerSettings.layer = layer.value.trim() || state.peerSettings.layer || ctx.makePeerLayer();
      state.peerSettings.pagePath = ctx.normalizePeerPagePath(pagePath.value);
      layer.value = state.peerSettings.layer;
      pagePath.value = state.peerSettings.pagePath;
      ctx.saveProjectMetadata();
      state.markDirty?.('editor/project.json');
    };
    const fail = message => { status.textContent = message; status.classList.add('error'); };
    layer.addEventListener('input', () => { status.classList.remove('error'); savePeerSettings(); if (!info.server) result.value = ''; });
    pagePath.addEventListener('input', () => { savePeerSettings(); if (!info.server) result.value = ''; });
    run.onclick = async () => {
      savePeerSettings();
      const selectedLayer = state.peerSettings.layer;
      if (!selectedLayer || info.server) return;
      status.classList.remove('error'); run.disabled = true; stop.disabled = true; open.disabled = true; result.value = '';
      status.textContent = 'Starting project…'; updateDomain();
      try {
        const frame = document.createElement('iframe');
        frame.className = 'peer-host-frame';
        frame.src = 'browser/peer-host.html?peerLayer=' + encodeURIComponent(selectedLayer);
        wrap.appendChild(frame); info.frame = frame;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Peer server host failed to initialize.')), 10000);
          frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, {once:true});
        });
        const hostWindow = frame.contentWindow;
        if (typeof hostWindow.peerServerExists === 'function' && await hostWindow.peerServerExists(domain.value.trim())) throw new Error('pick a new layer');
        const endpoint = await preparePeerEndpoint();
        if (!endpoint) throw new Error('Project runtime endpoint is not available.');
        const server = await hostWindow.createPeerServer(endpoint, peerServerDomain());
        try { await server.ready; }
        catch (error) {
          if (/unavailable-id|already registered/i.test(String(error?.message || error))) throw new Error('pick a new layer');
          throw error;
        }
        info.server = server; info.hostWindow = hostWindow; info.layerValue = selectedLayer;
        state.peerServers.set(t.id, info);
        server.addEventListener?.('close', () => {
          if (state.peerServers.get(t.id)?.server === server) void stopPeerServer(t);
        });
        try { window.keepAlive?.enable?.(); window.keepAlive?.start?.(); } catch (_) {}
        result.value = buildResult(); info.resultUrl = result.value; status.textContent = 'Running';
        stop.disabled = false; open.disabled = false; layer.disabled = true; pagePath.disabled = true;
      } catch (error) {
        try { await info.server?.close?.(); } catch (_) {}
        try { info.frame?.remove(); } catch (_) {}
        info.server = null; info.frame = null; info.hostWindow = null;
        layer.disabled = false; run.disabled = false; stop.disabled = true; open.disabled = true;
        fail(/pick a new layer/i.test(String(error?.message || error)) ? 'pick a new layer' : String(error?.message || error));
      }
    };
    stop.onclick = () => stopPeerServer(t);
    open.onclick = () => { if (info.server && result.value) window.open(result.value, '_blank', 'noopener'); };
    updateDomain();
    const existing = state.peerServers.get(t.id);
    if (existing) {
      const savedLayer = existing.layerValue || savedPeerLayer;
      const savedResult = existing.resultUrl || existing.result?.value || '';
      Object.assign(existing, {status,runButton:run,stopButton:stop,openButton:open,result,layer,domain,pagePath});
      layer.value = savedLayer; pagePath.value = savedPagePath; result.value = savedResult; layer.disabled = true; pagePath.disabled = true; run.disabled = true; stop.disabled = false; open.disabled = !savedResult; status.textContent = 'Running';
    }
  }
    return {
      title: 'Peer Server',
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="17" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.5 10.8 6-2.7M8.5 13.2l6 2.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      render: renderPeerServer,
      stop: stopPeerServer,
      prepare: preparePeerEndpoint,
      domain: peerServerDomain,
      origin: peerServerOrigin,
      runtimeEndpoint: getPeerRuntimeEndpoint
    };
  };
})();

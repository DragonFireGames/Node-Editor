(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.RunDebug = function(options) {
    const {state, tree, runConfigured, logError} = options;
    let render = () => {};
    function show() {
      tree.classList.remove('activity-collapsed');
      tree.innerHTML = '<div class="run-debug-sidebar"><div class="activity-sidebar-title">Run and Debug</div><div class="run-debug-actions"><button id="sidebar-run" class="primary">Run</button><button id="sidebar-refresh-endpoints">Refresh</button></div><div class="run-debug-section"><div class="run-debug-section-title">Browser Network Endpoints</div><div id="endpoint-list"></div></div></div>';
      const list = tree.querySelector('#endpoint-list');
      render = () => {
        const net = state.browserNetwork;
        const info = net?.getEndpointInfo ? net.getEndpointInfo() : (net?.endpoints || []).map((ep, index) => ({
          index,
          name: ep?.constructor?.name || 'Endpoint',
          enabled: ep?.enabled !== false,
          runtime: !!ep?.__editorRuntimeEndpoint,
          proxy: ep?.proxy || null,
          domain: ep?.domain || null,
          path: ep?.path || null,
          rootfolder: ep?.rootfolder || null
        }));
        if (!info.length) {
          list.innerHTML = '<div class="endpoint-empty">Browser network is not ready.</div>';
          return;
        }
        list.innerHTML = info.map(ep => {
          const detail = ep.runtime ? ep.domain || 'Runtime' : ep.proxy || ep.domain || '';
          return `<div class="endpoint-row"><div class="endpoint-name"><span>${ep.index + 1}. ${ep.name}</span><span class="endpoint-status ${ep.enabled ? 'enabled' : 'disabled'}">${ep.enabled ? 'ON' : 'OFF'}</span></div><div class="endpoint-detail">${ep.runtime ? 'Runtime endpoint • ' : ''}${detail || 'Default browser endpoint'}</div></div>`;
        }).join('');
      };
      render();
      const net = state.browserNetwork;
      if (net?.addEventListener && !tree._endpointListener) {
        const listener = () => render();
        net.addEventListener('endpointschange', listener);
        tree._endpointListener = listener;
      }
      tree.querySelector('#sidebar-refresh-endpoints').onclick = render;
      tree.querySelector('#sidebar-run').onclick = () => runConfigured().catch(logError);
      state.runDebugRefresh = render;
    }
    return {show, refresh: () => render()};
  };
})();

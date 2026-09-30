
const originalFetch = window.fetch.bind(window);
const originalWebSocket = window.WebSocket;
window.wait = t=>new Promise(r=>setTimeout(r,t));
let activeNetwork = null;
function setActiveNetwork(network) {
  activeNetwork = network || null;
  window.__activeNetwork = activeNetwork;
  return activeNetwork;
}
window.setActiveNetwork = setActiveNetwork;
if (!window.__networkFetchInstalled) {
  window.__networkFetchInstalled = true;
  window.fetch = function(input, init) {
    const network = activeNetwork || window.__activeNetwork || window.__sharedBrowserNetwork || window.browserNetwork || window.editorNetwork;
    if (!network?.request) return Promise.reject(new TypeError('Network is not initialized.'));
    if (input instanceof Request) {
      const request = init === undefined ? input : new Request(input, init);
      return network.request(request, 'fetch');
    }
    return network.request(input, location.href, init || {}, 'fetch');
  };
}

// Network is loaded before browser.js. Keep URL encoding helpers here so the
// editor-owned shared Network can proxy requests before a Browser iframe exists.
function textToBase64(str) {
  try { return btoa(unescape(encodeURIComponent(String(str)))); }
  catch (e) { return btoa(String(str)); }
}
function base64ToText(base64) {
  try {
    const binaryString = atob(base64);
    const bytes = Uint8Array.from(binaryString, char => char.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) { return atob(base64); }
}
window.textToBase64 = textToBase64;
window.base64ToText = base64ToText;


class EventHandler {
  constructor() {
    this.eventListeners = {};
  }
  dispatchEvent(event, ...args) {
    var list = this.eventListeners[event];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      list[i].callback.apply(this, args);
    }
  }
  addEventListener(event, callback, options) {
    this.eventListeners[event] = this.eventListeners[event] || [];
    this.eventListeners[event].push({callback,options});
    return callback;
  }
  removeEventListener(event, callback) {
    var list = this.eventListeners[event];
    if (!list) return;
    if (!callback) { delete this.eventListeners[event]; return; }
    this.eventListeners[event] = list.filter(item => item.callback !== callback);
    if (!this.eventListeners[event].length) delete this.eventListeners[event];
  }
}

class Network extends EventHandler {
  constructor() {
    super();
    this.endpoints = [];
  }
  async request() {
    if (arguments[0] instanceof Request) return await this._requestObject.apply(this,arguments);
    return await this._requestURL.apply(this,arguments);
  }
  async _requestURL(url,baseOrigin,data,type) {
    const absoluteUrl = resolveNetworkURL(url, baseOrigin);
    const request = new Request(absoluteUrl, data);
    return await this._requestObject(request,type);
  }
  async _requestObject(request,type) {
    request.__original_url = request.url;
    request.request_type = type;
    this.dispatchEvent('requeststart',request,type);
    const response = await this.searchEndpoints(async function(endp) {
      endp.dispatchEvent('handlerequest',request,type);
      var response = await endp.handleRequest(request.clone(), type);
      if (!response) return null;
      endp.dispatchEvent('returnresponse',response,request,type);
      return response;
    });
    if (response) {
      response.source_url = request.url;
      response.requested_url = request.__original_url || request.url;
      response.request_type = type;
      if (type === 'import' || type === 'script[src]' || type === 'link[rel=stylesheet]' || type === 'link[rel="stylesheet"]') {
        try {
          Object.defineProperty(response,'__devtoolsSourceTextPromise',{value:response.clone().text().catch(()=>null),configurable:true});
        } catch(e) {}
      }
    }
    this.dispatchEvent('requestend',response,request,type);
    return response;
  }
  async socket(url,baseOrigin,protocols) {
    const absoluteUrl = resolveNetworkURL(url,baseOrigin);
    this.dispatchEvent('socketstart',absoluteUrl,protocols);
    const response = await this.searchEndpoints(async function(endp) {
      endp.dispatchEvent('handlesocket',absoluteUrl,protocols);
      var response = await endp.handleSocket(absoluteUrl,protocols);
      if (!response) return null;
      endp.dispatchEvent('returnsocket',response,absoluteUrl,protocols);
      return response;
    });
    this.dispatchEvent('socketend',response,absoluteUrl,protocols);
    return response;
  }
  setEndpoints(endpoints) {
    this.endpoints = endpoints;
    this.dispatchEvent('endpointschange', this.endpoints);
  }
  prependEndpoint(endpoint) {
    this.endpoints.unshift(endpoint);
    this.dispatchEvent('endpointschange', this.endpoints);
    return endpoint;
  }
  appendEndpoint(endpoint) {
    this.endpoints.push(endpoint);
    this.dispatchEvent('endpointschange', this.endpoints);
    return endpoint;
  }
  removeEndpoint(endpoint) {
    const index = this.endpoints.indexOf(endpoint);
    if (index < 0) return false;
    this.endpoints.splice(index, 1);
    this.dispatchEvent('endpointschange', this.endpoints);
    return true;
  }
  replaceRuntimeEndpoint(endpoint) {
    const old = this.endpoints.filter(item => item && item.__editorRuntimeEndpoint);
    for (const item of old) {
      const index = this.endpoints.indexOf(item);
      if (index >= 0) this.endpoints.splice(index, 1);
    }
    if (endpoint) {
      endpoint.__editorRuntimeEndpoint = true;
      this.endpoints.unshift(endpoint);
    }
    this.dispatchEvent('endpointschange', this.endpoints);
    return endpoint || null;
  }
  _getOrderedEndpoints() {
    const roleOrder = {custom:0, native:1, proxy:2};
    return this.endpoints.slice().sort((a,b) => {
      const ar = roleOrder[a?.__networkRole || 'custom'] ?? 0;
      const br = roleOrder[b?.__networkRole || 'custom'] ?? 0;
      return ar - br;
    });
  }
  getEndpointInfo() {
    return this._getOrderedEndpoints().map((endpoint, index) => ({
      index,
      name: endpoint?.constructor?.name || 'Endpoint',
      enabled: endpoint?.enabled !== false,
      runtime: !!endpoint?.__editorRuntimeEndpoint,
      role: endpoint?.__networkRole || 'custom',
      proxy: endpoint?.proxy || null,
      domain: endpoint?.domain || null,
      path: endpoint?.path || null,
      rootfolder: endpoint?.rootfolder || null
    }));
  }
  async searchEndpoints(callback, type) {
    await wait(1);
    // Every request uses the same fallback order:
    //   1. custom/runtime endpoints
    //   2. native browser fetch
    //   3. primary proxy
    //   4. fallback proxy
    // This is intentionally independent of request type so npm, AI, browser,
    // emulator, downloads, and other callers all get identical network behavior.
    const endpoints = this._getOrderedEndpoints();
    for (var i = 0; i < endpoints.length; i++) {
      var endp = endpoints[i];
      if (endp?.enabled === false) continue;
      try {
        var response = await callback.call(this, endp);
        if (!response) continue;
        return response;
      } catch (e) {
        console.log('[networkRequest] Endpoint error:', e && e.message || e);
      }
    }
    return;
  }
}

class NetworkEndpoint extends EventHandler {
  constructor(enabled = true) {
    super();
    this.enabled = enabled;
    this.__networkRole = 'custom';
  }
  async handleRequest(request,type) {
    return await originalFetch(request);
  }
  async handleSocket(url,protocols) {
    return protocols ? new originalWebSocket(url, protocols) : new originalWebSocket(url);
  }
}

class ProxyNetworkEndpoint extends NetworkEndpoint {
  constructor(proxy, obscureURL = true, enabled) {
    super(enabled);
    this.proxy = proxy;
    this.obscureURL = obscureURL;
    this.__networkRole = 'proxy';
  }
  async handleRequest(request,type) {
    let targetProxyUrl = request.url;
    
    // 1. Check if we need to obscure the URL via Base64
    if (!request.url.startsWith('data:') && !request.url.startsWith('blob:')) {
      if (this.obscureURL) {
        let b64 = textToBase64(request.url);
        // Make it URL-safe so special characters don't break query strings
        let urlSafeB64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        targetProxyUrl = `${this.proxy}?base64_url=${encodeURIComponent(urlSafeB64)}`;
      } else {
        // Fall back to standard cleartext parameter
        targetProxyUrl = `${this.proxy}?url=${encodeURIComponent(request.url)}`;
      }
    }
    try {
      const proxyRequest = new Request(targetProxyUrl, request);
      let response = await originalFetch(proxyRequest);
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      if (response.url === targetProxyUrl) Object.defineProperty(response, 'url', {get:()=>targetProxyUrl});
      return response;
    } catch (err) {
      return null;
    }
  }
  async handleSocket(absoluteUrl, protocols) {
    let targetProxyUrl = absoluteUrl;

    // Switch the HTTP proxy URL to a WS proxy URL
    let proxyBaseUrl = this.proxy.replace(/^http/, 'ws');
    
    if (this.obscureURL) {
      let b64 = textToBase64(absoluteUrl);
      let urlSafeB64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      targetProxyUrl = `${proxyBaseUrl}?base64_url=${encodeURIComponent(urlSafeB64)}`;
    } else {
      targetProxyUrl = `${proxyBaseUrl}?url=${encodeURIComponent(absoluteUrl)}`;
    }
    
    // Create the real connection and return it.
    // networkRequest will hand this back to our InterceptableWebSocket
    return protocols 
      ? new originalWebSocket(targetProxyUrl, protocols) 
      : new originalWebSocket(targetProxyUrl);
  }
}

function resolveNetworkURL(url, baseOrigin) {
  const raw = (url instanceof URL) ? url.href : String(url == null ? '' : url);
  const candidates = [];
  if (baseOrigin) candidates.push(String(baseOrigin));
  try {
    if (typeof getReliablePageURL === 'function') candidates.push(getReliablePageURL());
  } catch (_) {}
  try {
    if (typeof CURRENT_PAGE_URL !== 'undefined') candidates.push(CURRENT_PAGE_URL);
  } catch (_) {}
  candidates.push('http://127.0.0.1/');

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw)) {
    try { return new URL(raw).href; } catch (_) {}
  }
  if (raw.startsWith('//')) {
    for (const base of candidates) {
      try { return new URL(raw, base).href; } catch (_) {}
    }
  }
  for (const base of candidates) {
    try {
      if (!base || !/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(base)) continue;
      return new URL(raw, base).href;
    } catch (_) {}
  }
  return raw;
}



function globalSingularInstance(prop) {
  Object.defineProperty(window[prop], Symbol.hasInstance, {
    value: function(instance) {
      if (!instance || typeof instance !== 'object') return false;

      const visited = new Set();

      function checkWindow(win) {
        if (!win || visited.has(win)) return false;
        visited.add(win);

        try {
          if (win[prop] && Object.getPrototypeOf(instance) === win[prop].prototype) {
            return true;
          }

          for (let i = 0; i < win.frames.length; i++) {
            if (checkWindow(win.frames[i])) {
              return true;
            }
          }
        } catch (e) {}

        return false;
      }

      return checkWindow(window.top);
    },
    configurable: true
  });
}
globalSingularInstance("Request");
globalSingularInstance("Response");

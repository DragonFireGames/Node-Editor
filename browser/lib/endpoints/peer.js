// dependencies:
// network.js
// peerjs

(function(){
  if (typeof Peer === 'undefined') {
    throw new Error("PeerJS is required before peer.js.");
  }

  const layer = (v=>{try{return eval(v)}catch(e){return v}})(document.currentScript.getAttribute('data-layer')) || "peer";
  console.log(`Peer layer '${layer}'`);

  const clientPeerId = layer + "-client-" + randomId();
  const peer = new Peer(clientPeerId);
  const connections = new Map();

  function randomId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g,'');
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function normalizeDomain(domain) {
    try {
      return new URL(domain).origin;
    } catch (e) {
      throw new TypeError(`Invalid peer domain: ${domain}`);
    }
  }

  function getPeerServerId(domain) {
    const normalized = normalizeDomain(domain);
    const bytes = new TextEncoder().encode(normalized);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2,'0');
    }
    return layer + "-server-" + hex;
  }

  function getPeerSocketDomain(url) {
    const parsed = new URL(url);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    return parsed.origin;
  }

  function toUint8Array(data) {
    if (data == null) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'string') return new TextEncoder().encode(data);
    return null;
  }

  function serializeHeaders(headers) {
    return Array.from(new Headers(headers || {}).entries());
  }

  function makeHeaders(headers) {
    return new Headers(Array.isArray(headers) ? headers : Object.entries(headers || {}));
  }

  function makeRequest(message) {
    const body = toUint8Array(message.body);
    const options = {
      method: message.method || 'GET',
      headers: makeHeaders(message.headers)
    };

    if (body && options.method !== 'GET' && options.method !== 'HEAD') {
      options.body = body;
    }

    return new Request(message.url,options);
  }

  function makeResponse(message) {
    const body = toUint8Array(message.body);
    return new Response(body && body.byteLength ? body : null,{
      status: message.status || 200,
      statusText: message.statusText || '',
      headers: makeHeaders(message.headers)
    });
  }

  function extractUnavailablePeerId(error) {
    if (!error || error.type !== 'peer-unavailable') return null;
    const message = String(error.message || '');
    const prefix = 'Could not connect to peer ';
    if (!message.startsWith(prefix)) return null;
    return message.slice(prefix.length);
  }

  peer.on('error',function(error) {
    const serverId = extractUnavailablePeerId(error);
    if (!serverId) return;
    const state = connections.get(serverId);
    if (state?.connectingReject) state.connectingReject(new Error(`Peer server ${serverId} is unavailable.`));
  });

  function getConnectionState(serverId) {
    var state = connections.get(serverId);
    if (!state) {
      state = {connection:null,connecting:null,connectingReject:null,pending:new Map(),sockets:new Map()};
      connections.set(serverId,state);
    }
    return state;
  }

  function attachConnection(serverId,connection) {
    const state = getConnectionState(serverId);
    if (state.connection === connection) return;
    if (state.connection) {
      try { state.connection.close(); } catch (_) {}
    }
    state.connection = connection;
    connection.on('data',function(message) {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'response') {
        const pending = state.pending.get(message.id);
        if (!pending) return;
        state.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (!message.ok) return pending.resolve(null);
        try { pending.resolve(makeResponse(message)); } catch (error) { pending.reject(error); }
        return;
      }

      const socket = state.sockets.get(message.id);
      if (!socket) return;
      if (message.type === 'socket-open') socket._peerOpen();
      else if (message.type === 'socket-data') socket._peerData(toUint8Array(message.data));
      else if (message.type === 'socket-close') {
        socket._peerClose(message.code || 1000,message.reason || '');
        state.sockets.delete(message.id);
      }
    });
    connection.on('close',function() {
      if (state.connection !== connection) return;
      state.connection = null;
      rejectConnectionPending(state,new Error(`Peer server ${serverId} disconnected.`));
      closeConnectionSockets(state,1006,`Peer server ${serverId} disconnected.`);
    });
    connection.on('error',function(error) {
      if (state.connection !== connection) return;
      state.connection = null;
      const reason = error || new Error(`Peer server ${serverId} failed.`);
      rejectConnectionPending(state,reason);
      closeConnectionSockets(state,1006,reason.message || String(reason));
    });
  }

  function rejectConnectionPending(state,error) {
    for (const [id,pending] of state.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      state.pending.delete(id);
    }
  }

  function closeConnectionSockets(state,code=1006,reason='Peer connection closed.') {
    for (const [id,socket] of state.sockets) {
      socket._peerClose(code,reason);
      state.sockets.delete(id);
    }
  }

  function makeCloseFrame(code=1000,reason='') {
    if (code < 1000 || code === 1004 || code === 1005 || code === 1006 || code === 1015 || code > 4999) code = 1000;
    let reasonBytes = new TextEncoder().encode(String(reason || ''));
    if (reasonBytes.length > 123) reasonBytes = reasonBytes.slice(0,123);
    const payload = new Uint8Array(2 + reasonBytes.length);
    payload[0] = code >> 8;
    payload[1] = code & 255;
    payload.set(reasonBytes,2);
    const mask = new Uint8Array(4);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(mask);
    else for (let i=0;i<4;i++) mask[i]=Math.floor(Math.random()*256);
    const frame = new Uint8Array(2 + 4 + payload.length);
    frame[0] = 0x88;
    frame[1] = 0x80 | payload.length;
    frame.set(mask,2);
    for (let i=0;i<payload.length;i++) frame[6+i]=payload[i]^mask[i&3];
    return frame;
  }

  function createPeerSocket(serverId,state,socketId,url,protocols) {
    let onOpen = null;
    let onServerData = null;
    let onClose = null;
    let open = false;
    let closed = false;
    const dataQueue = [];
    let closeEvent = null;

    const socket = {
      onClientMessage(data) {
        if (closed || !state.connection || !state.connection.open) return;
        try {
          state.connection.send({type:'socket-data',id:socketId,data:toUint8Array(data)});
        } catch (_) {}
      },
      closeClient(code=1000,reason='') {
        if (closed || !state.connection || !state.connection.open) return;
        state.connection.send({type:'socket-data',id:socketId,data:makeCloseFrame(code,reason)});
      },
      _peerOpen() {
        if (closed || open) return;
        open = true;
        if (typeof onOpen === 'function') setTimeout(() => onOpen(),0);
      },
      _peerData(data) {
        if (closed) return;
        if (typeof onServerData === 'function') setTimeout(() => onServerData(data),0);
        else dataQueue.push(data);
      },
      _peerClose(code=1000,reason='') {
        if (closed) return;
        closed = true;
        closeEvent = [code,reason];
        if (typeof onClose === 'function') setTimeout(() => onClose(code,reason),0);
      }
    };

    Object.defineProperty(socket,'_onOpen',{
      get() { return onOpen; },
      set(fn) {
        onOpen = fn;
        if (open && typeof fn === 'function') setTimeout(() => fn(),0);
      }
    });
    Object.defineProperty(socket,'_onServerData',{
      get() { return onServerData; },
      set(fn) {
        onServerData = fn;
        if (typeof fn === 'function' && dataQueue.length) {
          const queued = dataQueue.splice(0);
          setTimeout(() => { for (const data of queued) if (!closed) fn(data); },0);
        }
      }
    });
    Object.defineProperty(socket,'_onClose',{
      get() { return onClose; },
      set(fn) {
        onClose = fn;
        if (closeEvent && typeof fn === 'function') {
          const [code,reason] = closeEvent;
          setTimeout(() => fn(code,reason),0);
        }
      }
    });

    return socket;
  }

  function makeServerFrame(opcode,payload) {
    payload = toUint8Array(payload) || new Uint8Array(0);
    let header;
    if (payload.length < 126) header = new Uint8Array([0x80|opcode,payload.length]);
    else if (payload.length <= 65535) header = new Uint8Array([0x80|opcode,126,payload.length>>8,payload.length&255]);
    else {
      header = new Uint8Array(10);
      header[0] = 0x80|opcode;
      header[1] = 127;
      let n = payload.length;
      for (let i=9;i>=2;i--) { header[i] = n % 256; n = Math.floor(n/256); }
    }
    const frame = new Uint8Array(header.length+payload.length);
    frame.set(header);
    frame.set(payload,header.length);
    return frame;
  }

  function createNativeSocketBackend(ws) {
    let onOpen = null,onServerData = null,onClose = null,closed = false;
    let dataQueue = [],frameBuffer = new Uint8Array(0),fragmentOpcode = null,fragmentParts = [];
    try { ws.binaryType = 'arraybuffer'; } catch (_) {}

    function emitOpen() {
      if (!closed && typeof onOpen === 'function') setTimeout(() => onOpen(),0);
    }
    function emitData(data) {
      if (closed) return;
      if (typeof onServerData === 'function') setTimeout(() => onServerData(data),0);
      else dataQueue.push(data);
    }
    function emitClose(code=1000,reason='') {
      if (closed) return;
      closed = true;
      if (typeof onClose === 'function') setTimeout(() => onClose(code,reason),0);
    }
    function add(type,fn) {
      if (typeof ws.addEventListener === 'function') ws.addEventListener(type,fn);
      else {
        const old = ws['on'+type];
        ws['on'+type] = function(e) { if (typeof old === 'function') old.call(ws,e); fn(e); };
      }
    }
    function sendPayload(opcode,payload) {
      try {
        if (opcode === 1) ws.send(new TextDecoder().decode(payload));
        else ws.send(payload.buffer.slice(payload.byteOffset,payload.byteOffset+payload.byteLength));
      } catch (_) {}
    }
    function parse(input) {
      const incoming = toUint8Array(input);
      if (!incoming) return;
      const merged = new Uint8Array(frameBuffer.length+incoming.length);
      merged.set(frameBuffer); merged.set(incoming,frameBuffer.length); frameBuffer = merged;
      let offset = 0;
      while (frameBuffer.length-offset >= 2) {
        const b0 = frameBuffer[offset],b1 = frameBuffer[offset+1],fin = !!(b0&0x80),opcode = b0&15,masked = !!(b1&0x80);
        let len = b1&127,headerLen = 2;
        if (len === 126) {
          if (frameBuffer.length-offset < 4) break;
          len = (frameBuffer[offset+2]<<8)|frameBuffer[offset+3]; headerLen = 4;
        } else if (len === 127) {
          if (frameBuffer.length-offset < 10) break;
          len = 0;
          for (let i=0;i<8;i++) len = len*256+frameBuffer[offset+2+i];
          if (len > Number.MAX_SAFE_INTEGER) { try { ws.close(1009,'Message too large'); } catch (_) {} return; }
          headerLen = 10;
        }
        const maskLen = masked ? 4 : 0,frameLen = headerLen+maskLen+len;
        if (frameBuffer.length-offset < frameLen) break;
        let p = offset+headerLen,mask = null;
        if (masked) { mask = frameBuffer.slice(p,p+4); p += 4; }
        const payload = frameBuffer.slice(p,p+len);
        if (mask) for (let i=0;i<payload.length;i++) payload[i] ^= mask[i&3];
        offset += frameLen;

        if (opcode === 8) {
          let code = 1000,reason = '';
          if (payload.length >= 2) { code = (payload[0]<<8)|payload[1]; reason = new TextDecoder().decode(payload.slice(2)); }
          try { ws.close(code,reason); } catch (_) {}
          continue;
        }
        if (opcode === 9 || opcode === 10) continue;
        if (opcode === 1 || opcode === 2) {
          if (fragmentOpcode !== null) continue;
          if (fin) sendPayload(opcode,payload);
          else { fragmentOpcode = opcode; fragmentParts = [payload]; }
        } else if (opcode === 0 && fragmentOpcode !== null) {
          fragmentParts.push(payload);
          if (fin) {
            let total = 0;
            for (const part of fragmentParts) total += part.length;
            const all = new Uint8Array(total);
            let at = 0;
            for (const part of fragmentParts) { all.set(part,at); at += part.length; }
            sendPayload(fragmentOpcode,all);
            fragmentOpcode = null; fragmentParts = [];
          }
        }
      }
      if (offset) frameBuffer = frameBuffer.slice(offset);
    }

    add('open',emitOpen);
    add('message',function(event) {
      const data = event && event.data !== undefined ? event.data : event;
      const payload = toUint8Array(data);
      if (typeof data === 'string') emitData(makeServerFrame(1,payload));
      else if (payload) emitData(makeServerFrame(2,payload));
    });
    add('close',e => emitClose(e?.code || 1000,e?.reason || ''));
    add('error',function() {});

    const backend = {
      onClientMessage(data) { parse(data); },
      closeClient(code=1000,reason='') { if (!closed) try { ws.close(code,reason); } catch (_) {} }
    };
    Object.defineProperty(backend,'protocol',{get() { return ws.protocol || ''; }});
    Object.defineProperty(backend,'_onOpen',{get() { return onOpen; },set(fn) { onOpen = fn; if (ws.readyState === 1) emitOpen(); }});
    Object.defineProperty(backend,'_onServerData',{get() { return onServerData; },set(fn) {
      onServerData = fn;
      if (typeof fn === 'function' && dataQueue.length) {
        const queued = dataQueue.splice(0);
        setTimeout(() => { for (const data of queued) if (!closed) fn(data); },0);
      }
    }});
    Object.defineProperty(backend,'_onClose',{get() { return onClose; },set(fn) { onClose = fn; }});
    if (ws.readyState === 1) setTimeout(emitOpen,0);
    else if (ws.readyState === 3) setTimeout(() => emitClose(ws.code || 1000,ws.reason || ''),0);
    return backend;
  }

  function waitForConnection(serverId) {
    const state = getConnectionState(serverId);
    if (state.connection && state.connection.open) return Promise.resolve(state.connection);
    if (state.connecting) return state.connecting;
    const connection = peer.connect(serverId,{label:"network-"+randomId(),serialization:"binary",reliable:true});
    let promise;
    state.connecting = promise = new Promise(function(resolve,reject) {
      let settled = false;
      const timeout = setTimeout(function() { finishReject(new Error(`Timed out connecting to peer ${serverId}.`)); },6000);
      function cleanup() {
        clearTimeout(timeout);
        if (state.connecting === promise) state.connecting = null;
        state.connectingReject = null;
      }
      function finishResolve() {
        if (settled) return;
        settled = true;
        cleanup();
        attachConnection(serverId,connection);
        resolve(connection);
      }
      function finishReject(error) {
        if (settled) return;
        settled = true;
        cleanup();
        try { connection.close(); } catch (_) {}
        reject(error);
      }
      state.connectingReject = finishReject;
      connection.on('open',finishResolve);
      connection.on('close',function() { if (!settled) finishReject(new Error(`Peer server ${serverId} closed.`)); });
      connection.on('error',function(error) { if (!settled) finishReject(error || new Error(`Peer server ${serverId} failed.`)); });
    });
    return promise;
  }

  class PeerServer extends (typeof EventHandler !== 'undefined' ? EventHandler : class {}) {
    constructor(endpoint,domain,options = {}) {
      super();
      if (!endpoint || typeof endpoint.handleRequest !== 'function') {
        throw new TypeError("PeerServer requires a NetworkEndpoint.");
      }

      this.endpoint = endpoint;
      this.domain = normalizeDomain(domain);
      this.peerId = getPeerServerId(this.domain);
      this.peer = new Peer(this.peerId,options.peerOptions || {});
      this.connections = new Set();
      this.sockets = new Map();
      this.closed = false;

      this.ready = new Promise((resolve,reject) => {
        let settled = false;

        this.peer.on('open',id => {
          if (settled) return;
          settled = true;
          this.dispatchEvent?.('open',id,this);
          resolve(this);
        });

        this.peer.on('error',error => {
          if (settled) {
            this.dispatchEvent?.('error',error,this);
            return;
          }

          if (error.type === 'unavailable-id') {
            settled = true;
            this.closed = true;
            this.dispatchEvent?.('duplicate',this.domain,this);
            reject(new Error(`A PeerServer is already registered for ${this.domain}.`));
          } else {
            settled = true;
            this.dispatchEvent?.('error',error,this);
            reject(error);
          }
        });

        this.peer.on('connection',connection => {
          this.acceptConnection(connection);
        });

        this.peer.on('close',() => {
          this.closed = true;
          this.dispatchEvent?.('close',this);
        });
      });
    }

    acceptConnection(connection) {
      if (this.closed) {
        try { connection.close(); } catch (_) {}
        return;
      }

      this.connections.add(connection);

      connection.on('data',message => {
        this.handleMessage(connection,message).catch(error => {
          console.error('[PeerServer] request error:',error);
        });
      });

      connection.on('close',() => {
        this.connections.delete(connection);
        for (const [id,entry] of this.sockets) {
          if (entry.connection !== connection) continue;
          entry.closed = true;
          this.sockets.delete(id);
          if (entry.backend && typeof entry.backend.closeClient === 'function') {
            try { entry.backend.closeClient(1006,'Peer connection closed.'); } catch (_) {}
          }
        }
      });

      connection.on('error',error => {
        this.dispatchEvent?.('connectionerror',error,connection,this);
      });
    }

    async handleMessage(connection,message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'request') return await this.handleRequestMessage(connection,message);
      if (message.type === 'socket-open') return await this.handleSocketOpen(connection,message);
      if (message.type === 'socket-data') return this.handleSocketData(connection,message);
      if (message.type === 'socket-close') return this.handleSocketClose(connection,message);
    }

    async handleRequestMessage(connection,message) {
      let request;
      try {
        request = makeRequest(message);
      } catch (error) {
        connection.send({type:'response',id:message.id,ok:true,status:400,statusText:'Bad Request',headers:[['content-type','text/plain']],body:new TextEncoder().encode(String(error.message || error))});
        return;
      }

      try {
        const response = await this.endpoint.handleRequest(request,message.requestType);
        if (!response) {
          connection.send({type:'response',id:message.id,ok:false});
          return;
        }
        const buffer = await response.arrayBuffer();
        connection.send({type:'response',id:message.id,ok:true,status:response.status,statusText:response.statusText,headers:serializeHeaders(response.headers),body:new Uint8Array(buffer)});
      } catch (error) {
        const body = new TextEncoder().encode(String(error?.stack || error?.message || error));
        connection.send({type:'response',id:message.id,ok:true,status:500,statusText:'Internal Peer Server Error',headers:[['content-type','text/plain']],body:body});
      }
    }

    async handleSocketOpen(connection,message) {
      if (typeof this.endpoint.handleSocket !== 'function' || (typeof NetworkEndpoint !== 'undefined' && this.endpoint.handleSocket === NetworkEndpoint.prototype.handleSocket)) {
        connection.send({type:'socket-close',id:message.id,code:1003,reason:'Peer endpoint does not support WebSockets.'});
        return;
      }

      const entry = {connection:connection,backend:null,closed:false};
      this.sockets.set(message.id,entry);

      try {
        let backend = await this.endpoint.handleSocket(message.url,message.protocols);
        if (backend && typeof backend.onClientMessage !== 'function' && typeof backend.send === 'function' && typeof backend.close === 'function') {
          backend = createNativeSocketBackend(backend);
        }
        if (!backend || typeof backend.onClientMessage !== 'function') {
          this.sockets.delete(message.id);
          connection.send({type:'socket-close',id:message.id,code:1003,reason:'Peer endpoint rejected WebSocket.'});
          return;
        }

        entry.backend = backend;
        backend._onOpen = () => {
          if (entry.closed) return;
          connection.send({type:'socket-open',id:message.id,protocol:backend.protocol || ''});
        };
        backend._onServerData = data => {
          if (entry.closed) return;
          connection.send({type:'socket-data',id:message.id,data:toUint8Array(data)});
        };
        backend._onClose = (code=1000,reason='') => {
          if (entry.closed) return;
          entry.closed = true;
          this.sockets.delete(message.id);
          try { connection.send({type:'socket-close',id:message.id,code:code || 1000,reason:reason || ''}); } catch (_) {}
        };
      } catch (error) {
        entry.closed = true;
        this.sockets.delete(message.id);
        connection.send({type:'socket-close',id:message.id,code:1011,reason:String(error?.message || error)});
      }
    }

    handleSocketData(connection,message) {
      const entry = this.sockets.get(message.id);
      if (!entry || entry.connection !== connection || entry.closed || !entry.backend) return;
      try { entry.backend.onClientMessage(toUint8Array(message.data)); } catch (error) { this.handleSocketClose(connection,{id:message.id,code:1011,reason:String(error?.message || error)}); }
    }

    handleSocketClose(connection,message) {
      const entry = this.sockets.get(message.id);
      if (!entry || entry.connection !== connection) return;
      entry.closed = true;
      this.sockets.delete(message.id);
      if (entry.backend && typeof entry.backend.closeClient === 'function') {
        try { entry.backend.closeClient(message.code || 1000,message.reason || ''); } catch (_) {}
      }
    }

    async close() {
      if (this.closed) return;
      this.closed = true;

      for (const connection of this.connections) {
        try { connection.close(); } catch (_) {}
      }
      this.connections.clear();
      for (const [id,entry] of this.sockets) {
        entry.closed = true;
        if (entry.backend && typeof entry.backend.closeClient === 'function') {
          try { entry.backend.closeClient(1001,'Peer server closed.'); } catch (_) {}
        }
        this.sockets.delete(id);
      }

      try { this.peer.destroy(); } catch (_) {}
    }
  }

  class PeerEndpoint extends NetworkEndpoint {
    constructor(options = {}) {
      super(options.enabled ?? true);
      this.requestTimeout = options.requestTimeout ?? 30000;
    }

    async handleRequest(request,type) {
      let domain;
      try { domain = new URL(request.url).origin; } catch (_) { return null; }
      const serverId = getPeerServerId(domain);
      let connection;
      try { connection = await waitForConnection(serverId); } catch (_) { return null; }
      const state = getConnectionState(serverId);
      const id = randomId();
      const body = request.body ? new Uint8Array(await request.clone().arrayBuffer()) : null;
      return await new Promise((resolve,reject) => {
        const timeout = setTimeout(() => {
          state.pending.delete(id);
          reject(new Error(`Peer request timed out: ${request.url}`));
        },this.requestTimeout);
        state.pending.set(id,{resolve,reject,timeout});
        try {
          connection.send({type:'request',id:id,requestType:type,url:request.url,method:request.method,headers:serializeHeaders(request.headers),body:body});
        } catch (error) {
          clearTimeout(timeout);
          state.pending.delete(id);
          reject(error);
        }
      }).catch(() => null);
    }

    async handleSocket(url,protocols) {
      let domain;
      try { domain = getPeerSocketDomain(url); } catch (_) { return null; }
      const serverId = getPeerServerId(domain);
      let connection;
      try { connection = await waitForConnection(serverId); } catch (_) { return null; }
      const state = getConnectionState(serverId);
      const id = randomId();
      const socket = createPeerSocket(serverId,state,id,url,protocols);
      state.sockets.set(id,socket);
      try {
        connection.send({type:'socket-open',id:id,url:url,protocols:protocols || null});
      } catch (_) {
        state.sockets.delete(id);
        return null;
      }
      return socket;
    }

    close() {
      for (const [serverId,state] of connections) {
        if (state.connection) {
          try { state.connection.close(); } catch (_) {}
        }
        rejectConnectionPending(state,new Error('PeerEndpoint closed.'));
        closeConnectionSockets(state,1001,'PeerEndpoint closed.');
        state.sockets.clear();
        connections.delete(serverId);
      }
    }
  }

  var serverChecks = new Map();

  async function peerServerExists(domain,timeout = 6000) {
    const normalized = normalizeDomain(domain);
    const serverId = getPeerServerId(normalized);

    return await new Promise(resolve => {
      let settled = false;
      const connection = peer.connect(serverId,{
        label: 'peer-check-' + randomId(),
        serialization: 'binary',
        reliable: true
      });

      const timer = setTimeout(() => finish(false),timeout);
      serverChecks.set(serverId,finish);

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (serverChecks.get(serverId) === finish) serverChecks.delete(serverId);
        try { connection.close(); } catch (_) {}
        resolve(result);
      }

      connection.on('open',() => finish(true));
      connection.on('close',() => finish(false));
      connection.on('error',() => finish(false));

    });
  }

  async function ensurePeerServer(domain,createEndpoint,options = {}) {
    const normalized = normalizeDomain(domain);
    const interval = options.interval ?? 10000;
    let endpoint = null;
    let server = null;
    let checking = false;

    async function ensure() {
      if (checking) return;
      checking = true;

      try {
        if (server && !server.closed) return;

        const exists = await peerServerExists(normalized);

        if (exists) {
          server = null;
          return;
        }

        endpoint = await createEndpoint();
        server = new PeerServer(endpoint,normalized,options);

        try {
          await server.ready;
        } catch (error) {
          server = null;
          endpoint = null;
          if (error && /^A PeerServer is already registered for /i.test(String(error.message || error))) return;
          throw error;
        }
      } finally {
        checking = false;
      }
    }

    await ensure();

    const timer = setInterval(async function() {
      if (server && !server.closed) {
        const exists = await peerServerExists(normalized);
        if (exists) return;

        try { await server.close(); } catch (_) {}
        server = null;
      }

      try {
        await ensure();
      } catch (error) {
        console.error(`[PeerServer] Failed to restore ${normalized}:`,error);
      }
    },interval);

    return {
      get server() {
        return server;
      },
      get endpoint() {
        return endpoint;
      },
      close() {
        clearInterval(timer);
        if (server) server.close();
        server = null;
        endpoint = null;
      }
    };
  }

  window.peer = peer;
  window.PeerServer = PeerServer;
  window.PeerEndpoint = PeerEndpoint;
  window.getPeerServerId = getPeerServerId;
  window.getPeerSocketDomain = getPeerSocketDomain;
  window.peerServerExists = peerServerExists;
  window.ensurePeerServer = ensurePeerServer;
})();
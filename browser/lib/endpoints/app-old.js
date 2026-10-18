// dependencies:
// network.js
// filesystem.js

(function() {

  function normalizeNodePath(path) {
    const parts = String(path || "/").replace(/\\/g, "/").split("/").filter(Boolean);
    const out = [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") {
        if (out.length) out.pop();
      } else {
        out.push(part);
      }
    }
    return "/" + out.join("/");
  }

  function nodeExecution() {
    window.__hostOrigin = window.top.location.origin;
    function normalizeNodePath(path) {
      const parts = String(path || "/").replace(/\\/g, "/").split("/").filter(Boolean);
      const out = [];
      for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") {
          if (out.length) out.pop();
        } else {
          out.push(part);
        }
      }
      return "/" + out.join("/");
    }
    if (!window.nodeEmulator) throw new Error("Emulator not found!");

    (function() {
      var CURRENT_PAGE_URL = "http://127.0.0.1/";
      var BASE_ORIGIN = "http://127.0.0.1/";
      const originalFetch = window.fetch.bind(window);
      
      window.fetch = async function(input, data = {}, type = 'fetch') {
        const fetchUrl = typeof input === 'string' ? input : (input instanceof Request ? input.url : input);
        const resolvedUrl = new URL(fetchUrl, CURRENT_PAGE_URL).href;
        const response = await nodeEmulator.network.request(resolvedUrl, BASE_ORIGIN, data, type);
        if (response) return response;
        return await originalFetch.apply(this, arguments);
      };
    })();

    Object.keys(console).forEach(method => {
      const original = console[method];
      if (typeof original != 'function') return;
      console[method] = function(...args) {
        nodeEmulator.dispatchEvent('console',method,args);
      };
    });
    console.logText = function(...args) {
      nodeEmulator.dispatchEvent('console','logText',args);
    };

    function addEventListener(e,p,f,t) {
      e.addEventListener(p,f,t);
      setTimeout(()=>e.addEventListener(p,f,t),0);
    }

    addEventListener(window, 'error', function(e) {
      nodeEmulator.dispatchEvent('error',e,'[node runtime env]');
    });

    // --- Settings & Environment ---
    const ENV_SETTINGS = nodeEmulator.env;

    const domain = nodeEmulator.domain; 
    const rootfolder = nodeEmulator.rootfolder;
    const pathPrefix = nodeEmulator.pathPrefix || '/';
    ENV_SETTINGS.PWD = nodeEmulator.cwd || '/';

    function resolveWorkingPath(path = '.') {
      const raw = String(path ?? '.').trim();
      if (raw === '~') return '/';
      const base = nodeEmulator.cwd || '/';
      return normalizeNodePath(raw.startsWith('/') ? raw : `${base}/${raw}`);
    }

    function getPhysicalPath(virtualPath) {
      const root = String(nodeEmulator.rootfolder || '').replace(/^\/+|\/+$/g, '');
      const clean = normalizeNodePath(virtualPath).replace(/^\/+/, '');
      return root ? `${root}/${clean}` : clean;
    }

    function directoryExists(virtualPath) {
      const fsInstance = nodeEmulator.filesystem;
      if (!fsInstance || typeof fsInstance.listFilesSync !== 'function') return false;
      const clean = normalizeNodePath(virtualPath).replace(/^\/+|\/+$/g, '');
      if (!clean) return true;
      const physical = getPhysicalPath('/' + clean);
      if (fsInstance.existsSync(physical)) return false;
      const prefix = physical.replace(/\/+$/g, '') + '/';
      return fsInstance.listFilesSync().some(file => file.startsWith(prefix));
    }

    function listDirectory(virtualPath) {
      const target = normalizeNodePath(virtualPath);
      const physical = getPhysicalPath(target).replace(/\/+$/g, '');
      const prefix = physical ? physical + '/' : '';
      const entries = new Map();
      for (const file of nodeEmulator.filesystem.listFilesSync()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        entries.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
      }
      return Array.from(entries.entries())
        .sort((a,b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([name, isDirectory]) => isDirectory ? `${name}/` : name);
    }

    function ensureDirectory(path, command = 'cd') {
      const target = resolveWorkingPath(path);
      if (!directoryExists(target)) throw new Error(`${command}: no such directory: ${path}`);
      return target;
    }

    // 1. Initialize Globals (Removed mockFileSystem per request)
    window.activeServers = new Map(); // Active HTTP servers bound to ports/domains
    
    // Standard Node Globals
    window.global = window;
    window.process = {
      type: 'renderer',
      env: ENV_SETTINGS,
      cwd: () => nodeEmulator.cwd || '/',
      chdir: (path) => {
        const previous = nodeEmulator.cwd || '/';
        const target = ensureDirectory(path, 'chdir');
        nodeEmulator.previousCwd = previous;
        nodeEmulator.cwd = target;
        ENV_SETTINGS.OLDPWD = previous;
        ENV_SETTINGS.PWD = target;
        if (nodeEmulator.npm) nodeEmulator.npm.rootfolder = getRuntimeRootFolder();
      },
      nextTick: (cb, ...args) => Promise.resolve().then(() => cb(...args)),
      stdout: { write: (msg) => console.log(msg) },
      stderr: { write: (msg) => console.error(msg) },
      platform: 'browser'
    };

    if (typeof setImmediate === 'undefined') {
      global.setImmediate = function(callback, ...args) {
        return setTimeout(callback, 0, ...args);
      };
    }
    if (typeof clearImmediate === 'undefined') {
      global.clearImmediate = function(id) {
        clearTimeout(id);
      };
    }

    function inferMime(name) {
      if (name == "LICENSE")
        return "text/plain";
      const ext = name.split('.').pop()?.toLowerCase();
      const map = {
        'txt': 'text/plain',
        'md': 'text/markdown',
        'js': 'text/javascript',
        'ts': 'text/typescript',
        'json': 'application/json',
        'html': 'text/html',
        'css': 'text/css',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'avif': 'image/avif',
        'hdr': 'image/vnd.radiance',
        'exr': 'image/x-exr',
        'svg': 'image/svg+xml',
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'obj': 'model/obj',
        'fbx': 'model/x-fbx',
        'glb': 'model/gltf-binary',
        'gltf': 'model/gltf+json',
        'mtl': 'text/plain',
        'frag': 'text/x-hlsl',
        'vert': 'text/x-hlsl',
        'hlsl': 'text/x-hlsl',
        'fx': 'text/x-hlsl',
        'wgsl': 'text/wgsl',
        'py': 'text/x-python',
        'c': 'text/x-c',
        'cpp': 'text/x-c'
      };
      return map[ext] || 'application/octet-stream';
    }

    // --- Modular Polyfill Suite ---
    const polyfills = {};

    {
      /**
       * events (Enhanced Robust EventEmitter Polyfill)
       */
      polyfills.events = (function() {
        const module = { exports: {} };

        function EventEmitter() {
          this._events = Object.create(null);
          this._eventsCount = 0;
          this._maxListeners = undefined;
        }

        EventEmitter.prototype.setMaxListeners = function(n) {
          this._maxListeners = n;
          return this;
        };

        EventEmitter.prototype.getMaxListeners = function() {
          return this._maxListeners === undefined ? 10 : this._maxListeners;
        };

        EventEmitter.prototype.on = function(type, listener) {
          if (typeof listener !== 'function') {
            throw new TypeError('The "listener" argument must be of type Function. Received type ' + typeof listener);
          }
          
          // Safety check: ensure target object has an _events map even if EventEmitter constructor wasn't explicitly called via super()
          if (!this._events) {
            this._events = Object.create(null);
            this._eventsCount = 0;
          }

          if (!this._events[type]) {
            this._events[type] = listener;
            this._eventsCount++;
          } else if (typeof this._events[type] === 'function') {
            this._events[type] = [this._events[type], listener];
          } else {
            this._events[type].push(listener);
          }
          return this;
        };

        EventEmitter.prototype.addListener = EventEmitter.prototype.on;

        EventEmitter.prototype.once = function(type, listener) {
          const g = (...args) => {
            this.removeListener(type, g);
            listener.apply(this, args);
          };
          g.listener = listener;
          this.on(type, g);
          return this;
        };

        EventEmitter.prototype.removeListener = function(type, listener) {
          if (typeof listener !== 'function') {
            throw new TypeError('The "listener" argument must be of type Function. Received type ' + typeof listener);
          }
          if (!this._events) return this;
          const list = this._events[type];
          if (!list) return this;

          if (list === listener || (list.listener && list.listener === listener)) {
            if (--this._eventsCount === 0) {
              this._events = Object.create(null);
            } else {
              delete this._events[type];
            }
          } else if (Array.isArray(list)) {
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i] === listener || (list[i].listener && list[i].listener === listener)) {
                list.splice(i, 1);
                break;
              }
            }
            if (list.length === 1) {
              this._events[type] = list[0];
            } else if (list.length === 0) {
              delete this._events[type];
              this._eventsCount--;
            }
          }
          return this;
        };

        EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

        EventEmitter.prototype.removeAllListeners = function(type) {
          if (!this._events) return this;
          if (type === undefined) {
            this._events = Object.create(null);
            this._eventsCount = 0;
          } else if (this._events[type]) {
            if (--this._eventsCount === 0) {
              this._events = Object.create(null);
            } else {
              delete this._events[type];
            }
          }
          return this;
        };

        EventEmitter.prototype.listeners = function(type) {
          if (!this._events) return [];
          const evs = this._events[type];
          if (!evs) return [];
          return typeof evs === 'function' ? [evs] : [...evs];
        };

        EventEmitter.prototype.emit = function(type, ...args) {
          if (!this._events) return false;
          const handler = this._events[type];
          if (!handler) return false;

          if (typeof handler === 'function') {
            try {
              handler.apply(this, args);
            } catch (err) {
              setTimeout(() => { throw err; }, 0);
            }
          } else {
            const listeners = [...handler];
            for (const listener of listeners) {
              try {
                listener.apply(this, args);
              } catch (err) {
                setTimeout(() => { throw err; }, 0);
              }
            }
          }
          return true;
        };

        EventEmitter.prototype.listenerCount = function(eventName) {
          const listeners = this.listeners(eventName);
          return listeners ? listeners.length : 0;
        };

        EventEmitter.listenerCount = function(emitter, type) {
          if (typeof emitter.listenerCount === 'function') {
            return emitter.listenerCount(type);
          }
          if (typeof emitter.listeners === 'function') {
            const listeners = emitter.listeners(type);
            return listeners ? listeners.length : 0;
          }
          return 0;
        };

        module.exports = EventEmitter;
        module.exports.EventEmitter = EventEmitter;
        return module.exports;
      })();

      /**
       * path
       */
      polyfills.path = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        function normalizePath(pathStr) {
          if (typeof pathStr !== 'string') {
            throw new TypeError('Path must be a string. Received ' + JSON.stringify(pathStr));
          }
          if (pathStr === '') return '.';

          const isAbsolute = pathStr.startsWith('/');
          const trailingSlash = pathStr.endsWith('/') && pathStr.length > 1;
          const parts = pathStr.split('/').filter(Boolean);
          const stack = [];

          for (const part of parts) {
            if (part === '.') continue;
            if (part === '..') {
              if (stack.length > 0 && stack[stack.length - 1] !== '..') {
                stack.pop();
              } else if (!isAbsolute) {
                stack.push('..');
              }
            } else {
              stack.push(part);
            }
          }

          let res = stack.join('/');
          if (isAbsolute) {
            res = '/' + res;
          }
          if (trailingSlash && !res.endsWith('/')) {
            res += '/';
          }
          return res === '' ? (isAbsolute ? '/' : '.') : res;
        }

        exports.normalize = normalizePath;

        exports.join = function(...args) {
          const combined = args.filter(Boolean).join('/');
          return normalizePath(combined);
        };

        exports.dirname = function(p) {
          if (typeof p !== 'string' || p.length === 0) return '.';
          const normalized = normalizePath(p);
          const lastIndex = normalized.lastIndexOf('/');
          if (lastIndex === -1) return '.';
          if (lastIndex === 0) return '/';
          return normalized.substring(0, lastIndex);
        };

        exports.extname = function(p) {
          if (typeof p !== 'string') return '';
          const base = exports.basename(p);
          const index = base.lastIndexOf('.');
          if (index <= 0) return '';
          return base.substring(index);
        };

        exports.basename = function(p, ext) {
          if (typeof p !== 'string') return '';
          const normalized = normalizePath(p);
          let base = normalized.substring(normalized.lastIndexOf('/') + 1);
          if (ext && typeof ext === 'string' && base.endsWith(ext)) {
            base = base.slice(0, -ext.length);
          }
          return base;
        };

        exports.resolve = function(...args) {
          let resolvedPath = '';
          let resolvedAbsolute = false;

          for (let i = args.length - 1; i >= 0 && !resolvedAbsolute; i--) {
            const path = args[i];
            if (typeof path !== 'string' || !path) continue;
            resolvedPath = path + (resolvedPath ? '/' + resolvedPath : '');
            resolvedAbsolute = path.startsWith('/');
          }

          resolvedPath = normalizePath(resolvedPath);
          if (resolvedAbsolute) {
            return resolvedPath.replace(/\/+$/, '') || '/';
          }
          return normalizePath('/' + resolvedPath).replace(/\/+$/, '') || '/';
        };

        exports.isAbsolute = function(p) {
          return typeof p === 'string' && p.startsWith('/');
        };

        exports.relative = function(from, to) {
          const resolvedFrom = exports.resolve(from);
          const resolvedTo = exports.resolve(to);
          
          const fromParts = resolvedFrom.split('/').filter(Boolean);
          const toParts = resolvedTo.split('/').filter(Boolean);

          let commonLength = 0;
          for (let i = 0; i < Math.min(fromParts.length, toParts.length); i++) {
            if (fromParts[i] === toParts[i]) {
              commonLength++;
            } else {
              break;
            }
          }

          let outputParts = [];
          for (let i = commonLength; i < fromParts.length; i++) {
            outputParts.push('..');
          }
          outputParts = outputParts.concat(toParts.slice(commonLength));
          return outputParts.join('/');
        };

        exports.parse = function(p) {
          const root = (p && p.startsWith('/')) ? '/' : '';
          const dir = exports.dirname(p);
          const base = exports.basename(p);
          const ext = exports.extname(p);
          const name = base.slice(0, base.length - ext.length);
          return { root, dir, base, ext, name };
        };

        exports.sep = '/';
        exports.delimiter = ':';

        return module.exports;
      })();

      /**
       * stream
       */
      polyfills.stream = (function() {
        const module = { exports: {} };
        const EventEmitter = polyfills.events;

        function Stream() {
          EventEmitter.call(this);
        }
        Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);

        Stream.prototype.pipe = function(dest, options) {
          const source = this;
          source.on('data', chunk => {
            dest.write(chunk);
          });
          source.on('end', () => {
            if (!options || options.end !== false) {
              dest.end();
            }
          });
          source.on('error', err => {
            if (typeof dest.destroy === 'function') dest.destroy(err);
          });
          return dest;
        };

        function Readable(options) {
          Stream.call(this);
          options = options || {};
          this.readable = options.readable !== false;
          this.readableEnded = false;
          this.destroyed = false;
          this.readableFlowing = null;
          this._readableState = {
            endEmitted: false,
            ended: false,
            destroyed: false,
            flowing: null,
            objectMode: !!options.objectMode,
            encoding: null
          };
        }
        Object.setPrototypeOf(Readable.prototype, Stream.prototype);

        Readable.prototype.push = function(chunk) {
          if (chunk === null) {
            if (this._readableState.endEmitted) return false;
            this._readableState.ended = true;
            this.readableEnded = true;
            this._readableState.endEmitted = true;
            this.emit('end');
            return false;
          }
          if (this.destroyed) return false;
          if (typeof this._encoding === 'string' && typeof chunk === 'string') {
            // Keep the original chunk type; setEncoding is primarily a compatibility hint here.
          }
          this.emit('data', chunk);
          return true;
        };

        Readable.prototype.destroy = function(err, cb) {
          if (this.destroyed) {
            if (typeof cb === 'function') cb(err);
            return this;
          }
          this.destroyed = true;
          this._readableState.destroyed = true;
          this._readableState.ended = true;
          if (err) {
            this._readableState.errorEmitted = true;
            this.emit('error', err);
          }
          this.emit('close');
          if (typeof cb === 'function') cb(err);
          return this;
        };

        Readable.prototype.resume = function() {
          this.readableFlowing = true;
          this._readableState.flowing = true;
          return this;
        };
        Readable.prototype.pause = function() {
          this.readableFlowing = false;
          this._readableState.flowing = false;
          return this;
        };
        Readable.prototype.isPaused = function() { return this.readableFlowing === false; };
        Readable.prototype.read = function(size) { return null; };
        Readable.prototype.setEncoding = function(encoding) {
          this._encoding = encoding;
          this._readableState.encoding = encoding;
          return this;
        };
        Readable.prototype.unpipe = function() { return this; };

        function Writable(options) {
          Stream.call(this);
          options = options || {};
          this.writable = options.writable !== false;
          this.writableEnded = false;
          this.writableFinished = false;
          this.destroyed = false;
          this.writableNeedDrain = false;
          this._writableState = {
            errorEmitted: false,
            ended: false,
            finished: false,
            destroyed: false,
            writing: false,
            corked: 0,
            length: 0,
            needDrain: false,
            decodeStrings: true,
            defaultEncoding: 'utf8',
            writing: false,
            buffered: [],
            bufferedIndex: 0,
            pendingcb: 0,
            sync: false
          };
        }
        Object.setPrototypeOf(Writable.prototype, Stream.prototype);

        Writable.prototype._write = function(chunk, encoding, cb) {
          if (cb) cb();
        };

        Writable.prototype.write = function(data, encoding, cb) {
          if (typeof encoding === 'function') { cb = encoding; encoding = null; }
          if (this.writableEnded || this.destroyed || this.writable === false) {
            const err = new Error('write after end');
            if (typeof cb === 'function') cb(err);
            else this.emit('error', err);
            return false;
          }

          const done = typeof cb === 'function' ? cb : function(){};
          this._writableState.writing = true;
          try {
            // Node's Writable.write delegates to _write(). The old polyfill skipped it,
            // which broke libraries (notably ws) that install their behavior there.
            this._write(data, encoding || 'utf8', (err) => {
              this._writableState.writing = false;
              if (err) {
                this._writableState.errorEmitted = true;
                this.emit('error', err);
              }
              done(err);
            });
          } catch (err) {
            this._writableState.writing = false;
            this._writableState.errorEmitted = true;
            this.emit('error', err);
            done(err);
            return false;
          }
          return true;
        };

        Writable.prototype.end = function(data, encoding, cb) {
          if (typeof data === 'function') { cb = data; data = null; encoding = null; }
          else if (typeof encoding === 'function') { cb = encoding; encoding = null; }

          if (this.writableEnded || this.destroyed) {
            if (typeof cb === 'function') cb();
            return this;
          }

          if (data !== undefined && data !== null) this.write(data, encoding);
          this.writableEnded = true;
          this._writableState.ended = true;
          this.writableFinished = true;
          this._writableState.finished = true;
          this.finished = true;
          this.emit('finish');
          this.emit('close');
          if (typeof cb === 'function') cb();
          return this;
        };

        Writable.prototype.destroy = function(err, cb) {
          if (this.destroyed) {
            if (typeof cb === 'function') cb(err);
            return this;
          }
          this.destroyed = true;
          this.writable = false;
          this._writableState.destroyed = true;
          if (err) {
            this._writableState.errorEmitted = true;
            this.emit('error', err);
          }
          this.emit('close');
          if (typeof cb === 'function') cb(err);
          return this;
        };
        Writable.prototype.cork = function() { this._writableState.corked++; };
        Writable.prototype.uncork = function() { if (this._writableState.corked) this._writableState.corked--; };

        function Duplex(options) {
          options = options || {};
          // Initialize the two stream states without calling Stream/EventEmitter twice.
          Readable.call(this, options);
          this.writable = options.writable !== false;
          this.writableEnded = false;
          this.writableFinished = false;
          this.writableNeedDrain = false;
          this._writableState = {
            errorEmitted: false, ended: false, finished: false, destroyed: false,
            writing: false, corked: 0, length: 0, needDrain: false,
            decodeStrings: true, defaultEncoding: 'utf8', buffered: [],
            bufferedIndex: 0, pendingcb: 0, sync: false
          };
          this.destroyed = false;
          this.readable = options.readable !== false;
        }
        Object.setPrototypeOf(Duplex.prototype, Readable.prototype);
        // Copy only Writable methods that are not already supplied by Readable/EventEmitter.
        ['write','end','_write','cork','uncork'].forEach(key => {
          Duplex.prototype[key] = Writable.prototype[key];
        });
        Duplex.prototype.destroy = function(err, cb) {
          if (this.destroyed) {
            if (typeof cb === 'function') cb(err);
            return this;
          }
          this.destroyed = true;
          this.readable = false;
          this.writable = false;
          this.readableEnded = true;
          this.writableEnded = true;
          this._readableState.destroyed = true;
          this._writableState.destroyed = true;
          if (err) {
            this.emit('error', err);
          }
          this.emit('close');
          if (typeof cb === 'function') cb(err);
          return this;
        };

        function Transform(options) {
          Duplex.call(this, options);
        }
        Object.setPrototypeOf(Transform.prototype, Duplex.prototype);
        Transform.prototype._transform = function(chunk, encoding, cb) { cb(null, chunk); };

        function PassThrough(options) {
          Transform.call(this, options);
        }
        Object.setPrototypeOf(PassThrough.prototype, Transform.prototype);

        // Node stream pipeline helper utility
        function pipeline(...streams) {
          let callback = streams[streams.length - 1];
          if (typeof callback === 'function') {
            streams.pop();
          } else {
            callback = (err) => { if (err) console.error("Pipeline error:", err); };
          }

          let current = streams[0];
          for (let i = 1; i < streams.length; i++) {
            current = current.pipe(streams[i]);
          }

          let finishedCount = 0;
          const checkDone = (err) => {
            if (err) return callback(err);
            finishedCount++;
            if (finishedCount >= streams.length) {
              callback(null);
            }
          };

          streams.forEach(s => {
            s.on('error', checkDone);
            s.on('finish', () => checkDone());
            s.on('end', () => checkDone());
          });

          return streams[streams.length - 1];
        }

        // Node stream finished helper utility
        function finished(stream, cb) {
          let ended = false;
          const done = (err) => {
            if (ended) return;
            ended = true;
            cb(err || null);
          };
          stream.on('end', () => done());
          stream.on('finish', () => done());
          stream.on('error', (err) => done(err));
          return () => {};
        }

        // Attach all stream classes and utilities
        Stream.Stream = Stream;
        Stream.Readable = Readable;
        Stream.Writable = Writable;
        Stream.Duplex = Duplex;
        Stream.Transform = Transform;
        Stream.PassThrough = PassThrough;
        Stream.pipeline = pipeline;
        Stream.finished = finished;

        module.exports = Stream;
        module.exports.Stream = Stream;
        module.exports.Readable = Readable;
        module.exports.Writable = Writable;
        module.exports.Duplex = Duplex;
        module.exports.Transform = Transform;
        module.exports.PassThrough = PassThrough;
        module.exports.pipeline = pipeline;
        module.exports.finished = finished;

        return module.exports;
      })();

      /**
       * tty
       */
      polyfills.tty = (function() {
        const module = { exports: {} };
        const exports = module.exports;
        const Stream = polyfills.stream;

        exports.isatty = function(fd) {
          return false; // Browser standard output stream is not a TTY terminal device
        };

        function ReadStream() {
          if (Stream && Stream.Readable) {
            Stream.Readable.call(this);
          }
          this.isRaw = false;
          this.isTTY = false;
        }
        if (Stream && Stream.Readable) {
          Object.setPrototypeOf(ReadStream.prototype, Stream.Readable.prototype);
        }
        ReadStream.prototype.setRawMode = function(mode) {
          this.isRaw = !!mode;
          return this;
        };

        function WriteStream() {
          if (Stream && Stream.Writable) {
            Stream.Writable.call(this);
          }
          this.columns = 80;
          this.rows = 24;
          this.isTTY = false;
        }
        if (Stream && Stream.Writable) {
          Object.setPrototypeOf(WriteStream.prototype, Stream.Writable.prototype);
        }

        exports.ReadStream = ReadStream;
        exports.WriteStream = WriteStream;

        return module.exports;
      })();

      /**
       * util
       */
      polyfills.util = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        exports.inherits = function(ctor, superCtor) {
          if (superCtor) {
            ctor.super_ = superCtor;
            Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
          }
        };

        exports.promisify = function(fn) {
          return function(...args) {
            return new Promise((resolve, reject) => {
              fn.call(this, ...args, (err, result) => {
                if (err) reject(err);
                else resolve(result);
              });
            });
          };
        };

        exports.deprecate = function(fn, msg) {
          return function(...args) {
            return fn.apply(this, args);
          };
        };

        exports.inspect = function(obj) {
          try {
            return JSON.stringify(obj, null, 2);
          } catch (e) {
            return String(obj);
          }
        };

        return module.exports;
      })();

      /**
       * buffer
       */
      polyfills.buffer = (function() {
        const module = { exports: {} };

        // ES5 Function constructor to allow calling with or without 'new'
        function Buffer(arg, encodingOrOffset, length) {
          let arr;
          
          if (typeof arg === 'number') {
            arr = new Uint8Array(arg);
          } else if (typeof arg === 'string') {
            arr = new TextEncoder().encode(arg);
          } else if (arg && arg.buffer instanceof ArrayBuffer) {
            arr = new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength);
          } else {
            arr = new Uint8Array(arg || 0);
          }

          // Bind prototype chain so `instanceof Buffer` works
          Object.setPrototypeOf(arr, Buffer.prototype);
          return arr;
        }

        // Inherit standard Uint8Array prototype methods (slice, set, etc.)
        Object.setPrototypeOf(Buffer.prototype, Uint8Array.prototype);
        Object.setPrototypeOf(Buffer, Uint8Array);

        // Instance methods
        Buffer.prototype.toString = function(encoding) {
          return new TextDecoder().decode(this);
        };
        Buffer.prototype._isBuffer = true;

        // Static methods
        Buffer.from = function(data, encoding) {
          return Buffer(data, encoding);
        };

        Buffer.alloc = function(size) {
          return Buffer(size);
        };

        Buffer.allocUnsafe = Buffer.alloc;

        Buffer.prototype.writeUInt8 = function(value, offset = 0) {
          this[offset] = value & 0xff;
          return offset + 1;
        };

        Buffer.prototype.writeUInt16BE = function(value, offset = 0) {
          this[offset] = (value >>> 8) & 0xff;
          this[offset + 1] = value & 0xff;
          return offset + 2;
        };

        Buffer.prototype.writeUInt16LE = function(value, offset = 0) {
          this[offset] = value & 0xff;
          this[offset + 1] = (value >>> 8) & 0xff;
          return offset + 2;
        };

        Buffer.prototype.writeUInt32BE = function(value, offset = 0) {
          this[offset] = (value >>> 24) & 0xff;
          this[offset + 1] = (value >>> 16) & 0xff;
          this[offset + 2] = (value >>> 8) & 0xff;
          this[offset + 3] = value & 0xff;
          return offset + 4;
        };

        Buffer.prototype.writeUInt32LE = function(value, offset = 0) {
          this[offset] = value & 0xff;
          this[offset + 1] = (value >>> 8) & 0xff;
          this[offset + 2] = (value >>> 16) & 0xff;
          this[offset + 3] = (value >>> 24) & 0xff;
          return offset + 4;
        };

        Buffer.prototype.writeUIntBE = function(value, offset, byteLength) {
          for (let i = 0; i < byteLength; i++) {
            this[offset + byteLength - 1 - i] = value & 0xff;
            value = Math.floor(value / 256);
          }
          return offset + byteLength;
        };

        Buffer.concat = function(list, totalLength) {
          if (totalLength === undefined) {
            totalLength = list.reduce((acc, val) => acc + val.length, 0);
          }
          let result = Buffer(totalLength);
          let offset = 0;
          for (let buf of list) {
            result.set(buf, offset);
            offset += buf.length;
          }
          return result;
        };

        Buffer.isBuffer = function(obj) {
          return obj != null && (obj._isBuffer === true || obj instanceof Buffer);
        };

        Buffer.byteLength = function(str, encoding) {
          if (typeof str !== 'string') {
            return str.buffer ? str.byteLength : (str.length || 0);
          }
          return new TextEncoder().encode(str).length;
        };

        // Expose globally
        if (typeof window !== 'undefined' && !window.Buffer) {
          window.Buffer = Buffer;
        }
        if (typeof global !== 'undefined' && !global.Buffer) {
          global.Buffer = Buffer;
        }

        module.exports = { Buffer: Buffer };
        return module.exports;
      })();

      /**
       * fs polyfill
       */
      polyfills.fs = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        // Dynamically retrieve the resolved FileSystem instance
        function getFS() {
          const fsInstance = window.fileSystem;
          if (!fsInstance || typeof fsInstance.existsSync !== 'function') {
            throw new Error("FileSystem Error: window.fileSystem is not ready or initialized.");
          }
          return fsInstance;
        }

        // --- Path Normalization & Resolution Helpers ---

        function normalizePath(pathStr) {
          const parts = pathStr.split('/').filter(Boolean);
          const stack = [];
          for (const part of parts) {
            if (part === '.') continue;
            if (part === '..') {
              stack.pop();
            } else {
              stack.push(part);
            }
          }
          return '/' + stack.join('/');
        }

        function getRootFolder() {
          let root = (typeof rootfolder !== 'undefined' && rootfolder) ? rootfolder : '';
          if (root && !root.startsWith('/')) root = '/' + root;
          if (root && !root.endsWith('/')) root = root + '/';
          return root;
        }

        function resolveZipPath(p) {
          if (!p) return getRootFolder().slice(1).replace(/\/+$/, '');
          
          const rawPath = String(p ?? '.');
          const cwd = (window.process && typeof window.process.cwd === 'function') ? window.process.cwd() : '/';
          const resolved = rawPath.startsWith('/') ? rawPath : `${cwd}/${rawPath}`;

          const normalized = normalizePath(resolved);
          const root = getRootFolder(); 

          let fullPath = normalized;
          if (root && !fullPath.startsWith(root)) {
            const cleanNorm = fullPath.startsWith('/') ? fullPath.slice(1) : fullPath;
            const cleanRoot = root.startsWith('/') ? root.slice(1) : root;
            fullPath = cleanRoot + cleanNorm;
          }

          return fullPath.replace(/^\/+/, "").replace(/\/+$/, "");
        }

        function resolveCacheTarget(p) {
          const fsInstance = getFS();
          const resolved = resolveZipPath(p);
          if (fsInstance.existsSync(resolved)) {
            return { path: resolved, isFallback: false };
          }
          const fallbackPath = resolved ? `${resolved}/index.html` : 'index.html';
          if (fsInstance.existsSync(fallbackPath)) {
            return { path: fallbackPath, isFallback: true };
          }
          return null;
        }

        // --- Synchronous Methods ---

        exports.existsSync = function(filePath) {
          try {
            const match = resolveCacheTarget(filePath);
            if (match) return true;

            const targetDir = resolveZipPath(filePath);
            const prefix = targetDir.endsWith('/') ? targetDir : targetDir + '/';
            return getFS().listFilesSync().some(file => file.startsWith(prefix));
          } catch (e) {
            return false;
          }
        };

        exports.readdirSync = function(dirPath = '.') {
          const fsInstance = getFS();
          const target = resolveZipPath(dirPath || '.');
          const prefix = target ? (target.endsWith('/') ? target : target + '/') : '';
          const entries = new Map();
          for (const file of fsInstance.listFilesSync()) {
            if (!file.startsWith(prefix)) continue;
            const rest = file.slice(prefix.length);
            if (!rest) continue;
            const slash = rest.indexOf('/');
            entries.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
          }
          return Array.from(entries.keys()).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
        };

        exports.statSync = function(filePath) {
          const match = resolveCacheTarget(filePath);
          const exists = exports.existsSync(filePath);

          if (!exists && !match) {
            const err = new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
            err.code = 'ENOENT';
            err.errno = -2;
            err.path = filePath;
            err.syscall = 'stat';
            throw err;
          }

          const isDir = !match && exists;
          let size = 1024;
          let mimeType = isDir ? 'inode/directory' : 'application/octet-stream';

          if (!isDir && match) {
            const fileData = getFS().readFileSync(match.path, 'binary');
            size = fileData ? (fileData.byteLength || fileData.length || 0) : 0;
            
            if (typeof inferMime === 'function') {
              mimeType = inferMime(match.path);
            }
          }

          return {
            isDirectory: () => isDir,
            isFile: () => !isDir,
            size: size,
            mime: mimeType,
            mtime: new Date(),
            ino: 0,
            mode: isDir ? 16877 : 33188,
            uid: 0,
            gid: 0,
            ctime: new Date(),
            birthtime: new Date()
          };
        };

        exports.lstatSync = function(filePath) {
          try {
            const stats = exports.statSync(filePath);
            stats.syscall = 'lstat';
            return stats;
          } catch (err) {
            if (err.message && err.message.includes('stat')) {
              err.message = err.message.replace('stat', 'lstat');
              err.syscall = 'lstat';
            }
            throw err;
          }
        };

        exports.readFileSync = function(filePath, options) {
          const match = resolveCacheTarget(filePath);
          if (!match) {
            throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
          }

          const encoding = typeof options === 'string' ? options : (options && options.encoding);
          const data = getFS().readFileSync(match.path, encoding === 'utf8' ? 'utf8' : 'binary');

          if (encoding) {
            return typeof data === 'string' ? data : new TextDecoder().decode(data);
          }

          return (typeof Buffer !== 'undefined') ? Buffer.from(data) : data;
        };

        exports.readdirSync = function(filePath, options) {
          const targetDir = resolveZipPath(filePath);
          const prefix = targetDir.endsWith('/') ? targetDir : targetDir + '/';
          const entries = new Set();

          const allFiles = getFS().listFilesSync();
          
          allFiles.forEach((relativePath) => {
            if (relativePath.startsWith(prefix)) {
              const subPath = relativePath.slice(prefix.length);
              if (subPath) {
                const firstSegment = subPath.split('/')[0];
                entries.add(firstSegment);
              }
            }
          });

          const resultArray = Array.from(entries);
          if (resultArray.length === 0 && !exports.existsSync(filePath)) {
            throw new Error(`ENOENT: no such file or directory, scandir '${filePath}'`);
          }
          return resultArray;
        };

        exports.writeFileSync = function(filePath, content, options) {
          const targetPath = resolveZipPath(filePath);
          getFS().writeFileSync(targetPath, content);
        };

        // --- Callback-Based Async Methods ---

        exports.stat = function(filePath, options, callback) {
          const cb = typeof options === 'function' ? options : callback;
          try {
            const stats = exports.statSync(filePath);
            if (cb) cb(null, stats);
          } catch (err) {
            if (cb) cb(err);
          }
        };

        exports.lstat = function(filePath, options, callback) {
          const cb = typeof options === 'function' ? options : callback;
          try {
            const stats = exports.lstatSync(filePath);
            if (cb) cb(null, stats);
          } catch (err) {
            if (cb) cb(err);
          }
        };

        exports.readFile = function(filePath, options, callback) {
          const cb = typeof options === 'function' ? options : (typeof callback === 'function' ? callback : null);
          try {
            const result = exports.readFileSync(filePath, options);
            if (cb) cb(null, result);
          } catch (err) {
            if (cb) cb(err);
          }
        };

        exports.readdir = function(filePath, options, callback) {
          const cb = typeof options === 'function' ? options : callback;
          try {
            const entries = exports.readdirSync(filePath);
            if (cb) cb(null, entries);
          } catch (err) {
            if (cb) cb(err);
          }
        };

        exports.writeFile = function(filePath, content, options, callback) {
          const cb = typeof options === 'function' ? options : callback;
          try {
            exports.writeFileSync(filePath, content, options);
            if (cb) cb(null);
          } catch (err) {
            if (cb) cb(err);
          }
        };

        // --- Streams ---

        exports.createReadStream = function(filePath, options) {
          const Readable = (typeof polyfills !== 'undefined' && polyfills.stream) 
            ? polyfills.stream.Readable 
            : class {
                constructor() { this._listeners = {}; }
                push(data) { if (this.onData) this.onData(data); }
                emit(event, err) { if (this._listeners[event]) this._listeners[event](err); }
                on(event, fn) { this._listeners[event] = fn; }
              };

          const stream = new Readable();
          
          // Defer read execution to allow event listener attachment (e.g. stream.on('error'))
          setTimeout(() => {
            try {
              const match = resolveCacheTarget(filePath);
              if (!match) {
                throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
              }
              
              const data = getFS().readFileSync(match.path, 'binary');
              if (stream.push) {
                stream.push(data instanceof Uint8Array ? data : new Uint8Array(data));
                stream.push(null);
              }
            } catch (err) {
              if (stream.emit) stream.emit('error', err);
            }
          }, 0);

          return stream;
        };

        // --- Promise API ---

        exports.promises = {
          readFile: async function(filePath, options) {
            return exports.readFileSync(filePath, options);
          },
          stat: async function(filePath) {
            return exports.statSync(filePath);
          },
          lstat: async function(filePath) {
            return exports.lstatSync(filePath);
          },
          readdir: async function(filePath, options) {
            return exports.readdirSync(filePath, options);
          },
          writeFile: async function(filePath, content, options) {
            return exports.writeFileSync(filePath, content, options);
          }
        };

        // --- Streams ---

        function ReadStream(filePath, options) {
          if (!(this instanceof ReadStream)) {
            return new ReadStream(filePath, options);
          }
          polyfills.stream.Readable.call(this, options);
          this.path = filePath;
        }
        Object.setPrototypeOf(ReadStream.prototype, polyfills.stream.Readable.prototype);

        // Expose ReadStream on exports for external 'instanceof' checks
        exports.ReadStream = ReadStream;

        exports.createReadStream = function(filePath, options) {
          const stream = new ReadStream(filePath, options);
          
          // Defer read execution to allow event listener attachment (e.g. stream.on('error'))
          setTimeout(() => {
            try {
              const match = resolveCacheTarget(filePath);
              if (!match) {
                throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
              }
              
              const data = getFS().readFileSync(match.path, 'binary');
              if (typeof stream.push === 'function') {
                stream.push(data instanceof Uint8Array ? data : new Uint8Array(data));
                stream.push(null);
              }
            } catch (err) {
              if (typeof stream.emit === 'function') stream.emit('error', err);
            }
          }, 0);

          return stream;
        };

        return module.exports;
      })();

      /**
       * os
       */
      polyfills.os = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        exports.hostname = () => 'localhost';
        exports.platform = () => 'browser';
        exports.arch = () => 'x64';
        exports.release = () => '1.0.0';
        exports.uptime = () => 0;
        exports.loadavg = () => [0, 0, 0];
        exports.totalmem = () => 1024 * 1024 * 1024;
        exports.freemem = () => 512 * 1024 * 1024;
        exports.cpus = () => [{ model: 'Virtual Browser CPU', speed: 2000 }];
        exports.networkInterfaces = () => ({});
        exports.EOL = '\n';

        return module.exports;
      })();

      /**
       * url
       */
      polyfills.url = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        exports.parse = function(urlString, parseQueryString, slashesDenoteHost) {
          try {
            // Use standard browser URL parser as underlying engine
            const base = 'http://localhost';
            const parsed = new URL(urlString, base);

            const queryObj = {};
            if (parseQueryString) {
              parsed.searchParams.forEach((val, key) => {
                if (queryObj[key]) {
                  if (Array.isArray(queryObj[key])) {
                    queryObj[key].push(val);
                  } else {
                    queryObj[key] = [queryObj[key], val];
                  }
                } else {
                  queryObj[key] = val;
                }
              });
            }

            return {
              href: urlString,
              protocol: urlString.includes('://') ? parsed.protocol : null,
              slashes: urlString.includes('://'),
              auth: parsed.username ? `${parsed.username}:${parsed.password}` : null,
              host: parsed.host,
              hostname: parsed.hostname,
              port: parsed.port || null,
              search: parsed.search || null,
              query: parseQueryString ? queryObj : (parsed.search ? parsed.search.slice(1) : null),
              pathname: parsed.pathname,
              path: parsed.pathname + parsed.search,
              hash: parsed.hash || null
            };
          } catch (e) {
            // Fallback for relative or partial paths
            const queryIdx = urlString.indexOf('?');
            const pathname = queryIdx !== -1 ? urlString.slice(0, queryIdx) : urlString;
            const search = queryIdx !== -1 ? urlString.slice(queryIdx) : null;

            return {
              href: urlString,
              pathname: pathname,
              search: search,
              path: urlString,
              query: parseQueryString && search ? parseSearchParams(search.slice(1)) : (search ? search.slice(1) : null)
            };
          }
        };

        function parseSearchParams(searchStr) {
          const obj = {};
          const params = new URLSearchParams(searchStr);
          params.forEach((val, key) => {
            obj[key] = val;
          });
          return obj;
        }

        exports.format = function(urlObj) {
          if (typeof urlObj === 'string') return urlObj;
          let out = urlObj.pathname || '';
          if (urlObj.search) {
            out += urlObj.search;
          } else if (urlObj.query && typeof urlObj.query === 'object') {
            const params = new URLSearchParams(urlObj.query).toString();
            if (params) out += '?' + params;
          }
          return out;
        };

        exports.resolve = function(from, to) {
          try {
            const base = new URL(from, 'http://localhost');
            const resolved = new URL(to, base);
            return resolved.pathname + resolved.search;
          } catch (e) {
            return to;
          }
        };

        exports.URL = globalThis.URL;
        exports.URLSearchParams = globalThis.URLSearchParams;

        return module.exports;
      })();

      /**
       * http
       */
      polyfills.http = (function() {
        const module = { exports: {} };
        const exports = module.exports;
        const EventEmitter = polyfills.events;
        const Stream = polyfills.stream;

        // Node standard HTTP methods list required by the 'methods' npm package
        exports.METHODS = [
          'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD',
          'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL',
          'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH',
          'PURGE', 'PUT', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE',
          'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'
        ];

        exports.STATUS_CODES = {
          100: 'Continue', 101: 'Switching Protocols',
          200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
          301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
          400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
          500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable'
        };

        /**
         * Simulated HTTP Server (implements listen/emit request)
         */
        class Server extends EventEmitter {
          constructor(requestListener) {
            super();
            if (requestListener) {
              this.on('request', requestListener);
            }
            this.listening = false;
          }

          listen(port, host, callback) {
            const cb = typeof port === 'function' ? port : (typeof host === 'function' ? host : callback);
            const portNum = typeof port === 'number' || typeof port === 'string' ? String(port) : '3000';
            
            this.listening = true;
            if (typeof activeServers !== 'undefined' && activeServers.set) {
              activeServers.set(portNum, this);
            }
            try { nodeEmulator?.dispatchEvent?.('serverstart', this, portNum); } catch (_) {}
            if (cb) cb();
            return this;
          }

          close(cb) {
            this.listening = false;
            if (cb) cb();
            return this;
          }
        }

        /**
         * IncomingMessage stream wrapper for request handling in Express
         */
        class IncomingMessage extends Stream.Readable {
          constructor(url, method = 'GET', headers = {}, body = null) {
            super();
            this.url = url || '/';
            this.method = method.toUpperCase();
            this.headers = {};
            
            if (headers) {
              for (const k of Object.keys(headers)) {
                this.headers[k.toLowerCase()] = headers[k];
              }
            }

            this.rawHeaders = [];
            this.statusCode = 200;
            this.statusMessage = 'OK';
            
            // Setup socket/connection properties required by isFinished
            this.connection = new EventEmitter();
            this.connection.readable = true;
            this.connection.writable = true;
            this.socket = this.connection;

            this.complete = false;
            this.upgrade = false;

            // The lightweight Readable polyfill emits pushed chunks synchronously.
            // A real Node IncomingMessage, however, buffers request data until the
            // server/transport has had a chance to attach its data/end listeners.
            // Engine.IO polling POSTs rely on exactly that behavior: it installs
            // req.on("data") and req.on("end") after the request object is created.
            // Defer delivery one turn so those listeners cannot miss the body/end.
            const payload = (body !== null && body !== undefined)
              ? (typeof body === 'object' ? JSON.stringify(body) : String(body))
              : null;

            setTimeout(() => {
              if (this.destroyed) return;
              if (payload !== null) this.push(payload);
              this.push(null);
              this.complete = true;
            }, 0);
          }

          resume() {
            // Match Readable semantics closely enough for body-parser/finalhandler.
            this.readableFlowing = true;
            if (this._readableState) this._readableState.flowing = true;
            return this;
          }

          pause() {
            this.readableFlowing = false;
            if (this._readableState) this._readableState.flowing = false;
            return this;
          }

          setEncoding(encoding) {
            this._encoding = encoding;
            return this;
          }
        }

        /**
         * ServerResponse mock used to bridge res.send()/res.end() to frontend Promises
         */
        class ServerResponse extends Stream.Writable {
          constructor(onComplete) {
            super();
            this._onComplete = onComplete;
            this.statusCode = 200;
            this.statusMessage = 'OK';
            this._headers = {};
            this.headersSent = false;
            this.chunks = [];

            // Setup socket/connection properties required by isFinished
            this.connection = new EventEmitter();
            this.connection.writable = true;
            this.connection.readable = true;
            this.socket = this.connection;

            // Stream completion flags
            this.finished = false;
            this.writableEnded = false;
          }

          setHeader(name, value) {
            this._headers[name.toLowerCase()] = value;
            return this;
          }

          getHeader(name) {
            return this._headers[name.toLowerCase()];
          }

          removeHeader(name) {
            delete this._headers[name.toLowerCase()];
            return this;
          }

          writeHead(statusCode, statusMessage, headers) {
            if (typeof statusMessage === 'object') {
              headers = statusMessage;
              statusMessage = exports.STATUS_CODES[statusCode] || 'OK';
            }
            this.statusCode = statusCode;
            this.statusMessage = statusMessage || exports.STATUS_CODES[statusCode] || 'OK';

            if (headers) {
              for (const k of Object.keys(headers)) {
                this.setHeader(k, headers[k]);
              }
            }
            this.headersSent = true;
            return this;
          }

          write(chunk, encoding, callback) {
            if (this.finished || this.writableEnded) {
              if (callback) callback(new Error('write after end'));
              return false;
            }
            if (chunk) {
              if (typeof chunk === 'string') {
                this.chunks.push(new TextEncoder().encode(chunk));
              } else {
                this.chunks.push(chunk);
              }
            }
            if (callback) callback();
            return true;
          }

          end(data, encoding, callback) {
            if (typeof data === 'function') {
              callback = data;
              data = null;
            } else if (typeof encoding === 'function') {
              callback = encoding;
              encoding = null;
            }

            if (this.finished || this.writableEnded) {
              if (callback) callback();
              return this;
            }

            if (data) {
              this.write(data, encoding);
            }

            // Mark finished flags immediately
            this.finished = true;
            this.writableEnded = true;
            if (this.socket) {
              this.socket.writable = false;
            }

            // Consolidate response buffer
            let totalLength = this.chunks.reduce((acc, c) => acc + (c ? c.length : 0), 0);
            let combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of this.chunks) {
              if (chunk) {
                combined.set(chunk, offset);
                offset += chunk.length;
              }
            }

            if (this._onComplete) {
              const responseHeaders = new Headers();
              for (const [key, val] of Object.entries(this._headers)) {
                // Normalize array headers (like set-cookie) for the Web API
                if (Array.isArray(val)) {
                  val.forEach(v => responseHeaders.append(key, v));
                } else {
                  responseHeaders.set(key, val);
                }
              }

              // Generate the native Response
              const webResponse = new Response(combined, {
                status: this.statusCode,
                statusText: this.statusMessage,
                headers: responseHeaders
              });

              // Fire the callback synchronously with the Response object
              this._onComplete(webResponse);
            }

            this.emit('finish');
            if (callback) callback();
            return this;
          }
        }

        exports.Server = Server;
        exports.IncomingMessage = IncomingMessage;
        exports.ServerResponse = ServerResponse;

        exports.createServer = function(requestListener) {
          return new Server(requestListener);
        };

        return module.exports;
      })();

      /**
       * https
       */
      polyfills.https = (function() {
        const module = { exports: {} };
        const http = polyfills.http;

        if (!http) {
          throw new Error("[Polyfill Error] 'http' module must be defined before 'https'");
        }

        // Copy standard http exports (Server, IncomingMessage, ServerResponse, METHODS, etc.)
        for (const key of Object.keys(http)) {
          module.exports[key] = http[key];
        }

        // Override createServer to denote HTTPS / secure contexts if needed
        const originalCreateServer = http.createServer;
        module.exports.createServer = function(options, requestListener) {
          if (typeof options === 'function') {
            requestListener = options;
            options = {};
          }
          const server = originalCreateServer(requestListener);
          server.secure = true;
          return server;
        };

        class HttpsServer extends http.Server {
          constructor(options, requestListener) {
            if (typeof options === 'function') {
              requestListener = options;
              options = {};
            }
            super(requestListener);
            this.secure = true;
          }
        }

        module.exports.Server = HttpsServer;

        // Mock global request wrapper for client-side libraries like node-fetch
        module.exports.request = function(url, options, cb) {
          if (typeof url === 'string') {
            url = new URL(url);
          } else {
            options = url;
            url = null;
          }
          if (typeof options === 'function') {
            cb = options;
            options = {};
          }
          // Fallback to fetch or standard client request mock
          const req = new http.IncomingMessage(url ? url.pathname : '/', options.method || 'GET', options.headers || {});
          if (cb) {
            const res = new http.ServerResponse((result) => {
              cb(res);
            });
            // simulate async response trigger
            setTimeout(() => cb(res), 0);
          }
          return req;
        };

        module.exports.get = function(url, options, cb) {
          const req = module.exports.request(url, options, cb);
          return req;
        };

        return module.exports;
      })();

      /**
       * zlib
       */
      polyfills.zlib = (function() {
        const module = { exports: {} };
        const exports = module.exports;
        const Stream = polyfills.stream;

        // Base Zlib class inheriting from stream.Transform (or fallback to stream.Stream)
        function ZlibBase() {
          const BaseStream = (Stream && Stream.Transform) ? Stream.Transform : Stream.Stream;
          if (BaseStream) {
            BaseStream.call(this);
          }
        }
        
        const BaseStreamProto = (Stream && Stream.Transform) ? Stream.Transform.prototype : (Stream ? Stream.Stream.prototype : null);
        if (BaseStreamProto) {
          Object.setPrototypeOf(ZlibBase.prototype, BaseStreamProto);
        }

        // Pass-through mock implementation for streams in case something tries to pipe to them
        ZlibBase.prototype._transform = function(chunk, encoding, callback) {
          if (typeof this.push === 'function') this.push(chunk);
          if (callback) callback();
        };
        ZlibBase.prototype.write = function(chunk, encoding, callback) {
          if (typeof this.push === 'function') this.push(chunk);
          if (callback) callback();
          return true;
        };
        ZlibBase.prototype.end = function(chunk, encoding, callback) {
          if (chunk) this.write(chunk, encoding);
          if (typeof this.emit === 'function') this.emit('end');
          if (callback) callback();
        };

        // Standard zlib stream classes used by Node
        const classNames = [
          'Gzip', 'Gunzip', 'Deflate', 'Inflate', 'DeflateRaw', 'InflateRaw', 'Unzip'
        ];

        classNames.forEach(name => {
          const Ctor = function(options) {
            ZlibBase.call(this);
          };
          Object.setPrototypeOf(Ctor.prototype, ZlibBase.prototype);
          
          // Export the class
          exports[name] = Ctor;
          
          // Export the factory method
          exports['create' + name] = function(options) {
            return new Ctor(options);
          };
        });

        // Common constants referenced by Express middlewares (like 'compression')
        exports.constants = {
          Z_OK: 0,
          Z_STREAM_END: 1,
          Z_NEED_DICT: 2,
          Z_ERRNO: -1,
          Z_STREAM_ERROR: -2,
          Z_DATA_ERROR: -3,
          Z_MEM_ERROR: -4,
          Z_BUF_ERROR: -5,
          Z_VERSION_ERROR: -6,
          Z_NO_COMPRESSION: 0,
          Z_BEST_SPEED: 1,
          Z_BEST_COMPRESSION: 9,
          Z_DEFAULT_COMPRESSION: -1
        };

        // Mock static methods
        exports.gzip = exports.gzipSync = function(buffer, options, callback) {
          const cb = typeof options === 'function' ? options : callback;
          if (cb) cb(null, buffer);
          return buffer;
        };
        exports.gunzip = exports.gunzipSync = exports.gzipSync;
        exports.deflate = exports.deflateSync = exports.gzipSync;
        exports.inflate = exports.inflateSync = exports.gzipSync;

        return module.exports;
      })();

      /**
       * crypto
       */
      polyfills.crypto = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        // Simple hashing fallback for browser environments
        function simpleHash(str) {
          let hash = 0;
          for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
          }
          return Math.abs(hash).toString(16);
        }

        function Hash(algorithm) {
          this.algorithm = algorithm;
          this.buffer = [];
        }

        Hash.prototype.update = function(data) {
          if (data) {
            if (typeof data !== 'string') {
              data = new TextDecoder().decode(data);
            }
            this.buffer.push(data);
          }
          return this;
        };

        Hash.prototype.digest = function(encoding) {
          const combined = this.buffer.join('');
          const rawHash = simpleHash(combined);
          
          // Pad out to resemble standard hex output length
          const hex = (rawHash + '1234567890abcdef1234567890abcdef').slice(0, 32);

          if (encoding === 'base64') {
            try {
              return btoa(hex);
            } catch (e) {
              return hex;
            }
          }
          return hex;
        };

        exports.createHash = function(algorithm) {
          return new Hash(algorithm || 'sha1');
        };

        exports.createHmac = function(algorithm, key) {
          return exports.createHash(algorithm);
        };

        exports.randomBytes = function(size, callback) {
          const bytes = new Uint8Array(size);
          if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
          } else {
            for (let i = 0; i < size; i++) {
              bytes[i] = Math.floor(Math.random() * 256);
            }
          }

          if (callback) {
            callback(null, bytes);
            return;
          }

          // Support Node's buffer/object output wrapper if needed
          return {
            toString: (enc) => {
              let hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
              return enc === 'base64' ? btoa(hex) : hex;
            },
            buffer: bytes
          };
        };

        exports.randomFillSync = function(buffer, offset, size) {
          const target = buffer.subarray ? buffer.subarray(offset, offset + size) : buffer;
          if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(target);
          }
          return buffer;
        };

        return module.exports;
      })();

      /**
       * querystring
       */
      polyfills.querystring = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        exports.stringify = function(obj, sep, eq, options) {
          sep = sep || '&';
          eq = eq || '=';
          if (!obj || typeof obj !== 'object') return '';

          return Object.keys(obj)
            .map(k => {
              const ks = encodeURIComponent(k);
              const val = obj[k];
              if (Array.isArray(val)) {
                return val.map(v => `${ks}${eq}${encodeURIComponent(v)}`).join(sep);
              }
              return `${ks}${eq}${encodeURIComponent(val !== undefined ? val : '')}`;
            })
            .filter(Boolean)
            .join(sep);
        };

        exports.parse = function(qs, sep, eq, options) {
          sep = sep || '&';
          eq = eq || '=';
          const obj = {};

          if (!qs || typeof qs !== 'string') return obj;

          const pairs = qs.split(sep);
          for (const pair of pairs) {
            const eqIdx = pair.indexOf(eq);
            const key = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
            const val = eqIdx === -1 ? '' : pair.slice(eqIdx + eq.length);

            const decodedKey = decodeURIComponent(key.replace(/\+/g, ' '));
            const decodedVal = decodeURIComponent(val.replace(/\+/g, ' '));

            if (Object.prototype.hasOwnProperty.call(obj, decodedKey)) {
              if (!Array.isArray(obj[decodedKey])) {
                obj[decodedKey] = [obj[decodedKey]];
              }
              obj[decodedKey].push(decodedVal);
            } else {
              obj[decodedKey] = decodedVal;
            }
          }

          return obj;
        };

        exports.escape = function(str) {
          return encodeURIComponent(str);
        };

        exports.unescape = function(str) {
          return decodeURIComponent(str.replace(/\+/g, ' '));
        };

        return module.exports;
      })();

      /**
       * net
       */
      polyfills.net = (function() {
        const module = { exports: {} };
        const exports = module.exports;
        const EventEmitter = polyfills.events;
        const Stream = polyfills.stream;

        /**
         * Simulated Socket class bridging Node streams to WebSockets
         */
        class Socket extends Stream.Duplex {
          constructor(options = {}) {
            super(options);
            this.connecting = false;
            this.remoteAddress = '127.0.0.1';
            this.remoteFamily = 'IPv4';
            this.remotePort = 3000;
            this.localAddress = '127.0.0.1';
            this.localPort = 80;
            this.bytesRead = 0;
            this.bytesWritten = 0;
            this.encrypted = false;
            
            this._ws = null;
            this._pendingWrites = [];
          }

          connect(options, cb) {
            // Normalize arguments: connect(port, host, cb) vs connect(options, cb)
            let port, host;
            if (typeof options === 'number' || typeof options === 'string') {
              port = options;
              host = arguments[1];
              if (typeof host === 'function') {
                cb = host;
                host = 'localhost';
              }
            } else {
              port = options.port;
              host = options.host || 'localhost';
              cb = arguments[1] || cb;
            }

            this.remotePort = port;
            this.remoteAddress = host || '127.0.0.1';

            this.connecting = true;
            if (cb) this.once('connect', cb);

            // Map TCP connection to a WebSocket URL so networkInterceptors can catch it
            const protocol = (String(port) === '443' || String(port) === '8443') ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${this.remoteAddress}:${this.remotePort}`;

            // Instantiate our InterceptableWebSocket
            this._ws = new window.WebSocket(wsUrl, 'tcp-tunnel');
            this._ws.binaryType = 'arraybuffer'; // Crucial for raw byte streams

            this._ws.onopen = () => {
              this.connecting = false;
              this.emit('connect');
              
              // Flush any data written while the connection was establishing
              while (this._pendingWrites.length > 0) {
                const { chunk, callback } = this._pendingWrites.shift();
                this._ws.send(chunk);
                if (callback) callback();
              }
            };

            this._ws.onmessage = (e) => {
              let data = e.data;
              if (data instanceof ArrayBuffer) {
                // Fallback to Uint8Array if Buffer isn't polyfilled globally
                data = typeof Buffer !== 'undefined' ? Buffer.from(data) : new Uint8Array(data);
              }
              this.bytesRead += data.length;
              this.push(data); // Push into the Node stream readable buffer
            };

            this._ws.onclose = (e) => {
              this.emit('close', !e.wasClean);
              this.destroy();
            };

            this._ws.onerror = (err) => {
              this.emit('error', err);
            };

            return this;
          }

          // Node Stream implementation for writing data
          _write(chunk, encoding, callback) {
            this.bytesWritten += chunk.length;
            
            if (this._ws && this._ws.readyState === window.WebSocket.OPEN) {
              this._ws.send(chunk);
              if (callback) callback();
            } else {
              // Queue until connected
              this._pendingWrites.push({ chunk, callback });
            }
          }
          
          // Node Stream implementation for reading data (handled reactively via push)
          _read(size) {
            // No-op: Data is pushed to the stream buffer reactively from ws.onmessage
          }

          setEncoding(encoding) { return this; }
          
          // Add these two stubs to prevent the ws crash
          cork() { return this; }
          uncork() { return this; }

          setTimeout(timeout, callback) {
            if (callback) this.on('timeout', callback);
            return this;
          }
          setNoDelay(noDelay) { return this; }
          setKeepAlive(enable, initialDelay) { return this; }
          
          address() {
            return { port: this.localPort, family: this.localFamily, address: this.localAddress };
          }

          destroy(error) {
            if (this._ws && this._ws.readyState !== window.WebSocket.CLOSED) {
              this._ws.close();
            }
            if (error) this.emit('error', error);
            this.emit('close', !!error);
            return this;
          }
        }

        /**
         * Simulated Server class
         */
        class Server extends EventEmitter {
          constructor(connectionListener) {
            super();
            if (connectionListener) {
              this.on('connection', connectionListener);
            }
            this.listening = false;
          }

          listen(port, host, callback) {
            const cb = typeof port === 'function' ? port : (typeof host === 'function' ? host : callback);
            const portNum = typeof port === 'number' || typeof port === 'string' ? String(port) : '3000';
            
            this.listening = true;
            if (typeof activeServers !== 'undefined' && activeServers.set) {
              activeServers.set(portNum, this);
            }
            try { nodeEmulator?.dispatchEvent?.('serverstart', this, portNum); } catch (_) {}
            if (cb) cb();
            return this;
          }

          close(cb) {
            this.listening = false;
            if (cb) cb();
            return this;
          }

          address() {
            return { port: 3000, family: 'IPv4', address: '127.0.0.1' };
          }
        }

        exports.Socket = Socket;
        exports.Server = Server;

        exports.createServer = function(options, connectionListener) {
          if (typeof options === 'function') {
            connectionListener = options;
            options = {};
          }
          return new Server(connectionListener);
        };

        exports.isIP = function(input) {
          if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(input)) return 4;
          if (/^[0-9a-fA-F:]+$/.test(input)) return 6;
          return 0;
        };

        exports.isIPv4 = function(input) { return exports.isIP(input) === 4; };
        exports.isIPv6 = function(input) { return exports.isIP(input) === 6; };

        return module.exports;
      })();

      /**
       * punycode
       */
      polyfills.punycode = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        // Basic ASCII/Unicode fallback converters
        exports.decode = function(input) {
          return input;
        };

        exports.encode = function(input) {
          return input;
        };

        exports.toUnicode = function(input) {
          return input;
        };

        exports.toASCII = function(input) {
          return input;
        };

        exports.ucs2 = {
          decode: function(string) {
            const output = [];
            let counter = 0;
            while (counter < string.length) {
              const value = string.charCodeAt(counter++);
              if (value >= 0xD800 && value <= 0xDBFF && counter < string.length) {
                const extra = string.charCodeAt(counter++);
                if ((extra & 0xFC00) === 0xDC00) {
                  output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
                } else {
                  output.push(value);
                  counter--;
                }
              } else {
                output.push(value);
              }
            }
            return output;
          },
          encode: function(array) {
            return String.fromCodePoint(...array);
          }
        };

        exports.version = '2.1.1';

        return module.exports;
      })();

      /**
       * timers
       */
      polyfills.timers = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        // Browser timers normally return numeric IDs, while Node's timers return
        // Timeout objects. engine.io uses Timeout.refresh() for its heartbeat timer.
        // Provide a small Node-compatible wrapper without replacing the browser's
        // global timer APIs.
        function nodeTimeout(callback, delay, ...args) {
          const handle = {
            _id: null,
            _callback: callback,
            _delay: delay,
            _args: args,
            _active: true,
            refresh() {
              if (!this._active) return this;
              if (this._id !== null) globalThis.clearTimeout(this._id);
              this._id = globalThis.setTimeout(this._callback, this._delay, ...this._args);
              return this;
            },
            ref() { return this; },
            unref() { return this; },
            hasRef() { return false; },
            close() {
              if (this._id !== null) globalThis.clearTimeout(this._id);
              this._active = false;
            },
            valueOf() { return this._id; }
          };
          handle.refresh();
          return handle;
        }

        function nodeClearTimeout(handle) {
          if (handle && typeof handle === 'object' && '_id' in handle) {
            handle._active = false;
            if (handle._id !== null) globalThis.clearTimeout(handle._id);
            return;
          }
          return globalThis.clearTimeout(handle);
        }

        exports.setTimeout = nodeTimeout;
        exports.clearTimeout = nodeClearTimeout;
        exports.setInterval = globalThis.setInterval;
        exports.clearInterval = globalThis.clearInterval;

        exports.setImmediate = function(callback, ...args) {
          return setTimeout(callback, 0, ...args);
        };

        exports.clearImmediate = function(id) {
          return clearTimeout(id);
        };

        exports.active = function(item) {
          // Legacy Node timer function stub
        };

        exports.unenroll = function(item) {
          // Legacy Node timer function stub
        };

        exports.enroll = function(item, msecs) {
          // Legacy Node timer function stub
        };

        return module.exports;
      })();

      /**
       * tls
       */
      polyfills.tls = (function() {
        const module = { exports: {} };
        const exports = module.exports;
        const EventEmitter = polyfills.events;
        const net = polyfills.net;

        if (!net) {
          throw new Error("[Polyfill Error] 'net' module must be defined before 'tls'");
        }

        /**
         * Simulated TLS SecurePair / TLSSocket wrapper extending net.Socket
         */
        class TLSSocket extends net.Socket {
          constructor(socket, options = {}) {
            super(options);
            this.encrypted = true;
            this.authorized = true;
            this.authorizationError = null;
            if (socket) {
              this.remoteAddress = socket.remoteAddress;
              this.remotePort = socket.remotePort;
            }
          }

          getPeerCertificate(detailed) {
            return {
              subject: { CN: 'localhost' },
              issuer: { CN: 'localhost' },
              valid_from: 'Jan 1 00:00:00 2026 GMT',
              valid_to: 'Jan 1 00:00:00 2036 GMT'
            };
          }

          getCipher() {
            return { name: 'TLS_AES_256_GCM_SHA384', version: 'TLSv1.3' };
          }

          negotiatedProtocol() {
            return 'http/1.1';
          }
        }

        /**
         * Simulated TLS Server extending net.Server
         */
        class TLSServer extends net.Server {
          constructor(options, connectionListener) {
            if (typeof options === 'function') {
              connectionListener = options;
              options = {};
            }
            super(connectionListener);
            this.secure = true;
          }
        }

        exports.TLSSocket = TLSSocket;
        exports.Server = TLSServer;

        exports.createServer = function(options, connectionListener) {
          if (typeof options === 'function') {
            connectionListener = options;
            options = {};
          }
          return new TLSServer(options, connectionListener);
        };

        exports.connect = function(port, host, options, cb) {
          if (typeof host === 'function') {
            cb = host;
            host = undefined;
            options = {};
          } else if (typeof options === 'function') {
            cb = options;
            options = {};
          }
          const socket = new TLSSocket(null, options);
          socket.connect(port, host, cb);
          return socket;
        };

        exports.CLIENT_RENEG_LIMIT = 3;
        exports.DEFAULT_ECDH_CURVE = 'auto';

        return module.exports;
      })();

      /**
       * util (Updated with TextDecoder and TextEncoder support)
       */
      polyfills.util = (function() {
        const module = { exports: {} };
        const exports = module.exports;

        exports.TextDecoder = globalThis.TextDecoder;
        exports.TextEncoder = globalThis.TextEncoder;

        exports.inherits = function(ctor, superCtor) {
          if (ctor === undefined || ctor === null)
            throw new TypeError('The constructor to "inherits" must not be null or undefined');
          if (superCtor === undefined || superCtor === null)
            throw new TypeError('The constructor to "superCtor" must not be null or undefined');
          if (superCtor.prototype === undefined)
            throw new TypeError('The "superCtor" to "inherits" must have a prototype property');

          ctor.super_ = superCtor;
          Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
        };

        exports.inspect = function(obj, options) {
          try {
            return JSON.stringify(obj, null, 2);
          } catch (e) {
            return String(obj);
          }
        };

        exports.format = function(f, ...args) {
          let i = 0;
          if (typeof f !== 'string') {
            let objects = [f, ...args];
            return objects.map(o => exports.inspect(o)).join(' ');
          }
          return f.replace(/%[sdjifoO%]/g, (match) => {
            if (match === '%%') return '%';
            if (i >= args.length) return match;
            switch (match) {
              case '%s': return String(args[i++]);
              case '%d':
              case '%i': return Number(args[i++]);
              case '%f': return parseFloat(args[i++]);
              case '%j':
              case '%o':
              case '%O':
                try {
                  return JSON.stringify(args[i++]);
                } catch (_) {
                  return String(args[i-1]);
                }
              default:
                return match;
            }
          });
        };

        exports.isArray = Array.isArray;
        exports.isBoolean = (arg) => typeof arg === 'boolean';
        exports.isNull = (arg) => arg === null;
        exports.isNullOrUndefined = (arg) => arg == null;
        exports.isNumber = (arg) => typeof arg === 'number';
        exports.isString = (arg) => typeof arg === 'string';
        exports.isSymbol = (arg) => typeof arg === 'symbol';
        exports.isUndefined = (arg) => arg === undefined;
        exports.isObject = (arg) => arg !== null && typeof arg === 'object';
        exports.isFunction = (arg) => typeof arg === 'function';

        return module.exports;
      })();

    }

    // --- Node Module Resolver System ---

    const moduleCache = new Map(); // Canonical path -> { exports, loaded: boolean, moduleObj }
    const specifierMap = new Map(); // Key: "parentDir|specifier" -> Resolved Canonical Path

    /**
     * Helper to fetch a built-in module polyfill from available global namespaces
     */
    function getBuiltinPolyfill(specifier) {
      // Strip optional 'node:' prefix (e.g. 'node:path' -> 'path')
      const cleanSpecifier = specifier.startsWith('node:') ? specifier.slice(5) : specifier;

      if (typeof polyfills !== 'undefined' && polyfills[cleanSpecifier]) {
        return polyfills[cleanSpecifier];
      }
      if (typeof window !== 'undefined' && window.polyfills && window.polyfills[cleanSpecifier]) {
        return window.polyfills[cleanSpecifier];
      }
      return null;
    }

    function normalizePath(path) {
      const parts = path.split('/').filter(Boolean);
      const stack = [];
      for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') {
          stack.pop();
        } else {
          stack.push(part);
        }
      }
      return '/' + stack.join('/');
    }

    function dirname(filePath) {
      const normalized = normalizePath(filePath);
      const lastIndex = normalized.lastIndexOf('/');
      if (lastIndex <= 0) return '/';
      return normalized.substring(0, lastIndex);
    }

    function joinPaths(...parts) {
      return normalizePath(parts.join('/'));
    }

    /**
     * File System Reader over JSZip
     */
    async function resolveZipPath(absolutePath) {
      const filesystem = window.fileSystem;
      if (!filesystem) throw new Error("FileSystem not found on window.fileSystem.");

      const root = String(typeof rootfolder !== 'undefined' ? rootfolder || '' : '')
        .replace(/^\/+|\/+$/g,'');

      let virtualPath = normalizePath(String(absolutePath || '/'));
      let relativePath = virtualPath.replace(/^\/+/,'');
      let physicalPath = relativePath;

      if (root && !physicalPath.startsWith(root + '/') && physicalPath !== root) {
        physicalPath = `${root}/${physicalPath}`;
      }

      const candidates = [
        physicalPath,
        `${physicalPath}.js`,
        `${physicalPath}.json`
      ];

      for (const candidate of candidates) {
        if (!filesystem.existsSync(candidate)) continue;

        let resolvedPath = candidate;

        if (root && candidate.startsWith(root + '/')) {
          resolvedPath = candidate.slice(root.length + 1);
        }

        return {
          zipPath: candidate,
          resolvedPath: '/' + resolvedPath.replace(/^\/+/,'')
        };
      }

      // Package resolution
      const packagePath = `${physicalPath}/package.json`;

      if (filesystem.existsSync(packagePath)) {
        try {
          const pkgJson = JSON.parse(
            filesystem.readFileSync(packagePath,'utf8')
          );

          const mainFile = pkgJson.main || 'index.js';

          const packageResult = await resolveZipPath(
            joinPaths(virtualPath,mainFile)
          );

          if (packageResult) return packageResult;
        } catch (e) {
          console.log('[resolveZipPath] package.json error:',packagePath,e);
        }
      }

      // Directory fallback
      const indexPath = `${physicalPath}/index.js`;

      if (filesystem.existsSync(indexPath)) {
        let resolvedPath = indexPath;

        if (root && indexPath.startsWith(root + '/')) {
          resolvedPath = indexPath.slice(root.length + 1);
        }

        return {
          zipPath: indexPath,
          resolvedPath: '/' + resolvedPath.replace(/^\/+/,'')
        };
      }

      return null;
    }

    /**
     * Resolves specifiers to canonical ZIP paths or built-ins
     */
    async function lookupFileInZip(moduleSpecifier, parentDir) {
      const builtin = getBuiltinPolyfill(moduleSpecifier);
      if (builtin) {
        return { isBuiltin: true, exports: builtin };
      }

      let targetPath = '';

      if (moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/')) {
        targetPath = moduleSpecifier.startsWith('/')
          ? moduleSpecifier
          : joinPaths(parentDir, moduleSpecifier);

        const resolved = await resolveZipPath(targetPath);
        if (resolved) return resolved;
      } else {
        let currentLookupDir = parentDir;
        while (currentLookupDir) {
          targetPath = joinPaths(currentLookupDir, 'node_modules', moduleSpecifier);
          const resolved = await resolveZipPath(targetPath);
          if (resolved) return resolved;

          if (currentLookupDir === '/') break;
          currentLookupDir = dirname(currentLookupDir);
        }
      }

      throw new Error(`Cannot find module '${moduleSpecifier}' required from '${parentDir}'`);
    }

    /**
     * Extract require(...) targets from code via regex scan
     */
    function extractRequireSpecifiers(sourceCode) {
      const requireRegex = /\brequire\s*\(\s*(["'`])(.+?)\1\s*\)/g;
      const specifiers = new Set();
      let match;
      while ((match = requireRegex.exec(sourceCode)) !== null) {
        specifiers.add(match[2]);
      }
      return Array.from(specifiers);
    }

    /**
     * Phase 1: Pre-loader (Asynchronous Depth-First Pre-fetching)
     */
    var wait = t=>new Promise(r=>setTimeout(r,t));
    async function preloadModule(moduleSpecifier, currentFilePath) {
      await wait(0);
      //console.logText(moduleSpecifier,currentFilePath);
      const parentDir = dirname(currentFilePath);
      const location = await lookupFileInZip(moduleSpecifier, parentDir);

      if (location.isBuiltin) {
        return location;
      }

      const resolvedPath = location.resolvedPath;

      // Record mapping so synchronous lookup knows exact target path
      const mapKey = `${parentDir}|${moduleSpecifier}`;
      specifierMap.set(mapKey, resolvedPath);

      if (moduleCache.has(resolvedPath)) {
        return location;
      }

      const filesystem = window.fileSystem;

      if (resolvedPath.endsWith('.json')) {
        const jsonText = filesystem.readFileSync(location.zipPath, 'utf8');
        const parsedJson = JSON.parse(jsonText);

        moduleCache.set(resolvedPath, {
          exports: parsedJson,
          moduleObj: { exports: parsedJson },
          loaded: true
        });

        return location;
      }

      const rawSource = filesystem.readFileSync(location.zipPath, 'utf8');

      // Reserve module container
      const moduleObj = { exports: {} };
      const cachedEntry = {
        exports: moduleObj.exports,
        moduleObj: moduleObj,
        loaded: false,
        rawSource,
        location
      };
      moduleCache.set(resolvedPath, cachedEntry);

      // Recursively pre-fetch child dependencies
      const childSpecifiers = extractRequireSpecifiers(rawSource);
      for (const childSpec of childSpecifiers) {
        try {
          await preloadModule(childSpec, resolvedPath);
        } catch (e) {
          // Ignore dynamic/optional requires during pre-pass
        }
      }

      return location;
    }

    /**
     * Synchronous require handler used during module execution phase
     */
    function createRequireSync(currentFilePath) {
      return function requireSync(moduleSpecifier) {
        const parentDir = dirname(currentFilePath);

        // 1. Built-in polyfills check
        const builtin = getBuiltinPolyfill(moduleSpecifier);
        if (builtin) {
          return builtin;
        }

        // 2. Direct specifier map lookup
        const mapKey = `${parentDir}|${moduleSpecifier}`;
        const resolvedPath = specifierMap.get(mapKey);

        if (resolvedPath && moduleCache.has(resolvedPath)) {
          return executeModuleSync(resolvedPath);
        }

        // 3. Fallback direct match search
        if (moduleCache.has(moduleSpecifier)) {
          return executeModuleSync(moduleSpecifier);
        }

        throw new Error(`[Sync Require Error] Module '${moduleSpecifier}' was not preloaded or found in cache from '${currentFilePath}'`);
      };
    }

    /**
     * Phase 2: Synchronous Execution Engine (Robust Debug & Console Binding)
     */
    function executeModuleSync(resolvedPath) {
      const cached = moduleCache.get(resolvedPath);
      if (!cached) {
        throw new Error(`Module ${resolvedPath} not found in memory cache.`);
      }

      if (cached.loaded) {
        return cached.moduleObj.exports !== undefined ? cached.moduleObj.exports : cached.exports;
      }

      // CRITICAL FIX FOR CIRCULAR DEPENDENCIES:
      // Mark as loaded and pre-cache the exports reference BEFORE executing the factory.
      // This allows any circular require() back to this module to receive its exports object mid-execution.
      cached.loaded = true;

      const requireSync = createRequireSync(resolvedPath);
      
      const factory = new Function(
        'exports',
        'require',
        'module',
        '__filename',
        '__dirname',
        'process',
        'global',
        'console',
        cached.rawSource
      );

      const simulatedProcess = {
        env: typeof ENV_SETTINGS !== 'undefined' ? ENV_SETTINGS : { DEBUG: '*' },
        type: 'renderer',
        pid: 1,
        platform: 'browser',
        cwd: () => nodeEmulator.cwd || '/',
        chdir: (path) => {
          const raw = String(path ?? '.');
          const base = nodeEmulator.cwd || '/';
          const target = normalizeNodePath(raw.startsWith('/') ? raw : `${base}/${raw}`);
          if (!directoryExists(target)) throw new Error(`chdir: no such directory: ${path}`);
          const previous = nodeEmulator.cwd || '/';
          nodeEmulator.previousCwd = previous;
          nodeEmulator.cwd = target;
          if (typeof ENV_SETTINGS !== 'undefined') {
            ENV_SETTINGS.OLDPWD = previous;
            ENV_SETTINGS.PWD = target;
          }
          if (nodeEmulator.npm) nodeEmulator.npm.rootfolder = getRuntimeRootFolder();
        },
        nextTick: (cb, ...args) => setTimeout(() => cb(...args), 0),
        on: () => {},
        addListener: () => {},
        once: () => {},
        removeListener: () => {},
        off: () => {},
        emit: () => {},
        listeners: () => [],
        stdout: { write: () => {} },
        stderr: { write: () => {} }
      };
      //if (!simulatedProcess.env.DEBUG) simulatedProcess.env.DEBUG = '*';

      const safeConsole = {
        log: function(...args) {
          if (typeof console.logText === 'function') console.logText(`[Node App]`, ...args);
          else console.log(`[Node App]`, ...args);
        },
        logText: function(...args) {
          if (typeof console.logText === 'function') console.logText(`[Node App]`, ...args);
          else console.log(`[Node App]`, ...args);
        },
        error: function(...args) { console.error(`[Node Error ${resolvedPath}]`, ...args); },
        warn: function(...args) { console.warn(`[Node Warn]`, ...args); },
        info: function(...args) { console.info(`[Node Info]`, ...args); },
        dir: (obj) => console.dir(obj),
        time: (label) => console.time(label),
        timeEnd: (label) => console.timeEnd(label),
        assert: (cond, ...args) => { if (!cond) console.assert(cond, ...args); }
      };
      safeConsole.log.apply = safeConsole.log.apply || Function.prototype.apply;

      try {
        factory(
          cached.moduleObj.exports,
          requireSync,
          cached.moduleObj,
          resolvedPath,
          dirname(resolvedPath),
          simulatedProcess,
          window,
          safeConsole
        );

        // Deep guard for modules like 'debug' or log-dependent packages
        const exp = cached.moduleObj.exports;
        if (resolvedPath.includes('debug') || typeof exp === 'function') {
          if (typeof exp.log !== 'function') {
            exp.log = safeConsole.log;
          }
        }
        if (exp && typeof exp.default === 'function' && typeof exp.default.log !== 'function') {
          exp.default.log = safeConsole.log;
        }
      } catch (err) {
        // If execution fails, reset loaded state so it doesn't leave a broken partial export cached permanently
        cached.loaded = false;
        moduleCache.delete(resolvedPath);
        console.error(`[Module Execution Error] at ${resolvedPath}:`, err);
        console.error(err.stack);
        throw err;
      }

      return cached.moduleObj.exports !== undefined ? cached.moduleObj.exports : cached.exports;
    }

    /**
     * Main Entrypoint Interface
     */
    async function requireModule(moduleSpecifier, currentFilePath = '/index.js') {
      const location = await preloadModule(moduleSpecifier, currentFilePath);

      if (location.isBuiltin) {
        return location.exports;
      }

      return executeModuleSync(location.resolvedPath);
    }

    window.getServer = function(urlObj) {
      // Safely parse your custom domain variable to get the target hostname
      const targetDomainObj = typeof domain !== 'undefined' ? new URL(domain) : null;
      const targetHostname = targetDomainObj ? targetDomainObj.hostname : 'localhost';
      if (urlObj.hostname !== targetHostname) return null;
      const targetPort = targetDomainObj?.port || ((targetDomainObj?.protocol || '') === 'https:' ? '443' : '80');
      if (targetPort && urlObj.port && urlObj.port !== targetPort) return null;

      // Find the active HTTP server.
      // Checks process.env.PORT first, falls back to 443 (as defined in your script), then 3000
      const envPort = typeof process !== 'undefined' && process.env ? process.env.PORT : null;
      const server = typeof activeServers !== 'undefined' ? 
        (activeServers.get(String(envPort)) || activeServers.get('443') || activeServers.get('3000')) 
        : null;
      return server;
    };

    window.handleRequest = async function(request,type) {
      let urlObj;
      try { urlObj = new URL(request.url); } catch (e) {
        return null;
      }

      const server = getServer(urlObj);

      if (!server) {
        return null;
      }
      // ==========================================
      // 2. HANDLE STANDARD HTTP/EXPRESS TRAFFIC
      // ==========================================
      return await new Promise(async resolve => {
        const method = request.method || 'GET';
        const headers = request.headers || {};
        const body = request.body ? await request.clone().text() : null;
        
        let requestPath = urlObj.pathname + urlObj.search;
        if (pathPrefix !== '/' && (requestPath === pathPrefix || requestPath.startsWith(pathPrefix + '/'))) {
          requestPath = requestPath.slice(pathPrefix.length) || '/';
        }
        const req = new polyfills.http.IncomingMessage(requestPath, method, headers, body);

        // When Express handles the response and calls res.end(), resolve the fetch Promise
        const res = new polyfills.http.ServerResponse((result) => {
          resolve(result);
        });
        
        // Emit standard request to the Express app
        server.emit('request', req, res);
      });
    };

    window.handleSocket = async function(absoluteUrl, protocols) {
      let urlObj;
      try { urlObj = new URL(absoluteUrl); } catch (e) {
        return null;
      }
      
      const server = getServer(urlObj);

      if (!server) {
        return null;
      }

      let handshakeCompleted = false;
      let upgradeFinished = false;
      const queuedClientFrames = [];

      const mockBackend = {
        sendToClient: function(data) {
          // Server-side ws writes raw HTTP during upgrade and raw RFC6455 frames after it.
          // Never expose the HTTP 101 response as a browser WebSocket message.
          let bytes = null;
          if (typeof data === 'string') {
            bytes = new TextEncoder().encode(data);
          } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
          } else if (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array) {
            bytes = new Uint8Array(data);
          } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          }

          const str = typeof data === 'string' ? data :
            (bytes ? new TextDecoder().decode(bytes) : String(data));

          if (!handshakeCompleted && typeof str === 'string' &&
              /^HTTP\/1\.1 101\b/i.test(str)) {
            handshakeCompleted = true;
            // Real WebSockets never deliver the open event synchronously from
            // the operation that completed the connection. Keep the virtual
            // transport asynchronous too. This is especially important for
            // Engine.IO's websocket probe: it sends `2probe` and only THEN
            // installs its `packet` listener. A synchronous server reply would
            // arrive before that listener exists.
            setTimeout(() => {
              if (typeof mockBackend._onOpen === 'function') mockBackend._onOpen();
            }, 0);
            return;
          }

          nodeEmulator.network.dispatchEvent('websocket',absoluteUrl,{
            status: 200,
            contentType: 'application/octet-stream',
            type: 'server message',
            size: bytes ? bytes.byteLength : 0,
            data: bytes || String(data)
          });

          if (typeof mockBackend._onServerData === 'function') {
            // Real WebSocket `message` delivery is asynchronous. Do not call
            // the browser callback inline from serverSocket.write(). Engine.IO
            // installs its probe response listener immediately AFTER sending
            // `2probe`, so synchronous delivery loses the `3probe` packet.
            const serverData = bytes || data;
            setTimeout(() => {
              if (typeof mockBackend._onServerData !== 'function') return;
              try {
                mockBackend._onServerData(serverData);
              } catch (err) {
                console.error('[VirtualWS v17] BROWSER SERVER DATA CALLBACK THREW', err && err.stack || err);
                setTimeout(() => { throw err; }, 0);
              }
            }, 0);
          } else {
          }
        },

        closeClient: function(code = 1000, reason = "") {
          nodeEmulator.network.dispatchEvent('websocket',absoluteUrl,{
            status: code,
            contentType: 'text/plain',
            type: 'server close',
            size: 0,
            data: String(code) + " " + String(reason || "")
          });
          if (typeof mockBackend._onClose === 'function') {
            mockBackend._onClose(code, reason);
          }
        },

        onClientMessage: function(msg) {
          nodeEmulator.network.dispatchEvent('websocket',absoluteUrl,{
            status: 200,
            contentType: 'application/octet-stream',
            type: 'client message',
            size: msg && msg.byteLength ? msg.byteLength : (typeof msg === 'string' ? msg.length : 0),
            data: typeof msg === 'string' ? msg : ''
          });

          if (upgradeFinished) {
            deliverClientFrame(msg);
          } else {
            queuedClientFrames.push(msg);
            console.log(queuedClientFrames.length);
          }
        },

        _onOpen: null,
        _onServerData: null,
        _onClose: null
      };

      function toUint8(data) {
        if (data instanceof Uint8Array) return new Uint8Array(data);
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
          return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        if (typeof data === 'string') return new TextEncoder().encode(data);
        return new Uint8Array(data || []);
      }

      function deliverClientFrame(msg) {
        const chunk = toUint8(msg);
        if (!serverSideSocket || serverSideSocket.destroyed) return;
        let frameInfo = 'unparsed';
        try {
          if (chunk.length >= 2) {
            const fin = !!(chunk[0] & 0x80);
            const opcode = chunk[0] & 0x0f;
            const masked = !!(chunk[1] & 0x80);
            let len = chunk[1] & 0x7f;
            let h = 2;
            if (len === 126 && chunk.length >= 4) { len = (chunk[2] << 8) | chunk[3]; h = 4; }
            else if (len === 127 && chunk.length >= 10) { len = 0; for (let i=0;i<8;i++) len = len * 256 + chunk[2+i]; h = 10; }
            let p = h;
            let mask = null;
            if (masked && chunk.length >= h + 4) { mask = chunk.slice(h,h+4); p += 4; }
            if (mask && chunk.length >= p + len) {
              const payload = chunk.slice(p,p+len);
              for (let i=0;i<payload.length;i++) payload[i] ^= mask[i&3];
              const text = (opcode === 1) ? new TextDecoder().decode(payload) : '';
              frameInfo = JSON.stringify({fin, opcode, masked, length: len, payload: text, hex: Array.from(payload.slice(0,32)).map(b=>b.toString(16).padStart(2,'0')).join(' ')});
            } else frameInfo = JSON.stringify({fin, opcode, masked, length: len, incomplete: true});
          }
        } catch (e) { frameInfo = 'frame parse failed: ' + (e && e.message); }
        try {
          serverSideSocket.emit('data',
            typeof Buffer !== 'undefined' ? Buffer.from(chunk) : chunk);
        } catch (err) {
          console.error('[VirtualWS v8] SOCKET DATA EMIT THREW', err);
          console.error(err && err.stack || err);
          try { serverSideSocket.emit('error', err); } catch (_) {}
        }
      }

      class ServerSideSocket extends polyfills.net.Socket {
        constructor() {
          super();
          // `ws` may split one RFC6455 frame across multiple socket.write() calls
          // (for example: header in one write, payload in the next). Keep a
          // server->browser byte buffer so write boundaries are never treated as
          // WebSocket message/frame boundaries.
          this._outboundFrameBuffer = new Uint8Array(0);
          this.readable = true;
          this.writable = true;
          this.destroyed = false;
          this.readableEnded = false;
          this.writableEnded = false;
          this.writableFinished = false;
          this.readableFlowing = true;
          this.readableHighWaterMark = 16 * 1024;
          this.writableHighWaterMark = 16 * 1024;
          this.bytesRead = 0;
          this.bytesWritten = 0;
          // This is a browser-side Node net.Socket polyfill. Do not assume that
          // Node's native stream internals exist: create/augment the state objects
          // explicitly, while preserving the polyfill's existing state objects.
          this._readableState = this._readableState || {};
          Object.assign(this._readableState, {
            endEmitted: false,
            ended: false,
            destroyed: false,
            flowing: true,
            objectMode: !!this._readableState.objectMode,
            encoding: this._readableState.encoding || null
          });

          this._writableState = this._writableState || {};
          Object.assign(this._writableState, {
            errorEmitted: false,
            ended: false,
            finished: false,
            destroyed: false,
            writing: false,
            corked: 0,
            length: 0,
            needDrain: false,
            decodeStrings: this._writableState.decodeStrings !== false,
            defaultEncoding: this._writableState.defaultEncoding || 'utf8',
            buffered: this._writableState.buffered || [],
            bufferedIndex: this._writableState.bufferedIndex || 0,
            pendingcb: 0,
            sync: false
          });
          this.writableNeedDrain = false;
          this.writableCorked = 0;
          this.finished = false;
        }

        _deliverOutboundWebSocketBytes(bytes) {
          if (!bytes || !bytes.length) return;

          const merged = new Uint8Array(this._outboundFrameBuffer.length + bytes.length);
          merged.set(this._outboundFrameBuffer);
          merged.set(bytes, this._outboundFrameBuffer.length);
          this._outboundFrameBuffer = merged;

          let offset = 0;
          while (this._outboundFrameBuffer.length - offset >= 2) {
            const b0 = this._outboundFrameBuffer[offset];
            const b1 = this._outboundFrameBuffer[offset + 1];
            const fin = !!(b0 & 0x80);
            const opcode = b0 & 0x0f;
            const masked = !!(b1 & 0x80);
            let len = b1 & 0x7f;
            let headerLen = 2;

            if (len === 126) {
              if (this._outboundFrameBuffer.length - offset < 4) break;
              len = (this._outboundFrameBuffer[offset + 2] << 8) |
                    this._outboundFrameBuffer[offset + 3];
              headerLen = 4;
            } else if (len === 127) {
              if (this._outboundFrameBuffer.length - offset < 10) break;
              len = 0;
              for (let i = 0; i < 8; i++) {
                len = len * 256 + this._outboundFrameBuffer[offset + 2 + i];
              }
              if (len > Number.MAX_SAFE_INTEGER) {
                this._outboundFrameBuffer = new Uint8Array(0);
                this.destroy(new Error('WebSocket frame too large'));
                return;
              }
              headerLen = 10;
            }

            // Server frames produced by ws should be unmasked. Still account for
            // a mask so this bridge remains a valid generic RFC6455 frame parser.
            const maskLen = masked ? 4 : 0;
            const frameLen = headerLen + maskLen + len;
            if (this._outboundFrameBuffer.length - offset < frameLen) break;

            const frame = this._outboundFrameBuffer.slice(offset, offset + frameLen);
            offset += frameLen;

            const info = {
              fin, opcode, masked, length: len,
              hex: Array.from(frame.slice(0, 24)).map(b => b.toString(16).padStart(2, '0')).join(' ')
            };

            // Give the browser mock one COMPLETE RFC6455 frame. The browser-side
            // mock parser will turn this into a WebSocket message/event.
            mockBackend.sendToClient(frame);
          }

          if (offset > 0) {
            this._outboundFrameBuffer = this._outboundFrameBuffer.slice(offset);
          }
        }

        write(chunk, encoding, callback) {
          // Node's writable.write() allows write(chunk, callback). ws uses this
          // form for the second half of an RFC6455 frame. Normalize it before
          // forwarding the completion callback; otherwise Engine.IO never sees
          // its send callback and leaves the WebSocket transport non-writable.
          if (typeof encoding === 'function') {
            callback = encoding;
            encoding = 'utf8';
          }

          if (this.destroyed || this.writableEnded) {
            const err = new Error('write after end');
            if (typeof callback === 'function') callback(err);
            return false;
          }
          try {
            const bytes = toUint8(chunk);
            this.bytesWritten += bytes.byteLength;

            let outbound = '';
            try {
              if (bytes.length && bytes[0] === 0x48 &&
                  new TextDecoder().decode(bytes.slice(0, 16)).startsWith('HTTP/')) {
                outbound = ' HTTP/other ' + new TextDecoder().decode(bytes.slice(0, 64));
                // The HTTP upgrade response is not a WebSocket frame. Let the
                // backend consume it for handshake detection, but do not put it
                // into the RFC6455 frame buffer.
                mockBackend.sendToClient(chunk);
              } else {
                this._deliverOutboundWebSocketBytes(bytes);
              }
            } catch (logErr) {
              this._deliverOutboundWebSocketBytes(bytes);
            }

            if (typeof callback === 'function') callback();
            return true;
          } catch (err) {
            if (typeof callback === 'function') callback(err);
            else this.emit('error', err);
            return false;
          }
        }

        _write(chunk, encoding, callback) {
          if (typeof encoding === 'function') {
            callback = encoding;
            encoding = 'utf8';
          }
          return this.write(chunk, encoding, callback);
        }

        end(chunk, encoding, callback) {
          if (typeof chunk === 'function') {
            callback = chunk; chunk = null; encoding = null;
          } else if (typeof encoding === 'function') {
            callback = encoding; encoding = null;
          }
          if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
          if (this.writableEnded) {
            if (callback) callback();
            return this;
          }
          this.writableEnded = true;
          this.writableFinished = true;
          this.finished = true;
          if (this._writableState) {
            this._writableState.ended = true;
            this._writableState.finished = true;
          }
          if (typeof mockBackend.closeClient === 'function') {
            mockBackend.closeClient(1000, "Server ended connection");
          }
          this.destroy();
          if (callback) callback();
          return this;
        }

        destroy(err, callback) {
          if (this.destroyed) {
            if (callback) callback(err);
            return this;
          }
          this.destroyed = true;
          this.readable = false;
          this.writable = false;
          this.readableEnded = true;
          this.writableEnded = true;
          if (this._readableState) this._readableState.destroyed = true;
          if (this._writableState) this._writableState.destroyed = true;
          if (err) {
            try { this.emit('error', err); } catch (_) {}
          }
          this.emit('close');
          if (callback) callback(err);
          return this;
        }

        cork() {
          if (this._writableState) {
            this._writableState.corked = (this._writableState.corked || 0) + 1;
          }
          this.writableCorked = (this.writableCorked || 0) + 1;
          return this;
        }

        uncork() {
          if (this._writableState && this._writableState.corked > 0) {
            this._writableState.corked--;
          }
          if (this.writableCorked > 0) this.writableCorked--;
          return this;
        }

        setTimeout(msecs, callback) {
          if (this._timeout) clearTimeout(this._timeout);
          if (msecs > 0 && typeof callback === 'function') {
            this._timeout = setTimeout(callback, msecs);
          }
          return this;
        }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        ref() { return this; }
        unref() { return this; }
        address() { return { address: this.remoteAddress || '127.0.0.1', family: 'IPv4', port: this.remotePort || 0 }; }
        pause() { this.readableFlowing = false; return this; }
        resume() { this.readableFlowing = true; return this; }
        isPaused() { return this.readableFlowing === false; }
      }

      const serverSideSocket = new ServerSideSocket();
      const nativeSocketEmit = serverSideSocket.emit.bind(serverSideSocket);
      serverSideSocket.emit = function(type, ...args) {
        if (type === 'data' || type === 'error') {
          const listeners = typeof this.listeners === 'function' ? this.listeners(type).slice() : [];
          for (const listener of listeners) {
            try {
              listener.apply(this, args);
            } catch (err) {
              console.error('[VirtualWS v8] SOCKET ' + type.toUpperCase() + ' LISTENER THREW');
              console.error(err && err.stack || err);
              throw err;
            }
          }
          return listeners.length > 0;
        }
        return nativeSocketEmit(type, ...args);
      };
      serverSideSocket.remoteAddress = '127.0.0.1';
      serverSideSocket.remotePort = Math.floor(Math.random() * 10000) + 40000;
      serverSideSocket.on('error', (err) => console.error('[VirtualWS v12] SERVER SOCKET ERROR', err && err.stack || err));

      // RFC6455 requires a fresh random 16-byte client key for every handshake.
      let keyBytes = new Uint8Array(16);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(keyBytes);
      } else {
        for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = Math.floor(Math.random() * 256);
      }
      let secKey = '';
      if (typeof btoa === 'function') {
        let binary = '';
        for (const b of keyBytes) binary += String.fromCharCode(b);
        secKey = btoa(binary);
      } else if (typeof Buffer !== 'undefined') {
        secKey = Buffer.from(keyBytes).toString('base64');
      }

      const headers = {
        'upgrade': 'websocket',
        'connection': 'upgrade',
        'host': urlObj.host,
        'sec-websocket-key': secKey,
        'sec-websocket-version': '13'
      };

      const req = new polyfills.http.IncomingMessage(
        urlObj.pathname + urlObj.search, 'GET', headers, null
      );
      req.socket = serverSideSocket;
      req.connection = serverSideSocket;
      req.upgrade = true;
      req.complete = false;
      req.httpVersion = '1.1';
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 1;

      setTimeout(() => {
        try {
          server.emit('upgrade', req, serverSideSocket,
            typeof Buffer !== 'undefined' ? Buffer.alloc(0) : new Uint8Array(0));
          upgradeFinished = true;

          if (queuedClientFrames.length) {
            const pending = queuedClientFrames.splice(0);
            console.log(pending.length);
            for (const frame of pending) deliverClientFrame(frame);
          }
        } catch (err) {
          console.error('[VirtualWS v8] UPGRADE HANDLER THREW', err);
          console.error(err && err.stack || err);
          try { serverSideSocket.destroy(err); } catch (_) {}
        }
      }, 0);

      return mockBackend;
    };

    // 6. Terminal Command Execution
    function splitTerminalCommand(command) {
      const NpmClass = typeof window !== 'undefined' && (window.NPM || window.parent?.NPM);
      if (NpmClass && typeof NpmClass.splitCommand === 'function') return NpmClass.splitCommand(command);
      return String(command || '').trim().split(/\s+/).filter(Boolean);
    }

    function getRuntimeRootFolder() {
      // The runtime configuration establishes the project root. `cwd` is the
      // process working directory inside that root and must not redefine npm's
      // project root.
      return String(nodeEmulator.rootfolder || '').replace(/^\/+|\/+$/g, '');
    }

    function getNpmManager() {
      const NpmClass = typeof window !== 'undefined' && (window.NPM || window.parent?.NPM);
      if (!NpmClass) return null;
      const runtimeRoot = getRuntimeRootFolder();
      if (!nodeEmulator.npm) {
        nodeEmulator.npm = new NpmClass({
          filesystem: nodeEmulator.filesystem,
          network: nodeEmulator.network,
          rootfolder: runtimeRoot,
          log: console,
          env: nodeEmulator.env,
          commandRunner: async command => await window.terminalCommand(command),
          onFileSystemChange: () => {
            try {
              window.nodeEmulator?.dispatchEvent?.('filesystemchange');
            } catch (_) {}
          }
        });
      } else {
        nodeEmulator.npm.rootfolder = runtimeRoot;
      }
      return nodeEmulator.npm;
    }

    window.terminalCommand = async function(cmd) {
      console.logText(`\$ ${cmd}`);
      const parts = splitTerminalCommand(cmd);
      const bin = parts[0];
      const args = parts.slice(1);

      if (bin === "pwd") {
        const cwd = nodeEmulator.cwd || '/';
        console.logText(cwd);
        return cwd;
      } else if (bin === "echo") {
        const noNewline = args[0] === '-n';
        const value = args.slice(noNewline ? 1 : 0).join(' ');
        if (noNewline) {
          console.logText(value);
        } else {
          console.logText(value);
        }
        return value;
      } else if (bin === "printf") {
        const format = args[0] || '';
        const values = args.slice(1);
        let index = 0;
        const output = format.replace(/%([sd%])/g, (match, type) => {
          if (type === '%') return '%';
          const value = values[index++];
          if (type === 's') return value ?? '';
          if (type === 'd') {
            const number = Number(value);
            return Number.isFinite(number) ? String(Math.trunc(number)) : '0';
          }
          return match;
        });
        console.logText(output);
        return output;
      } else if (bin === "true") {
        return true;
      } else if (bin === "false") {
        return false;
      } else if (bin === "whoami") {
        const user = String(ENV_SETTINGS.USER || ENV_SETTINGS.USERNAME || 'user');
        console.logText(user);
        return user;
      } else if (bin === "hostname") {
        const hostname = String(nodeEmulator.domain || 'localhost');
        console.logText(hostname);
        return hostname;
      } else if (bin === "env") {
        const entries = Object.keys(ENV_SETTINGS).sort().map(key => `${key}=${ENV_SETTINGS[key]}`);
        console.logText(entries.join('\n'));
        return entries;
      } else if (bin === "which") {
        const name = args[0];
        const supported = new Set(['pwd','cd','echo','printf','true','false','whoami','hostname','env','which','ls','dir','node','npm']);
        if (!name || !supported.has(name)) {
          console.logText(`${name || ''}: not found`);
          return null;
        }
        const path = name === 'dir' ? '/bin/dir' : `/bin/${name}`;
        console.logText(path);
        return path;
      } else if (bin === "cd") {
        const target = args[0] === '-' ? (nodeEmulator.previousCwd || '/') : (args[0] || '/');
        try {
          const previous = nodeEmulator.cwd || '/';
          const next = ensureDirectory(target, 'cd');
          nodeEmulator.previousCwd = previous;
          nodeEmulator.cwd = next;
          ENV_SETTINGS.OLDPWD = previous;
          ENV_SETTINGS.PWD = next;
          if (nodeEmulator.npm) nodeEmulator.npm.rootfolder = getRuntimeRootFolder();
          console.logText(next);
          return next;
        } catch (e) {
          console.error(e.message);
          throw e;
        }
      } else if (bin === "ls" || bin === "dir") {
        const targetArg = args.find(arg => !arg.startsWith('-')) || '.';
        const target = resolveWorkingPath(targetArg);
        if (!directoryExists(target)) {
          const error = new Error(`${bin}: no such directory: ${targetArg}`);
          console.error(error.message);
          throw error;
        }
        const entries = listDirectory(target);
        console.logText(entries.join('  '));
        return entries;
      } else if (bin === "node") {
        const entryArgument = args[0] || "index.js";
        const entryFile = resolveWorkingPath(entryArgument);
        
        try {
          console.logText(`Starting Node process for ${entryFile}...`);
          await requireModule(entryFile);
          console.logText(`Process finished execution scope.`);
        } catch (e) {
          console.error(`Node process crashed: ${e.message}`);
          throw e;
        }
      } else if (bin === "npm") {
        const npm = getNpmManager();
        if (!npm) {
          console.logText(`npm is unavailable (optional npm.js module was not loaded).`);
          return;
        }
        try {
          return await npm.run(args);
        } catch (e) {
          console.error(`npm ERR! ${e.message || e}`);
          throw e;
        }
      } else {
        const error = new Error(`Command not found: ${bin}. The virtual terminal is not a real OS shell; supported commands are pwd, cd, echo, printf, true, false, whoami, hostname, env, which, ls/dir, node, and npm.`);
        console.error(error.message);
        throw error;
      }
    };

    // Initialize app defaults
    console.log("Node Simulator environment loaded. Use terminalCommand('node index.js') to start.");
  };

  class NodeEndpoint extends NetworkEndpoint {
    constructor(emulator, enabled = true) {
      super(enabled);
      this.emulator = emulator;
    }
    async handleRequest(request,type) {
      if (!this.emulator?.context?.handleRequest) return null;
      var response = await this.emulator.context.handleRequest(request, type);
      if (response) Object.setPrototypeOf(response, Response.prototype);
      return response;
    }
    async handleSocket(absoluteUrl, protocols) {
      if (!this.emulator?.context?.handleRequest) return null;
      return await this.emulator.context.handleSocket(absoluteUrl, protocols);
    }
  }

  class NodeEmulator extends EventHandler {
    constructor(options = {}) {
      super(options.enabled ?? true);

      this.domain = String(options.domain || "").replace(/\/+$/ ,"");
      this.rootfolder = String(options.rootfolder || "").replace(/^\/+|\/+$/g,"");
      this.pathPrefix = String(options.pathPrefix || "/").startsWith("/") ? String(options.pathPrefix || "/") : "/" + String(options.pathPrefix || "/");
      this.pathPrefix = this.pathPrefix === "/" ? "/" : this.pathPrefix.replace(/\/+$/, "");
      this.source = options.source;
      this.filesystem = options.filesystem;
      this.cwd = normalizeNodePath(options.cwd || '/');
      this.previousCwd = this.cwd;
      this.loaded = false;
      this.env = options.env || {};
      this.fileSystemSync = options.fileSystemSync !== false;
      this.endpoint = new NodeEndpoint(this);
      this.network = options.network || new Network();
      this.loadError = null;
      this.contextReady = this.runframe();
      this.ready = this.load().catch(e => { this.loadError = e; return null; });
    }
    async load() {
      try {
        const context = await this.contextReady;
        if (!context) throw new Error('Node runtime context could not be created.');
        this.context = context;
        this.context.nodeEmulator = this;
        if (!this.filesystem) {
          if (!this.source) throw new Error('No filesystem source was provided to the Node runtime.');
          this.filesystem = await FileSystem.create(this.source, { sync: this.fileSystemSync });
        }
        this.context.fileSystem = this.filesystem;
        this.loaded = true;
        this.dispatchEvent('loaded',this);
        return this;
      } catch (e) {
        this.loadError = e;
        this.dispatchEvent('loaderror',e);
        throw e;
      }
    }
    runframe() {
      this.iframe = document.createElement('iframe');
      this.iframe.style.display = "none";
      this.iframe.src = 'about:blank';
      (document.body || document.documentElement).appendChild(this.iframe);

      const init = () => {
        const context = this.iframe.contentWindow || this.iframe.contentDocument?.defaultView || null;
        const doc = this.iframe.contentDocument || context?.document || null;
        if (!context || !doc?.body) return false;
        if (this.context) return true;
        this.context = context;
        this.context.nodeEmulator = this;
        const script = doc.createElement('script');
        script.innerHTML = `(${nodeExecution.toString()})()`;
        doc.body.appendChild(script);
        return true;
      };

      if (init()) return Promise.resolve(this.context);
      return new Promise((resolve,reject) => {
        let attempts = 0;
        const check = () => {
          if (init()) return resolve(this.context);
          if (++attempts > 100) return reject(new Error('Node runtime context could not be created.'));
          setTimeout(check,0);
        };
        check();
      });
    }
    hasListeningServer() {
      try {
        const servers = this.context?.activeServers;
        if (!servers || typeof servers.values !== 'function') return false;
        for (const server of servers.values()) {
          if (server?.listening) return true;
        }
      } catch (_) {}
      return false;
    }
    async waitForServer(timeout = 10000, interval = 50) {
      const start = Date.now();
      while (Date.now() - start <= timeout) {
        if (this.hasListeningServer()) return true;
        await new Promise(r => setTimeout(r, interval));
      }
      return this.hasListeningServer();
    }
    destroy() {
      try { this.iframe?.remove(); } catch (e) {}
      this.context = null;
      this.loaded = false;
    }
    async terminalCommand(cmd) {
      await this.ready;
      if (this.loadError) throw this.loadError;
      return await this.context.terminalCommand(cmd);
    }
    async evalInContext(code) {
      await this.ready;
      if (this.loadError) throw this.loadError;
      return await this.context.eval(code);
    }
  }

  window.NodeEndpoint = NodeEndpoint;
  window.NodeEmulator = NodeEmulator;
})();

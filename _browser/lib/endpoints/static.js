// dependencies:
// network.js
// filesystem.js
(function(){

  function staticInferMime(name) {
    const ext=String(name||'').split('?')[0].split('#')[0].split('.').pop().toLowerCase();
    const map={html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',cjs:'text/javascript',json:'application/json',txt:'text/plain',md:'text/markdown',xml:'application/xml',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',ico:'image/x-icon',bmp:'image/bmp',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',mp4:'video/mp4',webm:'video/webm',wasm:'application/wasm',pdf:'application/pdf'};
    return map[ext]||'application/octet-stream';
  }
  class StaticEndpoint extends NetworkEndpoint {
    constructor(options = {}) {
      super(options.enabled ?? true);
      this.domain = String(options.domain || "").replace(/\/+$/,"");
      this.path = String(options.path || "/").startsWith("/") ? String(options.path || "/") : "/"+String(options.path || "/");
      this.path = this.path === "/" ? "/" : this.path.replace(/\/+$/, "");
      this.rootfolder = String(options.rootfolder || "").replace(/^\/+|\/+$/g,"");
      this.runfile = "/"+String(options.runfile || "/index.html").replace(/^\/+/,"");
      this.source = options.source;
      this.filesystem = options.filesystem;
      this.loaded = false;
      this.loading = this.load();
    }
    async load() {
      if (!this.filesystem) {
        if (!this.source) return;
        this.filesystem = await FileSystem.create(this.source);
      }
      this.loaded = true;
      this.dispatchEvent('loaded',this);
    }
    async handleRequest(request,type) {
      if (!this.filesystem && this.loading) { try { await this.loading; } catch(e){} }
      if (!this.filesystem || typeof this.filesystem.existsSync !== 'function') return null;
      const url = new URL(request.url);
      if (url.origin !== this.domain) return null;
      let pathname = decodeURIComponent(url.pathname || '/');
      let relative;
      const publicPath=this.path;
      if (publicPath === '/') {
        relative = pathname === '/' ? this.runfile : pathname;
      } else if (pathname === publicPath || pathname === publicPath + '/') {
        relative = this.runfile;
      } else if (pathname.startsWith(publicPath + '/')) {
        relative = pathname.slice(publicPath.length);
      } else return null;
      const clean='/'+relative.replace(/^\/+/,"");
      const filePath=this.rootfolder?(this.rootfolder+clean):clean.slice(1);
      if (!this.filesystem.existsSync(filePath)) return new Response('Not Found',{status:404,headers:{'Content-Type':'text/plain'}});
      const data=this.filesystem.readFileSync(filePath);
      return new Response(data,{status:200,statusText:'OK',headers:{'Content-Type':staticInferMime(filePath),'Content-Length':data.byteLength.toString()}});
    }
    async handleSocket(){return null;}
  }
  window.StaticEndpoint=StaticEndpoint;
})();

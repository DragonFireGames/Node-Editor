
(function() {
  class FileSystem {
    constructor(provider, sourceMode, syncEnabled) {
      this.provider = provider;
      this.sourceMode = sourceMode;
      this.sync = syncEnabled;
      this.directories = new Set(['']);
      for (const path of this.provider.directories || []) this._addParentDirectories(path);
      for (const rawPath of this.provider.cache?.keys?.() || []) {
        const path = this._normalize(rawPath);
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (parent) this._addParentDirectories(parent);
      }
      this.provider.directories = this.directories;
    }

    _normalize(path) {
      const parts = String(path ?? '').replace(/\\/g,'/').split('/').filter(Boolean);
      const out = [];
      for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') { if (out.length) out.pop(); continue; }
        out.push(part);
      }
      return out.join('/');
    }

    _addParentDirectories(path) {
      const parts = this._normalize(path).split('/').filter(Boolean);
      let curr = '';
      for (const part of parts) {
        curr = curr ? curr + '/' + part : part;
        this.directories.add(curr);
      }
    }

    static async empty(options = { sync: false }) {
      if (typeof JSZip === 'undefined') throw new Error('JSZip library required.');
      const provider = new ZipProvider(new JSZip(), false);
      await provider.init();
      return new this(provider, 4, options.sync !== false);
    }

    static async create(source, options = { sync: true }) {
      let provider;
      let mode = 0;
      const sync = options.sync !== false;

      if (typeof FileSystemDirectoryHandle !== 'undefined' && source instanceof FileSystemDirectoryHandle) {
        provider = new DirectoryHandleProvider(source, sync);
        mode = 1;
      } else if (typeof FileSystemFileHandle !== 'undefined' && source instanceof FileSystemFileHandle) {
        if (typeof JSZip === 'undefined') throw new Error("JSZip library required.");
        provider = new ZipFileHandleProvider(source, sync);
        mode = 2;
      } else if (source instanceof FileList || Array.isArray(source)) {
        if (typeof JSZip === 'undefined') throw new Error("JSZip library required.");
        const zip = new JSZip();
        const files = source instanceof FileList ? Array.from(source) : source;
        const promises = files.map(async (file) => {
          const path = file.customRelativePath || file.webkitRelativePath || file.name;
          const buffer = await file.arrayBuffer();
          zip.file(path, new Uint8Array(buffer));
        });
        await Promise.all(promises);
        provider = new ZipProvider(zip, false);
        mode = 3;
      } else if (source instanceof File && (source.type === 'application/zip' || source.name.endsWith('.zip'))) {
        if (typeof JSZip === 'undefined') throw new Error("JSZip library required.");
        const zip = await JSZip.loadAsync(source);
        provider = new ZipProvider(zip, false);
        mode = 4;
      } else if (source.files) {
        provider = new ZipProvider(source, false);
        mode = 4;
      } else {
        throw new Error("Unsupported file system source.");
      }

      await provider.init();
      return new this(provider, mode, sync);
    }

    readFileSync(path, encoding = 'binary') {
      path = this._normalize(path);
      const data = this.provider.cache.get(path);
      if (!data) return null;
      return encoding === 'utf8' ? new TextDecoder().decode(data) : data;
    }

    writeFileSync(path, content) {
      path = this._normalize(path);
      this._addParentDirectories(path.includes('/') ? path.slice(0,path.lastIndexOf('/')) : '');
      let binary = content;
      if (typeof content === 'string') binary = new TextEncoder().encode(content);
      this.provider.write(path, binary, content);
    }

    mkdirSync(path) {
      path = this._normalize(path);
      if (!path) return;
      this._addParentDirectories(path);
      this.provider.mkdir?.(path);
    }

    deleteFileSync(path) {
      path = this._normalize(path);
      return this.provider.delete(path);
    }

    moveSync(source, destination) {
      source = this._normalize(source);
      destination = this._normalize(destination);
      if (!source || !destination || source === destination) return false;
      if (destination.startsWith(source + '/')) throw new Error('Cannot move a path into itself.');
      if (this.existsSync(destination) || this.isDirectorySync(destination)) throw new Error(`Destination already exists: ${destination}`);
      const sourceIsDir = this.isDirectorySync(source);
      if (sourceIsDir) {
        const files = this.listFilesSync().filter(path => path === source || path.startsWith(source + '/'));
        const dirs = this.listDirectoriesSync().filter(path => path === source || path.startsWith(source + '/'));
        this._addParentDirectories(destination);
        for (const path of dirs) this._addParentDirectories(destination + path.slice(source.length));
        for (const path of files) {
          const target = destination + path.slice(source.length);
          const data = this.readFileSync(path, 'binary');
          this.writeFileSync(target, data);
        }
        for (const path of files) this.deleteFileSync(path);
        for (const path of dirs.sort((a,b) => b.length - a.length)) this.directories.delete(path);
        this.provider.directories = this.directories;
        this.provider.removeDirectory?.(source);
      } else {
        const parent = destination.includes('/') ? destination.slice(0, destination.lastIndexOf('/')) : '';
        this._addParentDirectories(parent);
        const data = this.readFileSync(source, 'binary');
        this.writeFileSync(destination, data);
        this.deleteFileSync(source);
      }
      return true;
    }

    deleteDirectorySync(path) {
      path = this._normalize(path);
      if (!path) return false;
      let changed = false;
      const prefix = path + '/';
      for (const file of [...this.provider.cache.keys()]) {
        if (file === path || file.startsWith(prefix)) { this.provider.delete(file); changed = true; }
      }
      for (const dir of [...this.directories]) {
        if (dir === path || dir.startsWith(prefix)) { this.directories.delete(dir); changed = true; }
      }
      this.provider.directories = this.directories;
      this.provider.removeDirectory?.(path);
      return changed;
    }

    existsSync(path) {
      return this.provider.cache.has(this._normalize(path));
    }

    isDirectorySync(path) {
      return this.directories.has(this._normalize(path));
    }

    listFilesSync() {
      return Array.from(this.provider.cache.keys());
    }

    listDirectoriesSync() {
      return Array.from(this.directories).filter(Boolean);
    }

    canSave() {
      return !!this.provider?.canSave;
    }

    async permissionState() {
      if (!this.canSave()) return 'denied';
      return await this.provider.permissionState?.() || 'granted';
    }

    async save() {
      if (!this.canSave()) throw new Error('This workspace does not have a writable File System API source.');
      return await this.provider.save();
    }

    async saveAs(suggestedName = 'workspace.zip') {
      if (typeof showSaveFilePicker !== 'function') throw new Error('The File System Access API is unavailable.');
      if (typeof JSZip === 'undefined') throw new Error('JSZip library required.');
      const handle = await showSaveFilePicker({
        suggestedName,
        types: [{ description: 'ZIP project', accept: { 'application/zip': ['.zip'] } }]
      });
      if (!handle) return false;
      const blob = await this.exportZip();
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      const provider = new ZipFileHandleProvider(handle, this.sync);
      await provider.init();
      this.provider = provider;
      this.sourceMode = 2;
      this.directories = new Set(['']);
      for (const path of provider.directories || []) this._addParentDirectories(path);
      for (const rawPath of provider.cache.keys()) {
        const path = this._normalize(rawPath);
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (parent) this._addParentDirectories(parent);
      }
      this.provider.directories = this.directories;
      return true;
    }

    async exportZip() {
      return await this.provider.exportZip();
    }
  }

  class DirectoryHandleProvider {
    constructor(dirHandle, sync) {
      this.dirHandle = dirHandle;
      this.canSave = true;
      this.sync = sync;
      this.cache = new Map();
      this.directories = new Set(['']);
    }
    async init() {
      await this._readDir(this.dirHandle, '');
    }
    async _readDir(handle, currentPath) {
      for await (const entry of handle.values()) {
        const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
        if (entry.kind === 'file') {
          const file = await entry.getFile();
          const buffer = await file.arrayBuffer();
          this.cache.set(entryPath, new Uint8Array(buffer));
        } else if (entry.kind === 'directory') {
          this.directories.add(entryPath);
          await this._readDir(entry, entryPath);
        }
      }
    }
    write(path, binary, original) {
      this.cache.set(path, binary);
      if (this.sync) {
        this._persistFile(path, binary);
      }
    }
    delete(path) {
      const deleted = this.cache.delete(path);
      if (deleted && this.sync) {
        this._persistDelete(path);
      }
      return deleted;
    }
    mkdir(path) { if (this.sync) this._persistDirectory(path); }
    async _persistDirectory(path) {
      const parts = String(path).split('/').filter(Boolean);
      let curr = this.dirHandle;
      for (const part of parts) curr = await curr.getDirectoryHandle(part, { create: true });
    }
    removeDirectory(path) { if (this.sync) this._persistRemoveDirectory(path); }
    async _persistRemoveDirectory(path) {
      const parts = String(path).split('/').filter(Boolean);
      const name = parts.pop();
      let curr = this.dirHandle;
      try { for (const p of parts) curr = await curr.getDirectoryHandle(p); await curr.removeEntry(name, { recursive: true }); } catch (e) {}
    }
    async _persistFile(path, binary) {
      const parts = path.split('/');
      const fileName = parts.pop();
      let curr = this.dirHandle;
      for (const p of parts) curr = await curr.getDirectoryHandle(p, { create: true });
      const fh = await curr.getFileHandle(fileName, { create: true });
      const writable = await fh.createWritable();
      await writable.write(binary);
      await writable.close();
    }
    async _persistDelete(path) {
      const parts = path.split('/');
      const fileName = parts.pop();
      let curr = this.dirHandle;
      try {
        for (const p of parts) curr = await curr.getDirectoryHandle(p);
        await curr.removeEntry(fileName);
      } catch (e) {}
    }
    async permissionState() {
      if (typeof this.dirHandle?.queryPermission !== 'function') return 'granted';
      try { return await this.dirHandle.queryPermission({ mode: 'readwrite' }); } catch (_) { return 'denied'; }
    }
    async save() {
      for (const [path, binary] of this.cache) {
        await this._persistFile(path, binary);
      }
      return null;
    }
    async exportZip() {
      const zip = new JSZip();
      for (const [path, data] of this.cache) zip.file(path, data);
      return await zip.generateAsync({ type: 'blob' });
    }
  }

  class ZipFileHandleProvider {
    constructor(fileHandle, sync) {
      this.fileHandle = fileHandle;
      this.canSave = true;
      this.sync = sync;
      this.cache = new Map();
      this.directories = new Set(['']);
      this.zip = null;
      this.writing = false;
    }
    async init() {
      const file = await this.fileHandle.getFile();
      this.zip = await JSZip.loadAsync(file);
      const promises = [];
      this.zip.forEach((relativePath, file) => {
        const clean = relativePath.replace(/\/$/,'');
        if (file.dir) this.directories.add(clean);
        else {
          promises.push(file.async('uint8array').then(d => this.cache.set(relativePath, d)));
        }
      });
      await Promise.all(promises);
    }
    write(path, binary, original) {
      this.cache.set(path, binary);
      this.zip.file(path, original);
      const parts = path.split('/').filter(Boolean);
      let curr = '';
      for (let i = 0; i < parts.length - 1; i++) { curr = curr ? curr + '/' + parts[i] : parts[i]; this.directories.add(curr); this.zip.folder(curr); }
      if (this.sync) {
        this._autoSave();
      }
    }
    delete(path) {
      const deleted = this.cache.delete(path);
      if (deleted) {
        this.zip.remove(path);
        if (this.sync) this._autoSave();
      }
      return deleted;
    }
    async _autoSave() {
      if (this.writing) return;
      this.writing = true;
      try { await this.save(); } finally { this.writing = false; }
    }
    async permissionState() {
      if (typeof this.fileHandle?.queryPermission !== 'function') return 'granted';
      try { return await this.fileHandle.queryPermission({ mode: 'readwrite' }); } catch (_) { return 'denied'; }
    }
    async save() {
      for (const dir of this.directories) if (dir) this.zip.folder(dir);
      this.cache.forEach((data, path) => this.zip.file(path, data));
      const blob = await this.zip.generateAsync({ type: 'blob' });
      const writable = await this.fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return null;
    }
    async exportZip() {
      for (const dir of this.directories) if (dir) this.zip.folder(dir);
      this.cache.forEach((data, path) => this.zip.file(path, data));
      return await this.zip.generateAsync({ type: 'blob' });
    }
  }

  class ZipProvider {
    constructor(zipInstance, sync) {
      this.zip = zipInstance;
      this.canSave = false;
      this.sync = sync;
      this.cache = new Map();
      this.directories = new Set(['']);
    }
    async init() {
      const promises = [];
      this.zip.forEach((relativePath, file) => {
        const clean = relativePath.replace(/\/$/,'');
        if (file.dir) this.directories.add(clean);
        else {
          promises.push(file.async('uint8array').then(d => this.cache.set(relativePath, d)));
        }
      });
      await Promise.all(promises);
    }
    write(path, binary, original) {
      this.cache.set(path, binary);
      this.zip.file(path, original);
      const parts = path.split('/').filter(Boolean);
      let curr = '';
      for (let i = 0; i < parts.length - 1; i++) { curr = curr ? curr + '/' + parts[i] : parts[i]; this.directories.add(curr); this.zip.folder(curr); }
    }
    mkdir(path) { this.directories.add(path); this.zip.folder(path); }
    removeDirectory(path) { for (const d of [...this.directories]) if (d === path || d.startsWith(path + '/')) this.directories.delete(d); this.zip.remove(path); }
    delete(path) {
      const deleted = this.cache.delete(path);
      if (deleted) this.zip.remove(path);
      return deleted;
    }
    async save() {
      return await this.exportZip();
    }
    async exportZip() {
      for (const dir of this.directories) if (dir) this.zip.folder(dir);
      this.cache.forEach((data, path) => this.zip.file(path, data));
      return await this.zip.generateAsync({ type: 'blob' });
    }
  }

  window.FileSystem = FileSystem;
})();
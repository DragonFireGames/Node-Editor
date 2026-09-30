(function() {
  class NpmError extends Error {
    constructor(message, code = 'ENPM') {
      super(message);
      this.name = 'NpmError';
      this.code = code;
    }
  }

  function normalizePath(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    const out = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        if (out.length) out.pop();
        continue;
      }
      out.push(part);
    }
    return '/' + out.join('/');
  }

  function joinPath(...parts) {
    return normalizePath(parts.join('/')).replace(/^\/+/, '');
  }

  function packageNodePath(packageName) {
    return packageName.startsWith('@') ? packageName : packageName;
  }

  function splitCommand(command) {
    const out = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (const ch of String(command || '')) {
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\' && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        else current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (/\s/.test(ch)) {
        if (current) {
          out.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (escaped) current += '\\';
    if (current) out.push(current);
    return out;
  }

  function parsePackageSpec(spec) {
    spec = String(spec || '').trim();
    if (!spec) throw new NpmError('Invalid package specification.');

    if (/^(?:https?:|git\+|git:|file:|\.\.?\/|\/)/i.test(spec)) {
      return { type: 'url', raw: spec, source: spec };
    }

    let name;
    let range = '';
    if (spec.startsWith('@')) {
      const slash = spec.indexOf('/');
      if (slash < 2) throw new NpmError(`Invalid package name '${spec}'.`);
      const at = spec.indexOf('@', slash + 1);
      if (at === -1) name = spec;
      else {
        name = spec.slice(0, at);
        range = spec.slice(at + 1) || 'latest';
      }
    } else {
      const at = spec.indexOf('@');
      if (at === -1) name = spec;
      else {
        name = spec.slice(0, at);
        range = spec.slice(at + 1) || 'latest';
      }
    }

    if (!name || !/^(@[^/]+\/)?[^/]+$/.test(name)) {
      throw new NpmError(`Invalid package name '${name || spec}'.`);
    }

    return { type: 'registry', raw: spec, name, range: range || 'latest' };
  }

  function parseVersion(version) {
    const match = String(version || '').trim().match(/^[=v\s]*([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2] || 0),
      patch: Number(match[3] || 0),
      prerelease: match[4] ? match[4].split('.') : [],
      build: match[5] || ''
    };
  }

  function compareVersions(a, b) {
    const va = typeof a === 'string' ? parseVersion(a) : a;
    const vb = typeof b === 'string' ? parseVersion(b) : b;
    if (!va || !vb) return String(a).localeCompare(String(b));
    for (const key of ['major', 'minor', 'patch']) {
      if (va[key] !== vb[key]) return va[key] - vb[key];
    }
    if (!va.prerelease.length && !vb.prerelease.length) return 0;
    if (!va.prerelease.length) return 1;
    if (!vb.prerelease.length) return -1;
    const n = Math.max(va.prerelease.length, vb.prerelease.length);
    for (let i = 0; i < n; i++) {
      if (i >= va.prerelease.length) return -1;
      if (i >= vb.prerelease.length) return 1;
      const x = va.prerelease[i], y = vb.prerelease[i];
      if (x === y) continue;
      const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
      if (xn && yn) return Number(x) - Number(y);
      if (xn) return -1;
      if (yn) return 1;
      return x < y ? -1 : 1;
    }
    return 0;
  }

  function versionSatisfies(version, range) {
    const v = parseVersion(version);
    if (!v) return false;
    range = String(range || '*').trim();
    if (!range || range === '*' || range === 'latest') return !v.prerelease.length;
    if (range === 'x' || range === 'X') return true;
    if (range.includes('||')) return range.split('||').some(r => versionSatisfies(version, r));

    const parts = range.replace(/^v/, '').trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1 && parts.every(p => /^(?:[<>]=?|=|~|\^)?v?\d/.test(p))) {
      return parts.every(p => versionSatisfies(version, p));
    }

    const comparator = range.match(/^(>=|<=|>|<|=)?\s*(v?\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)$/);
    if (comparator) {
      const op = comparator[1] || '=';
      const target = comparator[2];
      const targetVersion = parseVersion(target);
      if (!targetVersion) return false;
      const cmp = compareVersions(v, targetVersion);
      if (op === '>') return cmp > 0;
      if (op === '>=') return cmp >= 0;
      if (op === '<') return cmp < 0;
      if (op === '<=') return cmp <= 0;
      return cmp === 0;
    }

    let m = range.match(/^\^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (m) {
      const major = Number(m[1]);
      const minor = Number(m[2] || 0);
      const patch = Number(m[3] || 0);
      if (compareVersions(v, { major, minor, patch, prerelease: [] }) < 0) return false;
      if (major > 0) return v.major === major;
      if (minor > 0) return v.major === 0 && v.minor === minor;
      return v.major === 0 && v.minor === 0 && v.patch === patch;
    }

    m = range.match(/^~\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (m) {
      const major = Number(m[1]);
      const minor = Number(m[2] || 0);
      const patch = Number(m[3] || 0);
      if (compareVersions(v, { major, minor, patch, prerelease: [] }) < 0) return false;
      return v.major === major && (m[2] == null || v.minor === minor);
    }

    m = range.match(/^v?(\d+|x|X)(?:\.(\d+|x|X))?(?:\.(\d+|x|X))?$/);
    if (m) {
      if (m[1] !== 'x' && m[1] !== 'X' && v.major !== Number(m[1])) return false;
      if (m[2] && m[2] !== 'x' && m[2] !== 'X' && v.minor !== Number(m[2])) return false;
      if (m[3] && m[3] !== 'x' && m[3] !== 'X' && v.patch !== Number(m[3])) return false;
      return true;
    }

    return compareVersions(version, range) === 0;
  }

  function selectVersion(metadata, range) {
    const versions = Object.keys(metadata.versions || {})
      .filter(v => parseVersion(v))
      .sort(compareVersions)
      .reverse();

    const distTags = metadata['dist-tags'] || {};
    const requested = String(range || 'latest').trim();
    if (distTags[requested]) return distTags[requested];

    const candidates = versions.filter(v => !parseVersion(v).prerelease.length && versionSatisfies(v, requested));
    if (candidates.length) return candidates[0];

    const prereleaseCandidates = versions.filter(v => versionSatisfies(v, requested));
    if (prereleaseCandidates.length) return prereleaseCandidates[0];
    throw new NpmError(`No version of '${metadata.name || 'package'}' matches '${range}'.`, 'ERANGE');
  }

  function readTarString(bytes, offset, length) {
    let end = offset + length;
    while (end > offset && bytes[end - 1] === 0) end--;
    return new TextDecoder().decode(bytes.slice(offset, end));
  }

  function readTarNumber(bytes, offset, length) {
    const value = readTarString(bytes, offset, length).trim();
    if (!value) return 0;
    if (value[0] === 'x') {
      let result = 0;
      for (let i = 1; i < value.length; i++) result = result * 256 + value.charCodeAt(i);
      return result;
    }
    return parseInt(value, 8) || 0;
  }

  function parsePax(bytes) {
    const text = new TextDecoder().decode(bytes);
    const result = {};
    let pos = 0;
    while (pos < text.length) {
      const space = text.indexOf(' ', pos);
      if (space < 0) break;
      const length = Number(text.slice(pos, space));
      if (!length) break;
      const record = text.slice(space + 1, pos + length).replace(/\n$/, '');
      const eq = record.indexOf('=');
      if (eq >= 0) result[record.slice(0, eq)] = record.slice(eq + 1);
      pos += length;
    }
    return result;
  }

  function sanitizeTarPath(path) {
    path = String(path || '').replace(/\\/g, '/');
    path = path.replace(/^\.\//, '');
    if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) throw new NpmError(`Unsafe package path '${path}'.`, 'ETAR');
    const parts = path.split('/').filter(Boolean);
    const clean = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') throw new NpmError(`Unsafe package path '${path}'.`, 'ETAR');
      clean.push(part);
    }
    return clean.join('/');
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new NpmError('This browser does not provide gzip decompression for npm packages.', 'ENOTSUP');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function extractTgz(bytes) {
    const tar = await gunzip(bytes);
    const files = [];
    let offset = 0;
    let longName = null;
    let pax = {};
    let globalPax = {};

    while (offset + 512 <= tar.length) {
      const header = tar.slice(offset, offset + 512);
      offset += 512;
      let empty = true;
      for (const b of header) {
        if (b !== 0) { empty = false; break; }
      }
      if (empty) break;

      const name = readTarString(header, 0, 100);
      const prefix = readTarString(header, 345, 155);
      const rawPath = prefix ? `${prefix}/${name}` : name;
      const mode = readTarString(header, 100, 8);
      const size = readTarNumber(header, 124, 12);
      const type = String.fromCharCode(header[156] || 0);
      const body = tar.slice(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;

      if (type === 'L') {
        longName = new TextDecoder().decode(body).replace(/\0+$/, '').replace(/\n$/, '');
        continue;
      }
      if (type === 'g') {
        globalPax = { ...globalPax, ...parsePax(body) };
        continue;
      }
      if (type === 'x') {
        pax = { ...pax, ...parsePax(body) };
        continue;
      }

      const mergedPax = { ...globalPax, ...pax };
      pax = {};
      let filePath = mergedPax.path || longName || rawPath;
      longName = null;
      filePath = sanitizeTarPath(filePath);
      if (!filePath) continue;

      if (type === '5') continue;
      if (type === '2' || type === '1') continue;
      if (type !== '0' && type !== '' && type !== '\0') continue;

      let relativePath = filePath;
      if (relativePath === 'package') continue;
      if (relativePath.startsWith('package/')) relativePath = relativePath.slice('package/'.length);
      relativePath = sanitizeTarPath(relativePath);
      if (!relativePath) continue;

      files.push({ path: relativePath, data: body, mode });
    }
    return files;
  }

  class NPM {
    constructor(options = {}) {
      this.filesystem = options.filesystem;
      this.network = options.network;
      this.rootfolder = String(options.rootfolder || '').replace(/^\/+|\/+$/g, '');
      this.registry = String(options.registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
      this.log = options.log || console;
      this.metadataCache = new Map();
      this.tarballCache = new Map();
      this.installing = new Set();
      this.installRecords = new Map(); // relative package path -> {resolved, integrity}
      this.commandRunner = typeof options.commandRunner === 'function' ? options.commandRunner : null;
    }

    output(message = '') {
      if (typeof this.log?.logText === 'function') this.log.logText(message);
      else if (typeof this.log?.log === 'function') this.log.log(message);
    }

    warn(message) {
      if (typeof this.log?.warn === 'function') this.log.warn(message);
      else this.output(message);
    }

    error(message) {
      if (typeof this.log?.error === 'function') this.log.error(message);
      else this.output(message);
    }

    ensureReady() {
      if (!this.filesystem || typeof this.filesystem.readFileSync !== 'function') throw new NpmError('npm: filesystem is not initialized.', 'ENOTREADY');
      if (!this.network || typeof this.network.request !== 'function') throw new NpmError('npm: network is not initialized.', 'ENOTREADY');
    }

    projectPath(relative = '') {
      const clean = String(relative || '').replace(/^\/+/, '');
      return joinPath(this.rootfolder, clean);
    }

    readText(path) {
      try {
        const data = this.filesystem.readFileSync(path, 'utf8');
        return data == null ? null : String(data);
      } catch (_) {
        return null;
      }
    }

    writeText(path, text) {
      this.filesystem.writeFileSync(path, String(text));
    }

    deleteTree(relativePath) {
      const base = this.projectPath(relativePath).replace(/\/+$/, '');
      const prefix = base + '/';
      for (const file of this.filesystem.listFilesSync()) {
        if (file === base || file.startsWith(prefix)) this.filesystem.deleteFileSync(file);
      }
    }

    async request(url, type = 'npm') {
      const response = await this.network.request(url, this.registry + '/', {
        headers: {
          'Accept': 'application/json, text/plain, */*'
        }
      }, type);
      if (!response) throw new NpmError(`Network request failed: ${url}`, 'ENETWORK');
      if (!response.ok) throw new NpmError(`HTTP ${response.status} while fetching ${url}.`, 'EHTTP');
      return response;
    }

    async fetchMetadata(name) {
      if (this.metadataCache.has(name)) return this.metadataCache.get(name);
      const url = `${this.registry}/${encodeURIComponent(name)}`;
      const response = await this.request(url, 'npm:metadata');
      const metadata = await response.json();
      if (!metadata || typeof metadata !== 'object' || !metadata.versions) throw new NpmError(`Registry returned invalid metadata for '${name}'.`, 'EBADMETA');
      this.metadataCache.set(name, metadata);
      return metadata;
    }

    async fetchTarball(url) {
      if (this.tarballCache.has(url)) return this.tarballCache.get(url);
      const response = await this.network.request(url, this.registry + '/', {}, 'npm:tarball');
      if (!response || !response.ok) throw new NpmError(`Failed to download package archive: ${url}`, 'ENETWORK');
      const bytes = new Uint8Array(await response.arrayBuffer());
      this.tarballCache.set(url, bytes);
      return bytes;
    }

    async verifyIntegrity(bytes, integrity) {
      if (!integrity || typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') return true;
      const entries = String(integrity).trim().split(/\s+/).filter(Boolean);
      for (const entry of entries) {
        const match = entry.match(/^sha(512|256|1)-(.+)$/i);
        if (!match) continue;
        const algo = `SHA-${match[1]}`;
        const digest = new Uint8Array(await crypto.subtle.digest(algo, bytes));
        let binary = '';
        for (const b of digest) binary += String.fromCharCode(b);
        const encoded = btoa(binary);
        if (encoded === match[2]) return true;
      }
      throw new NpmError('Package integrity check failed.', 'EINTEGRITY');
    }

    readPackageJson(packageRelativePath) {
      const text = this.readText(this.projectPath(joinPath(packageRelativePath, 'package.json')));
      if (!text) return null;
      try { return JSON.parse(text); } catch (_) { return null; }
    }

    findInstalledPackage(name, fromRelativePath = '') {
      let current = this.projectPath(fromRelativePath);
      current = current.replace(/\/+$/, '');
      while (true) {
        const candidate = `${current}/node_modules/${packageNodePath(name)}`;
        const packageJson = this.readText(`${candidate}/package.json`);
        if (packageJson) {
          try {
            return { path: candidate, relativePath: candidate.replace(/^\/+/, '').replace(this.rootfolder ? new RegExp(`^${this.escapeRegExp(this.rootfolder)}/?`) : /^/, ''), manifest: JSON.parse(packageJson) };
          } catch (_) {}
        }
        const root = this.projectPath('').replace(/\/+$/, '');
        if (current === root || !current) break;
        const idx = current.lastIndexOf('/');
        if (idx < 0) break;
        current = current.slice(0, idx) || '';
      }
      return null;
    }

    escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    installedPackagePath(targetDir, name) {
      return this.projectPath(joinPath(targetDir, 'node_modules', packageNodePath(name)));
    }

    async materializePackage(targetDir, name, metadata, version, spec) {
      const manifest = metadata.versions?.[version];
      if (!manifest) throw new NpmError(`Registry metadata for '${name}@${version}' is missing the version record.`);
      const dist = manifest.dist || {};
      if (!dist.tarball) throw new NpmError(`Package '${name}@${version}' has no downloadable tarball.`);
      const bytes = await this.fetchTarball(dist.tarball);
      await this.verifyIntegrity(bytes, dist.integrity);
      const files = await extractTgz(bytes);
      if (!files.some(f => f.path === 'package.json')) throw new NpmError(`Package '${name}@${version}' does not contain package.json.`, 'EBADPACK');

      const destination = this.installedPackagePath(targetDir, name);
      this.deleteTree(destination.replace(this.rootfolder + '/', ''));
      for (const file of files) {
        this.filesystem.writeFileSync(`${destination}/${file.path}`, file.data);
      }

      const installedManifest = this.readText(`${destination}/package.json`);
      let parsedManifest = manifest;
      if (installedManifest) {
        try { parsedManifest = JSON.parse(installedManifest); } catch (_) {}
      }
      const relativePath = destination.replace(this.rootfolder ? this.rootfolder + '/' : '', '');
      this.installRecords.set(relativePath, { resolved: dist.tarball, integrity: dist.integrity || null });
      return {
        name,
        version,
        manifest: parsedManifest,
        path: destination,
        relativePath,
        resolved: dist.tarball,
        integrity: dist.integrity || null,
        spec
      };
    }

    async installResolved(name, range, targetDir, options = {}, stack = []) {
      const requestedRange = range || 'latest';
      const existing = this.findInstalledPackage(name, targetDir);
      if (existing && !options.force && versionSatisfies(existing.manifest.version, requestedRange)) {
        return {
          name,
          version: existing.manifest.version,
          manifest: existing.manifest,
          path: existing.path,
          relativePath: existing.relativePath,
          resolved: null,
          integrity: null,
          reused: true
        };
      }

      const key = `${targetDir}:${name}@${requestedRange}`;
      if (stack.includes(name) || this.installing.has(key)) return existing ? { name, version: existing.manifest.version, manifest: existing.manifest, path: existing.path, relativePath: existing.relativePath, reused: true } : null;
      this.installing.add(key);

      try {
        const metadata = await this.fetchMetadata(name);
        const version = selectVersion(metadata, requestedRange);
        const installed = await this.materializePackage(targetDir, name, metadata, version, requestedRange);
        const childTarget = installed.relativePath;
        const deps = {
          ...(installed.manifest.dependencies || {}),
          ...(installed.manifest.optionalDependencies || {})
        };

        for (const [depName, depRange] of Object.entries(deps)) {
          try {
            await this.installResolved(depName, depRange, childTarget, {}, [...stack, name]);
          } catch (err) {
            if (installed.manifest.optionalDependencies && Object.prototype.hasOwnProperty.call(installed.manifest.optionalDependencies, depName)) {
              this.warn(`npm WARN optional dependency ${depName}@${depRange} was not installed: ${err.message}`);
            } else {
              throw err;
            }
          }
        }

        for (const [peerName, peerRange] of Object.entries(installed.manifest.peerDependencies || {})) {
          const peer = this.findInstalledPackage(peerName, targetDir);
          if (!peer || !versionSatisfies(peer.manifest.version, peerRange)) {
            this.warn(`npm WARN unmet peer dependency ${peerName}@${peerRange} required by ${name}@${version}`);
          }
        }

        return installed;
      } finally {
        this.installing.delete(key);
      }
    }

    loadRootManifest() {
      const path = this.projectPath('package.json');
      const text = this.readText(path);
      if (!text) return { path, manifest: null };
      try { return { path, manifest: JSON.parse(text) }; }
      catch (_) { throw new NpmError('package.json contains invalid JSON.', 'EBADJSON'); }
    }

    saveRootManifest(manifest) {
      this.writeText(this.projectPath('package.json'), JSON.stringify(manifest, null, 2) + '\n');
    }

    async install(args) {
      this.ensureReady();
      const options = this.parseOptions(args);
      const root = this.loadRootManifest();
      let manifest = root.manifest;
      if (!manifest) {
        manifest = { name: 'browser-project', version: '1.0.0', private: true };
        if (!options.noSave) this.saveRootManifest(manifest);
      }

      const specs = options.positionals;
      const requests = [];
      if (specs.length) {
        for (const spec of specs) requests.push(parsePackageSpec(spec));
      } else {
        const groups = options.production ? ['dependencies', 'optionalDependencies'] : ['dependencies', 'devDependencies', 'optionalDependencies'];
        for (const group of groups) {
          for (const [name, range] of Object.entries(manifest[group] || {})) requests.push({ type: 'registry', raw: `${name}@${range}`, name, range, group });
        }
      }

      if (!requests.length) {
        this.output('npm install: package.json has no dependencies.');
        return;
      }

      const saveGroup = options.saveDev ? 'devDependencies' : 'dependencies';
      if (!manifest[saveGroup]) manifest[saveGroup] = {};

      for (const request of requests) {
        if (request.type !== 'registry') throw new NpmError(`Installing ${request.raw} is not supported yet; registry packages are required.`);
        this.output(`npm ${options.force ? 'update' : 'install'} ${request.name}${request.range && request.range !== 'latest' ? '@' + request.range : ''}`);
        const result = await this.installResolved(request.name, request.range, '', { force: options.force });
        if (!result) throw new NpmError(`Unable to install '${request.raw}'.`);
        if (specs.length && !options.noSave) {
          const originalSpec = request.range === 'latest' ? (options.saveExact ? result.version : `^${result.version}`) : request.range;
          manifest[saveGroup][request.name] = originalSpec;
        }
        this.output(`+ ${request.name}@${result.version}${result.reused ? ' (already installed)' : ''}`);
      }

      if (!options.noSave) this.saveRootManifest(manifest);
      await this.writeLockfile(manifest);
      this.output('npm install complete.');
    }

    async uninstall(args) {
      this.ensureReady();
      const options = this.parseOptions(args);
      const { manifest } = this.loadRootManifest();
      if (!manifest) throw new NpmError('Cannot uninstall packages without package.json.');
      for (const name of options.positionals) {
        let removedFrom = null;
        for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          if (manifest[group] && Object.prototype.hasOwnProperty.call(manifest[group], name)) {
            delete manifest[group][name];
            removedFrom = group;
          }
        }
        if (!removedFrom) this.warn(`npm WARN ${name} is not listed in package.json.`);
        this.deleteTree(this.projectPath(`node_modules/${packageNodePath(name)}`).replace(this.rootfolder ? this.rootfolder + '/' : '', ''));
        this.output(`removed ${name}`);
      }
      this.saveRootManifest(manifest);
      await this.prune({ quiet: true });
      await this.writeLockfile(manifest);
      this.output('npm uninstall complete.');
    }

    async audit(args = [], fix = false) {
      this.ensureReady();
      const options = this.parseOptions(args);
      const root = this.loadRootManifest();
      if (!root.manifest) throw new NpmError('npm audit requires package.json.', 'ENOLOCK');

      const lockText = this.readText(this.projectPath('package-lock.json'));
      if (!lockText) throw new NpmError('npm audit requires package-lock.json.', 'ENOLOCK');
      let lock;
      try { lock = JSON.parse(lockText); }
      catch (_) { throw new NpmError('package-lock.json contains invalid JSON.', 'EBADLOCK'); }

      const rootManifest = root.manifest;
      const omitDev = options.production || options.omitDev;
      const groups = omitDev ? ['dependencies', 'optionalDependencies'] : ['dependencies', 'devDependencies', 'optionalDependencies'];
      const direct = {};
      for (const group of groups) Object.assign(direct, rootManifest[group] || {});

      const packages = lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
      const versions = {};
      for (const [path, entry] of Object.entries(packages)) {
        if (!path || !path.startsWith('node_modules/') || !entry || !entry.version) continue;
        const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (!name || name.includes('/node_modules/')) continue;
        versions[name] = versions[name] || [];
        versions[name].push(String(entry.version));
      }
      for (const [name, range] of Object.entries(direct)) {
        if (!versions[name]) {
          const installed = this.readText(this.projectPath(`node_modules/${name}/package.json`));
          if (installed) {
            try {
              const pkg = JSON.parse(installed);
              if (pkg.version) versions[name] = [String(pkg.version)];
            } catch (_) {}
          }
        }
      }

      const body = {};
      for (const [name, list] of Object.entries(versions)) body[name] = [...new Set(list)];
      if (!Object.keys(body).length) {
        if (options.json) {
          this.output(JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities: 0, dependencies: 0 }, vulnerabilities: {}, actions: [] }, null, 2));
        } else {
          this.output('found 0 vulnerabilities');
        }
        return { vulnerabilities: {}, actions: [] };
      }

      const response = await this.network.request(`${this.registry}/-/npm/v1/security/advisories/bulk`, this.registry + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      }, 'npm:audit');
      if (!response) throw new NpmError('Network request failed while running npm audit.', 'ENETWORK');
      if (!response.ok) throw new NpmError(`HTTP ${response.status} while running npm audit.`, 'EHTTP');

      let advisories;
      try {
        advisories = await response.json();
      } catch (_) {
        throw new NpmError('Registry returned invalid audit data.', 'EBADAUDIT');
      }

      const vulnerabilities = {};
      for (const [name, records] of Object.entries(advisories || {})) {
        const list = Array.isArray(records) ? records : [records];
        for (const advisory of list) {
          const versionsFound = versions[name] || [];
          const affected = versionsFound.filter(v => versionSatisfies(v, advisory.vulnerable_versions || '*'));
          if (!affected.length) continue;
          const existing = vulnerabilities[name] || {
            name,
            severity: advisory.severity || 'unknown',
            isDirect: Object.prototype.hasOwnProperty.call(direct, name),
            via: [],
            effects: [],
            range: advisory.vulnerable_versions || '*',
            nodes: [],
            fixAvailable: false,
            advisories: []
          };
          existing.via.push({
            source: advisory.id,
            title: advisory.title || `Security advisory for ${name}`,
            url: advisory.url || null,
            severity: advisory.severity || 'unknown',
            range: advisory.vulnerable_versions || '*'
          });
          existing.nodes.push(...affected);
          existing.advisories.push(advisory);
          const patched = advisory.patched_versions;
          if (patched && patched !== '<0.0.0') {
            existing.fixAvailable = true;
          }
          vulnerabilities[name] = existing;
        }
      }

      for (const vuln of Object.values(vulnerabilities)) {
        vuln.nodes = [...new Set(vuln.nodes)];
        vuln.via = vuln.via.filter((item, index, arr) => arr.findIndex(x => x.source === item.source) === index);
        vuln.advisories = vuln.advisories.filter((item, index, arr) => arr.findIndex(x => x.id === item.id) === index);
      }

      const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4, unknown: 0 };
      const minSeverity = String(options.auditLevel || 'low').toLowerCase();
      const minRank = severityRank[minSeverity] ?? 1;
      const count = Object.values(vulnerabilities).reduce((n, v) => n + v.nodes.length, 0);
      const metadata = {
        vulnerabilities: Object.keys(vulnerabilities).length,
        dependencies: Object.keys(body).length,
        vulnerableDependencies: count
      };

      const report = {
        auditReportVersion: 2,
        metadata,
        vulnerabilities,
        actions: []
      };

      if (!fix) {
        if (options.json) {
          this.output(JSON.stringify(report, null, 2));
        } else if (!Object.keys(vulnerabilities).length) {
          this.output('found 0 vulnerabilities');
        } else {
          this.output(`found ${count} vulnerable package${count === 1 ? '' : 's'}`);
          for (const vuln of Object.values(vulnerabilities)) {
            this.output(`  ${vuln.name} ${vuln.nodes.join(', ')} — ${vuln.severity}`);
            for (const advisory of vuln.via) {
              this.output(`    ${advisory.title}${advisory.url ? ` (${advisory.url})` : ''}`);
            }
          }
          const blocking = Object.values(vulnerabilities).filter(v => (severityRank[v.severity] ?? 0) >= minRank);
          if (blocking.length) this.output(`
npm audit found ${blocking.length} package${blocking.length === 1 ? '' : 's'} with severity ${minSeverity} or higher.`);
        }
        return report;
      }

      const changed = [];
      for (const vuln of Object.values(vulnerabilities)) {
        if (!vuln.isDirect) continue;
        const advisory = vuln.advisories[0];
        if (!advisory || !advisory.patched_versions || advisory.patched_versions === '<0.0.0') continue;
        const currentRange = direct[vuln.name];
        let targetRange = advisory.patched_versions;
        let targetVersion = null;
        try {
          const metadata = await this.fetchMetadata(vuln.name);
          const candidates = Object.keys(metadata.versions || {}).filter(v => {
            if (!parseVersion(v) || parseVersion(v).prerelease.length) return false;
            if (!versionSatisfies(v, targetRange)) return false;
            if (!options.force && !versionSatisfies(v, currentRange)) return false;
            return true;
          }).sort(compareVersions).reverse();
          targetVersion = candidates[0] || null;
        } catch (_) {}

        if (!targetVersion) continue;
        const group = groups.find(g => rootManifest[g] && Object.prototype.hasOwnProperty.call(rootManifest[g], vuln.name));
        if (!group) continue;
        const oldRange = rootManifest[group][vuln.name];
        rootManifest[group][vuln.name] = options.force ? `^${targetVersion}` : `^${targetVersion}`;
        changed.push({ name: vuln.name, from: oldRange, to: rootManifest[group][vuln.name], version: targetVersion, force: !!options.force });
      }

      if (!changed.length) {
        if (options.json) this.output(JSON.stringify(report, null, 2));
        else this.output('npm audit fix found no automatically fixable direct dependencies.');
        return report;
      }

      this.saveRootManifest(rootManifest);
      await this.install([]);
      report.actions = changed;
      if (options.json) this.output(JSON.stringify(report, null, 2));
      else {
        for (const action of changed) this.output(`updated ${action.name} to ${action.version}`);
        this.output('npm audit fix complete.');
      }
      return report;
    }

    async prune(options = {}) {
      const { manifest } = this.loadRootManifest();
      if (!manifest) return;
      const keep = new Set(Object.keys({ ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}), ...(manifest.optionalDependencies || {}) }));
      const nodeRoot = this.projectPath('node_modules').replace(/\/+$/, '');
      const packages = this.listInstalledPackages();
      for (const pkg of packages) {
        if (!pkg.relative.startsWith('node_modules/')) continue;
        const rel = pkg.relative.slice('node_modules/'.length);
        if (!rel.includes('/node_modules/') && !keep.has(rel)) {
          this.deleteTree(pkg.relative);
          if (!options.quiet) this.output(`removed extraneous ${rel}`);
        }
      }
    }

    listInstalledPackages() {
      const prefix = this.projectPath('node_modules').replace(/\/+$/, '') + '/';
      const result = [];
      for (const file of this.filesystem.listFilesSync()) {
        if (!file.startsWith(prefix) || !file.endsWith('/package.json')) continue;
        const absDir = file.slice(0, -'/package.json'.length);
        const relative = absDir.replace(this.rootfolder ? this.rootfolder + '/' : '', '');
        const text = this.readText(file);
        if (!text) continue;
        try {
          const manifest = JSON.parse(text);
          if (manifest.name && manifest.version) result.push({ relative, path: absDir, manifest });
        } catch (_) {}
      }
      return result;
    }

    async update(args) {
      this.ensureReady();
      const { manifest } = this.loadRootManifest();
      if (!manifest) throw new NpmError('Cannot update without package.json.');
      const requested = this.parseOptions(args).positionals;
      const groups = ['dependencies', 'devDependencies', 'optionalDependencies'];
      const targets = requested.length ? requested : groups.flatMap(group => Object.keys(manifest[group] || {}));
      for (const name of targets) {
        let range = null;
        for (const group of groups) {
          if (manifest[group] && manifest[group][name] != null) {
            range = manifest[group][name];
            break;
          }
        }
        if (!range) {
          this.warn(`npm WARN ${name} is not listed in package.json.`);
          continue;
        }
        const result = await this.installResolved(name, range, '', { force: true });
        this.output(`updated ${name}@${result.version}`);
      }
      await this.writeLockfile(manifest);
    }

    async view(args) {
      this.ensureReady();
      const spec = this.parseOptions(args).positionals[0];
      if (!spec) throw new NpmError('npm view requires a package name.');
      const parsed = parsePackageSpec(spec);
      if (parsed.type !== 'registry') throw new NpmError('npm view supports registry package names only.');
      const metadata = await this.fetchMetadata(parsed.name);
      const version = parsed.range && parsed.range !== 'latest' ? selectVersion(metadata, parsed.range) : metadata['dist-tags']?.latest;
      const manifest = metadata.versions?.[version];
      if (!manifest) throw new NpmError(`Version '${version}' was not found for '${parsed.name}'.`);
      this.output(JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        main: manifest.main,
        dependencies: manifest.dependencies || {},
        dist: manifest.dist || {}
      }, null, 2));
    }

    async init(args) {
      this.ensureReady();
      const { manifest } = this.loadRootManifest();
      if (manifest) {
        this.output('package.json already exists.');
        return;
      }
      const options = this.parseOptions(args);
      const name = options.positionals[0] || 'browser-project';
      const next = {
        name: name.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase(),
        version: '1.0.0',
        description: '',
        main: 'index.js',
        scripts: {},
        keywords: [],
        author: '',
        license: 'ISC'
      };
      this.saveRootManifest(next);
      this.output('Created package.json');
    }

    async ls() {
      this.ensureReady();
      const installed = this.listInstalledPackages();
      this.output(JSON.stringify(installed.map(p => ({ name: p.manifest.name, version: p.manifest.version, path: p.relative })), null, 2));
    }

    async ci(args) {
      this.ensureReady();
      const { manifest } = this.loadRootManifest();
      const lockText = this.readText(this.projectPath('package-lock.json'));
      if (!manifest || !lockText) throw new NpmError('npm ci requires package.json and package-lock.json.');
      let lock;
      try { lock = JSON.parse(lockText); } catch (_) { throw new NpmError('package-lock.json contains invalid JSON.', 'EBADLOCK'); }
      this.deleteTree('node_modules');
      const packages = lock.packages || {};
      const entries = Object.entries(packages).filter(([path]) => path && path.startsWith('node_modules/'));
      entries.sort((a, b) => a[0].split('/node_modules/').length - b[0].split('/node_modules/').length);
      for (const [relative, entry] of entries) {
        const marker = '/node_modules/';
        const idx = relative.lastIndexOf(marker);
        const parent = idx < 0 ? '' : relative.slice(0, idx).replace(/\/node_modules$/, '');
        const name = relative.slice(idx + marker.length);
        if (!name || name.includes('/node_modules/')) continue;
        const range = entry.version || '*';
        await this.installResolved(name, `=${range}`, parent, { force: true });
      }
      this.output(`npm ci complete (${entries.length} packages).`);
    }

    async writeLockfile(manifest) {
      const lock = {
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: manifest.name,
            version: manifest.version,
            private: !!manifest.private,
            dependencies: manifest.dependencies || {},
            devDependencies: manifest.devDependencies || {},
            optionalDependencies: manifest.optionalDependencies || {}
          }
        }
      };
      for (const pkg of this.listInstalledPackages()) {
        const rel = pkg.relative;
        const entry = {
          version: pkg.manifest.version,
          resolved: null,
          integrity: null
        };
        if (pkg.manifest.dependencies && Object.keys(pkg.manifest.dependencies).length) entry.dependencies = pkg.manifest.dependencies;
        if (pkg.manifest.optionalDependencies && Object.keys(pkg.manifest.optionalDependencies).length) entry.optionalDependencies = pkg.manifest.optionalDependencies;
        if (pkg.manifest.peerDependencies && Object.keys(pkg.manifest.peerDependencies).length) entry.peerDependencies = pkg.manifest.peerDependencies;
        lock.packages[rel] = entry;
      }

      for (const pkg of this.listInstalledPackages()) {
        const rel = pkg.relative;
        const text = this.readText(this.projectPath(joinPath(rel, 'package.json')));
        if (!text) continue;
        // Preserve registry resolution data when this package was fetched in this process.
        const live = [...this.tarballCache.keys()].find(() => false);
        void live;
      }

      // Attach exact registry resolution data recorded during installs.
      for (const [relativePath, record] of this.installRecords) {
        if (!lock.packages[relativePath]) continue;
        if (record.resolved) lock.packages[relativePath].resolved = record.resolved;
        if (record.integrity) lock.packages[relativePath].integrity = record.integrity;
      }

      this.writeText(this.projectPath('package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    }

    async runScript(name, args = []) {
      this.ensureReady();
      const manifestText = this.readText(this.projectPath('package.json'));
      if (!manifestText) throw new NpmError('Could not find package.json.', 'ENOENT');

      let manifest;
      try {
        manifest = JSON.parse(manifestText);
      } catch (_) {
        throw new NpmError('package.json contains invalid JSON.', 'EBADJSON');
      }

      const scripts = manifest && manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
      const scriptName = String(name || '').trim();
      if (!scriptName) {
        const names = Object.keys(scripts);
        if (!names.length) {
          this.output('Lifecycle scripts included in this package:');
          this.output('  (none)');
        } else {
          this.output('Lifecycle scripts included in this package:');
          for (const key of names) this.output(`  ${key}: ${scripts[key]}`);
        }
        return names;
      }

      if (typeof scripts[scriptName] !== 'string') {
        const names = Object.keys(scripts);
        const available = names.length ? ` Available scripts: ${names.join(', ')}` : '';
        throw new NpmError(`Missing script: "${scriptName}".${available}`, 'ESCRIPT');
      }

      if (typeof this.commandRunner !== 'function') {
        throw new NpmError('npm run cannot execute scripts because no command runner is attached.', 'ENORUNNER');
      }

      const lifecycle = [];
      if (scripts[`pre${scriptName}`]) lifecycle.push(`pre${scriptName}`);
      lifecycle.push(scriptName);
      if (scripts[`post${scriptName}`]) lifecycle.push(`post${scriptName}`);

      for (const lifecycleName of lifecycle) {
        const command = String(scripts[lifecycleName]).trim();
        this.output(`\n> ${manifest.name || ''}@${manifest.version || ''} ${lifecycleName}`.trimEnd());
        this.output(`> ${command}`);
        const suffix = lifecycleName === scriptName && args.length ? ' ' + args.map(String).map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ') : '';
        await this.commandRunner(command + suffix);
      }
    }

    parseOptions(args) {
      const options = {
        positionals: [],
        saveDev: false,
        saveExact: false,
        noSave: false,
        production: false,
        force: false,
        quiet: false,
        json: false,
        auditLevel: 'low',
        omitDev: false
      };
      const list = Array.isArray(args) ? args : splitCommand(args);
      for (let i = 0; i < list.length; i++) {
        const arg = list[i];
        if (arg === '--audit-level' && list[i + 1]) { options.auditLevel = list[++i]; continue; }
        if (arg === '--save-dev' || arg === '-D') options.saveDev = true;
        else if (arg === '--save-exact' || arg === '-E') options.saveExact = true;
        else if (arg === '--no-save') options.noSave = true;
        else if (arg === '--force' || arg === '-f') options.force = true;
        else if (arg === '--quiet' || arg === '-q') options.quiet = true;
        else if (arg === '--json') options.json = true;
        else if (arg === '--production' || arg === '--omit=dev') { options.production = true; options.omitDev = true; }
        else if (arg.startsWith('--audit-level=')) options.auditLevel = arg.slice('--audit-level='.length);
        else if (arg === '--legacy-peer-deps' || arg === '--ignore-scripts') {}
        else if (arg.startsWith('--')) {}
        else options.positionals.push(arg);
      }
      return options;
    }

    async run(command) {
      const args = typeof command === 'string' ? splitCommand(command) : command;
      const list = Array.isArray(args) ? args.slice() : [];
      if (list[0] === 'npm') list.shift();
      if (!list.length) {
        this.output('npm 1.0.0-browser');
        return;
      }

      const alias = { add: 'install', i: 'install', in: 'install', rm: 'uninstall', remove: 'uninstall', r: 'uninstall', up: 'update', li: 'ls', list: 'ls' };
      const commandName = alias[list[0]] || list[0];
      const commandArgs = list.slice(1);
      switch (commandName) {
        case 'run':
          return await this.runScript(commandArgs[0], commandArgs.slice(1).filter(arg => arg !== '--'));
        case 'install':
          return await this.install(commandArgs);
        case 'start':
          return await this.runScript('start', commandArgs.filter(arg => arg !== '--'));
        case 'uninstall':
          return await this.uninstall(commandArgs);
        case 'update':
          return await this.update(commandArgs);
        case 'view':
          return await this.view(commandArgs);
        case 'init':
          return await this.init(commandArgs);
        case 'ls':
          return await this.ls(commandArgs);
        case 'ci':
          return await this.ci(commandArgs);
        case 'prune':
          return await this.prune(commandArgs);
        case 'audit':
          if (commandArgs[0] === 'fix') return await this.audit(commandArgs.slice(1), true);
          return await this.audit(commandArgs, false);
        case '--version':
        case '-v':
          this.output('npm 1.0.0-browser');
          return;
        default:
          throw new NpmError(`Unknown command '${commandName}'. Supported commands: install, uninstall, update, init, view, ls, ci, prune, audit, run, start.`);
      }
    }
  }

  NPM.version = '1.0.0-browser';
  NPM.parsePackageSpec = parsePackageSpec;
  NPM.versionSatisfies = versionSatisfies;
  NPM.splitCommand = splitCommand;

  if (typeof window !== 'undefined') {
    window.NPM = NPM;
    window.npm = NPM;
  }
  if (typeof globalThis !== 'undefined' && !globalThis.NPM) globalThis.NPM = NPM;
})();

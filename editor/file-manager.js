(function () {
  class FileManager {
    constructor(options = {}) {
      this.fs = options.fs || null;
      this.tree = options.tree;
      this.contextMenu = options.contextMenu;
      this.fileInput = options.fileInput;
      this.onOpen = options.onOpen || (() => {});
      this.onSelection = options.onSelection || (() => {});
      this.onChange = options.onChange || (() => {});
      this.onMove = options.onMove || (() => {});
      this.onDelete = options.onDelete || (() => {});
      this.showHiddenFolders = !!options.showHiddenFolders;
      this.selectedNode = null;
      this.selectedNodes = new Set();
      this.selectionAnchor = null;
      this.collapsedPaths = new Set();
      this.projectName = options.projectName || (() => 'Workspace');
      this.root = {
        id: 'root',
        name: '',
        path: '',
        isDir: true,
        children: []
      };
      this.nodeByPath = new Map([['', this.root]]);
      this.nodeByID = new Map([['root', this.root]]);
      this.contextMenu?.addEventListener('click', e => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        e.stopPropagation();
        this.contextMenu.style.display = 'none';
        this.performContextAction(action).catch(err => this.report(err));
      });
      document.body.addEventListener('click', () => this.hideContextMenu());
      document.addEventListener('keydown', e => {
        if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
        if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const visible = this.visibleNodes();
          this.selectedNodes = new Set(visible.map(n => n.path));
          this.selectedNode = visible.at(-1) || null;
          this.selectionAnchor = this.selectedNode;
          this.updateSelectionUI();
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedNodes.size) {
          e.preventDefault();
          this.deleteSelected().catch(err => this.report(err));
        }
      });
      this.fileInput?.addEventListener('change', e => {
        const files = e.target.files;
        if (files?.length) this.uploadFiles(files, this.selectedNode || this.root).catch(err => this.report(err));
        e.target.value = '';
      });
    }
    setFileSystem(fs) {
      this.fs = fs;
      this.selectedNode = null;
      this.selectedNodes.clear();
      this.selectionAnchor = null;
      this.collapsedPaths.clear();
      this.buildTree();
    }
    setShowHiddenFolders(value) {
      this.showHiddenFolders = !!value;
      this.buildTree();
      this.render();
    }
    isHiddenPath(path) {
      return this.normalize(path).split('/').some(part => part.startsWith('.'));
    }
    setProjectName(name) {
      this.projectName = name || (() => 'Workspace');
      this.render();
    }
    report(err) {
      if (window.EditorApp?.logError) window.EditorApp.logError(err); else console.error(err);
    }
    normalize(path) {
      const parts = String(path ?? '').replace(/\\/g, '/').split('/');
      const out = [];
      for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') {
          out.pop();
          continue;
        }
        out.push(part);
      }
      return out.join('/');
    }
    pathBase(path) {
      path = this.normalize(path);
      const i = path.lastIndexOf('/');
      return i >= 0 ? path.slice(0, i) : '';
    }
    basename(path) {
      path = this.normalize(path);
      return path.slice(path.lastIndexOf('/') + 1);
    }
    targetBase(node) {
      const n = node || this.root;
      if (!n.path) return '';
      return n.isDir ? n.path : this.pathBase(n.path);
    }
    buildTree() {
      this.root.children = [];
      this.nodeByPath = new Map([['', this.root]]);
      this.nodeByID = new Map([['root', this.root]]);
      if (!this.fs) return;
      const addDir = (path, name, parent) => {
        let node = this.nodeByPath.get(path);
        if (node) return node;
        node = {
          id: crypto.randomUUID(),
          name,
          path,
          isDir: true,
          children: []
        };
        parent.children.push(node);
        this.nodeByPath.set(path, node);
        this.nodeByID.set(node.id, node);
        return node;
      };
      const addFile = (path, name, parent) => {
        if (name.toLowerCase().endsWith('.piskel') || name.toLowerCase() === 'preview-config.json') return;
        const node = {
          id: crypto.randomUUID(),
          name,
          path,
          isDir: false,
          mime: EditorInferMime(name)
        };
        parent.children.push(node);
        this.nodeByPath.set(path, node);
        this.nodeByID.set(node.id, node);
      };
      for (const raw of this.fs.listFilesSync().map(p => this.normalize(p)).filter(Boolean)) {
        if (!this.showHiddenFolders && this.isHiddenPath(raw)) continue;
        const parts = raw.split('/');
        let parent = this.root, current = '';
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          current = current ? current + '/' + part : part;
          if (i === parts.length - 1) addFile(current, part, parent); else parent = addDir(current, part, parent);
        }
      }
      for (const raw of (this.fs.listDirectoriesSync?.() || []).map(p => this.normalize(p)).filter(Boolean)) {
        if (!this.showHiddenFolders && this.isHiddenPath(raw)) continue;
        const parts = raw.split('/');
        let parent = this.root, current = '';
        for (const part of parts) {
          current = current ? current + '/' + part : part;
          parent = addDir(current, part, parent);
        }
      }
      this.sortTree(this.root);
    }
    sortTree(node) {
      node.children?.sort((a, b) => a.isDir !== b.isDir ? a.isDir ? -1 : 1 : a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base'
      }));
      node.children?.forEach(x => this.sortTree(x));
    }
    refresh() {
      this.buildTree();
      this.render();
      this.onChange();
    }
    render() {
      const container = this.tree;
      if (!container) return;
      container.innerHTML = '';
      container.appendChild(document.createTextNode(typeof this.projectName === 'function' ? this.projectName() : this.projectName || 'Workspace'));
      const buttons = document.createElement('span');
      buttons.id = 'treebuttons';
      buttons.innerHTML = `
  <button id="collapseall"><svg version="1.1" fill="lightgrey" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 122.88 113.03" style="enable-background:new 0 0 122.88 113.03" xml:space="preserve"><style type="text/css"><![CDATA[.col-st0{fill-rule:evenodd;clip-rule:evenodd;}]]></style><g><path class="col-st0" d="M36.9,23.5h71.13c8.17,0,14.85,6.69,14.85,14.85v59.83c0,8.17-6.69,14.85-14.85,14.85H36.9 c-8.17,0-14.85-6.68-14.85-14.85V38.35C22.05,30.19,28.73,23.5,36.9,23.5L36.9,23.5z M10.08,73.96c0,2.78-2.26,5.04-5.04,5.04 C2.26,79,0,76.74,0,73.96V19.89C0,14.42,2.24,9.44,5.84,5.84C9.44,2.24,14.42,0,19.89,0h65.37c2.78,0,5.04,2.26,5.04,5.04 c0,2.78-2.26,5.04-5.04,5.04H19.89c-2.69,0-5.15,1.1-6.93,2.88c-1.78,1.78-2.88,4.23-2.88,6.93V73.96L10.08,73.96z M54.3,74.03 c-3.18,0-5.76-2.58-5.76-5.76s2.58-5.76,5.76-5.76h36.34c3.18,0,5.76,2.58,5.76,5.76s-2.58,5.76-5.76,5.76H54.3L54.3,74.03z"/></g></svg><span class="tooltip">Collapse All</span></button>
  <button id="newfile"><svg xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision" text-rendering="geometricPrecision" image-rendering="optimizeQuality" fill-rule="evenodd" fill="lightgrey" clip-rule="evenodd" viewBox="0 0 441 512.02"><path d="M324.87 279.77c32.01 0 61.01 13.01 82.03 34.02 21.09 21 34.1 50.05 34.1 82.1 0 32.06-13.01 61.11-34.02 82.11l-1.32 1.22c-20.92 20.29-49.41 32.8-80.79 32.8-32.06 0-61.1-13.01-82.1-34.02-21.01-21-34.02-50.05-34.02-82.11s13.01-61.1 34.02-82.1c21-21.01 50.04-34.02 82.1-34.02zM243.11 38.08v54.18c.99 12.93 5.5 23.09 13.42 29.85 8.2 7.01 20.46 10.94 36.69 11.23l37.92-.04-88.03-95.22zm91.21 120.49-41.3-.04c-22.49-.35-40.21-6.4-52.9-17.24-13.23-11.31-20.68-27.35-22.19-47.23l-.11-1.74V25.29H62.87c-10.34 0-19.75 4.23-26.55 11.03-6.8 6.8-11.03 16.21-11.03 26.55v336.49c0 10.3 4.25 19.71 11.06 26.52 6.8 6.8 16.22 11.05 26.52 11.05h119.41c2.54 8.79 5.87 17.25 9.92 25.29H62.87c-17.28 0-33.02-7.08-44.41-18.46C7.08 432.37 0 416.64 0 399.36V62.87c0-17.26 7.08-32.98 18.45-44.36C29.89 7.08 45.61 0 62.87 0h173.88c4.11 0 7.76 1.96 10.07 5l109.39 118.34c2.24 2.43 3.34 5.49 3.34 8.55l.03 119.72c-8.18-1.97-16.62-3.25-25.26-3.79v-89.25zm-229.76 54.49c-6.98 0-12.64-5.66-12.64-12.64 0-6.99 5.66-12.65 12.64-12.65h150.49c6.98 0 12.65 5.66 12.65 12.65 0 6.98-5.67 12.64-12.65 12.64H104.56zm0 72.3c-6.98 0-12.64-5.66-12.64-12.65 0-6.98 5.66-12.64 12.64-12.64h142.52c3.71 0 7.05 1.6 9.37 4.15a149.03 149.03 0 0 0-30.54 21.14H104.56zm0 72.3c-6.98 0-12.64-5.66-12.64-12.65 0-6.98 5.66-12.64 12.64-12.64h86.2c-3.82 8.05-6.95 16.51-9.29 25.29h-76.91zm277.27 25.48v22.18c0 4.32-3.66 7.97-7.98 7.97h-29.9v29.91c0 4.33-3.65 7.97-7.98 7.97h-22.18c-4.33 0-7.98-3.59-7.98-7.97v-29.91H275.9c-4.32 0-7.97-3.59-7.97-7.97v-22.18c0-4.38 3.59-7.97 7.97-7.97h29.91v-29.91c0-4.39 3.59-7.97 7.98-7.97h22.18c4.39 0 7.98 3.64 7.98 7.97v29.91h29.9c4.39 0 7.98 3.7 7.98 7.97z"/></svg><span class="tooltip">New File</span></button>
  <button id="newfolder"><svg version="1.1" fill="lightgrey" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 122.879 103.39" enable-background="new 0 0 122.879 103.39" xml:space="preserve"><g><path d="M2.971,18.676l3.314-0.001v-8.14c0-0.817,0.334-1.561,0.87-2.098c0.541-0.539,1.284-0.873,2.102-0.873h3.233V2.971 c0-0.817,0.333-1.561,0.869-2.098C13.899,0.333,14.643,0,15.46,0h36.251c0.817,0,1.561,0.333,2.099,0.872 c0.539,0.535,0.873,1.278,0.873,2.099v4.593h48.155c0.821,0,1.565,0.333,2.101,0.869c0.537,0.537,0.87,1.281,0.87,2.102v8.14h3.342 c0.82,0,1.564,0.334,2.101,0.87c0.536,0.537,0.87,1.281,0.87,2.102c-0.015,0.238-0.023,0.355-0.065,0.585l-3.188,23.435 c8.447,5.653,14.011,15.282,14.011,26.209c0,17.404-14.109,31.515-31.515,31.515c-11.842,0-22.157-6.534-27.542-16.192H13.975 c-1.043,0-2.024-0.206-2.918-0.578c-0.937-0.39-1.776-0.965-2.49-1.673c-0.695-0.691-1.267-1.52-1.691-2.434 c-0.42-0.904-0.697-1.896-0.809-2.928l-6.051-57.63c-0.084-0.812,0.17-1.586,0.65-2.175c0.477-0.588,1.182-0.998,1.997-1.08 L2.971,18.676L2.971,18.676z M105.931,67.26h-0.004l-0.003-0.001h-0.003l-0.003-0.001h-0.002h-0.002h-0.004l-0.003-0.001h-0.003 l-0.003-0.001h-0.004h-0.003l-0.004-0.001h-0.003l-0.003-0.001h-0.004h-0.003h-0.001h-0.003l-0.003-0.001h-0.003l-0.004-0.001 h-0.003h-0.004l-0.003-0.001h-0.003h-0.004h-0.003l-0.004-0.001h-0.003h-0.001h-0.003l-0.003-0.001h-0.003h-0.004h-0.003h-0.004 l-0.003-0.001h-0.003h-0.004h-0.003l-0.004-0.001h-0.003h-0.001h-0.003h-0.003h-0.003h-0.004h-0.003l-0.004-0.001h-0.003h-0.004 h-0.003h-0.004h-0.003h-0.004l0,0h-0.003l-0.004-0.001h-0.003h-0.003h-0.004h-0.007h-0.003h-0.004h-0.003h-0.004h-0.003h-5.77 h-3.953v-9.723c0-0.862-0.706-1.571-1.571-1.571h-6.116c-0.862,0-1.572,0.709-1.572,1.571v9.723h-9.723l0,0 c-0.862,0-1.571,0.709-1.571,1.575v6.112c0,0.866,0.709,1.575,1.571,1.572h9.727v4.76v4.963v0.017v0.017v0.007l0.001,0.011v0.017 l0.001,0.013v0.005l0.001,0.017l0.001,0.017v0.002l0.002,0.015l0.001,0.017l0.001,0.008l0.001,0.01l0.002,0.016l0.002,0.014v0.004 l0.002,0.016l0.003,0.017v0.003l0.003,0.014l0.002,0.017l0.002,0.009l0.001,0.007l0.004,0.017l0.002,0.015l0.001,0.002l0.004,0.016 l0.003,0.017l0.001,0.004l0.003,0.012l0.004,0.016l0.003,0.011l0.001,0.006l0.005,0.016l0.004,0.016l0.005,0.016l0.005,0.016 l0.001,0.006l0.004,0.01l0.005,0.016l0.004,0.011l0.001,0.005l0.006,0.016l0.006,0.015v0.002l0.005,0.014l0.006,0.015l0.003,0.007 l0.004,0.009l0.006,0.015l0.005,0.013l0.001,0.003l0.007,0.015l0.007,0.015l0.001,0.002l0.006,0.013l0.007,0.015l0.003,0.008 l0.004,0.007l0.007,0.015l0.007,0.013l0.001,0.001l0.007,0.015l0.008,0.014l0.002,0.004l0.006,0.011l0.008,0.014l0.005,0.009 l0.003,0.005l0.009,0.015l0.008,0.013l0.009,0.015l0.009,0.014l0.003,0.004l0.006,0.009l0.009,0.014l0.006,0.01l0.003,0.004 l0.009,0.013l0.01,0.014v0.001l0.009,0.012l0.01,0.013l0.004,0.006l0.006,0.007l0.01,0.013l0.008,0.011l0.002,0.002 c0.289,0.365,0.735,0.602,1.232,0.602h6.113c0.497,0,0.944-0.235,1.233-0.602l0.001-0.001l0.009-0.012l0.01-0.013l0.004-0.005 l0.006-0.008l0.009-0.013l0.008-0.011l0.002-0.002l0.009-0.014l0.01-0.013l0.001-0.003l0.008-0.011l0.009-0.013l0.009-0.014 l0.008-0.014l0.009-0.013V87.04l0.009-0.014l0.008-0.014l0.002-0.004l0.006-0.011l0.008-0.014l0.005-0.009l0.003-0.005l0.008-0.015 l0.007-0.014l0.001-0.001l0.007-0.014l0.007-0.015l0.003-0.006l0.004-0.009l0.007-0.015l0.006-0.011l0.001-0.004l0.007-0.015 l0.002-0.003l0.01-0.024l0.001-0.002l0.006-0.016l0.003-0.007l0.003-0.008l0.006-0.016l0.005-0.013l0.001-0.002l0.006-0.016 l0.005-0.016l0.002-0.003l0.004-0.012l0.005-0.016l0.003-0.01l0.002-0.006l0.005-0.016l0.004-0.016h0.001l0.004-0.016l0.004-0.017 l0.002-0.005l0.003-0.011l0.004-0.016l0.002-0.012l0.001-0.005l0.004-0.016l0.004-0.017v-0.001l0.003-0.015l0.003-0.017 l0.001-0.007l0.002-0.01l0.003-0.016l0.002-0.014l0.001-0.003l0.002-0.017l0.002-0.017l0.001-0.003l0.001-0.014l0.002-0.017 l0.001-0.009l0.001-0.008l0.002-0.017l0.001-0.016v-0.002l0.001-0.017l0.001-0.017l0.001-0.005v-0.013l0.001-0.017v-0.011 l0.001-0.006v-0.018v-0.017v-4.963v-4.76h2.694h5.984h1.044c0.862,0,1.571-0.71,1.571-1.572v-6.116 C107.288,68.026,106.696,67.365,105.931,67.26L105.931,67.26z M103.285,42.696l2.456-18.061L9.143,24.626H6.265l5.706,54.375 c0.037,0.351,0.126,0.683,0.259,0.979s0.311,0.561,0.521,0.775c0.164,0.162,0.354,0.293,0.562,0.379l0.037,0.018 c0.186,0.072,0.393,0.112,0.617,0.112h47.306c-0.924-2.966-1.422-6.119-1.422-9.39c0-17.405,14.11-31.515,31.515-31.515 C95.584,40.36,99.608,41.191,103.285,42.696L103.285,42.696z M12.227,13.515v5.147l87.64-0.93v-4.218H51.711 c-0.821,0-1.564-0.333-2.102-0.871c-0.536-0.536-0.87-1.28-0.87-2.1V5.951h-30.31v4.593c0,0.816-0.333,1.559-0.87,2.097 c-0.543,0.542-1.285,0.874-2.101,0.874H12.227L12.227,13.515z"/></g></svg><span class="tooltip">New Folder</span></button>
    `;
      container.appendChild(buttons);
      const rootList = this.renderNode(this.root);
      rootList.classList.add('file-tree-root');
      container.appendChild(rootList);
      rootList.ondragover = e => {
        if (e.target.closest?.('li[data-path]')) return;
        e.preventDefault();
        rootList.classList.add('draghover');
        e.dataTransfer.dropEffect = 'move';
      };
      rootList.ondragleave = e => {
        if (!rootList.contains(e.relatedTarget)) rootList.classList.remove('draghover');
      };
      rootList.ondrop = e => {
        if (e.target.closest?.('li[data-path]')) return;
        e.preventDefault();
        e.stopPropagation();
        rootList.classList.remove('draghover');
        const raw = e.dataTransfer.getData('application/x-file-manager-paths') || e.dataTransfer.getData('text/plain');
        if (!raw) return;
        let paths;
        try { paths = JSON.parse(raw); } catch (_) { paths = [raw]; }
        this.handleMoveMany(paths, this.root).catch(err => this.report(err));
      };
      buttons.querySelector('#collapseall').onclick = () => this.collapseAll();
      buttons.querySelector('#newfile').onclick = () => this.createFile(this.selectedNode || this.root);
      buttons.querySelector('#newfolder').onclick = () => this.createFolder(this.selectedNode || this.root);
      container.oncontextmenu = e => {
        e.preventDefault();
        e.stopPropagation();
        const li = e.target.closest?.('li[data-path]');
        if (li && container.contains(li)) {
          const node = this.nodeByPath.get(li.dataset.path);
          if (node) {
            if (!this.selectedNodes.has(node.path)) this.select(node, {preserve:true});
            this.showContextMenu(e.clientX, e.clientY);
            return;
          }
        }
        this.clearSelection();
        this.showContextMenu(e.clientX, e.clientY);
      };
      container.ondragover = e => {
        e.preventDefault();
        const li = e.target.closest?.('li[data-path]');
        li?.classList.add('draghover');
        container.classList.add('draghover');
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-proxy-download') || e.dataTransfer.files?.length ? 'copy' : 'move';
      };
      container.ondragleave = e => {
        const related = e.relatedTarget;
        if (!related || !container.contains(related)) {
          container.classList.remove('draghover');
          container.querySelectorAll('.draghover').forEach(el => el.classList.remove('draghover'));
        }
      };
      container.ondrop = e => {
        e.preventDefault();
        container.classList.remove('draghover');
        container.querySelectorAll('.draghover').forEach(el => el.classList.remove('draghover'));
        const targetLi = e.target.closest?.('li[data-path]');
        const targetNode = targetLi ? this.nodeByPath.get(targetLi.dataset.path) || this.root : this.root;
        const browserToken = e.dataTransfer.getData('application/x-proxy-download');
        if (browserToken) {
          try {
            const file = window.__editorFileDropBridge?.take?.(browserToken);
            if (file) return this.uploadFiles([file], targetNode).catch(err => this.report(err));
          } catch (err) {
            this.report(err);
            return;
          }
        }
        const files = e.dataTransfer.files;
        if (files.length) return this.uploadFiles(files, targetNode).catch(err => this.report(err));
        const raw = e.dataTransfer.getData('application/x-file-manager-paths') || e.dataTransfer.getData('text/plain');
        if (raw) {
          let paths;
          try { paths = JSON.parse(raw); } catch (_) { paths = [raw]; }
          this.handleMoveMany(paths, targetNode).catch(err => this.report(err));
        }
      };
    }
    renderNode(node) {
      const ul = document.createElement('ul');
      for (const child of node.children) {
        const li = document.createElement('li');
        li.dataset.path = child.path;
        li.innerHTML = EditorRenderIcon(child.name, child.isDir);
        if (child.isDir) {
          const arrow = document.createElement('span');
          arrow.textContent = '▼';
          arrow.className = 'arrow';
          if (this.collapsedPaths.has(child.path)) {
            li.classList.add('collapsed');
            arrow.textContent = '▶';
          }
          arrow.onclick = e => {
            e.stopPropagation();
            const collapsed = li.classList.toggle('collapsed');
            if (collapsed) this.collapsedPaths.add(child.path);
            else this.collapsedPaths.delete(child.path);
            arrow.textContent = collapsed ? '▶' : '▼';
          };
          li.prepend(arrow);
        }
        li.appendChild(document.createTextNode(child.name + (child.isDir ? '/' : '')));
        if (this.selectedNodes.has(child.path)) li.classList.add('selected-file');
        li.onclick = e => {
          e.stopPropagation();
          this.handleSelectionClick(child, e);
          if (!child.isDir && !e.shiftKey && !(e.ctrlKey || e.metaKey)) this.onOpen(child.path);
        };
        li.ondblclick = e => {
          if (child.isDir) {
            e.stopPropagation();
            const arrow = li.querySelector('.arrow');
            const collapsed = li.classList.toggle('collapsed');
            if (collapsed) this.collapsedPaths.add(child.path);
            else this.collapsedPaths.delete(child.path);
            if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
          }
        };
        li.oncontextmenu = e => {
          if (e.target !== li) return;
          e.preventDefault();
          e.stopPropagation();
          if (!this.selectedNodes.has(child.path)) this.select(child, {preserve:true});
          this.showContextMenu(e.clientX, e.clientY);
        };
        li.draggable = true;
        li.ondragstart = e => {
          if (!this.selectedNodes.has(child.path)) this.select(child);
          const paths = [...this.selectedNodes];
          e.dataTransfer.setData('text/plain', JSON.stringify(paths));
          e.dataTransfer.setData('application/x-file-manager-paths', JSON.stringify(paths));
          e.dataTransfer.effectAllowed = 'move';
          li.classList.add('dragging');
        };
        li.ondragend = () => li.classList.remove('dragging');
        li.ondragover = e => {
          e.preventDefault();
          li.classList.add('draghover');
        };
        li.ondragleave = () => li.classList.remove('draghover');
        li.ondrop = e => {
          e.preventDefault();
          li.classList.remove('draghover');
          const browserToken = e.dataTransfer.getData('application/x-proxy-download');
          if (browserToken) {
            try {
              const file = window.__editorFileDropBridge?.take?.(browserToken);
              if (file) {
                const destination = child.isDir ? child : this.nodeByPath.get(this.pathBase(child.path)) || this.root;
                return this.uploadFiles([file], destination).catch(err => this.report(err));
              }
            } catch (err) {
              this.report(err);
              return;
            }
          }
          const raw = e.dataTransfer.getData('application/x-file-manager-paths') || e.dataTransfer.getData('text/plain');
          if (raw) {
            let paths;
            try { paths = JSON.parse(raw); } catch (_) { paths = [raw]; }
            this.handleMoveMany(paths, child).catch(err => this.report(err));
          }
        };
        if (child.isDir) li.appendChild(this.renderNode(child));
        ul.appendChild(li);
      }
      return ul;
    }
    visibleNodes() {
      return [...this.tree.querySelectorAll('li[data-path]')]
        .filter(li => li.offsetParent !== null)
        .map(li => this.nodeByPath.get(li.dataset.path))
        .filter(Boolean);
    }
    handleSelectionClick(node, e) {
      const multi = e.ctrlKey || e.metaKey;
      if (e.shiftKey) {
        const visible = this.visibleNodes();
        const anchor = this.selectionAnchor || this.selectedNode || node;
        const a = visible.findIndex(n => n.path === anchor.path);
        const b = visible.findIndex(n => n.path === node.path);
        if (a < 0 || b < 0) return this.select(node);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        this.selectedNodes.clear();
        for (const n of visible.slice(lo, hi + 1)) this.selectedNodes.add(n.path);
        this.selectedNode = node;
      } else if (multi) {
        if (this.selectedNodes.has(node.path)) {
          this.selectedNodes.delete(node.path);
          this.selectedNode = this.selectedNodes.size ? this.nodeByPath.get([...this.selectedNodes].at(-1)) : null;
        } else {
          this.selectedNodes.add(node.path);
          this.selectedNode = node;
        }
        this.selectionAnchor = node;
      } else {
        this.select(node);
      }
      this.updateSelectionUI();
    }
    updateSelectionUI() {
      this.tree.querySelectorAll('li[data-path]').forEach(li => {
        li.classList.toggle('selected-file', this.selectedNodes.has(li.dataset.path));
      });
      this.onSelection(this.selectedNode, [...this.selectedNodes].map(p => this.nodeByPath.get(p)).filter(Boolean));
    }
    clearSelection() {
      this.selectedNode = null;
      this.selectedNodes.clear();
      this.selectionAnchor = null;
      this.updateSelectionUI();
    }
    select(node, options = {}) {
      if (!node) return this.clearSelection();
      if (!options.preserve) this.selectedNodes.clear();
      this.selectedNodes.add(node.path);
      this.selectedNode = node;
      this.selectionAnchor = node;
      this.updateSelectionUI();
    }
    collapseAll() {
      this.collapsedPaths.clear();
      this.tree.querySelectorAll('li[data-path]:has(.arrow)').forEach(li => {
        this.collapsedPaths.add(li.dataset.path);
        li.classList.add('collapsed');
        const a = li.querySelector('.arrow');
        if (a) a.textContent = '▶';
      });
    }
    showContextMenu(x, y) {
      if (!this.contextMenu) return;
      this.contextMenu.innerHTML = '<ul></ul>';
      const ul = this.contextMenu.firstChild, n = this.selectedNode, selected = [...this.selectedNodes].map(p => this.nodeByPath.get(p)).filter(Boolean), items = [];
      if (n) {
        if (selected.length > 1) items.push(['delete', `Delete ${selected.length} Items`], ['duplicate', `Duplicate ${selected.length} Items`]);
        else items.push(['rename', 'Rename'], ['delete', 'Delete']);
        if (n.isDir) items.push(['flatten', 'Flatten']); else items.push(['copyFile', 'Copy'], ['download', 'Download']);
      }
      items.push(['newFile', 'New File'], ['newFolder', 'New Folder'], ['upload', 'Upload File']);
      for (const [action, label] of items) {
        const li = document.createElement('li');
        li.dataset.action = action;
        li.textContent = label;
        ul.appendChild(li);
      }
      this.contextMenu.style.left = Math.min(x, innerWidth - (this.contextMenu.offsetWidth || 180) - 8) + 'px';
      this.contextMenu.style.top = Math.min(y, innerHeight - (this.contextMenu.offsetHeight || 200) - 8) + 'px';
      this.contextMenu.style.display = 'block';
    }
    hideContextMenu() {
      if (this.contextMenu) this.contextMenu.style.display = 'none';
    }
    async performContextAction(action) {
      const n = this.selectedNode || this.root;
      switch (action) {
        case 'rename':
          if (n === this.root) return;
          this.beginInlineRename(n);
          break;
        case 'delete':
          await this.deleteSelected();
          break;
        case 'duplicate':
          await this.duplicateSelected();
          break;
        case 'flatten':
          await this.flattenNode(n);
          break;
        case 'copyFile':
          {
            const ext = n.name.includes('.') ? '.' + n.name.split('.').pop() : '';
            const stem = ext ? n.name.slice(0, -ext.length) : n.name;
            let i = 1, name;
            do {
              name = `${stem} (${i++})${ext}`;
            } while (this.fs.existsSync((this.targetBase(n) ? this.targetBase(n) + '/' : '') + name));
            await this.copyNode(n, name);
            break;
          }
        case 'download':
          await this.downloadNode(n);
          break;
        case 'newFile':
          await this.createFile(n);
          break;
        case 'newFolder':
          await this.createFolder(n);
          break;
        case 'upload':
          this.fileInput?.click();
          break;
      }
    }
    beginInlineName(kind, parentNode) {
      const target = parentNode?.isDir ? parentNode : (parentNode ? this.nodeByPath.get(this.pathBase(parentNode.path)) : this.root) || this.root;
      const base = this.targetBase(target);
      let host = target === this.root ? this.tree : [...this.tree.querySelectorAll('li[data-path]')].find(li => li.dataset.path === target.path);
      if (host && target !== this.root && host.classList.contains('collapsed')) {
        host.classList.remove('collapsed');
        this.collapsedPaths.delete(target.path);
        const arrow = host.querySelector('.arrow');
        if (arrow) arrow.textContent = '▼';
      }
      if (!host) host = this.tree;
      const old = this.tree.querySelector('.tree-inline-name');
      old?.remove();
      const row = document.createElement('li');
      row.className = 'tree-inline-name';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tree-inline-input';
      input.placeholder = kind === 'file' ? 'File name' : 'Folder name';
      row.appendChild(input);
      const list = target === this.root ? host.querySelector('ul') : host.querySelector(':scope > ul');
      if (list) list.insertBefore(row, list.firstChild);
      else host.appendChild(row);
      const finish = async (commit) => {
        if (row.dataset.done) return;
        row.dataset.done = '1';
        const value = input.value.trim();
        row.remove();
        if (!commit || !value) return;
        try {
          if (kind === 'file') await this.createFile(target, value);
          else await this.createFolder(target, value);
        } catch (err) {
          this.report(err);
        }
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(!!input.value.trim()));
      input.focus();
      input.select();
    }
    beginInlineRename(node) {
      const li = [...this.tree.querySelectorAll('li[data-path]')].find(x => x.dataset.path === node.path);
      if (!li) return;
      const old = this.tree.querySelector('.tree-inline-name');
      old?.remove();
      const children = [...li.childNodes];
      const textNode = children.reverse().find(x => x.nodeType === Node.TEXT_NODE);
      if (!textNode) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tree-inline-input';
      input.value = node.name;
      textNode.replaceWith(input);
      li.classList.add('tree-inline-name');
      const finish = async (commit) => {
        if (input.dataset.done) return;
        input.dataset.done = '1';
        const value = input.value.trim();
        if (commit && value && value !== node.name) {
          try { await this.renameNode(node, value); return; }
          catch (err) { this.report(err); }
        }
        input.replaceWith(document.createTextNode(node.name + (node.isDir ? '/' : '')));
        li.classList.remove('tree-inline-name');
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(!!input.value.trim()));
      input.focus();
      input.select();
    }
    async createFile(parentNode, name) {
      if (!name) return this.beginInlineName('file', parentNode);
      const given = String(name).trim();
      if (!given) return;
      const base = this.targetBase(parentNode), path = base ? base + '/' + given : given;
      if (this.fs.existsSync(path)) throw new Error('File already exists: ' + path);
      this.fs.writeFileSync(path, '');
      this.refresh();
      const node = this.nodeByPath.get(path);
      if (node) {
        this.select(node);
        this.onOpen(path);
        this.reveal(path);
      }
    }
    async createFolder(parentNode, name) {
      if (!name) return this.beginInlineName('folder', parentNode);
      const given = String(name).trim();
      if (!given) return;
      const base = this.targetBase(parentNode), path = base ? base + '/' + given : given;
      if (this.fs.isDirectorySync?.(path)) throw new Error('Folder already exists: ' + path);
      this.fs.mkdirSync(path);
      this.refresh();
      this.reveal(path);
    }
    reveal(path) {
      path = this.normalize(path);
      const parts = path.split('/');
      let current = '';
      for (let i = 0; i < parts.length - 1; i++) {
        current = current ? current + '/' + parts[i] : parts[i];
        const li = [...this.tree.querySelectorAll('li[data-path]')].find(x => x.dataset.path === current);
        if (!li) continue;
        li.classList.remove('collapsed');
        this.collapsedPaths.delete(current);
        const a = li.querySelector('.arrow');
        if (a) a.textContent = '▼';
      }
      const target = [...this.tree.querySelectorAll('li[data-path]')].find(x => x.dataset.path === path);
      target?.scrollIntoView?.({block:'nearest'});
    }
    async uploadFiles(files, dstNode) {
      const base = this.targetBase(dstNode);
      for (const file of files) {
        const path = base ? base + '/' + file.name : file.name;
        this.fs.writeFileSync(path, new Uint8Array(await file.arrayBuffer()));
      }
      this.refresh();
      const last = files?.[files.length - 1];
      if (last) this.reveal((base ? base + '/' : '') + last.name);
    }
    async copyNode(node, copyName) {
      const base = this.targetBase(node), newPath = base ? base + '/' + copyName : copyName;
      if (node.isDir) {
        this.fs.mkdirSync(newPath);
        const prefix = node.path + '/';
        for (const p of this.fs.listFilesSync()) if (p.startsWith(prefix)) await this.copyFile(p, newPath + p.slice(node.path.length));
      } else await this.copyFile(node.path, newPath);
      this.refresh();
    }
    async copyFile(oldPath, newPath) {
      if (!this.fs.existsSync(oldPath)) return;
      this.fs.writeFileSync(newPath, this.fs.readFileSync(oldPath, 'binary'));
    }
    async moveFile(oldPath, newPath) {
      if (this.fs.existsSync(newPath) && !confirm('File ' + newPath + ' already exists. Replace it?')) return;
      await this.copyFile(oldPath, newPath);
      this.fs.deleteFileSync(oldPath);
    }
    async movePath(oldPath, newPath, isDir = false) {
      oldPath = this.normalize(oldPath);
      newPath = this.normalize(newPath);
      if (oldPath === newPath) return;
      if (newPath.startsWith(oldPath + '/')) return;
      const collapsed = [...this.collapsedPaths].filter(p => p === oldPath || p.startsWith(oldPath + '/'));
      for (const p of collapsed) this.collapsedPaths.delete(p);
      if (isDir) {
        this.fs.mkdirSync(newPath);
        const files = this.fs.listFilesSync().filter(p => p === oldPath || p.startsWith(oldPath + '/'));
        for (const p of files) await this.copyFile(p, newPath + p.slice(oldPath.length));
        for (const p of files) this.fs.deleteFileSync(p);
        this.fs.deleteDirectorySync?.(oldPath);
      } else {
        await this.moveFile(oldPath, newPath);
        if (this.fs.existsSync(oldPath + '.piskel')) await this.moveFile(oldPath + '.piskel', newPath + '.piskel');
      }
      for (const p of collapsed) this.collapsedPaths.add(newPath + p.slice(oldPath.length));
      this.refresh();
      this.reveal(newPath);
      this.onMove(oldPath, newPath, isDir);
    }
    async renameNode(node, name) {
      const parent = this.pathBase(node.path), newPath = parent ? parent + '/' + name : name;
      if (this.normalize(newPath) === this.normalize(node.path)) return;
      if (this.fs.existsSync(newPath)) throw new Error('A file or folder already exists: ' + newPath);
      await this.movePath(node.path, newPath, node.isDir);
      this.reveal(newPath);
    }
    async deleteNode(node) {
      if (node === this.root) return;
      if (!confirm(`Are you sure you want to delete ${node.path}? This action is permanent.`)) return;
      const old = node.path;
      const isDir = node.isDir;
      if (isDir) this.fs.deleteDirectorySync?.(old); else {
        this.fs.deleteFileSync(old);
        if (this.fs.existsSync(old + '.piskel')) this.fs.deleteFileSync(old + '.piskel');
      }
      this.refresh();
      this.onDelete(old, isDir);
    }
    async deleteSelected() {
      const nodes = [...this.selectedNodes].map(p => this.nodeByPath.get(p)).filter(n => n && n !== this.root);
      if (!nodes.length) return;
      if (!confirm(`Are you sure you want to delete ${nodes.length} selected item${nodes.length === 1 ? '' : 's'}? This action is permanent.`)) return;
      for (const node of nodes.sort((a,b) => b.path.length - a.path.length)) {
        if (!this.nodeByPath.has(node.path)) continue;
        if (node.isDir) this.fs.deleteDirectorySync?.(node.path);
        else {
          this.fs.deleteFileSync(node.path);
          if (this.fs.existsSync(node.path + '.piskel')) this.fs.deleteFileSync(node.path + '.piskel');
        }
        this.onDelete(node.path, node.isDir);
      }
      this.clearSelection();
      this.refresh();
    }
    async duplicateSelected() {
      const nodes = [...this.selectedNodes].map(p => this.nodeByPath.get(p)).filter(Boolean);
      for (const node of nodes) {
        const ext = !node.isDir && node.name.includes('.') ? '.' + node.name.split('.').pop() : '';
        const stem = ext ? node.name.slice(0, -ext.length) : node.name;
        let i = 1, name;
        do { name = `${stem} (${i++})${ext}`; }
        while (this.fs.existsSync((this.targetBase(node) ? this.targetBase(node) + '/' : '') + name));
        await this.copyNode(node, name);
      }
      this.refresh();
    }
    async handleMoveMany(paths, dstNode) {
      const unique = [...new Set(paths)].map(p => this.nodeByPath.get(p)).filter(Boolean);
      const targetBase = this.targetBase(dstNode);
      const moving = new Set(unique.map(n => n.path));
      for (const node of unique) {
        if (node === dstNode || (dstNode?.path && dstNode.path.startsWith(node.path + '/'))) continue;
        const newPath = targetBase ? targetBase + '/' + node.name : node.name;
        if (moving.has(newPath)) continue;
        await this.movePath(node.path, newPath, node.isDir);
      }
      this.clearSelection();
    }
    async flattenNode(node) {
      if (!node.isDir) return;
      if (!confirm(`Are you sure you want to flatten ${node.path}?`)) return;
      const parent = this.pathBase(node.path), base = parent ? parent + '/' : '', files = this.fs.listFilesSync().filter(p => p.startsWith(node.path + '/'));
      for (const p of files) {
        const rel = p.slice(node.path.length + 1);
        await this.moveFile(p, base + rel);
      }
      this.fs.deleteDirectorySync?.(node.path);
      this.refresh();
      this.onDelete(node.path, true);
    }
    async downloadNode(node) {
      if (node.isDir) return;
      const data = this.fs.readFileSync(node.path, 'binary');
      const url = URL.createObjectURL(new Blob([data], {
        type: node.mime || 'application/octet-stream'
      }));
      const a = document.createElement('a');
      a.href = url;
      a.download = node.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async handleMove(srcPath, dstNode) {
      const src = this.nodeByPath.get(srcPath);
      if (!src) return;
      const base = this.targetBase(dstNode), newPath = base ? base + '/' + this.basename(src.path) : this.basename(src.path);
      if (newPath.startsWith(src.path + '/')) return;
      await this.movePath(src.path, newPath, src.isDir);
    }
  }
  window.FileManager = FileManager;
})();

  class EditorFileView {
    constructor(options = {}) {
      this.state = options.state;
      this.host = options.host;
      this.viewTabs = options.viewTabs;
      this.fileNode = options.fileNode;
      this.current = null;
      this.model = null;
      this.ignoreModelChange = false;
    }
    clear() {
      this.host.innerHTML = '';
      this.current = null;
      this.model = null;
      this.viewTabs.innerHTML = '';
    }
    async open(node) {
      if (this.model) {
        this.model.dispose();
        this.model = null;
      }
      if (this.state.editor) this.state.editor.setModel(null);
      this.fileNode = node;
      this.buildModes();
      await this.activate(this.getDefaultMode());
    }
    getMime() {
      return this.fileNode?.mime || EditorInferMime(this.fileNode?.name || '');
    }
    getModes() {
      const m = this.getMime(), name = this.fileNode?.name || '';
      const modes = [];
      if (m.startsWith('image/')) modes.push('Preview'); else if (m.startsWith('audio/') || m.startsWith('video/')) modes.push('Preview'); else if (m === 'text/markdown') modes.push('Preview');
      if (m.startsWith('text/') || ['application/json', 'application/javascript', 'application/typescript', 'application/xml', 'model/gltf+json'].includes(m)) modes.push('Edit');
      if (m === 'image/svg+xml') modes.push('Edit');
      if (!modes.length) modes.push('Preview');
      if (this.isRawCapable()) modes.push('Raw');
      return [...new Set(modes)];
    }
    isRawCapable() {
      const m = this.getMime();
      return m.startsWith('text/') || ['application/json', 'application/javascript', 'application/typescript', 'application/xml', 'model/gltf+json', 'image/svg+xml'].includes(m);
    }
    getDefaultMode() {
      const modes = this.getModes();
      if (this.getMime() === 'text/markdown') return modes.includes('Preview') ? 'Preview' : modes[0];
      if (this.getMime().startsWith('image/') || this.getMime().startsWith('audio/') || this.getMime().startsWith('video/')) return 'Preview';
      return modes.includes('Edit') ? 'Edit' : modes[0];
    }
    buildModes() {
      this.viewTabs.innerHTML = '';
      for (const mode of this.getModes()) {
        const b = document.createElement('span');
        b.className = 'editorTab';
        b.textContent = ` ${mode} `;
        b.onclick = () => this.activate(mode);
        b.dataset.mode = mode;
        this.viewTabs.appendChild(b);
      }
    }
    setActiveMode(mode) {
      this.viewTabs.querySelectorAll('.editorTab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    }
    async activate(mode) {
      if (!this.fileNode) return;
      this.current = mode;
      this.setActiveMode(mode);
      this.host.innerHTML = '';
      if (this.model) {
        this.model.dispose();
        this.model = null;
      }
      if (this.state.editor) this.state.editor.setModel(null);
      if (this.state.monacoHost) this.state.monacoHost.style.display = 'none';
      if (mode === 'Edit') return this.showEdit();
      if (mode === 'Raw') return this.showRaw();
      return this.showPreview();
    }
    readText() {
      return this.state.fs.readFileSync(this.fileNode.path, 'utf8') || '';
    }
    writeText(value) {
      this.state.fs.writeFileSync(this.fileNode.path, value);
      this.state.dirty = true;
      this.state.markDirty?.(this.fileNode.path);
    }
    async showEdit() {
      const path = this.fileNode.path;
      const initial = this.readText();
      const fallback = document.createElement('textarea');
      fallback.className = 'rawedit active editor-edit-fallback';
      fallback.value = initial;
      fallback.spellcheck = false;
      fallback.autocorrect = 'off';
      fallback.autocapitalize = 'off';
      fallback.oninput = () => {
        if (this.current !== 'Edit' || this.fileNode?.path !== path) return;
        this.writeText(fallback.value);
        this.state.updateStatus();
      };
      this.host.appendChild(fallback);
      try {
        const monaco = await Promise.race([this.state.ensureMonaco(), new Promise((_, reject) => setTimeout(() => reject(new Error('Monaco timed out')), 4000))]);
        if (this.current !== 'Edit' || this.fileNode?.path !== path) return;
        if (!this.state.editor) {
          this.state.editor = monaco.editor.create(this.state.monacoHost, {
            theme: window.EditorTheme?.id || 'vs-dark',
            'semanticHighlighting.enabled': true,
            automaticLayout: true,
            minimap: {
              enabled: false
            },
            fontSize: 13,
            scrollBeyondLastLine: false,
            folding: true,
            wordWrap: 'off'
          });
        }
        const text = this.readText();
        this.model = monaco.editor.createModel(text, this.state.language(path));
        this.state.editor.setModel(this.model);
        const listener = this.model.onDidChangeContent(() => {
          if (this.current !== 'Edit' || this.ignoreModelChange || !this.state.fs) return;
          this.writeText(this.model.getValue());
          this.state.updateStatus();
        });
        this._modelListener = listener;
        fallback.remove();
        this.state.monacoHost.style.display = 'block';
      } catch (e) {
        this.state.monacoHost.style.display = 'none';
      }
    }
    showRaw() {
      const textarea = document.createElement('textarea');
      textarea.id = 'rawEditorActive';
      textarea.className = 'rawedit active';
      textarea.value = this.readText();
      textarea.spellcheck = false;
      textarea.oninput = () => {
        this.writeText(textarea.value);
        if (this.model) {
          this.ignoreModelChange = true;
          this.model.setValue(textarea.value);
          this.ignoreModelChange = false;
        }
        this.state.updateStatus();
      };
      this.host.appendChild(textarea);
      if (this.model) this.state.monacoHost.style.display = 'none';
    }
    async showPreview() {
      const m = this.getMime();
      if (m === 'text/markdown') {
        const box = document.createElement('div');
        box.className = 'editor-markdown';
        box.innerHTML = simpleMarkdown(this.readText());
        this.host.appendChild(box);
        return;
      }
      if (m.startsWith('image/') || m.startsWith('audio/') || m.startsWith('video/')) {
        const data = this.state.fs.readFileSync(this.fileNode.path, 'binary');
        const url = URL.createObjectURL(new Blob([data], {
          type: m || 'application/octet-stream'
        }));
        let el;
        if (m.startsWith('image/')) {
          el = document.createElement('img');
          el.className = 'img-display';
          el.src = url;
        } else if (m.startsWith('audio/')) {
          el = document.createElement('audio');
          el.controls = true;
          el.src = url;
        } else {
          el = document.createElement('video');
          el.controls = true;
          el.src = url;
        }
        el.onload = el.onloadeddata = () => URL.revokeObjectURL(url);
        this.host.appendChild(el);
        return;
      }
      const box = document.createElement('div');
      box.className = 'file-preview-message';
      box.textContent = `No preview available for ${this.fileNode.name}`;
      this.host.appendChild(box);
    }
  }
  function simpleMarkdown(text) {
    let s = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>');
    s = s.replace(/^[-*] (.+)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
    return s.split(/\n\s*\n/).map(block => (/^<(h[1-3]|ul)/).test(block.trim()) ? block : `<p>${block.replace(/\n/g, '<br>')}</p>`).join('');
  }
  window.EditorFileView = EditorFileView;
})();

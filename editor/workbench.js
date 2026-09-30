(function () {
  const instances = new Set();
  let activeDrag = null;
  let activeWorkbench = null;
  let activeGroup = null;
  class Workbench {
    constructor(root, options = {}) {
      this.root = root;
      this.onActivate = options.onActivate || (() => {});
      this.onClose = options.onClose || (() => {});
      this.onBuiltin = options.onBuiltin || (() => {});
      this.onLayoutChange = options.onLayoutChange || (() => {});
      this.restoring = false;
      this.groups = new Map();
      this.nextId = 1;
      this.dragInfo = null;
      this.hostTab = options.hostTab || null;
      this.keepEmpty = !!options.keepEmpty;
      instances.add(this);
      if (!activeWorkbench) activeWorkbench = this;
      this._onDragEnd = () => {
        if (activeDrag?.workbench === this) activeDrag = null;
        this.dragInfo = null;
        this.hideDropPreview();
      };
      this.dropPreview = document.createElement('div');
      this.dropPreview.className = 'workbench-drop-preview';
      this.dropPreview.innerHTML = '<div data-zone="header"></div><div data-zone="top"></div><div data-zone="right"></div><div data-zone="bottom"></div><div data-zone="left"></div>';
      document.body.appendChild(this.dropPreview);
      this.root.addEventListener('dragover', e => this.handleDragOver(e));
      this.root.addEventListener('drop', e => this.handleDrop(e));
      document.addEventListener('dragend', this._onDragEnd);
      this.createGroup();
    }
    notifyLayoutChange() {
      if (!this.restoring) this.onLayoutChange(this.serialize());
    }
    serializeNode(node) {
      if (!node) return null;
      if (node.type === 'group') {
        return {
          type: 'group',
          tabs: node.group.tabs.map(t => {
            if (t.kind === 'file') return {kind:'file', path:t.path, view:t.view};
            const out = {kind:'builtin', builtin:t.builtin};
            if (t.builtin === 'group') {
              out.groupName = t.groupName || 'Group';
              out.groupLayout = t._groupWorkbench?.serialize?.() || t.groupLayout || null;
            }
            return out;
          }),
          active: node.group.tabs.findIndex(t => t.id === node.group.active)
        };
      }
      return {type:'split', dir:node.dir, ratio:node.ratio || .5, a:this.serializeNode(node.a), b:this.serializeNode(node.b)};
    }
    serialize() {
      this.ensureRoot();
      return {version:1, root:this.serializeNode(this.rootNode)};
    }
    restore(layout, makeTab) {
      if (!layout?.root || typeof makeTab !== 'function') return false;
      this.restoring = true;
      try {
        this.groups.clear();
        this.nextId = 1;
        const build = data => {
          if (!data) return null;
          if (data.type === 'group') {
            const g = this.createGroup();
            for (const tabData of data.tabs || []) {
              const tab = makeTab(tabData);
              if (!tab) continue;
              tab.group = g;
              g.tabs.push(tab);
            }
            if (g.tabs.length) g.active = g.tabs[Math.max(0, Math.min(data.active ?? 0, g.tabs.length - 1))]?.id || g.tabs[0].id;
            return {type:'group', group:g};
          }
          if (data.type === 'split') {
            const a = build(data.a), b = build(data.b);
            if (!a) return b;
            if (!b) return a;
            const split = {type:'split', id:'split-'+this.nextId++, dir:data.dir === 'vertical' ? 'vertical' : 'horizontal', a, b, ratio:Math.max(.12, Math.min(.88, Number(data.ratio) || .5)), parent:null};
            a.parent = split;
            b.parent = split;
            return split;
          }
          return null;
        };
        const root = build(layout.root);
        if (!root) return false;
        root.parent = null;
        this.rootNode = root;
        this.rebuild();
        return true;
      } finally {
        this.restoring = false;
      }
    }
    createGroup() {
      const g = {
        id: 'group-' + this.nextId++,
        tabs: [],
        active: null,
        el: null,
        tabBar: null,
        content: null,
        viewBar: null,
        viewBody: null
      };
      g.ownerWorkbench = this;
      this.groups.set(g.id, g);
      if (!this.activeGroup) this.activeGroup = g;
      return g;
    }
    reset() {
      this.groups.clear();
      this.nextId = 1;
      this.rootNode = {
        type: 'group',
        group: this.createGroup()
      };
      this.setActiveGroup(this.rootNode.group);
      this.rebuild();
      this.notifyLayoutChange();
    }
    ensureRoot() {
      if (!this.rootNode) this.rootNode = {
        type: 'group',
        group: [...this.groups.values()][0] || this.createGroup()
      };
    }
    setActiveGroup(g) {
      if (!g || g.ownerWorkbench !== this) return;
      activeWorkbench = this;
      activeGroup = g;
      this.activeGroup = g;
    }
    getActiveGroup() {
      if (this.activeGroup && this.groups.has(this.activeGroup.id)) return this.activeGroup;
      return this.getFirstLeaf();
    }
    makeGroupElement(g) {
      const el = document.createElement('div');
      el.className = 'workbench-group';
      el.__workbench = this;
      el.dataset.group = g.id;
      el.tabIndex = 0;
      el.addEventListener('mousedown', () => this.setActiveGroup(g));
      el.addEventListener('focusin', () => this.setActiveGroup(g));
      const bar = document.createElement('div');
      bar.className = 'workbench-tabs';
      const content = document.createElement('div');
      content.className = 'workbench-content';
      const viewBar = document.createElement('div');
      viewBar.className = 'workbench-viewbar';
      const body = document.createElement('div');
      body.className = 'workbench-viewbody';
      content.append(viewBar, body);
      el.append(bar, content);
      g.el = el;
      g.tabBar = bar;
      g.content = content;
      g.viewBar = viewBar;
      g.viewBody = body;
      bar.addEventListener('dragover', e => {
        if (!(activeDrag || this.dragInfo)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        bar.classList.add('dragover');
      });
      bar.addEventListener('dragleave', e => {
        if (!bar.contains(e.relatedTarget)) bar.classList.remove('dragover');
      });
      bar.addEventListener('drop', e => {
        if (!(activeDrag || this.dragInfo)) return;
        e.preventDefault();
        e.stopPropagation();
        bar.classList.remove('dragover');
        this.dropTabIntoBar(g, e.clientX);
      });
      return el;
    }
    nodeElement(node) {
      if (node.type === 'group') return this.makeGroupElement(node.group);
      const holder = document.createElement('div');
      this.renderNode(node, holder);
      return holder.firstElementChild;
    }
    renderNode(node, parent) {
      if (node.type === 'group') {
        parent.appendChild(this.makeGroupElement(node.group));
        return;
      }
      const split = document.createElement('div');
      split.className = 'workbench-split ' + node.dir;
      split.dataset.split = node.id;
      const a = document.createElement('div');
      a.className = 'workbench-split-child';
      const b = document.createElement('div');
      b.className = 'workbench-split-child';
      a.appendChild(this.nodeElement(node.a));
      b.appendChild(this.nodeElement(node.b));
      const d = document.createElement('div');
      d.className = 'workbench-divider ' + node.dir;
      d.addEventListener('mousedown', e => this.startResize(node, e));
      split.append(a, d, b);
      node.el = split;
      node.aWrap = a;
      node.bWrap = b;
      parent.appendChild(split);
      this.applyRatio(node);
    }
    rebuild() {
      this.ensureRoot();
      this.root.innerHTML = '';
      this.renderNode(this.rootNode, this.root);
      for (const g of this.groups.values()) this.renderGroup(g);
      queueMicrotask(() => {
        for (const g of this.groups.values()) {
          const t = g.tabs.find(x => x.id === g.active);
          if (t) this.onActivate(t, g); else if (!g.tabs.length) this.onActivate(null, g);
        }
      });
    }
    applyRatio(node) {
      if (!node.aWrap) return;
      node.aWrap.style.flex = `0 0 ${(node.ratio || .5) * 100}%`;
      node.bWrap.style.flex = '1 1 0';
    }
    startResize(node, e) {
      e.preventDefault();
      document.body.classList.add('resizing');
      const rect = node.el.getBoundingClientRect();
      const total = node.dir === 'horizontal' ? rect.width : rect.height;
      const start = node.dir === 'horizontal' ? e.clientX : e.clientY;
      const initial = (node.ratio || .5) * total;
      const move = ev => {
        const delta = (node.dir === 'horizontal' ? ev.clientX : ev.clientY) - start;
        node.ratio = Math.max(.12, Math.min(.88, (initial + delta) / total));
        this.applyRatio(node);
      };
      const up = () => {
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        this.notifyLayoutChange();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    }
    renderGroup(g) {
      if (!g.tabBar) return;
      g.tabBar.innerHTML = '';
      for (const t of g.tabs) {
        const el = document.createElement('div');
        el.className = 'workbench-tab' + (g.active === t.id ? ' active' : '');
        el.draggable = true;
        el.dataset.tabId = t.id;
        const icon = document.createElement('span');
        icon.className = 'tab-icon';
        if (t.icon) {
          try {
            const raw = String(t.icon).replace(/^\s*<\?xml[^>]*>\s*/i, '').trim();
            const tpl = document.createElement('template');
            tpl.innerHTML = raw;
            const svg = tpl.content.querySelector('svg');
            if (svg) icon.appendChild(svg.cloneNode(true)); else icon.textContent = '';
          } catch (_) {
            icon.textContent = '';
          }
        }
        const name = document.createElement('span');
        name.className = 'tab-name';
        name.textContent = t.title || t.id;
        const close = document.createElement('span');
        close.className = 'tab-close';
        close.textContent = '×';
        el.append(icon, name, close);
        el.onclick = e => {
          if (e.target !== close) this.activateTab(g, t.id);
        };
        close.onclick = e => {
          e.stopPropagation();
          this.onClose(t, g);
        };
        el.addEventListener('dragstart', e => {
          const info = {
            workbench: this,
            tabId: t.id,
            groupId: g.id
          };
          this.dragInfo = info;
          activeDrag = info;
          el.classList.add('dragging');
          document.body.classList.add('workbench-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', 'workbench-tab:' + t.id);
        });
        el.addEventListener('dragend', () => {
          el.classList.remove('dragging');
          document.body.classList.remove('workbench-dragging');
          if (activeDrag?.workbench === this && activeDrag.tabId === t.id) activeDrag = null;
          this.dragInfo = null;
          this.hideDropPreview();
        });
        g.tabBar.appendChild(el);
      }
      const add = document.createElement('button');
      add.className = 'workbench-add-tab';
      add.textContent = '+';
      add.title = 'New tab';
      add.onclick = e => {
        e.stopPropagation();
        this.onBuiltin('welcome', g);
      };
      g.tabBar.appendChild(add);
    }
    showBuiltinMenu(g, anchor) {
      document.querySelectorAll('.workbench-builtin-menu').forEach(x => x.remove());
      const menu = document.createElement('div');
      menu.className = 'workbench-builtin-menu';
      menu.innerHTML = '<button data-kind="browser">Browser</button><button data-kind="peer">Peer Server</button><button data-kind="terminal">Terminal</button><button data-kind="run">Run Configuration</button><button data-kind="environment">Environment Variables</button><button data-kind="ai">AI</button><button data-kind="welcome">Welcome</button>';
      const r = anchor.getBoundingClientRect();
      menu.style.left = Math.min(r.left, innerWidth - 210) + 'px';
      menu.style.top = r.bottom + 2 + 'px';
      document.body.appendChild(menu);
      menu.addEventListener('click', e => {
        const k = e.target.closest('[data-kind]')?.dataset.kind;
        if (k) this.onBuiltin(k, g);
        menu.remove();
      });
      setTimeout(() => document.addEventListener('click', () => menu.remove(), {
        once: true
      }), 0);
    }
    addTab(tab, g = this.getFirstLeaf()) {
      if (!g) g = this.createGroup();
      const same = g.tabs.find(x => x.id === tab.id);
      if (same) {
        this.activateTab(g, same.id);
        return g;
      }
      tab.group = g;
      g.tabs.push(tab);
      this.renderGroup(g);
      this.activateTab(g, tab.id);
      return g;
    }
    activateTab(g, id) {
      const t = g.tabs.find(x => x.id === id);
      if (!t) return;
      this.setActiveGroup(g);
      g.active = id;
      this.renderGroup(g);
      this.onActivate(t, g);
      this.notifyLayoutChange();
    }
    removeTab(g, id) {
      const idx = g.tabs.findIndex(x => x.id === id);
      if (idx < 0) return;
      const wasActive = g.active === id;
      g.tabs.splice(idx, 1);
      const next = g.tabs[idx] || g.tabs[idx - 1];
      g.active = null;
      if (next) this.activateTab(g, next.id); else {
        if (this.groups.size === 1 && !this.keepEmpty) {
          this.onBuiltin('welcome', g);
          return;
        }
        this.showEmpty(g);
        this.renderGroup(g);
      }
      if (!g.tabs.length) this.collapseEmptyGroup(g);
      else this.notifyLayoutChange();
    }
    showEmpty(g) {
      this.onActivate(null, g);
    }
    replaceTab(g, tab) {
      if (!g) g = this.getFirstLeaf();
      if (!g) return null;
      if (g.active) {
        const old = g.tabs.find(x => x.id === g.active);
        if (old) g.tabs.splice(g.tabs.indexOf(old), 1);
      }
      g.tabs.push(tab);
      tab.group = g;
      this.renderGroup(g);
      this.activateTab(g, tab.id);
      return tab;
    }
    collapseEmptyGroup(g) {
      if (this.groups.size <= 1) return;
      const node = this.findGroupNode(g.id);
      if (!node) return;
      const p = node.parent;
      if (!p) return;
      const sibling = p.a === node ? p.b : p.a;
      if (!p.parent) {
        this.rootNode = sibling;
        sibling.parent = null;
      } else {
        if (p.parent.a === p) p.parent.a = sibling; else p.parent.b = sibling;
        sibling.parent = p.parent;
      }
      this.groups.delete(g.id);
      this.rebuild();
    }
    findGroupNode(id, node = this.rootNode) {
      if (!node) return null;
      if (node.type === 'group') return node.group.id === id ? node : null;
      return this.findGroupNode(id, node.a) || this.findGroupNode(id, node.b);
    }
    getFirstLeaf(node = this.rootNode) {
      if (!node) return null;
      if (node.type === 'group') return node.group;
      return this.getFirstLeaf(node.a);
    }
    getZone(groupEl, x, y) {
      const r = groupEl.getBoundingClientRect();
      const bar = groupEl.querySelector('.workbench-tabs');
      if (y <= r.top + (bar?.getBoundingClientRect().height || 35) + 6) return 'header';
      const rx = (x - r.left) / r.width, ry = (y - r.top) / r.height;
      const edge = .24;
      if (rx < edge) return 'left';
      if (rx > 1 - edge) return 'right';
      if (ry < edge) return 'top';
      if (ry > 1 - edge) return 'bottom';
      return 'header';
    }
    showDropPreview(el, zone) {
      const r = el.getBoundingClientRect();
      this.dropPreview.style.display = 'block';
      this.dropPreview.style.left = r.left + 'px';
      this.dropPreview.style.top = r.top + 'px';
      this.dropPreview.style.width = r.width + 'px';
      this.dropPreview.style.height = r.height + 'px';
      for (const c of this.dropPreview.children) c.classList.toggle('active', c.dataset.zone === zone);
    }
    hideDropPreview() {
      this.dropPreview.style.display = 'none';
    }
    dropTabIntoBar(target, clientX) {
      const info = activeDrag || this.dragInfo;
      const sourceWorkbench = info?.workbench;
      const source = sourceWorkbench?.groups.get(info?.groupId);
      const tab = source?.tabs.find(x => x.id === info?.tabId);
      activeDrag = null;
      if (sourceWorkbench) sourceWorkbench.dragInfo = null;
      this.dragInfo = null;
      this.hideDropPreview();
      document.body.classList.remove('workbench-dragging');
      if (!tab || !target || !this.canDropTab(tab, target)) return;
      if (source !== target) {
        this.moveTab(tab, source, target, sourceWorkbench);
        return;
      }
      const tabEls = [...target.tabBar.querySelectorAll('.workbench-tab')];
      let insertAt = target.tabs.length;
      for (let i = 0; i < tabEls.length; i++) {
        const r = tabEls[i].getBoundingClientRect();
        if (clientX < r.left + r.width / 2) {
          insertAt = i;
          break;
        }
      }
      const oldIndex = target.tabs.indexOf(tab);
      if (oldIndex < 0) return;
      target.tabs.splice(oldIndex, 1);
      if (oldIndex < insertAt) insertAt--;
      insertAt = Math.max(0, Math.min(insertAt, target.tabs.length));
      target.tabs.splice(insertAt, 0, tab);
      tab.group = target;
      this.renderGroup(target);
      this.activateTab(target, tab.id);
    }
    canDropTab(tab, target) {
      if (!tab || !target) return false;
      const sourceWorkbench = tab.group?.ownerWorkbench;
      if (sourceWorkbench === this && tab.group === target) return true;
      let owner = this;
      while (owner?.hostTab) {
        if (owner.hostTab === tab) return false;
        owner = owner.hostTab.group?.ownerWorkbench || null;
      }
      return true;
    }
    handleDragOver(e) {
      const info = activeDrag || this.dragInfo;
      if (!info) return;
      const el = e.target.closest('.workbench-group');
      if (!el || !this.root.contains(el)) return;
      const target = this.groups.get(el.dataset.group);
      const source = info.workbench?.groups.get(info.groupId);
      const tab = source?.tabs.find(x => x.id === info.tabId);
      if (!target || !tab || !this.canDropTab(tab, target)) return;
      const zone = this.getZone(el, e.clientX, e.clientY);
      this.showDropPreview(el, zone);
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
    }
    handleDrop(e) {
      const info = activeDrag || this.dragInfo;
      if (!info) return;
      const el = e.target.closest('.workbench-group');
      if (!el || !this.root.contains(el)) {
        this.hideDropPreview();
        return;
      }
      const target = this.groups.get(el.dataset.group);
      const sourceWorkbench = info.workbench;
      const source = sourceWorkbench?.groups.get(info.groupId);
      const tab = source?.tabs.find(x => x.id === info.tabId);
      if (!target || !tab || !this.canDropTab(tab, target)) {
        this.hideDropPreview();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const zone = this.getZone(el, e.clientX, e.clientY);
      activeDrag = null;
      if (sourceWorkbench) sourceWorkbench.dragInfo = null;
      this.dragInfo = null;
      this.hideDropPreview();
      document.body.classList.remove('workbench-dragging');
      if (zone === 'header') {
        if (source === target) {
          const tabEls = [...target.tabBar.querySelectorAll('.workbench-tab')];
          let insertAt = target.tabs.length;
          for (let i = 0; i < tabEls.length; i++) {
            const r = tabEls[i].getBoundingClientRect();
            if (e.clientX < r.left + r.width / 2) {
              insertAt = i;
              break;
            }
          }
          const oldIndex = target.tabs.indexOf(tab);
          if (oldIndex >= 0 && oldIndex < insertAt) insertAt--;
          target.tabs.splice(oldIndex, 1);
          target.tabs.splice(Math.max(0, Math.min(insertAt, target.tabs.length)), 0, tab);
          tab.group = target;
          this.renderGroup(target);
          this.activateTab(target, tab.id);
        } else this.moveTab(tab, source, target, sourceWorkbench);
        return;
      }
      const dir = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
      const before = zone === 'left' || zone === 'top';
      const newGroup = this.splitGroup(target, dir, before);
      this.moveTab(tab, source, newGroup, sourceWorkbench);
    }
    splitGroup(target, dir, before) {
      const targetNode = this.findGroupNode(target.id);
      const newGroup = this.createGroup();
      const oldNode = {
        type: 'group',
        group: target
      };
      const newNode = {
        type: 'group',
        group: newGroup
      };
      const parent = targetNode.parent || null;
      const split = {
        type: 'split',
        id: 'split-' + this.nextId++,
        dir,
        a: before ? newNode : oldNode,
        b: before ? oldNode : newNode,
        ratio: .5,
        parent
      };
      oldNode.parent = split;
      newNode.parent = split;
      if (parent) {
        if (parent.a === targetNode) parent.a = split; else parent.b = split;
      } else this.rootNode = split;
      this.rebuild();
      this.notifyLayoutChange();
      return newGroup;
    }
    moveTab(tab, source, target, sourceWorkbench = source?.ownerWorkbench || this) {
      if (!tab || !source || !target) return;
      if (source === target) {
        source.tabs = source.tabs.filter(x => x !== tab);
        source.tabs.push(tab);
      } else {
        source.tabs = source.tabs.filter(x => x !== tab);
        if (source.active === tab.id) source.active = source.tabs[source.tabs.length - 1]?.id || null;
        target.tabs.push(tab);
        tab.group = target;
      }
      sourceWorkbench?.renderGroup(source);
      this.renderGroup(target);
      this.activateTab(target, tab.id);
      if (!source.tabs.length) sourceWorkbench?.collapseEmptyGroup(source);
      sourceWorkbench?.notifyLayoutChange();
      if (sourceWorkbench !== this) this.notifyLayoutChange();
    }
    dispose() {
      for (const g of this.groups.values()) for (const t of g.tabs) if (t.builtin === 'group') t._groupWorkbench?.dispose?.();
      document.removeEventListener('dragend', this._onDragEnd);
      this.dropPreview.remove();
      instances.delete(this);
      this.groups.clear();
      this.rootNode = null;
    }
  }
  Workbench.getInstances = () => [...instances];
  Workbench.getActiveGroup = () => activeGroup && activeGroup.ownerWorkbench?.groups.has(activeGroup.id) ? activeGroup : activeWorkbench?.getActiveGroup?.() || null;
  window.Workbench = Workbench;
})();

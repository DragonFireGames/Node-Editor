(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.Settings = function(options) {
    const {
      state,
      tree,
      $,
      saveBehaviorSettings,
      getBrowserSettings,
      saveBrowserSettings,
      subscribeBrowserSettings
    } = options;

    function show() {
      tree.classList.remove('activity-collapsed');
      tree.innerHTML = `
        <div class="editor-settings-page sidebar-settings">
          <div class="editor-settings-header">
            <h2>Settings</h2>
            <p>Editor and workspace behavior.</p>
          </div>
          <div class="editor-settings-section">
            <h3>Saving</h3>
            <label class="setting-check"><input id="setting-auto-save" type="checkbox"><span>Save project before Run</span></label>
            <label class="setting-check"><input id="setting-auto-clear" type="checkbox"><span>Clear terminal before Run</span></label>
          </div>
          <div class="editor-settings-section">
            <h3>Workspace</h3>
            <label class="setting-check"><input id="setting-confirm-replace" type="checkbox"><span>Confirm before replacing the workspace</span></label>
            <label class="setting-check"><input id="setting-confirm-delete" type="checkbox"><span>Confirm before deleting files and folders</span></label>
            <label class="setting-check"><input id="setting-show-hidden" type="checkbox"><span>Show hidden folders</span></label>
          </div>
          <div class="editor-settings-section">
            <h3>Image Editing</h3>
            <label class="setting-check"><input id="setting-piskel-auto-save" type="checkbox"><span>Auto-save Piskel edits</span></label>
            <p class="editor-settings-note">Automatically saves Piskel changes to the image and its <code>.piskel</code> sidecar.</p>
          </div>
          <div class="editor-settings-section">
            <h3>Browser</h3>
            <label class="setting-check"><input id="setting-hide-browser-bar" type="checkbox"><span>Hide browser bar</span></label>
            <label>Default tab<input id="setting-browser-default-tab" type="text" spellcheck="false"></label>
            <label>CORS proxy gateway<input id="setting-browser-primary-proxy" type="text" spellcheck="false" placeholder="Optional"></label>
            <label>Fallback proxy<input id="setting-browser-fallback-proxy" type="text" spellcheck="false" placeholder="Optional"></label>
            <label>Search engine<select id="setting-browser-search-engine">
              <option value="https://mojeek.com/search?q=">Mojeek</option>
              <option value="https://duckduckgo.com/html/?q=">DuckDuckGo HTML</option>
              <option value="https://html.duckduckgo.com/html/?q=">DuckDuckGo Lite</option>
            </select></label>
            <label class="setting-check"><input id="setting-browser-use-fallback" type="checkbox"><span>Use fallback proxy</span></label>
            <label class="setting-check"><input id="setting-browser-obscure-url" type="checkbox"><span>Obscure proxied URLs</span></label>
            <label class="setting-check"><input id="setting-browser-clear-devtools" type="checkbox"><span>Clear DevTools on page reload</span></label>
            <label class="setting-check"><input id="setting-browser-autodownload" type="checkbox"><span>Automatically download browser downloads</span></label>
            <p class="editor-settings-note">Browser settings are shared with the Browser panel and its Settings dialog.</p>
          </div>
        </div>`;

      const a = $('setting-auto-save');
      const c = $('setting-auto-clear');
      const r = $('setting-confirm-replace');
      const d = $('setting-confirm-delete');
      const h = $('setting-show-hidden');
      const piskelAutoSave = $('setting-piskel-auto-save');
      const b = $('setting-hide-browser-bar');
      const defaultTab = $('setting-browser-default-tab');
      const primaryProxy = $('setting-browser-primary-proxy');
      const fallbackProxy = $('setting-browser-fallback-proxy');
      const searchEngine = $('setting-browser-search-engine');
      const useFallback = $('setting-browser-use-fallback');
      const obscureURL = $('setting-browser-obscure-url');
      const clearDevTools = $('setting-browser-clear-devtools');
      const autoDownload = $('setting-browser-autodownload');

      a.checked = !!state.behavior.autoSaveOnRun;
      c.checked = !!state.behavior.autoClearTerminal;
      r.checked = !!state.behavior.confirmBeforeReplace;
      d.checked = !!state.behavior.confirmBeforeDelete;
      h.checked = !!state.behavior.showHiddenFolders;
      try { const stored = localStorage.getItem('node-editor.piskel.autoSave'); piskelAutoSave.checked = stored === null ? true : stored === 'true'; } catch (_) { piskelAutoSave.checked = true; }
      b.checked = !!state.behavior.hideBrowserBar;

      a.onchange = () => { state.behavior.autoSaveOnRun = a.checked; saveBehaviorSettings(); };
      c.onchange = () => { state.behavior.autoClearTerminal = c.checked; saveBehaviorSettings(); };
      r.onchange = () => { state.behavior.confirmBeforeReplace = r.checked; saveBehaviorSettings(); };
      d.onchange = () => { state.behavior.confirmBeforeDelete = d.checked; saveBehaviorSettings(); };
      h.onchange = () => {
        state.behavior.showHiddenFolders = h.checked;
        state.fileManager?.setShowHiddenFolders(h.checked);
        state.fileManager?.refresh();
        saveBehaviorSettings();
      };
      piskelAutoSave.onchange = () => {
        try { localStorage.setItem('node-editor.piskel.autoSave', piskelAutoSave.checked ? 'true' : 'false'); } catch (_) {}
      };
      b.onchange = () => {
        state.behavior.hideBrowserBar = b.checked;
        for (const info of state.browserTabs.values()) {
          try { info.frame?.contentWindow?.setBrowserChromeHidden?.(b.checked); } catch (_) {}
        }
        saveBehaviorSettings();
      };

      function renderBrowserSettings(value) {
        const settings = value || getBrowserSettings?.() || {};
        defaultTab.value = settings.defaultTab || '';
        primaryProxy.value = settings.primaryProxy || '';
        fallbackProxy.value = settings.fallbackProxy || '';
        searchEngine.value = settings.searchEngine || 'https://mojeek.com/search?q=';
        useFallback.checked = !!settings.useFallback;
        obscureURL.checked = !!settings.obscureURL;
        clearDevTools.checked = settings.clearDevToolsOnReload !== false;
        autoDownload.checked = !!settings.autoDownload;
      }

      function writeBrowserSettings(patch) {
        saveBrowserSettings?.(patch);
      }

      defaultTab.onchange = () => writeBrowserSettings({defaultTab: defaultTab.value});
      primaryProxy.onchange = () => writeBrowserSettings({primaryProxy: primaryProxy.value});
      fallbackProxy.onchange = () => writeBrowserSettings({fallbackProxy: fallbackProxy.value});
      searchEngine.onchange = () => writeBrowserSettings({searchEngine: searchEngine.value});
      useFallback.onchange = () => writeBrowserSettings({useFallback: useFallback.checked});
      obscureURL.onchange = () => writeBrowserSettings({obscureURL: obscureURL.checked});
      clearDevTools.onchange = () => writeBrowserSettings({clearDevToolsOnReload: clearDevTools.checked});
      autoDownload.onchange = () => writeBrowserSettings({autoDownload: autoDownload.checked});

      renderBrowserSettings();
      const unsubscribe = subscribeBrowserSettings?.(renderBrowserSettings) || null;
      tree.__settingsBrowserUnsubscribe?.();
      tree.__settingsBrowserUnsubscribe = unsubscribe;
    }
    return {show};
  };
})();

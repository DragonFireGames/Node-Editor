(function() {
  const root = window.EditorSidebar = window.EditorSidebar || {};
  root.Settings = function(options) {
    const {state, tree, $, saveBehaviorSettings} = options;
    function show() {
      tree.classList.remove('activity-collapsed');
      tree.innerHTML = '<div class="editor-settings-page sidebar-settings"><div class="editor-settings-header"><h2>Settings</h2><p>Editor and workspace behavior.</p></div><div class="editor-settings-section"><h3>Saving</h3><label><input id="setting-auto-save" type="checkbox"> Save project before Run</label><label><input id="setting-auto-clear" type="checkbox"> Clear terminal before Run</label></div><div class="editor-settings-section"><h3>Workspace</h3><label><input id="setting-confirm-replace" type="checkbox"> Confirm before replacing the workspace</label><label><input id="setting-confirm-delete" type="checkbox"> Confirm before deleting files and folders</label><label><input id="setting-show-hidden" type="checkbox"> Show hidden folders</label></div><div class="editor-settings-section"><h3>Browser</h3><label><input id="setting-hide-browser-bar" type="checkbox"> Hide browser bar</label></div></div>';
      const a = $('setting-auto-save'), c = $('setting-auto-clear'), r = $('setting-confirm-replace'), d = $('setting-confirm-delete'), h = $('setting-show-hidden'), b = $('setting-hide-browser-bar');
      a.checked = state.behavior.autoSaveOnRun;
      c.checked = state.behavior.autoClearTerminal;
      r.checked = state.behavior.confirmBeforeReplace;
      d.checked = state.behavior.confirmBeforeDelete;
      h.checked = state.behavior.showHiddenFolders;
      b.checked = state.behavior.hideBrowserBar;
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
      b.onchange = () => {
        state.behavior.hideBrowserBar = b.checked;
        for (const info of state.browserTabs.values()) {
          try { info.frame?.contentWindow?.setBrowserChromeHidden?.(b.checked); } catch (_) {}
        }
        saveBehaviorSettings();
      };
    }
    return {show};
  };
})();

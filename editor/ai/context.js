(function() {
  const root = window.EditorAI = window.EditorAI || {};
  function activeTab(state) {
    const wb = state?.workbench;
    if (!wb) return null;
    for (const g of wb.groups.values()) {
      const t = g.tabs.find(x => x.id === g.active);
      if (t) return {group:g, tab:t};
    }
    return null;
  }
  function sensitivePath(path) { return /(^|\/)(?:\.env(?:\..*)?|\.editor\/process\.env|.*(?:secret|credential|password|token|private[-_]?key).*)$/i.test(String(path||'')); }
  function build(state, options = {}) {
    const active = activeTab(state);
    const tab = active?.tab;
    const projectFiles = state.fs?.listFilesSync?.() || [];
    let selection = '';
    let activeContent = '';
    if (tab?.kind === 'file') {
      activeContent = tab.editor?.getValue?.() || state.fs?.readFileSync?.(tab.path, 'utf8') || '';
      const sel = tab.editor?.getSelection?.();
      if (sel && tab.editor?.getModel?.()) selection = tab.editor.getModel().getValueInRange(sel) || '';
    }
    const parts = [
      `Project: ${state.projectName || 'Workspace'}`,
      `Files: ${projectFiles.length} files`,
      tab?.kind === 'file' ? `Active file: ${tab.path}` : 'Active file: none'
    ];
    if (activeContent && !sensitivePath(tab?.path) && activeContent.length <= (options.maxFileChars || 20000)) parts.push(`Active file contents:\n${activeContent}`);
    else if (activeContent && sensitivePath(tab?.path)) parts.push('Active file contents are omitted from automatic context because the filename looks sensitive.');
    if (selection) parts.push(`Current selection:\n${selection}`);
    return parts.join('\n\n');
  }
  root.activeEditorTab = activeTab;
  root.buildContext = build;
})();

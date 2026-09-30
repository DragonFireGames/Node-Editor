(function() {
  const factories = window.EditorBuiltinFactories = window.EditorBuiltinFactories || {};
  factories['run-config'] = function(ctx) {
    const state = ctx.state;
    function renderRunConfig(g) {
    const div = document.createElement('div');
    div.className = 'run-config-page';
    g.viewBody.appendChild(div);
    state.runConfig.render(div, () => ctx.runConfigured().catch(ctx.logError));
  }
    return {
      title: 'Run Configuration',
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7 5v14l11-7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
      render: renderRunConfig
    };
  };
})();

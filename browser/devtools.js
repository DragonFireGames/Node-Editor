(function(){
  'use strict';


  function createInstance(element, options, emitter) {
    options=options||{};
    var uiRoot=element;
    function getUIElement(id){ return uiRoot ? uiRoot.querySelector('#'+CSS.escape(String(id))) : null; }
    function getUIQuerySelector(selector){ return uiRoot ? uiRoot.querySelector(selector) : null; }
    function getUIQuerySelectorAll(selector){ return uiRoot ? uiRoot.querySelectorAll(selector) : []; }
  var activePage = null;
  var attachedPages = new Set();
  var network = options.network || null;
  var cacheMap = options.cacheMap || Object.create(null);
  var pageRecords = new Map();
  var pageEventHandlers = new Map();
  var globalHandlers = null;
  var created = false;
  var instanceToken = {};

  function getRootPage(page) {
    var current = page || null;
    var seen = new Set();
    while (current && !seen.has(current)) {
      var known=pageRecords.get(current);
      if(known?.rootPage){ current=known.rootPage; break; }
      if(!current.parent || current.parent===false) break;
      seen.add(current);
      current=current.parent;
    }
    return current || page || null;
  }

  function ensureRootData(page) {
    var rootPage = getRootPage(page);
    if (!rootPage) return null;
    var data = rootPage.devtools;
    if (!data || data.rootPage !== rootPage) {
      data = {
        rootPage:rootPage,
        tabs:new Map(),
        events:new EventHandler(),
        collectors:new Map()
      };
      rootPage.devtools=data;
    }
    return data;
  }

  function makeTab(page,parentPage) {
    var record=pageRecords.get(page);
    if(record?.tab) return record.tab;
    var parentRecord=parentPage ? pageRecords.get(parentPage) : null;
    return {
      id:'devtools-' + String(page?.id || Math.random().toString(36).slice(2,9)),
      iframe:page?.iframe || null,
      page:page,
      subframe:!!parentPage,
      parentTab:parentRecord?.tab || null,
      frameElement:page?.iframe || null,
      framePath:[],
      url:parentPage ? 'about:srcdoc' : (page?.location?.url || 'about:blank'),
      title:''
    };
  }

  function ensureTabState(tab) {
    if(!tab?.page) return null;
    var rootPage=getRootPage(tab.page);
    var rootData=ensureRootData(rootPage);
    if(!rootData) return null;
    var state=rootData.tabs.get(tab.page);
    if(!state){
      state={
        rootPage:rootPage,
        page:tab.page,
        tab:tab,
        rawDocument:String(tab.page.rawDocument || ''),
        processedDocument:String(tab.page.processedDocument || ''),
        documentSource:'',
        sourceEntries:[],
        consoleLog:[],
        networkLog:[],
        networkRecording:false,
        networkSelection:null
      };
      rootData.tabs.set(tab.page,state);
    }else{
      state.tab=tab;
    }
    if(tab.page.rawDocument!=null && String(tab.page.rawDocument || '')) state.rawDocument=String(tab.page.rawDocument || '');
    if(tab.page.processedDocument!=null && String(tab.page.processedDocument || '')) state.processedDocument=String(tab.page.processedDocument || '');
    return state;
  }

  function getActiveTab(){ return activePage ? pageRecords.get(activePage)?.tab || null : null; }
  function getActiveTabId(){ return getActiveTab()?.id || null; }
  function getTabs(){ return Array.from(attachedPages).map(page=>pageRecords.get(page)?.tab).filter(Boolean); }
  function getNetwork(page){ return page?.network || activePage?.network || network || null; }
  function emitEvent(event,...args){ if(!emitter || typeof emitter.dispatchEvent !== 'function') return false; emitter.dispatchEvent(event,...args); return true; }
  function sanitizeHTML(value){ return String(value == null ? '' : value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function getTabState(tab){ return ensureTabState(tab); }

  var DEVTOOLS_UI_HTML = "      <!-- Draggable Splitter Bar -->\n      <div id=\"devtools-resizer\"></div>\n\n      <!-- DevTools Side Panel -->\n      <div id=\"devtools-panel\" class=\"hidden\">\n        <!-- DevTools Header Bar -->\n        <div class=\"flex items-center justify-between bg-[#111214] border-b border-[#2b2d31] px-2 pt-1 text-xs text-gray-300 flex-shrink-0\">\n          <div class=\"flex items-center gap-1 overflow-x-auto\" style=\"scrollbar-width: none;\">\n            <button id=\"dt-tab-elements\" class=\"dt-tab active\">\n              <i class=\"fa-solid fa-code text-xs\"></i> Elements\n            </button>\n            <button id=\"dt-tab-console\" class=\"dt-tab\">\n              <i class=\"fa-solid fa-terminal text-xs\"></i> Console \n              <span id=\"dt-console-count\" class=\"hidden text-[10px] bg-rose-600 text-white px-1.5 py-0.2 rounded-full font-bold\">0</span>\n            </button>\n            <button id=\"dt-tab-sources\" class=\"dt-tab\">\n              <i class=\"fa-solid fa-file-code text-xs\"></i> Sources\n            </button>\n            <button id=\"dt-tab-network\" class=\"dt-tab\">\n              <i class=\"fa-solid fa-network-wired text-xs\"></i> Network \n              <span id=\"dt-network-count\" class=\"hidden text-[10px] bg-indigo-600 text-white px-1.5 py-0.2 rounded-full font-bold\">0</span>\n            </button>\n            <button id=\"dt-tab-performance\" class=\"dt-tab\">\n              <i class=\"fa-solid fa-chart-line text-xs\"></i> Performance\n            </button>\n            <button id=\"dt-tab-application\" class=\"dt-tab\">\n              <i class=\"fa-solid fa-database text-xs\"></i> Application\n            </button>\n          </div>\n          <div class=\"flex items-center gap-1 flex-shrink-0 ml-2\">\n            <button id=\"dt-clear-active\" class=\"hover:text-white p-1 text-gray-400\" title=\"Clear current view\"><i class=\"fa-solid fa-ban text-xs\"></i></button>\n            <button id=\"dt-panel-close\" class=\"hover:text-white p-1 text-gray-400\" title=\"Close DevTools (F12)\"><i class=\"fa-solid fa-xmark text-sm\"></i></button>\n          </div>\n        </div>\n\n        <!-- 1. DevTools View: Elements / Live DOM Inspector -->\n        <div id=\"dt-view-elements\" class=\"flex-1 hidden bg-[#1e1f22] overflow-hidden\">\n          <div class=\"w-[55%] min-w-0 flex flex-col border-r border-[#383a40]\">\n            <div class=\"flex items-center gap-2 bg-[#2b2d31] px-2 py-1.5 border-b border-[#383a40] text-[11px] flex-shrink-0\">\n              <button id=\"dt-pick-element\" class=\"bg-indigo-600 hover:bg-indigo-500 text-white px-2 py-1 rounded text-[10px] font-semibold\" title=\"Select an element from the page (Ctrl+Shift+C)\">\n                <i class=\"fa-solid fa-crosshairs mr-1\"></i> Select\n              </button>\n              <input id=\"dom-tree-filter\" class=\"min-w-0 flex-1 bg-[#1e1f22] border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200 outline-none\" placeholder=\"Filter DOM…\" spellcheck=\"false\">\n              <button id=\"dom-tree-refresh\" class=\"hover:text-white text-gray-400 px-1\" title=\"Refresh DOM\"><i class=\"fa-solid fa-rotate-right\"></i></button>\n            </div>\n            <div id=\"dom-breadcrumbs\" class=\"px-2 py-1 border-b border-[#383a40] bg-[#111214] text-[10px] font-mono text-gray-500 truncate flex-shrink-0\"></div>\n            <div id=\"dom-tree-container\" class=\"flex-1 overflow-auto p-2\"></div>\n          </div>\n          <div id=\"element-details\" class=\"w-[45%] min-w-0 flex flex-col bg-[#1e1f22] overflow-hidden\">\n            <div id=\"element-summary\" class=\"px-2 py-2 bg-[#111214] border-b border-[#383a40] text-[11px] text-gray-300 flex-shrink-0\">Select an element to inspect it.</div>\n            <div class=\"flex items-center gap-1 px-2 py-1 border-b border-[#383a40] bg-[#2b2d31] flex-shrink-0\">\n              <button id=\"element-detail-tab-html\" class=\"dt-subtab active\">HTML</button>\n              <button id=\"element-detail-tab-styles\" class=\"dt-subtab\">Styles</button>\n              <button id=\"element-detail-tab-properties\" class=\"dt-subtab\">Properties</button>\n              <button id=\"element-detail-tab-attributes\" class=\"dt-subtab\">Attributes</button>\n            </div>\n            <div id=\"element-detail-content\" class=\"flex-1 overflow-auto min-h-0\"></div>\n          </div>\n        </div>\n\n        <!-- 2. DevTools View: Console -->\n        <div id=\"dt-view-console\" class=\"w-full flex-1 min-h-0 flex flex-col hidden bg-[#1e1f22] overflow-hidden\">\n          <div class=\"w-full flex items-center gap-2 bg-[#2b2d31] px-3 py-1 border-b border-[#383a40] text-[11px] flex-shrink-0\">\n            <span class=\"text-gray-400 font-semibold\"><i class=\"fa-solid fa-filter mr-1\"></i> Filter:</span>\n            <select id=\"consoleFilter\" class=\"bg-[#1e1f22] text-gray-200 rounded px-2 py-0.5 border border-gray-700 outline-none text-xs\">\n              <option value=\"all\">All Levels</option>\n              <option value=\"log\">Logs</option>\n              <option value=\"warn\">Warnings</option>\n              <option value=\"error\">Errors</option>\n            </select>\n            <button id=\"console-clear\" class=\"ml-auto text-xs text-gray-400 hover:text-white\"><i class=\"fa-solid fa-trash mr-1\"></i> Clear</button>\n          </div>\n          <div id=\"consoleOutput\" class=\"w-full flex-1 min-h-0 overflow-y-auto p-2 font-mono text-xs space-y-1 min-h-0\"></div>\n          <div class=\"w-full border-t border-[#383a40] bg-[#111214] p-2 flex items-end gap-2 flex-shrink-0 box-border\">\n            <span class=\"text-indigo-400 font-bold font-mono text-sm flex-shrink-0\">&gt;</span>\n            <textarea id=\"consoleInput\" placeholder=\"\" class=\"min-w-0 flex-1 bg-transparent text-gray-100 font-mono text-xs border-none outline-none resize-none min-h-[20px] max-h-[120px]\" rows=\"1\" spellcheck=\"false\"></textarea>\n          </div>\n        </div>\n\n        <!-- 3. DevTools View: Sources / Original + Active -->\n        <div id=\"dt-view-sources\" class=\"flex-1 hidden bg-[#1e1f22] overflow-hidden\">\n          <div class=\"w-1/3 min-w-0 border-r border-[#383a40] flex flex-col bg-[#111214]\">\n            <div class=\"p-1.5 border-b border-[#383a40] text-[10px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1\">\n              <span class=\"flex-1\">Sources / Delivery Tree</span>\n              <button id=\"sources-refresh\" class=\"text-gray-500 hover:text-white px-1\" title=\"Refresh\"><i class=\"fa-solid fa-rotate\"></i></button>\n            </div>\n            <div class=\"p-1 border-b border-[#383a40]\">\n              <input id=\"sources-filter\" class=\"w-full bg-[#1e1f22] border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200 outline-none\" placeholder=\"Search sources…\" spellcheck=\"false\">\n            </div>\n            <div class=\"flex items-center gap-1 px-1 py-1 border-b border-[#383a40]\">\n              <button id=\"sources-mode-original\" class=\"dt-subtab active flex-1\">Original</button>\n              <button id=\"sources-mode-active\" class=\"dt-subtab flex-1\">Active</button>\n            </div>\n            <div id=\"sources-file-tree\" class=\"flex-1 overflow-y-auto p-1 font-mono text-[10px]\"></div>\n          </div>\n          <div class=\"flex-1 min-w-0 flex flex-col\">\n            <div id=\"sources-current-file\" class=\"px-2 py-1.5 border-b border-[#383a40] bg-[#2b2d31] text-[10px] font-mono text-indigo-300 truncate flex-shrink-0\">Select a source…</div>\n            <div id=\"sources-source-info\" class=\"px-2 py-1 border-b border-[#383a40] bg-[#111214] text-[10px] text-gray-500 truncate flex-shrink-0\"></div>\n            <div id=\"sources-dependencies\" class=\"hidden px-2 py-1 border-b border-[#383a40] bg-[#16171a] text-[9px] flex flex-col gap-1 max-h-12 overflow-auto flex-shrink-0\"></div>\n            <div class=\"flex items-center gap-2 px-2 py-1 border-b border-[#383a40] bg-[#1a1b1e] flex-shrink-0\">\n              <input id=\"sources-search\" class=\"flex-1 bg-[#111214] border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200 outline-none\" placeholder=\"Find in source…\" spellcheck=\"false\">\n              <button id=\"sources-copy-current\" class=\"text-gray-400 hover:text-white text-[10px] px-1\" title=\"Copy source\"><i class=\"fa-regular fa-copy\"></i></button>\n            </div>\n            <pre id=\"sources-editor\" tabindex=\"0\" class=\"flex-1 min-h-0 text-[11px] leading-relaxed font-mono\" spellcheck=\"false\"></pre>\n          </div>\n        </div>\n\n        <!-- 4. DevTools View: Network Viewer -->\n        <div id=\"dt-view-network\" class=\"w-full h-full flex flex-col hidden bg-[#1e1f22] overflow-hidden\">\n          <div class=\"w-full flex items-center gap-2 bg-[#2b2d31] px-2 py-1.5 border-b border-[#383a40] text-[11px] flex-shrink-0\">\n            <div class=\"text-gray-300 font-semibold flex-shrink-0\"><i class=\"fa-solid fa-network-wired mr-1 text-indigo-400\"></i> Network</div>\n            <button id=\"network-record-toggle\" class=\"bg-indigo-600 hover:bg-indigo-500 text-white px-2 py-1 rounded text-[10px] font-semibold\" title=\"Record network activity for this tab\"><i class=\"fa-solid fa-circle mr-1\"></i> Record</button>\n            <span id=\"network-record-status\" class=\"text-gray-500 ml-0.5\">Stopped</span>\n            <input id=\"network-filter\" class=\"min-w-0 flex-1 bg-[#1e1f22] border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200 outline-none\" placeholder=\"Filter requests…\" spellcheck=\"false\">\n            <select id=\"network-status-filter\" class=\"bg-[#1e1f22] text-gray-200 rounded px-2 py-1 border border-gray-700 outline-none text-[10px]\">\n              <option value=\"all\">All</option>\n              <option value=\"pending\">Pending</option>\n              <option value=\"2xx\">2xx</option>\n              <option value=\"3xx\">3xx</option>\n              <option value=\"4xx\">4xx</option>\n              <option value=\"5xx\">5xx</option>\n            </select>\n            <select id=\"network-type-filter\" class=\"bg-[#1e1f22] text-gray-200 rounded px-2 py-1 border border-gray-700 outline-none text-[10px]\">\n              <option value=\"all\">All Types</option>\n            </select>\n            <button class=\"hover:text-rose-400 text-gray-400 px-1\" title=\"Clear network log\"><i class=\"fa-solid fa-trash\"></i></button>\n          </div>\n          <div id=\"network-waterfall\" class=\"relative border-t border-b border-[#383a40] bg-[#151619] h-[88px] overflow-hidden font-mono text-[9px] flex-shrink-0\"></div>\n          <div class=\"w-full flex-1 overflow-auto font-mono text-[10px] min-h-0\">\n            <table class=\"w-full text-left border-collapse table-fixed\">\n              <thead>\n                <tr class=\"bg-[#111214] text-gray-400 text-[10px] uppercase border-b border-gray-800 sticky top-0\">\n                  <th class=\"p-2 truncate\">Name / URL</th>\n                  <th class=\"p-2 w-14\">Status</th>\n                  <th class=\"p-2 w-14\">Method</th>\n                  <th class=\"p-2 w-24\">Type</th>\n                  <th class=\"p-2 w-16 text-right\">Size</th>\n                  <th class=\"p-2 w-16 text-right\">Time</th>\n                </tr>\n              </thead>\n              <tbody id=\"network-log-body\"></tbody>\n            </table>\n          </div>\n          <div id=\"network-detail-drawer\" class=\"w-full hidden border-t border-gray-700 bg-[#111214] max-h-[45%] overflow-hidden font-mono flex-shrink-0 box-border flex flex-col\"></div>\n        </div>\n\n        <!-- 5. DevTools View: Performance -->\n        <div id=\"dt-view-performance\" class=\"flex-1 flex-col hidden bg-[#1e1f22] overflow-auto p-4\">\n          <div class=\"flex justify-between items-center mb-4\">\n            <h3 class=\"text-gray-300 font-semibold text-xs\"><i class=\"fa-solid fa-stopwatch mr-1\"></i> Page Load Timing</h3>\n            <button id=\"performance-refresh\" class=\"bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1 text-[10px] rounded font-semibold transition\">Analyze Current Tab</button>\n          </div>\n          <div id=\"perf-metrics-container\" class=\"space-y-3 font-mono text-xs\">\n            <div class=\"text-gray-500 italic text-center py-10\">Click \"Analyze Current Tab\" to view simulated metrics.</div>\n          </div>\n        </div>\n\n        <!-- 6. DevTools View: Application -->\n        <div id=\"dt-view-application\" class=\"flex-1 flex hidden bg-[#1e1f22] overflow-hidden\">\n          <div class=\"w-1/3 border-r border-[#383a40] bg-[#111214] flex flex-col\">\n            <div class=\"p-2 border-b border-[#383a40] text-[10px] font-semibold text-gray-400 uppercase tracking-wider\">Storage</div>\n            <div class=\"flex-1 overflow-y-auto p-1 text-[11px] font-semibold text-gray-300 space-y-1\">\n              <div class=\"cursor-pointer hover:bg-[#2b2d31] p-1.5 rounded flex items-center gap-2\"><i class=\"fa-solid fa-database text-indigo-400\"></i> Local Storage</div>\n              <div class=\"cursor-pointer hover:bg-[#2b2d31] p-1.5 rounded flex items-center gap-2\"><i class=\"fa-solid fa-box text-emerald-400\"></i> Session Storage</div>\n              <div class=\"cursor-pointer hover:bg-[#2b2d31] p-1.5 rounded flex items-center gap-2\"><i class=\"fa-solid fa-cookie text-yellow-400\"></i> Cookies</div>\n            </div>\n          </div>\n          <div class=\"flex-1 flex flex-col\">\n            <div class=\"flex justify-between items-center bg-[#2b2d31] px-2 py-1.5 border-b border-[#383a40] text-[10px] font-semibold text-gray-300\">\n              <span id=\"app-storage-title\">Select a storage type</span>\n              <button id=\"application-refresh\" class=\"text-gray-400 hover:text-white\"><i class=\"fa-solid fa-rotate\"></i></button>\n            </div>\n            <div class=\"flex-1 overflow-y-auto bg-[#1e1f22] font-mono text-xs\">\n              <table class=\"w-full text-left border-collapse\">\n                <thead>\n                  <tr class=\"bg-[#111214] text-gray-400 text-[10px] uppercase border-b border-gray-800\">\n                    <th class=\"p-2 border-r border-gray-800 w-1/3\">Key</th>\n                    <th class=\"p-2\">Value</th>\n                  </tr>\n                </thead>\n                <tbody id=\"app-storage-body\"></tbody>\n              </table>\n            </div>\n          </div>\n        </div>\n      </div>\n";
  var DEVTOOLS_CSS = "/* DevTools Resizer & Panel */\n#devtools-resizer {\n  width: 5px; background: #2b2d31; cursor: col-resize; transition: background 0.15s;\n  z-index: 20; flex-shrink: 0;\n}\n#devtools-resizer:hover, #devtools-resizer.active { background: #5865f2; }\n\n#devtools-panel {\n  width: 480px; max-width: 85vw; min-width: 320px;\n  background: #1e1f22; border-left: 1px solid #2b2d31;\n  display: flex; flex-direction: column; flex-shrink: 0;\n  font-size: 12px; color: #dbdee1; height: 100%; z-index: 10;\n}\n#devtools-panel.hidden { display: none; }\n\n.dt-tab {\n  padding: 5px 10px; border-radius: 4px 4px 0 0; font-size: 11px; font-weight: 500; color: #949ba4;\n  cursor: pointer; transition: all 0.15s ease; border: none; background: transparent;\n  display: flex; align-items: center; gap: 4px; border-bottom: 2px solid transparent; white-space: nowrap;\n}\n.dt-tab:hover { color: #ffffff; background: rgba(255, 255, 255, 0.05); }\n.dt-tab.active { color: #5865f2; border-bottom-color: #5865f2; background: rgba(88, 101, 242, 0.1); font-weight: 600; }\n\n/* User Custom Console Output CSS Rules */\n.log { display: inline; line-height: 1.4; vertical-align: top; margin: 0; padding: 0; font-family: monospace; user-select: text; }\n.log-number { color: #61afef; }\n.log-string { color: #98c379; white-space: pre-wrap; word-break: break-all; }\n.log-boolean { color: #d19a66; }\n.log-null, .log-undefined, .log-empty { color: #7f848e; font-style: italic; }\n.log-property { color: #abb2bf; }\n.log-class { color: #e5c07b; font-weight: bold; }\n.log-function { color: #e06c75; }\n.log-function-source { color: #7f848e; font-size: 11px; margin-top: 2px; }\n.log-dropdown { display: inline-block; margin: 0 4px; }\n.log-html { color: #98c379; font-weight: 500; word-break: break-all; }\n.log-command { color: #61afef; font-weight: 600; cursor: pointer; }\n.log-command:hover { text-decoration: underline; }\n.log-error { color: #f44747; background: rgba(244, 71, 71, 0.12); padding: 3px 6px; border-radius: 4px; display: block; border-left: 3px solid #f44747; margin: 2px 0; }\n.log-warning { color: #e5c07b; background: rgba(229, 192, 123, 0.12); padding: 3px 6px; border-radius: 4px; display: block; border-left: 3px solid #e5c07b; margin: 2px 0; }\n.log-details { display: inline-block; margin: 0 4px 0 0; }\n.log-promise { color: #c678dd; font-style: italic; }\n.log-circular, .log-promise-rejected { color: #f44747; font-style: italic; }\n.log-url { text-decoration: underline; cursor: pointer; color: #61afef; }\n.log-url:hover { font-weight: bold; }\n.log-line { border-bottom: 1px solid rgba(255, 255, 255, 0.04); padding: 4px 0; word-wrap: break-word; font-family: monospace; font-size: 11px; }\n\n    .dt-syntax-code { margin:0; padding:0; font:inherit; line-height:inherit; white-space:pre-wrap; overflow:auto; box-sizing:border-box; max-width:100%; max-height:100%; }\n    .log-command { display:block; white-space:pre-wrap; cursor:pointer; }\n    .log-command-prompt { color:#818cf8; font-weight:700; }\n    .log-command-code { display:inline; white-space:pre-wrap; }\n    .log-function-source, .log-html { white-space:pre-wrap; }\n    #consoleOutput .console-log-list { min-height:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:flex-end; }\n    #consoleOutput .console-empty-state { padding:2px 4px; }\n    .dt-syn-keyword { color:#c4b5fd; }\n    .dt-syn-literal { color:#fda4af; }\n    .dt-syn-string { color:#86efac; }\n    .dt-syn-template { color:#86efac; }\n    .dt-syn-number { color:#f9a8d4; }\n    .dt-syn-comment { color:#6b7280; }\n    .dt-syn-builtin { color:#93c5fd; }\n    .dt-syn-function { color:#fcd34d; }\n    .dt-syn-bracket { font-weight:600; }\n    .dt-syn-bracket-1 { color:#f9c74f; }\n    .dt-syn-bracket-2 { color:#a78bfa; }\n    .dt-syn-bracket-3 { color:#38bdf8; }\n    .dt-syn-bracket-error { color:#f87171 !important; font-weight:700; }\n    .dt-syn-tag { color:#67e8f9; }\n    .dt-syn-attribute { color:#c4b5fd; }\n    .dt-syn-property { color:#93c5fd; }\n    .dt-syn-selector { color:#67e8f9; }\n    #sources-editor { margin:0; height:100%; overflow:auto; box-sizing:border-box; padding:12px; background:#1e1f22; color:#e5e7eb; font:inherit; line-height:1.55; white-space:pre; tab-size:2; outline:none; user-select:text; }\n    #sources-editor .dt-syn-keyword, #sources-editor .dt-syn-literal, #sources-editor .dt-syn-string, #sources-editor .dt-syn-template, #sources-editor .dt-syn-number, #sources-editor .dt-syn-comment, #sources-editor .dt-syn-builtin, #sources-editor .dt-syn-function, #sources-editor .dt-syn-bracket, #sources-editor .dt-syn-tag, #sources-editor .dt-syn-attribute, #sources-editor .dt-syn-property, #sources-editor .dt-syn-selector { white-space:pre; }\n    .dt-code-editor { white-space:pre; tab-size:2; line-height:1.55; user-select:text; }\n    .dt-code-editor:focus { outline:none; }\n/* DOM Tree Inspector Styles */\n.dom-node-container { margin-left: 12px; display: block; }\n.dom-node {\n  font-family: monospace; font-size: 11px; line-height: 1.6; padding: 1px 4px;\n  border-radius: 3px; cursor: pointer; display: flex; align-items: flex-start;\n}\n.dom-node-content { flex: 1; word-wrap: break-word; }\n.dom-node:hover > .dom-node-content { background: #2b2d31; }\n.dom-node.selected > .dom-node-content { background: #383a40; color: #38bdf8; font-weight: 600; border-left: 2px solid #38bdf8; padding-left: 4px;}\n.dom-tag { color: #f43f5e; font-weight: 600; }\n.dom-attr-name { color: #fb923c; }\n.dom-attr-val { color: #38bdf8; user-select: text; }\n.dom-text { color: #e2e8f0; }\n.dom-caret {\n  width: 12px; text-align: center; color: #949ba4; display: inline-block;\n  cursor: pointer; user-select: none; margin-right: 2px; font-size: 9px;\n}\n.dom-caret:hover { color: #fff; }\n\n\n/* Performance Tab Bars */\n.perf-bar { height: 16px; border-radius: 4px; margin-bottom: 4px; position: relative; }\n.perf-label { position: absolute; left: 8px; top: 0; font-size: 10px; line-height: 16px; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.8); z-index: 2; }\n\n    .dt-console-syntax-wrap {\n      position: relative;\n      flex: 1 1 auto;\n      min-width: 0;\n      min-height: 20px;\n      height: 20px;\n      overflow: hidden;\n    }\n    .dt-console-syntax-wrap > textarea,\n    .dt-console-syntax-highlight {\n      position: absolute;\n      inset: 0;\n      box-sizing: border-box;\n      width: 100%;\n      margin: 0 !important;\n      padding: 0 !important;\n      border: 0 !important;\n      outline: 0 !important;\n      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace;\n      font-size: 12px;\n      line-height: 20px;\n      letter-spacing: normal;\n      tab-size: 2;\n      white-space: pre-wrap;\n      word-break: break-word;\n      overflow-x: hidden;\n    }\n    .dt-console-syntax-highlight {\n      z-index: 0;\n      pointer-events: none;\n      overflow: hidden;\n      color: #e5e7eb;\n      background: transparent;\n    }\n    .dt-console-syntax-wrap > textarea {\n      z-index: 1;\n      resize: none;\n      overflow-x: hidden;\n      overflow-y: auto;\n      background: transparent !important;\n      color: transparent !important;\n      -webkit-text-fill-color: transparent !important;\n      caret-color: #f3f4f6 !important;\n    }\n    .dt-console-syntax-wrap > textarea::selection {\n      background: rgba(88,101,242,.45);\n      color: transparent;\n    }\n    .dt-console-syn-keyword { color: #c4b5fd; }\n    .dt-console-syn-literal { color: #fda4af; }\n    .dt-console-syn-string, .dt-console-syn-template { color: #86efac; }\n    .dt-console-syn-number { color: #f9a8d4; }\n    .dt-console-syn-comment { color: #6b7280; }\n    .dt-console-syn-builtin { color: #93c5fd; }\n    .dt-console-syn-function { color: #fcd34d; }\n    .dt-console-syn-bracket { font-weight: 600; }\n    .dt-console-syn-bracket.dt-console-bracket-1 { color: #f9c74f; }\n    .dt-console-syn-bracket.dt-console-bracket-2 { color: #a78bfa; }\n    .dt-console-syn-bracket.dt-console-bracket-3 { color: #38bdf8; }\n    .dt-console-syn-bracket.dt-console-bracket-error { color: #f87171 !important; font-weight: 700; }\n  \n.dt-subtab { border: 0; background: transparent; color: #9ca3af; padding: 3px 7px; border-radius: 3px; font-size: 10px; cursor: pointer; white-space: nowrap; }\n    .dt-subtab:hover { color: #fff; background: #2b2d31; }\n    .dt-subtab.active { color: #a5b4fc; background: #1e1f22; box-shadow: inset 0 -1px 0 #6366f1; }\n\n    #devtools-panel { box-sizing: border-box; }\n";
  function createConsoleSyntax(){
  const BRACKET_COLORS = ['dt-console-bracket-1','dt-console-bracket-2','dt-console-bracket-3'];
  const OPEN = {'(':')','[':']','{':'}'};
  const CLOSE = {')':'(',']':'[','}':'{'};

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function makeSpan(className,text) {
    return '<span class="dt-console-syn-' + className + '">' + escapeHTML(text) + '</span>';
  }

  function scanString(code,start,quote) {
    let i = start + 1;
    while (i < code.length) {
      if (code[i] === '\\') { i += 2; continue; }
      if (code[i] === quote) return i + 1;
      i++;
    }
    return code.length;
  }

  function findTemplateExpressionEnd(code,start) {
    let i = start;
    let depth = 0;

    while (i < code.length) {
      const ch = code[i], next = code[i + 1];

      if (ch === '/' && next === '/') {
        const n = code.indexOf('\n',i + 2);
        i = n < 0 ? code.length : n;
        continue;
      }

      if (ch === '/' && next === '*') {
        const n = code.indexOf('*/',i + 2);
        i = n < 0 ? code.length : n + 2;
        continue;
      }

      if (ch === '"' || ch === "'") {
        i = scanString(code,i,ch);
        continue;
      }

      if (ch === '`') {
        i = skipTemplateLiteral(code,i);
        continue;
      }

      if (ch === '{') {
        depth++;
        i++;
        continue;
      }

      if (ch === '}') {
        if (depth === 0) return i;
        depth--;
        i++;
        continue;
      }

      if (ch === '\\') {
        i += 2;
        continue;
      }

      i++;
    }

    return -1;
  }

  function skipTemplateLiteral(code,start) {
    let i = start + 1;

    while (i < code.length) {
      const ch = code[i], next = code[i + 1];

      if (ch === '\\') {
        i += 2;
        continue;
      }

      if (ch === '`') return i + 1;

      if (ch === '$' && next === '{') {
        const end = findTemplateExpressionEnd(code,i + 2);
        if (end < 0) return code.length;
        i = end + 1;
        continue;
      }

      i++;
    }

    return code.length;
  }

  function scanTemplateProtected(code,start,ranges) {
    let i = start + 1;
    let segmentStart = start;

    while (i < code.length) {
      const ch = code[i], next = code[i + 1];

      if (ch === '\\') {
        i += 2;
        continue;
      }

      if (ch === '`') {
        ranges.push([segmentStart,i + 1]);
        return i + 1;
      }

      if (ch === '$' && next === '{') {
        ranges.push([segmentStart,i]);

        const end = findTemplateExpressionEnd(code,i + 2);
        if (end < 0) {
          return code.length;
        }

        segmentStart = end + 1;
        i = end + 1;
        continue;
      }

      i++;
    }

    ranges.push([segmentStart,code.length]);
    return code.length;
  }

  function scanProtected(code) {
    const ranges = [];
    let i = 0;
    while (i < code.length) {
      const ch = code[i], next = code[i + 1];
      if (ch === '/' && next === '/') {
        const n = code.indexOf('\n',i + 2);
        const end = n < 0 ? code.length : n;
        ranges.push([i,end]);
        i = end;
        continue;
      }
      if (ch === '/' && next === '*') {
        const n = code.indexOf('*/',i + 2);
        const end = n < 0 ? code.length : n + 2;
        ranges.push([i,end]);
        i = end;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const end = scanString(code,i,ch);
        ranges.push([i,end]);
        i = end;
        continue;
      }
      if (ch === '`') {
        i = scanTemplateProtected(code,i,ranges);
        continue;
      }
      i++;
    }
    return ranges;
  }

  function markBrackets(code,ranges) {
    const marks = new Map();
    const stack = [];
    let rangeIndex = 0;

    function isProtected(pos) {
      while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= pos) rangeIndex++;
      return rangeIndex < ranges.length && ranges[rangeIndex][0] <= pos && pos < ranges[rangeIndex][1];
    }

    for (let i = 0; i < code.length; i++) {
      if (isProtected(i)) continue;
      const ch = code[i];
      if (OPEN[ch]) {
        stack.push({char:ch,index:i,level:stack.length % 3});
        continue;
      }
      if (!CLOSE[ch]) continue;

      if (!stack.length) {
        marks.set(i,'dt-console-bracket-error');
        continue;
      }

      const top = stack[stack.length - 1];
      if (top.char === CLOSE[ch]) {
        const cls = BRACKET_COLORS[top.level];
        marks.set(top.index,cls);
        marks.set(i,cls);
        stack.pop();
      } else {
        marks.set(i,'dt-console-bracket-error');
      }
    }

    for (const open of stack) marks.set(open.index,'dt-console-bracket-error');
    return marks;
  }

  function lex(code) {
    const protectedRanges = scanProtected(code);
    const tokens = [];
    const keywordSet = new Set('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch throw try typeof var void while with yield this'.split(' '));
    const literalSet = new Set(['true','false','null','undefined','NaN','Infinity']);
    const builtinSet = new Set([
      'window','document','console','JSON','Math','Array','Object','String','Number','Boolean','BigInt','Symbol',
      'Promise','Reflect','Proxy','Date','RegExp','Map','Set','WeakMap','WeakSet','URL','URLSearchParams',
      'Error','TypeError','RangeError','ReferenceError','SyntaxError','EvalError','URIError','fetch',
      'setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','requestIdleCallback',
      'queueMicrotask','event'
    ]);

    let i = 0;
    let protectedIndex = 0;
    function advanceProtected(pos) {
      while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex][1] <= pos) protectedIndex++;
      return protectedRanges[protectedIndex] && protectedRanges[protectedIndex][0] <= pos && pos < protectedRanges[protectedIndex][1];
    }

    while (i < code.length) {
      if (advanceProtected(i)) {
        const end = protectedRanges[protectedIndex][1];
        const start = protectedRanges[protectedIndex][0];
        const type = code[start] === '`' ? 'template' : 'string';
        if (code[start] === '/' && code[start + 1] === '/') tokens.push({start,end,type:'comment'});
        else if (code[start] === '/' && code[start + 1] === '*') tokens.push({start,end,type:'comment'});
        else tokens.push({start,end,type});
        i = end;
        continue;
      }

      const ch = code[i];
      if (/\d/.test(ch) && (i === 0 || /[^A-Za-z_$]/.test(code[i - 1]))) {
        const m = code.slice(i).match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?n?)/);
        if (m) {
          tokens.push({start:i,end:i + m[0].length,type:'number'});
          i += m[0].length;
          continue;
        }
      }

      if (/[A-Za-z_$]/.test(ch)) {
        const m = code.slice(i).match(/^[A-Za-z_$][\w$]*/)[0];
        const rest = code.slice(i + m.length);
        let type = 'plain';
        if (keywordSet.has(m)) type = 'keyword';
        else if (literalSet.has(m)) type = 'literal';
        else if (builtinSet.has(m)) type = 'builtin';
        else if (/^\s*\(/.test(rest)) type = 'function';
        tokens.push({start:i,end:i + m.length,type});
        i += m.length;
        continue;
      }

      i++;
    }
    return {tokens,protectedRanges};
  }

  function render(code) {
    code = String(code == null ? '' : code);
    const parsed = lex(code);
    const brackets = markBrackets(code,parsed.protectedRanges);
    const byStart = new Map();
    parsed.tokens.forEach(token => byStart.set(token.start,token));

    let html = '';
    let i = 0;
    while (i < code.length) {
      const token = byStart.get(i);
      if (token) {
        const text = code.slice(token.start,token.end);
        html += token.type === 'plain' ? escapeHTML(text) : makeSpan(token.type,text);
        i = token.end;
        continue;
      }
      const bracketClass = brackets.get(i);
      if (bracketClass) {
        html += makeSpan('bracket ' + bracketClass,code[i]);
        i++;
        continue;
      }
      html += escapeHTML(code[i]);
      i++;
    }
    return html;
  }

  function copyTextMetrics(from,to) {
    const css = getComputedStyle(from);
    to.style.fontFamily = css.fontFamily;
    to.style.fontSize = css.fontSize;
    to.style.fontWeight = css.fontWeight;
    to.style.fontStyle = css.fontStyle;
    to.style.lineHeight = css.lineHeight;
    to.style.letterSpacing = css.letterSpacing;
    to.style.textTransform = css.textTransform;
    to.style.textIndent = css.textIndent;
    to.style.textAlign = css.textAlign;
    to.style.tabSize = css.tabSize;
    to.style.padding = css.padding;
    to.style.border = css.border;
    to.style.boxSizing = css.boxSizing;
  }

  function attach(textarea) {
    if (!textarea || textarea.tagName !== 'TEXTAREA' || textarea.dataset.consoleSyntaxAttached === '1') return textarea;
    textarea.dataset.consoleSyntaxAttached = '1';

    const wrapper = document.createElement('div');
    wrapper.className = 'dt-console-syntax-wrap';
    wrapper.setAttribute('aria-hidden','false');

    const highlight = document.createElement('pre');
    highlight.className = 'dt-console-syntax-highlight';
    highlight.setAttribute('aria-hidden','true');

    const parent = textarea.parentNode;
    if (!parent) return textarea;
    parent.insertBefore(wrapper,textarea);
    wrapper.appendChild(highlight);
    wrapper.appendChild(textarea);

    function syncMetrics() {
      copyTextMetrics(textarea,highlight);
      const css = getComputedStyle(textarea);
      highlight.style.color = css.color === 'rgba(0, 0, 0, 0)' ? '#e5e7eb' : css.color;
      highlight.style.background = 'transparent';
      highlight.style.width = '100%';
      highlight.style.height = '100%';
    }

    function renderValue() {
      highlight.innerHTML = render(textarea.value || '');
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    }

    function syncSize() {
      // Keep the initial console prompt exactly one line tall.
      if (!textarea.value) {
        textarea.style.height = '20px';
        wrapper.style.height = '20px';
      } else {
        wrapper.style.height = textarea.offsetHeight + 'px';
      }
      renderValue();
    }

    function syncAll() {
      syncMetrics();
      renderValue();
      syncSize();
    }

    wrapper.addEventListener('scroll',function(){
      textarea.scrollTop = wrapper.scrollTop;
      textarea.scrollLeft = wrapper.scrollLeft;
    });
    textarea.addEventListener('scroll',function(){
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    });
    textarea.addEventListener('input',function(){
      renderValue();
      // browser.html already adjusts the native textarea's height after input.
      requestAnimationFrame(syncSize);
    });

    const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
    if (nativeValue && nativeValue.get && nativeValue.set) {
      Object.defineProperty(textarea,'value',{
        configurable:true,
        enumerable:true,
        get:function(){ return nativeValue.get.call(textarea); },
        set:function(next){
          nativeValue.set.call(textarea,String(next == null ? '' : next));
          requestAnimationFrame(syncAll);
        }
      });
    }

    const observer = new ResizeObserver(syncAll);
    observer.observe(textarea);

    syncAll();
    return textarea;
  }

    return {attach,render};
  }
  var ConsoleSyntax = createConsoleSyntax();
var DevToolsInternal = {
  activeTab: 'elements',

  util: {
    getActiveDocument() {
      const tab = getActiveTab();
      if (!tab || !tab.iframe) return null;
      return tab.iframe.contentDocument || tab.iframe.contentWindow?.document || null;
    },
    isNearBottom(element,threshold = 24) {
      if (!element) return true;
      return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
    },
    scrollToBottom(element) {
      if (!element) return;
      element.scrollTop = element.scrollHeight;
    },
  },

  syntax: (() => {
    const JS_KEYWORDS = new Set('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch throw try typeof var void while with yield this'.split(' '));
    const JS_LITERALS = new Set(['true','false','null','undefined','NaN','Infinity']);
    const JS_BUILTINS = new Set(['window','document','console','JSON','Math','Array','Object','String','Number','Boolean','Promise','Reflect','Proxy','Date','RegExp','Map','Set','WeakMap','WeakSet','URL','URLSearchParams','Error','TypeError','fetch','setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','event']);

    function esc(value) {
      return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');
    }

    function token(cls,text) {
      return '<span class=\"dt-syn-' + cls + '\">' + esc(text) + '</span>';
    }

    const BRACKET_COLORS = ['dt-syn-bracket-1','dt-syn-bracket-2','dt-syn-bracket-3'];
    const OPEN_BRACKETS = {'(':')','[':']','{':'}'};
    const CLOSE_BRACKETS = {')':'(',']':'[','}':'{'};

    function scanString(code,start,quote) {
      let i = start + 1;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === quote) return i + 1;
        i++;
      }
      return code.length;
    }

    function findTemplateExpressionEnd(code,start,endLimit) {
      let i = start, depth = 0;
      while (i < endLimit) {
        const ch = code[i], next = code[i + 1];
        if (ch === '/' && next === '/') {
          const n = code.indexOf('\n',i + 2);
          i = n < 0 || n > endLimit ? endLimit : n;
          continue;
        }
        if (ch === '/' && next === '*') {
          const n = code.indexOf('*/',i + 2);
          i = n < 0 || n + 2 > endLimit ? endLimit : n + 2;
          continue;
        }
        if (ch === '"' || ch === "'") { i = Math.min(scanString(code,i,ch),endLimit); continue; }
        if (ch === '`') { i = skipTemplateLiteral(code,i,endLimit); continue; }
        if (ch === '{') { depth++; i++; continue; }
        if (ch === '}') {
          if (depth === 0) return i;
          depth--; i++; continue;
        }
        if (ch === '\\') { i += 2; continue; }
        i++;
      }
      return -1;
    }

    function skipTemplateLiteral(code,start,endLimit) {
      let i = start + 1;
      while (i < endLimit) {
        const ch = code[i], next = code[i + 1];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '`') return i + 1;
        if (ch === '$' && next === '{') {
          const end = findTemplateExpressionEnd(code,i + 2,endLimit);
          if (end < 0) return endLimit;
          i = end + 1;
          continue;
        }
        i++;
      }
      return endLimit;
    }

    function collectProtectedJavaScript(code,start,endLimit,ranges) {
      let i = start;
      while (i < endLimit) {
        const ch = code[i], next = code[i + 1];
        if (ch === '/' && next === '/') {
          const n = code.indexOf('\n',i + 2);
          const end = n < 0 || n > endLimit ? endLimit : n;
          ranges.push({start:i,end,type:'comment'});
          i = end;
          continue;
        }
        if (ch === '/' && next === '*') {
          const n = code.indexOf('*/',i + 2);
          const end = n < 0 || n + 2 > endLimit ? endLimit : n + 2;
          ranges.push({start:i,end,type:'comment'});
          i = end;
          continue;
        }
        if (ch === '"' || ch === "'") {
          const end = Math.min(scanString(code,i,ch),endLimit);
          ranges.push({start:i,end,type:'string'});
          i = end;
          continue;
        }
        if (ch === '`') {
          i = collectTemplateJavaScript(code,i,endLimit,ranges);
          continue;
        }
        i++;
      }
    }

    function collectTemplateJavaScript(code,start,endLimit,ranges) {
      let i = start + 1, segmentStart = start;
      while (i < endLimit) {
        const ch = code[i], next = code[i + 1];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '`') {
          ranges.push({start:segmentStart,end:i + 1,type:'template'});
          return i + 1;
        }
        if (ch === '$' && next === '{') {
          if (i > segmentStart) ranges.push({start:segmentStart,end:i,type:'template'});
          const exprStart = i + 2;
          const exprEnd = findTemplateExpressionEnd(code,exprStart,endLimit);
          if (exprEnd < 0) return endLimit;
          collectProtectedJavaScript(code,exprStart,exprEnd,ranges);
          segmentStart = exprEnd + 1;
          i = exprEnd + 1;
          continue;
        }
        i++;
      }
      if (segmentStart < endLimit) ranges.push({start:segmentStart,end:endLimit,type:'template'});
      return endLimit;
    }

    function getProtectedJavaScriptRanges(code) {
      const ranges = [];
      collectProtectedJavaScript(code,0,code.length,ranges);
      return ranges;
    }

    function markJavaScriptBrackets(code,ranges) {
      const marks = new Map();
      const stack = [];
      let rangeIndex = 0;
      const isProtected = pos => {
        while (rangeIndex < ranges.length && ranges[rangeIndex].end <= pos) rangeIndex++;
        return rangeIndex < ranges.length && ranges[rangeIndex].start <= pos && pos < ranges[rangeIndex].end;
      };
      for (let i = 0; i < code.length; i++) {
        if (isProtected(i)) continue;
        const ch = code[i];
        if (OPEN_BRACKETS[ch]) {
          stack.push({char:ch,index:i,level:stack.length % 3});
          continue;
        }
        if (!CLOSE_BRACKETS[ch]) continue;
        if (!stack.length) {
          marks.set(i,'dt-syn-bracket-error');
          continue;
        }
        const top = stack[stack.length - 1];
        if (top.char === CLOSE_BRACKETS[ch]) {
          const cls = BRACKET_COLORS[top.level];
          marks.set(top.index,cls);
          marks.set(i,cls);
          stack.pop();
        } else {
          marks.set(i,'dt-syn-bracket-error');
        }
      }
      for (const open of stack) marks.set(open.index,'dt-syn-bracket-error');
      return marks;
    }

    function highlightJavaScript(code) {
      code = String(code ?? '');
      const ranges = getProtectedJavaScriptRanges(code);
      const brackets = markJavaScriptBrackets(code,ranges);
      let out = '', i = 0, rangeIndex = 0;
      while (i < code.length) {
        while (rangeIndex < ranges.length && ranges[rangeIndex].end <= i) rangeIndex++;
        const range = ranges[rangeIndex];
        if (range && range.start <= i && i < range.end) {
          out += token(range.type,code.slice(i,range.end));
          i = range.end;
          continue;
        }
        const ch = code[i];
        if (/\d/.test(ch) && (i === 0 || /[^A-Za-z_$]/.test(code[i - 1]))) {
          const match = code.slice(i).match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?n?)/);
          if (match) { out += token('number',match[0]); i += match[0].length; continue; }
        }
        if (/[A-Za-z_$]/.test(ch)) {
          const match = code.slice(i).match(/^[A-Za-z_$][\w$]*/)[0];
          const cls = JS_KEYWORDS.has(match) ? 'keyword' : JS_LITERALS.has(match) ? 'literal' : JS_BUILTINS.has(match) ? 'builtin' : /^[$A-Z_a-z][\w$]*$/.test(match) && /^\s*\(/.test(code.slice(i + match.length)) ? 'function' : '';
          out += cls ? token(cls,match) : esc(match);
          i += match.length; continue;
        }
        const bracketClass = brackets.get(i);
        if (bracketClass) {
          out += token('bracket ' + bracketClass, ch);
          i++;
          continue;
        }
        out += esc(ch); i++;
      }
      return out;
    }

    function highlightCSS(code) {
      code = String(code ?? '');
      let out = '', i = 0, inBlock = false;
      while (i < code.length) {
        const ch = code[i], next = code[i + 1];
        if (ch === '/' && next === '*') {
          const end = code.indexOf('*/',i + 2);
          const e = end < 0 ? code.length : end + 2;
          out += token('comment',code.slice(i,e)); i = e; continue;
        }
        if (ch === '"' || ch === "'") {
          const e = scanString(code,i,ch);
          out += token('string',code.slice(i,e)); i = e; continue;
        }
        if (ch === '{') { inBlock = true; out += esc(ch); i++; continue; }
        if (ch === '}') { inBlock = false; out += esc(ch); i++; continue; }
        if (ch === '@') {
          const match = code.slice(i).match(/^@[\w-]+/);
          if (match) { out += token('keyword',match[0]); i += match[0].length; continue; }
        }
        if (/\d/.test(ch) && (i === 0 || /[^A-Za-z_-]/.test(code[i - 1]))) {
          const match = code.slice(i).match(/^(?:\d+(?:\.\d+)?%?|\.\d+%?)(?:[A-Za-z]+)?/);
          if (match) { out += token('number',match[0]); i += match[0].length; continue; }
        }
        if (/[A-Za-z_-]/.test(ch)) {
          const match = code.slice(i).match(/^[A-Za-z_-][\w-]*/)[0];
          let j = i + match.length;
          while (j < code.length && /\s/.test(code[j])) j++;
          const cls = inBlock && code[j] === ':' ? 'property' : 'selector';
          out += token(cls,match); i += match.length; continue;
        }
        out += esc(ch); i++;
      }
      return out;
    }

    function highlightHTML(code) {
      code = String(code ?? '');
      let out = '', last = 0;
      const tagRe = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
      let match;
      while ((match = tagRe.exec(code))) {
        out += esc(code.slice(last,match.index));
        const tag = match[0];
        if (tag.startsWith('<!--')) {
          out += token('comment',tag);
        } else {
          let inner = '';
          let i = 0;
          if (tag[i] === '<') { inner += esc(tag[i++]); }
          if (tag[i] === '/') { inner += esc(tag[i++]); }
          const name = tag.slice(i).match(/^[A-Za-z][\w:-]*/);
          if (name) { inner += token('tag',name[0]); i += name[0].length; }
          while (i < tag.length) {
            if (tag[i] === '>' || (tag[i] === '/' && tag[i + 1] === '>')) {
              inner += esc(tag.slice(i)); break;
            }
            if (/\s/.test(tag[i])) {
              const ws = tag.slice(i).match(/^\s+/)[0]; inner += esc(ws); i += ws.length; continue;
            }
            const attr = tag.slice(i).match(/^[A-Za-z_:][\w:.-]*/);
            if (attr) {
              inner += token('attribute',attr[0]); i += attr[0].length;
              const eq = tag.slice(i).match(/^\s*=\s*/);
              if (eq) {
                inner += esc(eq[0]); i += eq[0].length;
                if (tag[i] === '"' || tag[i] === "'") {
                  const e = scanString(tag,i,tag[i]);
                  inner += token('string',tag.slice(i,e)); i = e;
                }
              }
              continue;
            }
            inner += esc(tag[i++]);
          }
          out += inner;
        }
        last = match.index + tag.length;
      }
      out += esc(code.slice(last));
      return out;
    }

    function highlight(code,language) {
      const lang = String(language || 'javascript').toLowerCase();
      if (lang === 'html' || lang === 'xml') return highlightHTML(code);
      if (lang === 'css') return highlightCSS(code);
      return highlightJavaScript(code);
    }

    function inferLanguage(language,value) {
      const lang = String(language || '').toLowerCase();
      if (lang) return lang;
      const text = String(value || '');
      if (/<!doctype\s+html|<html[\s>]/i.test(text) || /<\/?[a-z][^>]*>/i.test(text)) return 'html';
      if (/[.#]?[\w-]+\s*\{[\s\S]*:[^}]+;?[\s\S]*\}/.test(text)) return 'css';
      return 'javascript';
    }

    function makeCode(code,language,className) {
      const pre = document.createElement('pre');
      pre.className = (className || '') + ' dt-syntax-code';
      pre.innerHTML = highlight(code,inferLanguage(language,code));
      return pre;
    }

    function attachEditor(editor,highlightEl,language) {
      if (!editor || !highlightEl) return;
      const refresh = () => {
        highlightEl.innerHTML = highlight(editor.value,inferLanguage(language,editor.value));
        highlightEl.scrollTop = editor.scrollTop;
        highlightEl.scrollLeft = editor.scrollLeft;
      };
      editor.classList.add('dt-syntax-editor-input');
      highlightEl.classList.add('dt-syntax-editor-highlight');
      editor.addEventListener('input',refresh);
      editor.addEventListener('scroll',() => {
        highlightEl.scrollTop = editor.scrollTop;
        highlightEl.scrollLeft = editor.scrollLeft;
      });
      refresh();
      return refresh;
    }

    function caretOffset(root) {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !root.contains(selection.anchorNode)) return 0;
      const range = document.createRange();
      range.selectNodeContents(root);
      range.setEnd(selection.anchorNode,selection.anchorOffset);
      return range.toString().length;
    }

    function restoreCaretOffset(root,offset) {
      const selection = window.getSelection();
      if (!selection) return;
      const walker = document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      let node, remaining = Math.max(0,offset);
      while ((node = walker.nextNode())) {
        if (remaining <= node.nodeValue.length) {
          const range = document.createRange();
          range.setStart(node,remaining);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        remaining -= node.nodeValue.length;
      }
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function attachEditable(editor,language) {
      if (!editor) return;
      editor.contentEditable = 'true';
      editor.spellcheck = false;
      const refresh = (restoreCaret) => {
        const position = restoreCaret ? caretOffset(editor) : 0;
        const top = editor.scrollTop, left = editor.scrollLeft;
        const value = editor.textContent || '';
        editor.innerHTML = highlight(value,inferLanguage(language,value));
        editor.scrollTop = top;
        editor.scrollLeft = left;
        if (restoreCaret) restoreCaretOffset(editor,position);
      };
      editor.addEventListener('input',() => refresh(true));
      refresh(false);
      return () => refresh(true);
    }

    return { highlight, inferLanguage, makeCode, attachEditor, attachEditable };
  })(),

  ui: (() => {
    function toggle() {
      const panel = getUIElement('devtools-panel');
      const resizer = getUIElement('devtools-resizer');
      if (!panel) return;
      const opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden',!opening);
      if (resizer) resizer.classList.toggle('hidden',!opening);
      if (opening) switchTab(DevToolsInternal.activeTab);
      else DevToolsInternal.elements.stopPicker();
      emitEvent('toggle',opening);
    }

    function refreshActiveViews() {
      const panel = getUIElement('devtools-panel');
      if (!panel || panel.classList.contains('hidden')) return;
      const tab = getActiveTab();
      if (!tab) return;
      if (DevToolsInternal.activeTab === 'elements') DevToolsInternal.elements.refresh(DevToolsInternal.elements.selected);
      else if (DevToolsInternal.activeTab === 'console') DevToolsInternal.console.render(tab);
      else if (DevToolsInternal.activeTab === 'sources') DevToolsInternal.sources.refresh();
      else if (DevToolsInternal.activeTab === 'network') DevToolsInternal.network.render();
      else if (DevToolsInternal.activeTab === 'performance') DevToolsInternal.performance.render();
      else if (DevToolsInternal.activeTab === 'application') DevToolsInternal.application.load(DevToolsInternal.application.type);
    }

    function switchTab(tabName) {
      DevToolsInternal.activeTab = tabName;
      const views = ['elements', 'console', 'sources', 'network', 'performance', 'application'];

      views.forEach(t => {
        const tabBtn = getUIElement(`dt-tab-${t}`);
        const view = getUIElement(`dt-view-${t}`);
        if (!tabBtn || !view) return;

        if (t === tabName) {
          tabBtn.classList.add('active');
          view.classList.remove('hidden');
          if (t === 'elements' || t === 'sources' || t === 'application') view.classList.add('flex');
        } else {
          tabBtn.classList.remove('active');
          view.classList.add('hidden');
          if (t === 'elements' || t === 'sources' || t === 'application') view.classList.remove('flex');
        }
      });

      if (tabName !== 'elements') DevToolsInternal.elements.stopPicker();
      refreshActiveViews();
      if (tabName === 'console') {
        const input = getUIElement('consoleInput');
        if (input) {
          input.value = DevToolsInternal.console.getDraft(getActiveTab());
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 120) + 'px';
          input.focus();
        }
      }
    }

    function clearForReload(tab) {
      if (!tab) return;
      DevToolsInternal.console.clearTab(tab);
      DevToolsInternal.network.clearTab(tab);

      // A reload starts a new source universe for the top-level page.
      // Clear the source state for the top page and every frame attached to it;
      // the normal request/document listeners will repopulate them from the new page.
      pageRecords.forEach(function(record) {
        if (record.rootPage === tab.page) DevToolsInternal.sources.clearTab(record.tab);
      });
    }

    function clearActive() {
      if (DevToolsInternal.activeTab === 'console') DevToolsInternal.console.clear();
      else if (DevToolsInternal.activeTab === 'network') DevToolsInternal.network.clear();
      else if (DevToolsInternal.activeTab === 'elements') DevToolsInternal.elements.refresh();
      else if (DevToolsInternal.activeTab === 'sources') DevToolsInternal.sources.refresh();
      else if (DevToolsInternal.activeTab === 'performance') DevToolsInternal.performance.render();
      else if (DevToolsInternal.activeTab === 'application') DevToolsInternal.application.load(DevToolsInternal.application.type);
    }

    return { toggle, switchTab, clearActive, clearForReload, refreshActiveViews };
  })(),

  console: (() => {
    const history = [];
    const drafts = new Map();
    let historyIndex = -1;
    let renderTab = null;
    const CORS_ERROR = {};

    function getLog(tab) {
      if (!tab) return [];
      getTabState(tab);
      getTabState(tab).consoleLog = getTabState(tab).consoleLog || [];
      return getTabState(tab).consoleLog;
    }

    function setDraft(tab,value) {
      if (tab) drafts.set(tab.id,String(value || ''));
      if (tab?.id === getActiveTabId() && DevToolsInternal.activeTab === 'console') {
        DevToolsInternal.util.scrollToBottom(getUIElement('consoleOutput'));
      }
    }

    function getDraft(tab) {
      return tab ? drafts.get(tab.id) || '' : '';
    }

    function resetHistory() {
      historyIndex = -1;
    }

    function getLogList(out) {
      if (!out) return null;
      let list = out.querySelector(':scope > .console-log-list');
      if (!list) {
        list = document.createElement('div');
        list.className = 'console-log-list';
        out.appendChild(list);
      }
      return list;
    }

    function filterLogText(txt) {
      if (!txt) return document.createTextNode('');
      const frag = document.createDocumentFragment();
      for (var i in cacheMap) (function(i){
        const original = cacheMap[i];
        const parts = txt.split(original);
        if (parts.length > 1) {
          frag.appendChild(document.createTextNode(parts[0]));
          const u = document.createElement('span');
          u.addEventListener('click',()=>emitEvent('open-url',original,true));
          u.className = 'log-url';
          u.textContent = i;
          frag.appendChild(u);
          txt = parts.slice(1).join(original);
        }
      })(i);
      frag.appendChild(document.createTextNode(String(txt)));
      return frag;
    }

    function deepCopy(o,map = new Map()) {
      if (typeof o !== 'object' || o === null) return o;
      if (map.has(o)) return map.get(o);
      try {
        if (o?.outerHTML) return o;
        var np;
        if (o instanceof Array) {
          np = o.constructor.from(o);
          np._length = o.length;
        } else {
          np = Object.create(Object.getPrototypeOf(o));
        }
        if (o.constructor && !o.constructor.toString().includes('[native code]')) np._constructor = o.constructor;
        map.set(o,np);
        for (var i in o) if (Object.prototype.hasOwnProperty.call(o,i)) np[i] = deepCopy(o[i],map);
        return np;
      } catch(e) {
        if (e.message && e.message.includes('cross-origin')) return CORS_ERROR;
        throw e;
      }
    }

    function logContainer(data, tab = renderTab || getActiveTab()) {
      if (browserConsole) {
        var node = browserConsole.add(data, {className:'log-line'});
        updateBadge(tab);
        return node;
      }
      const out = getUIElement('consoleOutput');
      if (!out) return null;
      const followBottom = DevToolsInternal.util.isNearBottom(out);
      const container = document.createElement('div');
      container.style.marginLeft = '4px';
      container.appendChild(data);
      container.classList.add('log-line');
      const list = getLogList(out);
      if (list) list.appendChild(container);
      if (followBottom) DevToolsInternal.util.scrollToBottom(out);
      updateBadge(tab);
      return container;
    }

    function renderValue(value, targetWin) {
      if (browserConsole) return browserConsole.renderValue(value,targetWin);
      return document.createTextNode(String(value));
    }
    function renderAnything(...args) {
      const targetTab = renderTab || getActiveTab();
      const targetWin = targetTab?.iframe?.contentWindow || window;
      for (const value of args) logContainer(renderValue(value,targetWin),targetTab);
    }

    function renderText(msg,tab) {
      return logContainer(browserConsole ? browserConsole.createText(msg) : getUIElement('consoleOutput') ? document.createTextNode(String(msg)) : document.createTextNode(''),tab);
    }
    function renderError(msg,tab) {
      return logContainer(browserConsole ? browserConsole.createError(msg) : (function(){ const span=document.createElement('span'); span.classList.add('log-error','log'); span.textContent=String(msg); return span; })(),tab);
    }
    function renderWarning(msg,tab) {
      return logContainer(browserConsole ? browserConsole.createWarning(msg) : (function(){ const span=document.createElement('span'); span.classList.add('log-warning','log'); span.textContent=String(msg); return span; })(),tab);
    }
    function renderRecord(record,tab) {
      renderTab = tab;
      try {
        if (record.kind === 'command') {
          const command = document.createElement('span');
          command.className = 'log-command';
          const prompt = document.createElement('span');
          prompt.className = 'log-command-prompt';
          prompt.textContent = '> ';
          command.appendChild(prompt);
          command.appendChild(DevToolsInternal.syntax.makeCode(record.text,'javascript','log-command-code'));
          const comm = logContainer(command,tab);
          if (comm) {
            comm.addEventListener('click',() => {
              const input = getUIElement('consoleInput');
              if (input) {
                input.value = record.text;
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight,120) + 'px';
              }
              setDraft(tab,record.text);
            });
          }
        } else if (record.method === 'error') {
          renderError(record.args.map(a => typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch(e) { return String(a); } })() : String(a)).join(' '),tab);
        } else if (record.method === 'warn') {
          renderWarning(record.args.map(a => typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch(e) { return String(a); } })() : String(a)).join(' '),tab);
        } else {
          renderAnything(...(record.args || []));
        }
      } finally {
        renderTab = null;
      }
    }

    function updateBadge(tab) {
      const badge = getUIElement('dt-console-count');
      if (!badge) return;
      const count = getLog(tab).length;
      badge.textContent = count;
      badge.classList.toggle('hidden',count === 0);
    }

    function render(tab) {
      const out = getUIElement('consoleOutput');
      if (!out) return;
      const followBottom = DevToolsInternal.util.isNearBottom(out);
      const previousScrollTop = out.scrollTop;
      out.innerHTML = '';
      const list = getLogList(out);
      if (!tab) {
        updateBadge(null);
        return;
      }
      const filter = getUIElement('consoleFilter')?.value || 'all';
      const records = getLog(tab).filter(record => filter === 'all' || record.method === filter || record.kind === 'command');
      if (!records.length) {
        const empty = document.createElement('div');
        empty.className = 'console-empty-state';
        empty.innerHTML = '<span class=\"text-gray-500\">Console ready.</span> <span class=\"text-gray-600\">Type a JavaScript expression below; Shift+Enter inserts a new line.</span>';
        list.appendChild(empty);
      } else {
        records.forEach(record => renderRecord(record,tab));
      }
      requestAnimationFrame(() => {
        if (followBottom) DevToolsInternal.util.scrollToBottom(out);
        else out.scrollTop = previousScrollTop;
      });
    }

    function recordMessage(tab,method,args,sourceTab) {
      if (!tab) return;
      const logs = getLog(tab);
      logs.push({kind:'message',method,args:Array.isArray(args) ? args : [args],time:Date.now(),frameTabId:sourceTab?.id});
      if (logs.length > 1000) logs.splice(0,logs.length - 1000);
      if (tab.id === getActiveTabId() && DevToolsInternal.activeTab === 'console' && !getUIElement('devtools-panel')?.classList.contains('hidden')) renderRecord(logs[logs.length - 1],tab);
      updateBadge(tab);
    }

    function recordCommand(tab,text) {
      if (!tab) return;
      const logs = getLog(tab);
      const record = {kind:'command',text,time:Date.now()};
      logs.push(record);
      if (logs.length > 1000) logs.splice(0,logs.length - 1000);
      const normalized = String(text);
      const index = history.indexOf(normalized);
      if (index >= 0) history.splice(index,1);
      history.push(normalized);
      if (history.length > 500) history.splice(0,history.length - 500);
      if (tab.id === getActiveTabId() && DevToolsInternal.activeTab === 'console' && !getUIElement('devtools-panel')?.classList.contains('hidden')) renderRecord(record,tab);
      updateBadge(tab);
    }

    function filter() {
      render(getActiveTab());
    }

    function run(text) {
      const tab = getActiveTab();
      if (!tab?.page) return;
      text = String(text || '');
      if (!text.trim()) return;
      recordCommand(tab,text);
      resetHistory();
      setDraft(tab,'');
      (async function(){
        try {
          const result = await tab.page.runCommand(text);
          recordMessage(tab,'result',[result.value]);
        } catch(e) {
          recordMessage(tab,'error',[e.message]);
        }
        if (tab.id === getActiveTabId() && DevToolsInternal.activeTab === 'console') render(tab);
      })();
    }

    function handleInput(e) {
      const input = e.target;
      const tab = getActiveTab();
      if (!tab) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const val = input.value;
        if (val.trim()) {
          run(val);
          input.value = '';
          setDraft(tab,'');
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight,120) + 'px';
        }
        return;
      }

      if (e.key === 'Enter' && e.shiftKey) return;

      if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (input.selectionStart !== input.selectionEnd || input.selectionStart !== 0) return;
        e.preventDefault();
        if (historyIndex === -1) setDraft(tab,input.value);
        if (!history.length) return;
        if (historyIndex < history.length - 1) historyIndex++;
        input.value = history[history.length - 1 - historyIndex] || '';
        requestAnimationFrame(() => input.setSelectionRange(input.value.length,input.value.length));
        return;
      }

      if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (input.selectionStart !== input.selectionEnd || input.selectionEnd !== input.value.length) return;
        if (historyIndex === -1) return;
        e.preventDefault();
        if (historyIndex > 0) {
          historyIndex--;
          input.value = history[history.length - 1 - historyIndex] || '';
        } else {
          resetHistory();
          input.value = getDraft(tab);
        }
        requestAnimationFrame(() => input.setSelectionRange(input.value.length,input.value.length));
      }
    }

    function clearTab(tab) {
      if (!tab) return;
      getTabState(tab);
      getTabState(tab).consoleLog = [];
      if (tab.id === getActiveTabId()) render(tab);
    }

    function clear() {
      clearTab(getActiveTab());
    }

    return { getLog, setDraft, getDraft, resetHistory, recordMessage, recordCommand, filter, run, handleInput, clear, clearTab, render };
  })(),

  network: (() => {
    const requestIds = new WeakMap();
    const requestTabs = new WeakMap();
    const requestQueues = new Map();
    const requestRecords = new Map();
    const socketTabs = new Map();
    let nextRequestId = 1;
    let context = null;
    let renderTimer = null;
    let selectedRequest = null;
    let detailTab = 'headers';
    let activePreviewUrl = null;

    function headerObject(headers) {
      const out = {};
      if (!headers) return out;
      try {
        if (headers instanceof Headers || typeof headers.forEach === 'function') {
          headers.forEach((value,key) => out[key] = value);
          return out;
        }
      } catch(e) {}
      if (Array.isArray(headers)) headers.forEach(pair => { if (pair?.length >= 2) out[pair[0]] = pair[1]; });
      else if (typeof headers === 'object') Object.entries(headers).forEach(([key,value]) => out[key] = String(value));
      return out;
    }

    function getRequestHeaders(request) {
      return headerObject(request?.headers);
    }

    function getResponseHeaders(response) {
      return headerObject(response?.headers);
    }

    function isTextualContent(contentType) {
      const type = String(contentType || '').toLowerCase();
      return type.startsWith('text/') || type.includes('json') || type.includes('javascript') || type.includes('xml') || type.includes('svg') || type.includes('css') || type.includes('wasm');
    }

    function formatBytes(size) {
      if (size == null || size === '') return '';
      size = Number(size) || 0;
      if (size < 1024) return size + ' B';
      if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' KB';
      return (size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    }

    function formatDuration(ms) {
      if (ms == null || !isFinite(ms)) return '';
      if (ms < 1000) return Math.round(ms) + ' ms';
      return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
    }

    function getTypeName(req) {
      if (!req) return '';
      if (req.websocketFrame || req.method === 'WEBSOCKET' || req.type === 'websocket connection' || req.type === 'websocket') return 'WS';
      if (req.contentType) {
        const type = String(req.contentType).toLowerCase().split(';')[0].trim();
        if (type === 'text/html') return 'Document';
        if (type.includes('javascript') || type === 'application/ecmascript') return 'Script';
        if (type === 'text/css') return 'Stylesheet';
        if (type.startsWith('image/')) return 'Image';
        if (type.startsWith('audio/')) return 'Audio';
        if (type.startsWith('video/')) return 'Media';
        if (type.includes('font')) return 'Font';
        if (type.includes('json') || type.includes('xml') || type.startsWith('text/')) return 'Fetch';
      }
      const type = String(req.type || '').toLowerCase();
      if (type.includes('css')) return 'Stylesheet';
      if (type.includes('script') || type === 'js') return 'Script';
      if (type.includes('image')) return 'Image';
      if (type.includes('font')) return 'Font';
      if (type.includes('media')) return 'Media';
      if (type.includes('xhr') || type.includes('fetch') || type.includes('json')) return 'Fetch';
      return type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Other';
    }

    function isFailedRequest(req) {
      return !!(req?.error || (!req?.pending && (req?.status == null || Number(req.status) >= 400)));
    }

    function getRequestName(url) {
      const raw = String(url || '');
      try {
        const u = new URL(raw);
        const path = u.pathname || '';
        const parts = path.split('/').filter(Boolean);
        let name = parts.length ? decodeURIComponent(parts[parts.length - 1]) : '';
        if (!name) name = u.hostname || raw;
        if (u.search) name += u.search;
        return name || raw;
      } catch(e) {
        const clean = raw.split('#')[0];
        const queryIndex = clean.indexOf('?');
        const base = queryIndex >= 0 ? clean.slice(0,queryIndex) : clean;
        const query = queryIndex >= 0 ? clean.slice(queryIndex) : '';
        const parts = base.split('/').filter(Boolean);
        return (parts.length ? parts[parts.length - 1] : base || raw) + query;
      }
    }

    function isJsonRequest(req) {
      const contentType = String(req?.contentType || '').toLowerCase();
      if (contentType.includes('json')) return true;
      const url = String(req?.url || '').split('?')[0].split('#')[0].toLowerCase();
      return /\.json$/.test(url);
    }

    function createNetworkIcon(req) {
      const wrap = document.createElement('span');
      wrap.className = 'network-request-icon inline-flex items-center justify-center flex-none w-4 h-4 mr-1 align-middle';
      wrap.setAttribute('aria-hidden','true');

      if (isFailedRequest(req)) {
        wrap.classList.add('text-red-500');
        wrap.innerHTML = '<i class="fa-solid fa-circle-xmark text-[14px]"></i>';
        wrap.title = 'Request failed';
        return wrap;
      }

      if (req?.websocketFrame || req?.method === 'WEBSOCKET' || req?.type === 'websocket connection' || req?.type === 'websocket') {
        wrap.classList.add('text-fuchsia-400');
        wrap.innerHTML = '<span class="font-bold text-[15px] leading-none">↔</span>';
        wrap.title = 'WebSocket';
        return wrap;
      }

      const type = getTypeName(req);
      if (type === 'Image') {
        const img = document.createElement('img');
        img.className = 'network-request-thumb w-4 h-4 rounded-[2px] object-cover border border-gray-700/80 bg-gray-900';
        img.alt = '';
        img.loading = 'lazy';
        img.title = 'Image';
        wrap.appendChild(img);
        if (req?._networkIconUrl) {
          img.src = req._networkIconUrl;
        } else if (req?.response && typeof req.response.clone === 'function') {
          req.response.clone().blob().then(blob => {
            if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) return;
            if (!req._networkIconUrl) req._networkIconUrl = URL.createObjectURL(blob);
            if (img.isConnected) img.src = req._networkIconUrl;
          }).catch(() => {});
        }
        return wrap;
      }

      if (isJsonRequest(req)) {
        wrap.classList.add('text-amber-300');
        wrap.innerHTML = '<span class="font-mono font-bold text-[9px] leading-none">{;}</span>';
        wrap.title = 'JSON';
        return wrap;
      }

      if (type === 'Script') {
        wrap.className = 'network-request-icon inline-flex items-center justify-center flex-none w-4 h-4 mr-1 rounded-[2px] border border-yellow-500/70 bg-yellow-500/10 text-yellow-300 align-middle';
        wrap.innerHTML = '<span class="font-mono font-bold text-[8px] leading-none">&lt;&gt;</span>';
        wrap.title = 'Script';
        return wrap;
      }

      if (type === 'Stylesheet') {
        wrap.classList.add('text-cyan-300');
        wrap.innerHTML = '<i class="fa-solid fa-file-lines text-[13px]"></i>';
        wrap.title = 'Stylesheet';
        return wrap;
      }

      if (type === 'Font') {
        wrap.classList.add('text-pink-400');
        wrap.innerHTML = '<i class="fa-solid fa-font text-[12px]"></i>';
        wrap.title = 'Font';
        return wrap;
      }

      if (type === 'Media' || type === 'Audio') {
        wrap.classList.add('text-orange-300');
        wrap.innerHTML = '<i class="fa-solid fa-photo-film text-[12px]"></i>';
        wrap.title = type;
        return wrap;
      }

      wrap.classList.add('text-blue-400');
      wrap.innerHTML = '<i class="fa-solid fa-file-lines text-[13px]"></i>';
      wrap.title = type || 'Document';
      return wrap;
    }

    function revokeNetworkIconUrl(req) {
      if (!req?._networkIconUrl) return;
      try { URL.revokeObjectURL(req._networkIconUrl); } catch(e) {}
      req._networkIconUrl = null;
    }

    function requestKey(request,type) {
      return `${request?.method || 'GET'} ${request?.url || ''} ${type || ''}`;
    }

    function queueRequestId(key,id) {
      const queue = requestQueues.get(key) || [];
      queue.push(id);
      requestQueues.set(key,queue);
    }

    function consumeRequestId(key) {
      const queue = requestQueues.get(key);
      if (!queue?.length) return null;
      const id = queue.shift();
      if (queue.length) requestQueues.set(key,queue);
      else requestQueues.delete(key);
      return id;
    }

    function removeQueuedRequestId(id) {
      for (const [key,queue] of requestQueues) {
        const index = queue.indexOf(id);
        if (index < 0) continue;
        queue.splice(index,1);
        if (queue.length) requestQueues.set(key,queue);
        else requestQueues.delete(key);
        return;
      }
    }

    function getNetworkRootTab(tab) {
      let current = tab || null;
      const seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        const parentPage = current.page?.parent || null;
        if (parentPage && parentPage !== false) {
          const parentRecord = pageRecords.get(parentPage);
          if (parentRecord?.tab) { current = parentRecord.tab; continue; }
        }
        if (current.parentTab) { current = current.parentTab; continue; }
        break;
      }
      return current || tab || null;
    }

    function looksLikeSourceForNetwork(request,type) {
      const u=String(request?.url || '').split('#')[0].split('?')[0].toLowerCase();
      const t=String(type || '').toLowerCase();
      return t === 'import' || /\.(?:js|mjs|cjs)$/.test(u) || t.includes('script');
    }

    function handleRequestStart(request,type,explicitTab) {
      const sourceTab = explicitTab || context;
      if (!sourceTab || !request) return;
      requestTabs.set(request,sourceTab);

      // Network is page-scoped like DevTools: requests made by child frames
      // belong to the top-level page's network log, not to an isolated frame
      // log. Sources/Console still retain the originating frame through
      // requestTabs.
      const tab = getNetworkRootTab(sourceTab);
      if (!tab || !isRecording(tab)) return;
      let url;
      try { url = new URL(request.url); } catch(e) { return; }
      const id = 'req-' + nextRequestId++;
      requestIds.set(request,id);
      const key = requestKey(request,type);
      requestRecords.set(id,{tab,key,sourceTab});
      queueRequestId(key,id);
      record({id,tabId:tab.id,frameTabId:sourceTab.id,url:url.href,origin:url.origin,method:request.method || 'GET',requestHeaders:headerObject(request.headers),type,pending:true,startedAt:performance.now()});
    }

    async function handleRequestEnd(response,request,type,explicitTab) {
      try {
      if (!request) return;
      if (!response) {
        const sourceTab = explicitTab || requestTabs.get(request);
        let id = requestIds.get(request);
        const key = requestKey(request,type);
        if (!id) id = consumeRequestId(key);
        else removeQueuedRequestId(id);
        const info = id ? requestRecords.get(id) : null;
        const tab = info?.tab || getNetworkRootTab(sourceTab);
        const previous = id && tab ? getLog(tab).find(r => r.id === id) : null;
        if (tab && id && previous && previous.pending) {
          let origin=''; try { origin=new URL(request.url).origin; } catch(e) {}
          record({id,tabId:tab.id,frameTabId:sourceTab?.id,url:request.url,origin,method:request.method || 'GET',requestHeaders:headerObject(request.headers),status:0,contentType:'',type,size:0,pending:false,error:'Request completed without a response',startedAt:previous.startedAt,duration:previous.startedAt != null ? Math.max(0,performance.now()-previous.startedAt) : null});
        }
        if(id) requestRecords.delete(id);
        return;
      }
      const sourceTab = explicitTab || requestTabs.get(request);
      let id = requestIds.get(request);
      const key = requestKey(request,type);
      if (!id) id = consumeRequestId(key);
      else removeQueuedRequestId(id);
      const recordInfo = id ? requestRecords.get(id) : null;
      const tab = recordInfo?.tab || getNetworkRootTab(sourceTab);
      const previous = id && tab ? getLog(tab).find(r => r.id === id) : null;
      if (!tab || !id || !previous) return;

      let url;
      try { url = new URL(request.url); } catch(e) { requestRecords.delete(id); return; }
      const blob = typeof response.clone === 'function' ? await response.clone().blob() : {size:0};
      const reqres = typeof response.clone === 'function' ? response.clone() : null;
      const contentType = (response.headers ? response.headers.get('content-type') : '') || blob.type || 'application/octet-stream';
      let responseText = null;
      try {
        if (response.__devtoolsSourceTextPromise) responseText = await response.__devtoolsSourceTextPromise;
      } catch(e) {}
      if (responseText == null && (isTextualContent(contentType) || looksLikeSourceForNetwork(request,type)) && blob.size <= 16 * 1024 * 1024) {
        try { responseText = await response.clone().text(); } catch(e) {}
      }

      record({id,tabId:tab.id,frameTabId:sourceTab?.id,url:url.href,origin:url.origin,method:request.method || 'GET',requestHeaders:headerObject(request.headers),status:response.status,contentType,type,size:blob.size,responseUrl:response.url || url.href,responseHeaders:headerObject(response.headers),responseText,response:reqres,pending:false,startedAt:previous.startedAt,duration:previous.startedAt != null ? Math.max(0,performance.now() - previous.startedAt) : null});
      requestRecords.delete(id);
      } catch(e) {
        try {
          var sourceTab = explicitTab || requestTabs.get(request);
          var id = request && (requestIds.get(request) || consumeRequestId(requestKey(request,type)));
          var info = id && requestRecords.get(id);
          var tab = info?.tab || getNetworkRootTab(sourceTab);
          var previous = id && tab ? getLog(tab).find(function(r){ return r.id === id; }) : null;
          if (tab && id && previous && previous.pending) {
            let status = 0;
            let contentType = '';
            let responseHeaders = {};
            try { status = Number(response?.status) || 0; } catch(_) {}
            try { contentType = response?.headers?.get?.('content-type') || ''; } catch(_) {}
            try { responseHeaders = headerObject(response?.headers); } catch(_) {}
            record({id,tabId:tab.id,frameTabId:sourceTab?.id,status,type,error:e?.message || String(e),contentType,responseHeaders,pending:false,startedAt:previous.startedAt,duration:previous.startedAt != null ? Math.max(0,performance.now()-previous.startedAt) : null});
          }
          if(id) requestRecords.delete(id);
        } catch(_) {}
      }
    }

    function failPendingRequest(pageOrTab,request,type,error) {
      const sourceTab = getPageTab(pageOrTab) || pageOrTab || null;
      if (!sourceTab || !request) return;
      const key = requestKey(request,type);
      const id = requestIds.get(request) || consumeRequestId(key);
      if (!id) return;
      const info = requestRecords.get(id);
      const tab = info?.tab || getNetworkRootTab(sourceTab);
      const previous = tab ? getLog(tab).find(r => r.id === id) : null;
      if (!previous || !previous.pending) { requestRecords.delete(id); return; }
      record({id,tabId:tab.id,frameTabId:sourceTab.id,status:0,contentType:'',type,pending:false,error:error?.message || String(error || 'Request failed'),duration:previous.startedAt != null ? Math.max(0,performance.now() - previous.startedAt) : null});
      requestRecords.delete(id);
    }

    function handleSocketStart(url,protocols,explicitTab) {
      let contexts = socketTabs.get(url) || [];
      let value = contexts.find(item => !item.startedAt);
      if (!value?.tab && (explicitTab || context)) {
        const sourceTab = explicitTab || context;
        const tab = getNetworkRootTab(sourceTab);
        value = {tab,sourceTab,recording:isRecording(tab)};
        contexts.push(value);
      }
      if (!value?.tab || !isRecording(value.tab)) return;

      value.startedAt = performance.now();
      value.id = 'req-' + nextRequestId++;
      value.protocols = protocols;
      socketTabs.set(url,contexts);

      return record({
        id:value.id,
        tabId:value.tab.id,
        frameTabId:value.sourceTab?.id,
        url,
        origin:new URL(url).origin,
        method:'GET',
        status:0,
        contentType:'',
        type:'websocket connection',
        size:0,
        pending:true,
        startedAt:value.startedAt,
        protocols
      });
    }

    function handleSocketEnd(url,protocols,socket,explicitTab) {
      const contexts = socketTabs.get(url) || [];
      const index = contexts.findIndex(item => item.id);
      const value = index >= 0 ? contexts[index] : (contexts.shift() || (explicitTab ? {tab:getNetworkRootTab(explicitTab),sourceTab:explicitTab,recording:true} : null));
      if (index >= 0) contexts.splice(index,1);
      if (contexts.length) socketTabs.set(url,contexts);
      else socketTabs.delete(url);
      if (!value?.tab || !isRecording(value.tab)) return;

      const duration = value.startedAt != null ? Math.max(0,performance.now() - value.startedAt) : 0;
      return record({
        id:value.id || 'req-' + nextRequestId++,
        tabId:value.tab.id,
        frameTabId:value.sourceTab?.id,
        url,
        origin:new URL(url).origin,
        method:'GET',
        status:101,
        contentType:'text/plain',
        type:'websocket connection',
        size:0,
        pending:false,
        startedAt:value.startedAt,
        duration,
        protocols:value.protocols || protocols,
        response:new Response('connected')
      });
    }

    function handleWebsocket(url,data,explicitTab) {
      const contexts = socketTabs.get(url) || [];
      const value = contexts.find(item=>item.sourceTab===explicitTab) || contexts[0] || (explicitTab ? {tab:getNetworkRootTab(explicitTab),sourceTab:explicitTab,recording:true} : null);
      if (!value?.tab || !isRecording(value.tab)) return;

      const payload = data?.data;
      let payloadPreview = null;
      try {
        if (typeof payload === 'string') payloadPreview = payload.slice(0,4096);
        else if (payload && typeof payload.byteLength === 'number') payloadPreview = `[Binary ${payload.byteLength} bytes]`;
        else if (payload != null) payloadPreview = String(payload).slice(0,4096);
      } catch(e) {}

      return record({
        id:'ws-' + url,
        tabId:value.tab.id,
        frameTabId:value.sourceTab?.id,
        url,
        origin:new URL(url).origin,
        method:'WEBSOCKET',
        status:data?.status,
        contentType:data?.contentType || 'application/octet-stream',
        type:'websocket',
        size:data?.size || (typeof payload?.byteLength === 'number' ? payload.byteLength : (typeof payload === 'string' ? payload.length : 0)),
        pending:false,
        websocketFrame:true,
        websocketPayload:payloadPreview,
        duration:data?.duration || null
      });
    }

    function getLog(tab) {
      if (!tab) return [];
      getTabState(tab);
      getTabState(tab).networkLog = getTabState(tab).networkLog || [];
      return getTabState(tab).networkLog;
    }

    function isRecording(tab) {
      return !!getTabState(tab)?.networkRecording;
    }

    function toggleRecording() {
      const tab = getActiveTab();
      if (!tab) return;
      getTabState(tab);
      getTabState(tab).networkRecording = !isRecording(tab);
      updateRecordingUI(tab);
      if (isRecording(tab)) emitEvent('toast','Network recording started','success');
      else emitEvent('toast','Network recording stopped');
    }

    function updateRecordingUI(tab) {
      const button = getUIElement('network-record-toggle');
      const status = getUIElement('network-record-status');
      const recording = isRecording(tab);
      if (button) {
        button.innerHTML = recording ? '<i class="fa-solid fa-stop mr-1"></i> Stop' : '<i class="fa-solid fa-circle mr-1"></i> Record';
        button.className = recording ? 'bg-rose-600 hover:bg-rose-500 text-white px-2 py-1 rounded text-[10px] font-semibold' : 'bg-indigo-600 hover:bg-indigo-500 text-white px-2 py-1 rounded text-[10px] font-semibold';
        button.title = recording ? 'Stop recording network activity for this tab' : 'Record network activity for this tab';
      }
      if (status) {
        status.textContent = recording ? 'Recording' : 'Stopped';
        status.className = recording ? 'text-rose-400 font-semibold' : 'text-gray-500';
      }
    }

    function getStatusClass(status) {
      if (!status) return 'text-gray-500';
      if (status >= 200 && status < 300) return 'text-emerald-400';
      if (status >= 300 && status < 400) return 'text-yellow-400';
      return 'text-rose-400';
    }

    function getScrollContainer(element) {
      let node = element;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight >= node.clientHeight) return node;
        node = node.parentElement;
      }
      return null;
    }

    function record(req) {
      const tab = req.tabId ? getTabs().find(t => t.id === req.tabId) : context || getActiveTab();
      if (!tab) return null;
      const log = getLog(tab);

      if (req.websocketFrame) {
        const wsEntry = log.find(r => r.websocketFrame && r.url === req.url);
        if (wsEntry) {
          wsEntry.status = req.status ?? wsEntry.status;
          wsEntry.contentType = req.contentType || wsEntry.contentType;
          wsEntry.frameCount = (wsEntry.frameCount || 0) + 1;
          wsEntry.size = (wsEntry.size || 0) + (req.size || 0);
          wsEntry.websocketPayload = req.websocketPayload;
          wsEntry.lastMessageAt = Date.now();
          wsEntry.duration = req.duration ?? wsEntry.duration;
          wsEntry.frames = wsEntry.frames || [];
          if (req.websocketPayload != null && wsEntry.frames.length < 50) wsEntry.frames.push({time:Date.now(),payload:req.websocketPayload,size:req.size || 0});
          scheduleRender();
          return wsEntry;
        }
      }

      const index = log.findIndex(r => r.id === req.id);
      if (index >= 0) log[index] = { ...log[index], ...req };
      else {
        if (!isRecording(tab)) return null;
        log.push({ ...req, frameCount: req.websocketFrame ? 1 : undefined, lastMessageAt: req.websocketFrame ? Date.now() : undefined, recordedAt: Date.now(), frames: req.websocketFrame ? [{time:Date.now(),payload:req.websocketPayload,size:req.size || 0}] : undefined });
      }

      if (log.length > 1000) {
        const removed = log.splice(0,log.length - 1000);
        removed.forEach(revokeNetworkIconUrl);
      }
      if (tab.id === getActiveTabId()) {
        const badge = getUIElement('dt-network-count');
        if (badge) {
          badge.textContent = log.length;
          badge.classList.toggle('hidden',log.length === 0);
        }
      }
      if (tab.id === getActiveTabId() && DevToolsInternal.activeTab === 'network' && !getUIElement('devtools-panel')?.classList.contains('hidden')) scheduleRender();
      return log[index >= 0 ? index : log.length - 1];
    }

    function scheduleRender() {
      if (renderTimer != null) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (DevToolsInternal.activeTab === 'network' && !getUIElement('devtools-panel')?.classList.contains('hidden')) render();
      },50);
    }

    function setDetailTab(name) {
      detailTab = name;
      showDetails(selectedRequest);
    }

    function getTemporalSelection(tab) {
      return getTabState(tab)?.networkSelection || null;
    }

    function setTemporalSelection(tab,start,end) {
      if (!tab) return;
      getTabState(tab);
      const a = Math.min(start,end);
      const b = Math.max(start,end);
      if (!isFinite(a) || !isFinite(b) || b - a < 0.5) {
        delete getTabState(tab).networkSelection;
      } else {
        getTabState(tab).networkSelection = {start:a,end:b};
      }
      render();
    }

    function clearTemporalSelection(tab) {
      if (!tab) return;
      if (getTabState(tab)) delete getTabState(tab).networkSelection;
      render();
    }

    function getWaterfallBarColor(req) {
      if (req?.pending) return '#eab308';
      if (req?.status >= 400 || req?.error) return '#ef4444';
      if (req?.status >= 300) return '#9ca3af';
      const colors = {
        'Document':'#60a5fa',
        'Script':'#facc15',
        'Stylesheet':'#22d3ee',
        'Image':'#4ade80',
        'Font':'#f472b6',
        'Media':'#fb923c',
        'Fetch':'#a78bfa',
        'WS':'#c084fc',
        'Audio':'#fb923c',
        'Other':'#94a3b8'
      };
      return colors[getTypeName(req)] || '#94a3b8';
    }

    function getWaterfallTimes(rows) {
      const now = performance.now();
      const values = rows.map(req => {
        const start = Number(req.startedAt ?? req.recordedAt ?? now);
        const duration = req.duration == null
          ? (req.pending ? Math.max(0.5, now - start) : 0.5)
          : Math.max(0.5, Number(req.duration) || 0.5);
        return {req,start,end:start + duration,duration};
      });
      if (!values.length) return {values,minStart:0,maxEnd:1,span:1};
      const minStart = Math.min(...values.map(x => x.start));
      const maxEnd = Math.max(...values.map(x => x.end));
      return {values,minStart,maxEnd,span:Math.max(1,maxEnd-minStart)};
    }

    function renderWaterfall(rows) {
      const container = getUIElement('network-waterfall');
      const tab = getActiveTab();
      if (!container || !tab) return;

      const selection = getTemporalSelection(tab);
      container.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'h-6 flex items-center px-2 border-b border-gray-800 text-[9px] uppercase tracking-wider text-gray-500 bg-[#151619]';
      const title = document.createElement('span');
      title.textContent = selection ? 'Request overview • time filter active' : 'Request overview • drag to filter by time';
      header.appendChild(title);

      if (selection) {
        const range = document.createElement('span');
        range.className = 'ml-2 text-gray-400 normal-case';
        range.textContent = `${formatDuration(selection.end - selection.start)}`;
        header.appendChild(range);

        const clearButton = document.createElement('button');
        clearButton.className = 'ml-auto w-4 h-4 flex items-center justify-center text-gray-500 hover:text-white';
        clearButton.title = 'Clear time filter';
        clearButton.innerHTML = '<i class="fa-solid fa-xmark text-[10px]"></i>';
        clearButton.onclick = e => { e.stopPropagation(); clearTemporalSelection(tab); };
        header.appendChild(clearButton);
      }
      container.appendChild(header);

      if (!rows.length) return;

      const canvas = document.createElement('canvas');
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '62px';
      canvas.style.cursor = 'crosshair';
      canvas.title = 'Drag across the timeline to select a time range';
      container.appendChild(canvas);

      const rect = () => canvas.getBoundingClientRect();
      const draw = (selectionPreview = null) => {
        const box = rect();
        const dpr = Math.max(1,window.devicePixelRatio || 1);
        const width = Math.max(1,Math.floor(box.width));
        const height = 62;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr,0,0,dpr,0,0);
        ctx.clearRect(0,0,width,height);

        const {values,minStart,span} = getWaterfallTimes(rows);
        const toX = time => ((time - minStart) / span) * width;

        ctx.fillStyle = '#151619';
        ctx.fillRect(0,0,width,height);

        ctx.strokeStyle = '#25272d';
        ctx.lineWidth = 1;
        for (let i=0;i<=5;i++) {
          const x = Math.round((i / 5) * width) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x,0);
          ctx.lineTo(x,height);
          ctx.stroke();
        }

        const lanes = [];
        const laneHeight = 6;
        const laneGap = 1;
        const top = 17;
        const maxLanes = Math.max(1,Math.floor((height-top-3)/(laneHeight+laneGap)));
        values.slice().sort((a,b) => a.start-b.start).forEach(item => {
          let lane = 0;
          while (lane < lanes.length && lanes[lane] > item.start) lane++;
          if (lane >= maxLanes) lane = maxLanes - 1;
          lanes[lane] = item.end;
          item.lane = lane;
        });

        values.forEach(item => {
          const x = Math.max(0,toX(item.start));
          const endX = Math.min(width,Math.max(x+1,toX(item.end)));
          const barWidth = Math.max(1,endX-x);
          const y = top + item.lane*(laneHeight+laneGap);
          ctx.fillStyle = getWaterfallBarColor(item.req);
          ctx.globalAlpha = item.req.pending ? 0.75 : 0.88;
          ctx.fillRect(x,y,barWidth,laneHeight);
          ctx.globalAlpha = 1;
          if (item.req.status >= 300 && item.req.status < 400) {
            ctx.fillStyle = '#6b7280';
            ctx.fillRect(x,y,Math.min(2,barWidth),laneHeight);
          } else if (item.req.status >= 400 || item.req.error) {
            ctx.fillStyle = '#f87171';
            ctx.fillRect(x,y,Math.min(2,barWidth),laneHeight);
          }
        });

        ctx.fillStyle = '#6b7280';
        ctx.font = '8px monospace';
        ctx.textBaseline = 'top';
        for (let i=0;i<=5;i++) {
          const t = (i/5)*span;
          const x = Math.min(width-2,Math.max(2,((i/5)*width)));
          const label = formatDuration(t) || '0 ms';
          ctx.fillText(label,x === width-2 ? x-ctx.measureText(label).width : x+2,3);
        }

        const activeSelection = selectionPreview || selection;
        if (activeSelection) {
          const sx = Math.max(0,Math.min(width,toX(activeSelection.start)));
          const ex = Math.max(0,Math.min(width,toX(activeSelection.end)));
          const left = Math.min(sx,ex);
          const right = Math.max(sx,ex);
          ctx.fillStyle = 'rgba(148,163,184,0.12)';
          ctx.fillRect(left,0,right-left,height);
          ctx.strokeStyle = '#94a3b8';
          ctx.lineWidth = 1;
          ctx.strokeRect(left+0.5,0.5,Math.max(0,right-left-1),height-1);
          ctx.fillStyle = '#d1d5db';
          ctx.fillRect(left,0,1,height);
          ctx.fillRect(right-1,0,1,height);
        }
        return {minStart,span,width};
      };

      let dragStart = null;
      let dragCurrent = null;
      let geometry = draw();

      const pointToTime = event => {
        const box = rect();
        const x = Math.max(0,Math.min(box.width,event.clientX-box.left));
        return geometry.minStart + (x / Math.max(1,geometry.width)) * geometry.span;
      };

      canvas.addEventListener('pointerdown',event => {
        if (event.button !== 0) return;
        canvas.setPointerCapture?.(event.pointerId);
        dragStart = pointToTime(event);
        dragCurrent = dragStart;
        geometry = draw({start:dragStart,end:dragCurrent});
      });
      canvas.addEventListener('pointermove',event => {
        if (dragStart == null) return;
        dragCurrent = pointToTime(event);
        geometry = draw({start:dragStart,end:dragCurrent});
      });
      canvas.addEventListener('pointerup',event => {
        if (dragStart == null) return;
        dragCurrent = pointToTime(event);
        const start = Math.min(dragStart,dragCurrent);
        const end = Math.max(dragStart,dragCurrent);
        setTemporalSelection(tab,start,end);
        dragStart = dragCurrent = null;
      });
      canvas.addEventListener('pointercancel',() => { dragStart = dragCurrent = null; geometry = draw(); });

      if (selection) geometry = draw(selection);
    }

    function render() {
      const tbody = getUIElement('network-log-body');
      if (!tbody) return;
      const scrollContainer = getScrollContainer(tbody);
      const followBottom = DevToolsInternal.util.isNearBottom(scrollContainer);
      const previousScrollTop = scrollContainer?.scrollTop || 0;
      const activeTab = getActiveTab();
      const networkLog = getLog(activeTab);
      updateRecordingUI(activeTab);

      const query = (getUIElement('network-filter')?.value || '').trim().toLowerCase();
      const statusFilter = getUIElement('network-status-filter')?.value || 'all';
      const typeFilter = getUIElement('network-type-filter')?.value || 'all';

      const types = [...new Set(networkLog.map(getTypeName).filter(Boolean))].sort();
      const typeSelect = getUIElement('network-type-filter');
      if (typeSelect) {
        const current = typeSelect.value;
        typeSelect.innerHTML = '<option value="all">All Types</option>' + types.map(type => `<option value="${sanitizeHTML(type)}">${sanitizeHTML(type)}</option>`).join('');
        typeSelect.value = types.includes(current) ? current : 'all';
      }

      const overviewRows = networkLog.filter(req => {
        const text = `${req.url} ${req.method || ''} ${req.contentType || ''} ${getTypeName(req)}`.toLowerCase();
        if (query && !text.includes(query)) return false;
        if (typeFilter !== 'all' && getTypeName(req) !== typeFilter) return false;
        if (statusFilter === 'pending' && !req.pending) return false;
        if (/^[2-5]xx$/.test(statusFilter)) {
          const group = Number(statusFilter[0]);
          if (req.status == null || Math.floor(req.status / 100) !== group) return false;
        }
        return true;
      });

      const selection = getTemporalSelection(activeTab);
      const rows = selection ? overviewRows.filter(req => {
        const start = Number(req.startedAt ?? req.recordedAt ?? 0);
        const duration = req.duration == null ? (req.pending ? Math.max(0,performance.now() - start) : 0) : Math.max(0,Number(req.duration) || 0);
        const end = start + duration;
        return !(end < selection.start || start > selection.end);
      }) : overviewRows;

      tbody.innerHTML = '';
      renderWaterfall(overviewRows);
      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-gray-500 italic">No recorded requests. Press Record to capture activity.</td></tr>';
        return;
      }

      rows.forEach(req => {
        const tr = document.createElement('tr');
        tr.className = `hover:bg-gray-800 border-b border-gray-800/50 cursor-pointer text-[10px] ${selectedRequest === req ? 'bg-[#2b2d31]' : ''}`;

        const name = document.createElement('td');
        name.className = 'p-2 text-indigo-300 font-mono truncate';
        name.title = req.url;
        name.style.maxWidth = '1px';
        const nameInner = document.createElement('div');
        nameInner.className = 'flex items-center min-w-0';
        nameInner.appendChild(createNetworkIcon(req));
        const urlLabel = document.createElement('span');
        urlLabel.className = 'truncate';
        urlLabel.textContent = getRequestName(req.url);
        nameInner.appendChild(urlLabel);
        name.appendChild(nameInner);

        const status = document.createElement('td');
        status.className = `p-2 ${getStatusClass(req.status)} font-semibold`;
        status.textContent = req.pending ? '…' : (req.status || 'ERR');

        const method = document.createElement('td');
        method.className = 'p-2 text-yellow-400';
        method.textContent = req.method || 'GET';

        const type = document.createElement('td');
        type.className = 'p-2 text-gray-400 truncate';
        type.textContent = getTypeName(req);
        type.title = `${getTypeName(req)}${req.contentType ? ' • ' + req.contentType : ''}${req.websocketFrame ? ' • ' + (req.frameCount || 0) + ' frames' : ''}`;

        const size = document.createElement('td');
        size.className = 'p-2 text-right text-gray-400';
        size.textContent = formatBytes(req.size);

        const time = document.createElement('td');
        time.className = 'p-2 text-right text-gray-400';
        time.textContent = req.duration == null ? '' : formatDuration(req.duration);

        tr.append(name,status,method,type,size,time);
        tr.onclick = () => showDetails(req);
        tbody.appendChild(tr);
      });

      requestAnimationFrame(() => {
        if (followBottom && scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
        else if (scrollContainer) scrollContainer.scrollTop = previousScrollTop;
      });
    }

    function headerTable(obj) {
      const rows = Object.entries(obj || {});
      if (!rows.length) return '<div class="p-3 text-gray-500 italic">No headers recorded.</div>';
      return `<table class="w-full text-left border-collapse text-[10px]"><tbody>${rows.map(([key,value]) => `<tr class="border-b border-gray-800/60"><td class="p-2 align-top text-indigo-300 w-1/3">${sanitizeHTML(key)}</td><td class="p-2 text-gray-300 break-all">${sanitizeHTML(value)}</td></tr>`).join('')}</tbody></table>`;
    }

    function revokePreviewUrl() {
      if (activePreviewUrl) {
        try { URL.revokeObjectURL(activePreviewUrl); } catch(e) {}
        activePreviewUrl = null;
      }
    }

    function sanitizePreviewHtml(html) {
      try {
        const doc = new DOMParser().parseFromString(String(html || ''),'text/html');
        doc.querySelectorAll('script,iframe,frame,object,embed,portal,meta[http-equiv]').forEach(node => node.remove());
        doc.querySelectorAll('*').forEach(node => {
          Array.from(node.attributes).forEach(attr => {
            if (/^on/i.test(attr.name) || /^(?:javascript|vbscript):/i.test(attr.value)) node.removeAttribute(attr.name);
          });
        });
        return '<!doctype html>' + doc.documentElement.outerHTML;
      } catch(e) { return String(html || ''); }
    }

    function getResponseLanguage(req,text) {
      const contentType = String(req?.contentType || '').toLowerCase().split(';')[0].trim();
      if (contentType.includes('json')) return 'javascript';
      if (contentType.includes('javascript') || contentType.includes('ecmascript')) return 'javascript';
      if (contentType.includes('css')) return 'css';
      if (contentType.includes('html') || contentType.includes('xml') || contentType.includes('svg')) return 'html';

      const rawUrl = String(req?.url || '').split('#')[0];
      const path = rawUrl.split('?')[0].toLowerCase();
      if (/\.(?:m?js|cjs)$/.test(path)) return 'javascript';
      if (/\.css$/.test(path)) return 'css';
      if (/\.(?:html?|xhtml|xml|svg)$/.test(path)) return 'html';

      return DevToolsInternal.syntax.inferLanguage('',text);
    }

    function makeResponseCode(req,text,className) {
      const language = getResponseLanguage(req,text);
      return DevToolsInternal.syntax.makeCode(text,language,className);
    }

    async function renderPreview(req,container) {
      if (!container) return;
      revokePreviewUrl();
      container.innerHTML = '';
      container.className = 'flex-1 min-h-0 overflow-auto bg-[#151619]';
      if (req.websocketFrame) {
        const label = document.createElement('div');
        label.className = 'px-3 pt-2 text-[9px] text-gray-500 uppercase tracking-wider';
        label.textContent = `Latest WebSocket payload • ${req.frameCount || 0} frames`;
        const pre = document.createElement('pre');
        pre.className = 'm-0 p-3 whitespace-pre-wrap break-all text-[10px] text-emerald-400';
        pre.textContent = req.websocketPayload || '';
        container.append(label,pre);
        return;
      }

      const contentType = String(req.contentType || '').toLowerCase().split(';')[0].trim();
      if (!req.response && !req.responseText) {
        const empty = document.createElement('div');
        empty.className = 'p-4 text-gray-500 italic';
        empty.textContent = req.pending ? 'Request is still pending.' : 'Response body was not retained. Record the request before it starts to capture a preview.';
        container.appendChild(empty);
        return;
      }

      if (contentType === 'text/html' && req.responseText != null) {
        const toolbar = document.createElement('div');
        toolbar.className = 'flex items-center gap-1 px-2 py-1 border-b border-gray-800 bg-[#111214] flex-none';
        const renderedButton = document.createElement('button');
        renderedButton.className = 'px-1.5 py-0.5 rounded text-[9px] dt-subtab active';
        renderedButton.textContent = 'Rendered';
        const sourceButton = document.createElement('button');
        sourceButton.className = 'px-1.5 py-0.5 rounded text-[9px] dt-subtab';
        sourceButton.textContent = 'Source';

        const view = document.createElement('div');
        view.className = 'flex-1 min-h-0 overflow-hidden';

        const frame = document.createElement('iframe');
        frame.className = 'w-full h-full min-h-[220px] border-0 bg-white';
        frame.setAttribute('sandbox','');
        frame.srcdoc = sanitizePreviewHtml(req.responseText);

        const source = makeResponseCode(req,req.responseText,'w-full h-full min-h-0 p-3 text-[10px] overflow-auto whitespace-pre-wrap break-all');
        source.classList.add('hidden');
        view.append(frame,source);

        renderedButton.onclick = () => {
          renderedButton.classList.add('active');
          sourceButton.classList.remove('active');
          frame.classList.remove('hidden');
          source.classList.add('hidden');
        };
        sourceButton.onclick = () => {
          sourceButton.classList.add('active');
          renderedButton.classList.remove('active');
          source.classList.remove('hidden');
          frame.classList.add('hidden');
        };

        toolbar.append(renderedButton,sourceButton);
        container.append(toolbar,view);
        return;
      }

      if (req.responseText != null && isTextualContent(contentType)) {
        const code = makeResponseCode(req,req.responseText,'w-full h-full min-h-0 p-3 text-[10px] overflow-auto whitespace-pre-wrap break-all');
        container.appendChild(code);
        return;
      }

      if (contentType.startsWith('image/') && req.response) {
        try {
          const blob = await req.response.clone().blob();
          activePreviewUrl = URL.createObjectURL(blob);
          const img = document.createElement('img');
          img.src = activePreviewUrl;
          img.className = 'block max-w-full max-h-full mx-auto object-contain p-3';
          img.alt = req.url;
          container.appendChild(img);
          return;
        } catch(e) {}
      }

      if (contentType.startsWith('audio/') && req.response) {
        try {
          const blob = await req.response.clone().blob();
          activePreviewUrl = URL.createObjectURL(blob);
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.src = activePreviewUrl;
          audio.className = 'm-4 w-[calc(100%-2rem)]';
          container.appendChild(audio);
          return;
        } catch(e) {}
      }

      if (contentType.startsWith('video/') && req.response) {
        try {
          const blob = await req.response.clone().blob();
          activePreviewUrl = URL.createObjectURL(blob);
          const video = document.createElement('video');
          video.controls = true;
          video.src = activePreviewUrl;
          video.className = 'block max-w-full max-h-full mx-auto p-3';
          container.appendChild(video);
          return;
        } catch(e) {}
      }

      if (contentType === 'application/pdf' && req.response) {
        try {
          const blob = await req.response.clone().blob();
          activePreviewUrl = URL.createObjectURL(blob);
          const frame = document.createElement('iframe');
          frame.className = 'w-full h-full min-h-[260px] border-0';
          frame.src = activePreviewUrl;
          container.appendChild(frame);
          return;
        } catch(e) {}
      }

      const pre = document.createElement('pre');
      pre.className = 'm-0 p-3 whitespace-pre-wrap break-all text-[10px] text-emerald-400';
      pre.textContent = req.responseText ?? `[Binary response • ${formatBytes(req.size) || 0}]`;
      container.appendChild(pre);
    }

    async function showDetails(req) {
      const drawer = getUIElement('network-detail-drawer');
      if (!drawer) return;
      selectedRequest = req || null;
      revokePreviewUrl();
      if (!req) {
        drawer.classList.add('hidden');
        return;
      }

      const detailTabs = ['headers','preview','response','timing'];
      drawer.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'flex items-center justify-between px-2 py-1 border-b border-gray-800 flex-shrink-0';
      const left = document.createElement('div');
      left.className = 'flex items-center gap-1';
      detailTabs.forEach(name => {
        const button = document.createElement('button');
        button.className = `dt-subtab ${detailTab === name ? 'active' : ''}`;
        button.textContent = name[0].toUpperCase() + name.slice(1);
        button.onclick = () => setDetailTab(name);
        left.appendChild(button);
      });
      const close = document.createElement('button');
      close.className = 'text-gray-400 hover:text-white px-1';
      close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      close.onclick = closeDetails;
      header.append(left,close);

      const urlLine = document.createElement('div');
      urlLine.className = 'px-2 py-1.5 border-b border-gray-800 bg-[#0f1012] text-[10px] flex-shrink-0';
      urlLine.style.userSelect = 'text';
      urlLine.style.webkitUserSelect = 'text';
      urlLine.innerHTML = `<span class="text-gray-500">URL</span> <span class="text-cyan-300 break-all">${sanitizeHTML(req.url)}</span>`;

      const body = document.createElement('div');
      body.className = 'flex-1 min-h-0 overflow-hidden';

      if (detailTab === 'headers') {
        body.innerHTML = `<div class="grid grid-cols-2 gap-3 p-2 overflow-auto h-full"><div><div class="text-gray-500 mb-1 uppercase text-[9px] tracking-wider">Request</div>${headerTable(req.requestHeaders)}${req.method ? `<div class="mt-2 text-[10px] text-gray-500">Method <span class="text-yellow-400">${sanitizeHTML(req.method)}</span></div>` : ''}</div><div><div class="text-gray-500 mb-1 uppercase text-[9px] tracking-wider">Response</div>${headerTable(req.responseHeaders)}${req.status ? `<div class="mt-2 text-[10px] text-gray-500">Status <span class="${getStatusClass(req.status)}">${sanitizeHTML(req.status)}</span></div>` : ''}</div></div>`;
      } else if (detailTab === 'response') {
        const text = req.responseText ?? '[Response body was not retained. Record the request before it starts to capture the body.]';
        const pre = makeResponseCode(req,text,'m-0 h-full min-h-0 w-full p-3 text-[10px] overflow-auto whitespace-pre-wrap break-all');
        body.appendChild(pre);
      } else if (detailTab === 'timing') {
        body.innerHTML = `<div class="grid grid-cols-2 gap-3 p-3 text-[10px]"><div><span class="text-gray-500">Started</span><div class="text-gray-200">${req.startedAt == null ? '-' : req.startedAt.toFixed(2) + ' ms'}</div></div><div><span class="text-gray-500">Duration</span><div class="text-gray-200">${req.duration == null ? (req.pending ? 'Pending' : '-') : formatDuration(req.duration)}</div></div><div><span class="text-gray-500">Size</span><div class="text-gray-200">${formatBytes(req.size) || '-'}</div></div><div><span class="text-gray-500">Recorded</span><div class="text-gray-200">${req.recordedAt ? new Date(req.recordedAt).toLocaleTimeString() : '-'}</div></div></div>`;
      } else {
        await renderPreview(req,body);
      }

      drawer.append(header,urlLine,body);
      drawer.classList.remove('hidden');
    }

    function closeDetails() {
      revokePreviewUrl();
      const drawer = getUIElement('network-detail-drawer');
      if (drawer) drawer.classList.add('hidden');
      selectedRequest = null;
    }

    function clearTab(tab) {
      if (!tab) return;
      getTabState(tab);
      (getTabState(tab).networkLog || []).forEach(revokeNetworkIconUrl);
      getTabState(tab).networkLog = [];
      delete getTabState(tab).networkSelection;
      if (tab.id === getActiveTabId()) {
        revokePreviewUrl();
        selectedRequest = null;
        const tbody = getUIElement('network-log-body');
        if (tbody) tbody.innerHTML = '';
        const waterfall = getUIElement('network-waterfall');
        if (waterfall) waterfall.innerHTML = '';
        closeDetails();
        const badge = getUIElement('dt-network-count');
        if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
      }
    }

    function clear() {
      clearTab(getActiveTab());
    }

    function getPageTab(pageOrTab) {
      if (!pageOrTab) return null;
      if (pageOrTab.page) return pageOrTab;
      return pageRecords.get(pageOrTab)?.tab || null;
    }

    async function requestForTab(page,...args) {
      try {
        var net=getNetwork(page);
        if(!net) throw new Error('No network available for page');
        return await net.request(...args);
      } catch(error) {
        failPendingRequest(page,args[0],args[3] || 'fetch',error);
        throw error;
      }
    }

    async function socketForTab(page,...args) {
      var net=getNetwork(page);
      if(!net) throw new Error('No network available for page');
      return await net.socket(...args);
    }

    function getContext(){ return context; }
    function getRequestTab(request){ return requestTabs.get(request) || null; }

    return { getLog, isRecording, toggleRecording, updateRecordingUI, getTypeName, record, render, clear, clearTab, setDetailTab, showDetails, closeDetails, getPageTab, getNetworkRootTab, requestForTab, socketForTab, getRequestHeaders, getResponseHeaders, isTextualContent, formatBytes, formatDuration, getContext, getRequestTab, handleRequestStart, handleRequestEnd, handleSocketStart, handleSocketEnd, handleWebsocket };
  })(),

  elements: (() => {
    let selected = null;
    let nodeMap = new WeakMap();
    let detailTab = 'html';
    const picker = {active:false,overlay:null,highlight:null,label:null};

    function getOriginalAttributeInfo(node,attrName,attrValue) {
      const raw = node.getAttribute('data-raw-' + attrName);
      if (raw != null) return {value:raw,processed:attrValue};
      return {value:attrValue,processed:null};
    }

    function getLabel(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      const id = node.id ? `#${node.id}` : '';
      const classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean).slice(0,3).map(v => '.' + v).join('') : '';
      return tag + id + classes;
    }

    function buildAttributeHtml(node) {
      let attrHtml = '';
      Array.from(node.attributes).forEach(attr => {
        if (attr.name.startsWith('data-raw-')) return;
        const info = getOriginalAttributeInfo(node,attr.name,attr.value);
        attrHtml += ` <span class="dom-attr-name">${sanitizeHTML(attr.name)}</span>=<span class="dom-attr-val">"${sanitizeHTML(info.value)}"</span>`;
        if (info.processed != null) attrHtml += `<span class="text-[9px] text-gray-600" title="Processed value is available in the live DOM">*</span>`;
      });
      return attrHtml;
    }

    function createChildren(container,node,depth) {
      Array.from(node.children).forEach(child => container.appendChild(buildNode(child,depth)));
    }

    function buildNode(node,depth = 0) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
      const div = document.createElement('div');
      div.className = 'dom-node-container';
      div.dataset.domDepth = depth;
      div.dataset.domSearch = getLabel(node).toLowerCase();

      const hasChildren = node.children.length > 0;
      const nodeWrapper = document.createElement('div');
      nodeWrapper.className = 'dom-node';
      nodeWrapper.dataset.domNode = getLabel(node);

      const caretSpan = document.createElement('span');
      caretSpan.className = 'dom-caret';
      caretSpan.textContent = hasChildren ? (depth < 2 ? '▼' : '▶') : ' ';

      const contentSpan = document.createElement('span');
      contentSpan.className = 'dom-node-content';
      contentSpan.innerHTML = `&lt;<span class="dom-tag">${sanitizeHTML(node.tagName.toLowerCase())}</span>${buildAttributeHtml(node)}&gt;`;
      nodeWrapper.append(caretSpan,contentSpan);
      div.appendChild(nodeWrapper);
      nodeMap.set(node,nodeWrapper);

      let childrenContainer = null;
      let populated = false;
      const populateChildren = () => {
        if (populated || !hasChildren) return;
        childrenContainer = document.createElement('div');
        createChildren(childrenContainer,node,depth + 1);
        div.appendChild(childrenContainer);
        populated = true;
      };
      if (hasChildren) {
        if (depth < 2) populateChildren();
        caretSpan.onclick = e => {
          e.stopPropagation();
          populateChildren();
          const collapsed = childrenContainer.style.display === 'none';
          childrenContainer.style.display = collapsed ? 'block' : 'none';
          caretSpan.textContent = collapsed ? '▼' : '▶';
        };
      }
      contentSpan.onclick = e => {
        e.stopPropagation();
        select(node,true);
      };
      return div;
    }

    function select(node,scrollTree = false) {
      selected = node;
      refresh(node,scrollTree);
      renderDetails();
    }

    function refresh(nodeToSelect = selected,scrollTree = false) {
      const container = getUIElement('dom-tree-container');
      if (!container) return;
      container.innerHTML = '';
      nodeMap = new WeakMap();
      const doc = DevToolsInternal.util.getActiveDocument();
      if (!doc || !doc.documentElement) {
        container.innerHTML = '<div class="text-gray-500 italic p-2">Frame document loading...</div>';
        return;
      }
      const treeRoot = buildNode(doc.documentElement,0);
      container.appendChild(treeRoot);
      const target = nodeToSelect && nodeToSelect.ownerDocument === doc ? nodeToSelect : (selected && selected.ownerDocument === doc ? selected : doc.documentElement);
      if (target) {
        selected = target;
        updateBreadcrumbs(target);
        const wrapper = nodeMap.get(target);
        if (wrapper && scrollTree) wrapper.scrollIntoView({behavior:'smooth',block:'center'});
        getUIQuerySelectorAll('.dom-node.selected').forEach(n => n.classList.remove('selected'));
        wrapper?.classList.add('selected');
      }
    }

    function updateBreadcrumbs(node) {
      const out = getUIElement('dom-breadcrumbs');
      if (!out) return;
      const path = [];
      let current = node;
      while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 10) {
        path.unshift(current);
        current = current.parentElement;
      }
      out.innerHTML = '';
      path.forEach((item,index) => {
        const span = document.createElement('span');
        span.className = 'cursor-pointer hover:text-gray-200';
        span.textContent = getLabel(item) || item.tagName.toLowerCase();
        span.onclick = () => select(item,true);
        out.appendChild(span);
        if (index < path.length - 1) out.appendChild(document.createTextNode('  ›  '));
      });
    }

    function filterTree(value) {
      const query = String(value || '').trim().toLowerCase();
      getUIQuerySelectorAll('#dom-tree-container .dom-node-container').forEach(el => {
        if (!query) { el.style.display = ''; return; }
        const selfMatch = (el.dataset.domSearch || '').includes(query);
        const childMatch = el.querySelector('.dom-node-container[style=""]') || false;
        el.style.display = selfMatch || childMatch ? '' : 'none';
      });
    }

    function switchDetailTab(tabName) {
      detailTab = tabName;
      ['html','styles','properties','attributes'].forEach(name => getUIElement(`element-detail-tab-${name}`)?.classList.toggle('active',name === tabName));
      renderDetails();
    }

    function renderDetails() {
      const summary = getUIElement('element-summary');
      const content = getUIElement('element-detail-content');
      if (!summary || !content) return;
      if (!selected || !selected.isConnected) {
        summary.textContent = 'Select an element to inspect it.';
        content.innerHTML = '';
        return;
      }
      summary.innerHTML = `<span class="text-indigo-300 font-mono">${sanitizeHTML(getLabel(selected))}</span><span class="text-gray-500 ml-2">${sanitizeHTML(selected.namespaceURI || 'HTML')}</span>`;
      updateBreadcrumbs(selected);
      content.innerHTML = '';
      if (detailTab === 'html') renderHtml(content);
      else if (detailTab === 'styles') renderStyles(content);
      else if (detailTab === 'properties') renderProperties(content);
      else renderAttributes(content);
    }

    function renderHtml(container) {
      container.classList.add('flex','flex-col','min-h-0');
      const editorWrap = document.createElement('div');
      editorWrap.className = 'flex-1 min-h-0 overflow-hidden';
      const editor = document.createElement('div');
      editor.id = 'selected-element-editor';
      editor.className = 'dt-code-editor w-full h-full bg-[#1e1f22] text-gray-200 font-mono text-xs p-3 outline-none overflow-auto';
      editor.style.minHeight = '180px';
      editor.dataset.rawHtml = selected.outerHTML;
      editor.textContent = selected.outerHTML;
      editorWrap.appendChild(editor);
      container.appendChild(editorWrap);
      DevToolsInternal.syntax.attachEditable(editor,'html');
      const toolbar = document.createElement('div');
      toolbar.className = 'flex items-center gap-1 p-2 border-b border-gray-800';
      const apply = document.createElement('button');
      apply.className = 'bg-indigo-600 hover:bg-indigo-500 text-white px-2 py-1 rounded text-[10px] font-semibold';
      apply.textContent = 'Apply';
      apply.onclick = applySelectedHtml;
      const copy = document.createElement('button');
      copy.className = 'text-gray-400 hover:text-white px-2 py-1 text-[10px]';
      copy.textContent = 'Copy';
      copy.onclick = () => DevToolsInternal.sources.copyText(editor.value);
      const scroll = document.createElement('button');
      scroll.className = 'text-gray-400 hover:text-white px-2 py-1 text-[10px]';
      scroll.textContent = 'Scroll to node';
      scroll.onclick = scrollSelected;
      toolbar.append(apply,copy,scroll);
      container.appendChild(toolbar);
      const textInfo = document.createElement('div');
      textInfo.className = 'p-2 text-[10px] text-gray-500';
      textInfo.textContent = `Text content: ${String(selected.textContent || '').trim().slice(0,300) || '[empty]'}`;
      container.appendChild(textInfo);
    }

    function renderStyles(container) {
      let styles;
      try { styles = selected.ownerDocument.defaultView.getComputedStyle(selected); } catch(e) { styles = null; }
      if (!styles) { container.innerHTML = '<div class="p-3 text-gray-500">Computed styles unavailable.</div>'; return; }
      const filter = document.createElement('input');
      filter.className = 'm-2 w-[calc(100%-1rem)] bg-[#111214] border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200 outline-none';
      filter.placeholder = 'Filter properties…';
      const table = document.createElement('table');
      table.className = 'w-full border-collapse font-mono text-[10px]';
      const render = () => {
        const query = filter.value.toLowerCase();
        table.innerHTML = '';
        for (let i = 0; i < styles.length; i++) {
          const name = styles[i];
          if (query && !name.toLowerCase().includes(query)) continue;
          const value = styles.getPropertyValue(name);
          if (!value) continue;
          const tr = document.createElement('tr');
          tr.className = 'border-b border-gray-800/60';
          tr.innerHTML = `<td class="px-2 py-1 text-gray-500 align-top w-1/2">${sanitizeHTML(name)}</td><td class="px-2 py-1 text-gray-200 break-all">${sanitizeHTML(value)}</td>`;
          table.appendChild(tr);
        }
      };
      filter.oninput = render;
      container.append(filter,table);
      render();
    }

    function renderProperties(container) {
      const values = {nodeName:selected.nodeName,nodeType:selected.nodeType,id:selected.id,className:typeof selected.className === 'string' ? selected.className : String(selected.className || ''),textContent:String(selected.textContent || '').trim().slice(0,1000),childElementCount:selected.childElementCount,parentElement:selected.parentElement ? getLabel(selected.parentElement) : '',isConnected:selected.isConnected};
      if ('value' in selected) values.value = selected.value;
      if ('href' in selected) values.href = selected.href;
      if ('src' in selected) values.src = selected.getAttribute('data-raw-src') || selected.src;
      if ('checked' in selected) values.checked = selected.checked;
      if ('disabled' in selected) values.disabled = selected.disabled;
      const table = document.createElement('table');
      table.className = 'w-full border-collapse text-[10px] font-mono';
      Object.entries(values).forEach(([key,value]) => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-gray-800/60';
        tr.innerHTML = `<td class="px-2 py-1 text-gray-500 align-top w-1/3">${sanitizeHTML(key)}</td><td class="px-2 py-1 text-gray-200 break-all">${sanitizeHTML(String(value ?? ''))}</td>`;
        table.appendChild(tr);
      });
      container.appendChild(table);
    }

    function renderAttributes(container) {
      const table = document.createElement('table');
      table.className = 'w-full border-collapse text-[10px] font-mono';
      Array.from(selected.attributes).forEach(attr => {
        if (attr.name.startsWith('data-raw-')) return;
        const info = getOriginalAttributeInfo(selected,attr.name,attr.value);
        const tr = document.createElement('tr');
        tr.className = 'border-b border-gray-800/60';
        tr.innerHTML = `<td class="px-2 py-1 text-gray-500 align-top w-1/3">${sanitizeHTML(attr.name)}</td><td class="px-2 py-1 text-indigo-300 break-all">${sanitizeHTML(info.value)}</td><td class="px-2 py-1 text-gray-500 break-all">${info.processed != null ? sanitizeHTML(info.processed) : ''}</td>`;
        table.appendChild(tr);
      });
      const head = document.createElement('div');
      head.className = 'grid grid-cols-3 px-2 py-1 text-[9px] uppercase tracking-wider text-gray-600 border-b border-gray-800';
      head.innerHTML = '<span>Name</span><span>Original</span><span>Active</span>';
      container.append(head,table);
    }

    function applySelectedHtml() {
      const node = selected;
      const editor = getUIElement('selected-element-editor');
      if (!node || !editor || !node.parentElement) return;
      const parent = node.parentElement;
      const oldIndex = Array.from(parent.children).indexOf(node);
      try {
        const html = editor.value != null ? editor.value : (editor.textContent || '');
        node.outerHTML = html;
        const next = parent.children[oldIndex] || parent.children[Math.max(0,oldIndex - 1)];
        selected = next || parent;
        refresh(selected,true);
        renderDetails();
        emitEvent('toast','Element updated','success');
      } catch(e) {
        emitEvent('toast','Could not apply HTML: ' + e.message,'error');
      }
    }

    function scrollSelected() {
      try { selected?.scrollIntoView({behavior:'smooth',block:'center'}); } catch(e) {}
    }

    function togglePicker() {
      if (picker.active) stopPicker();
      else startPicker();
    }

    function startPicker() {
      const tab = getActiveTab();
      if (!tab || !tab.iframe) return emitEvent('toast','No active page to inspect','error');
      const doc = DevToolsInternal.util.getActiveDocument();
      if (!doc) return emitEvent('toast','Page is still loading','error');
      stopPicker();
      picker.active = true;
      getUIElement('dt-pick-element')?.classList.add('bg-emerald-600');
      const overlay = document.createElement('div');
      overlay.id = 'dt-picker-overlay';
      overlay.style.cssText = 'position:fixed;z-index:99999;pointer-events:auto;cursor:crosshair;';
      const highlight = document.createElement('div');
      highlight.style.cssText = 'position:absolute;pointer-events:none;border:2px solid #38bdf8;background:rgba(56,189,248,.10);box-sizing:border-box;display:none;';
      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;pointer-events:none;background:#111214;color:#e5e7eb;border:1px solid #38bdf8;padding:2px 4px;font:10px monospace;white-space:nowrap;display:none;';
      overlay.append(highlight,label);
      document.body.appendChild(overlay);
      picker.overlay = overlay;
      picker.highlight = highlight;
      picker.label = label;
      const updateBounds = () => {
        if (!picker.overlay || !tab.iframe.isConnected) return;
        const rect = tab.iframe.getBoundingClientRect();
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
      };
      updateBounds();
      window.addEventListener('resize',updateBounds);
      overlay._updateBounds = updateBounds;
      overlay.addEventListener('mousemove',event => {
        const rect = tab.iframe.getBoundingClientRect();
        const node = doc.elementFromPoint(event.clientX - rect.left,event.clientY - rect.top);
        if (!node || node.nodeType !== Node.ELEMENT_NODE) {
          highlight.style.display = 'none';
          label.style.display = 'none';
          return;
        }
        const nodeRect = node.getBoundingClientRect();
        highlight.style.display = 'block';
        highlight.style.left = nodeRect.left + 'px';
        highlight.style.top = nodeRect.top + 'px';
        highlight.style.width = Math.max(1,nodeRect.width) + 'px';
        highlight.style.height = Math.max(1,nodeRect.height) + 'px';
        label.textContent = getLabel(node);
        label.style.display = 'block';
        label.style.left = Math.max(0,nodeRect.left) + 'px';
        label.style.top = Math.max(0,nodeRect.top - 18) + 'px';
      });
      overlay.addEventListener('click',event => {
        const rect = tab.iframe.getBoundingClientRect();
        const node = doc.elementFromPoint(event.clientX - rect.left,event.clientY - rect.top);
        if (node && node.nodeType === Node.ELEMENT_NODE) {
          select(node,true);
          DevToolsInternal.ui.switchTab('elements');
        }
        stopPicker();
      });
    }

    function stopPicker() {
      if (picker.overlay?._updateBounds) window.removeEventListener('resize',picker.overlay._updateBounds);
      picker.overlay?.remove();
      picker.overlay = null;
      picker.highlight = null;
      picker.label = null;
      picker.active = false;
      getUIElement('dt-pick-element')?.classList.remove('bg-emerald-600');
    }

    function inspect(targetInfo) {
      const node = targetInfo?.target;
      if (node?.nodeType === Node.ELEMENT_NODE) selected = node;
      const panel = getUIElement('devtools-panel');
      if (panel?.classList.contains('hidden')) DevToolsInternal.ui.toggle();
      DevToolsInternal.ui.switchTab('elements');
      refresh(selected,true);
      renderDetails();
    }

    function isPickerActive(){ return picker.active; }

    return { get selected(){return selected;}, select, refresh, filter:filterTree, switchDetailTab, renderDetails, togglePicker, startPicker, stopPicker, inspect, getLabel, scrollSelected, applySelectedHtml, isPickerActive };
  })(),

  sources: (() => {
    let mode = 'original';
    let entry = null;
    let search = '';
    const sourceBuckets = new Map();
    const sourceRequests = new Map();
    const frameDocumentTrackers = new WeakMap();

    function resolveUrl(rawUrl,baseUrl) {
      try { return new URL(rawUrl,baseUrl).href; } catch(e) { return rawUrl; }
    }

    function sourceEntryNameFromUrl(url,index,fallback) {
      try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const name = decodeURIComponent(parts[parts.length - 1] || fallback);
        return name || fallback;
      } catch(e) { return fallback || `(resource ${index + 1})`; }
    }

    // Sources owns its own URL naming/grouping. Keep this separate from the
    // Network panel's final-segment display name so Network formatting can
    // never flatten or otherwise alter the Sources hierarchy.
    function sourcePathFromUrl(url) {
      try {
        const u = new URL(url);
        return u.pathname || '/';
      } catch(e) { return '/'; }
    }


    function getSourceBucket(tab) {
      if (!tab) return null;
      let bucket = sourceBuckets.get(tab);
      if (!bucket) {
        bucket = new Map();
        sourceBuckets.set(tab,bucket);
      }
      return bucket;
    }

    function looksLikeJavaScript(url,type,contentType) {
      const u = String(url || '');
      const t = String(type || '').toLowerCase();
      const c = String(contentType || '').toLowerCase();
      return t === 'import' || /(?:^|[/?#])[^/?#]+\.(?:js|mjs)(?:[?#]|$)/i.test(u) || c.includes('javascript') || c.includes('ecmascript');
    }

    function looksLikeCSS(url,type,contentType) {
      const u = String(url || '');
      const t = String(type || '').toLowerCase();
      const c = String(contentType || '').toLowerCase();
      return t === 'stylesheet' || t === 'css' || /(?:^|[/?#])[^/?#]+\.css(?:[?#]|$)/i.test(u) || c.includes('text/css');
    }

    function looksLikeSource(url,type,contentType) {
      return looksLikeJavaScript(url,type,contentType) || looksLikeCSS(url,type,contentType);
    }

    function handleRequestStart(request,type,explicitTab) {
      if (!request) return;
      let url;
      try { url = new URL(request.url).href; } catch(e) { return; }
      if (!looksLikeSource(url,type,'')) return;
      const tab = explicitTab || DevToolsInternal.network.getRequestTab(request) || DevToolsInternal.network.getContext() || getActiveTab();
      if (!tab) return;
      sourceRequests.set(request,{tab,url,type,startedAt:performance.now()});
    }

    async function handleRequestEnd(response,request,type,explicitTab) {
      try {
      if (!response || !request) return;
      let pending = sourceRequests.get(request);
      let url;
      try { url = new URL(request.url).href; } catch(e) { return; }
      let contentType = '';
      try { contentType = response.headers?.get?.('content-type') || ''; } catch(e) {}
      if (!pending) {
        if (!looksLikeSource(url,type,contentType)) return;
        const tab = explicitTab || DevToolsInternal.network.getRequestTab(request) || DevToolsInternal.network.getContext() || getActiveTab();
        if (!tab) return;
        pending = {tab,url,type,startedAt:performance.now()};
      }
      sourceRequests.delete(request);

      let text = null;
      try {
        if (response.__devtoolsSourceTextPromise) text = await response.__devtoolsSourceTextPromise;
      } catch(e) {}
      if (text == null) {
        try {
          const size = Number(response.headers?.get?.('content-length')) || 0;
          if (!size || size <= 16 * 1024 * 1024) text = await response.clone().text();
        } catch(e) {}
      }
      if (text == null) return;

      const bucket = getSourceBucket(pending.tab);
      if (!bucket) return;
      bucket.set(pending.url,{
        url:pending.url,
        text,
        contentType,
        requestType:pending.type || type || '',
        loadedAt:Date.now()
      });

      if (DevToolsInternal.activeTab === 'sources' && pending.tab.id === getActiveTabId()) {
        try { refresh(); } catch(e) {}
      }
      } catch(e) {}
    }

    function extractStringToken(code,start) {
      const quote = code[start];
      if (quote !== '"' && quote !== "'") return null;
      let i = start + 1;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === quote) {
          const raw = code.slice(start,i + 1);
          try { return {value:JSON.parse(quote === '"' ? raw : '"' + raw.slice(1,-1).replace(/\\'/g,"'").replace(/"/g,'\\"') + '"'),end:i + 1}; } catch(e) {
            try { return {value:raw.slice(1,-1),end:i + 1}; } catch(err) { return {value:'',end:i + 1}; }
          }
        }
        i++;
      }
      return null;
    }

    function lexModuleTokens(code) {
      const tokens = [];
      let i = 0;
      while (i < code.length) {
        const ch = code[i], next = code[i + 1];
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === '/' && next === '/') {
          const n = code.indexOf('\n',i + 2);
          i = n < 0 ? code.length : n + 1;
          continue;
        }
        if (ch === '/' && next === '*') {
          const n = code.indexOf('*/',i + 2);
          i = n < 0 ? code.length : n + 2;
          continue;
        }
        if (ch === '"' || ch === "'") {
          const token = extractStringToken(code,i);
          if (token) { tokens.push({type:'string',value:token.value,start:i,end:token.end}); i = token.end; continue; }
        }
        if (/[A-Za-z_$]/.test(ch)) {
          const m = code.slice(i).match(/^[A-Za-z_$][\w$]*/)[0];
          tokens.push({type:'word',value:m,start:i,end:i + m.length});
          i += m.length;
          continue;
        }
        tokens.push({type:'punct',value:ch,start:i,end:i + 1});
        i++;
      }
      return tokens;
    }

    function extractModuleSpecifiers(code) {
      const tokens = lexModuleTokens(String(code || ''));
      const specs = [];
      const add = value => {
        if (!value || typeof value !== 'string' || specs.includes(value)) return;
        specs.push(value);
      };

      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'word' || (t.value !== 'import' && t.value !== 'export')) continue;

        if (t.value === 'import') {
          const next = tokens[i + 1];
          if (next?.value === '.') continue; // import.meta
          if (next?.value === '(') {
            const arg = tokens[i + 2];
            if (arg?.type === 'string') add(arg.value);
            continue;
          }
          if (next?.type === 'string') {
            add(next.value);
            continue;
          }
        }

        for (let j = i + 1; j < tokens.length; j++) {
          if (tokens[j].type === 'punct' && tokens[j].value === ';') break;
          if (tokens[j].type === 'word' && tokens[j].value === 'from') {
            const spec = tokens[j + 1];
            if (spec?.type === 'string') add(spec.value);
            break;
          }
          if (tokens[j].type === 'word' && (tokens[j].value === 'import' || tokens[j].value === 'export')) break;
        }
      }
      return specs;
    }

    function getSourceResource(tab,url) {
      const bucket = sourceBuckets.get(tab);
      return bucket?.get(url) || null;
    }

    function extractWrappedModuleSource(activeCode) {
      const marker = 'window.__executeCodeModule(';
      const startMarker = String(activeCode || '').indexOf(marker);
      if (startMarker < 0) return null;
      let i = startMarker + marker.length;
      while (/\s/.test(activeCode[i] || '')) i++;
      if (activeCode[i] !== '"') return null;
      const token = extractStringToken(activeCode,i);
      return token?.value || null;
    }

    function extractCSSImports(code) {
      const source = String(code || '');
      const specs = [];
      const add = value => {
        value = String(value || '').trim();
        if (!value || value.startsWith('#') || specs.includes(value)) return;
        specs.push(value);
      };

      let i = 0;
      let quote = null;
      while (i < source.length) {
        const ch = source[i], next = source[i + 1];
        if (quote) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === quote) quote = null;
          i++;
          continue;
        }
        if (ch === '/' && next === '*') {
          const end = source.indexOf('*/',i + 2);
          i = end < 0 ? source.length : end + 2;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; i++; continue; }

        if (ch === '@' && source.slice(i,i + 7).toLowerCase() === '@import') {
          const before = i === 0 ? '' : source[i - 1];
          const after = source[i + 7] || '';
          if (/[\w-]/.test(before) || /[\w-]/.test(after)) { i++; continue; }
          i += 7;
          while (/[\s\n\r\t]/.test(source[i] || '')) i++;

          if (source.slice(i,i + 4).toLowerCase() === 'url(') {
            i += 4;
            while (/[\s\n\r\t]/.test(source[i] || '')) i++;
            let value = '';
            if (source[i] === '"' || source[i] === "'") {
              const q = source[i++];
              while (i < source.length) {
                if (source[i] === '\\' && i + 1 < source.length) { value += source[i + 1]; i += 2; continue; }
                if (source[i] === q) { i++; break; }
                value += source[i++];
              }
            } else {
              while (i < source.length && source[i] !== ')') value += source[i++];
              value = value.trim();
            }
            while (i < source.length && source[i] !== ')') i++;
            if (source[i] === ')') i++;
            add(value);
            continue;
          }

          if (source[i] === '"' || source[i] === "'") {
            const q = source[i++];
            let value = '';
            while (i < source.length) {
              if (source[i] === '\\' && i + 1 < source.length) { value += source[i + 1]; i += 2; continue; }
              if (source[i] === q) { i++; break; }
              value += source[i++];
            }
            add(value);
            continue;
          }
        }
        i++;
      }
      return specs;
    }

    function getSourceText(tab,url) {
      const captured = getSourceResource(tab,url);
      if (captured?.text != null) return {text:captured.text,contentType:captured.contentType || ''};
      const network = findNetworkResource(tab,url);
      if (network?.responseText != null) return {text:network.responseText,contentType:network.contentType || ''};
      const decoded = decodeDataUriText(url);
      if (decoded != null) return {text:decoded,contentType:/^data:text\/css/i.test(url) ? 'text/css' : ''};
      return null;
    }

    function mergeModuleDependencies(tab,entries,pushEntry) {
      const byUrl = new Map();
      entries.forEach(item => {
        const key = item.url ? resolveUrl(item.url,tab.url) : '';
        if (key && !byUrl.has(key)) byUrl.set(key,item);
      });

      const queue = entries.filter(item => (item.type === 'js' || item.type === 'css') && item.original);
      const visited = new Set();
      while (queue.length) {
        const current = queue.shift();
        const currentUrl = resolveUrl(current.url || tab.url,tab.url);
        const sourceType = current.type === 'css' ? 'css' : 'js';
        const visitKey = sourceType + ':' + currentUrl;
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);

        const specs = sourceType === 'css' ? extractCSSImports(current.original) : extractModuleSpecifiers(current.original);
        current.imports = [];
        current.importedBy = current.importedBy || [];
        specs.forEach(spec => {
          const resolved = resolveUrl(spec,currentUrl);
          current.imports.push({specifier:spec,url:resolved});
          let target = byUrl.get(resolved);
          if (!target) {
            const resource = getSourceText(tab,resolved);
            const type = sourceType === 'css' ? 'css' : 'js';
            target = {
              id:(sourceType === 'css' ? 'stylesheet-' : 'module-') + resolved,
              name:sourceEntryNameFromUrl(resolved,entries.length,type === 'css' ? 'style.css' : 'module.js'),
              type,
              url:resolved,
              deliveryUrl:resolved,
              activeUrl:resolved,
              original:resource?.text || '',
              active:resource?.text || '',
              kind:type === 'css' ? 'stylesheet' : 'module',
              importedModule:type === 'js' ? true : undefined,
              importedStylesheet:type === 'css' ? true : undefined,
              module:type === 'js',
              unavailable:!resource?.text
            };
            byUrl.set(resolved,target);
            pushEntry(target);
          }
          target.importedBy = target.importedBy || [];
          if (!target.importedBy.some(item => item.url === currentUrl)) target.importedBy.push({url:currentUrl,name:current.name});
          if (target.original && !visited.has((target.type || type) + ':' + resolved)) queue.push(target);
        });
      }
    }

    function decodeDataUriText(url) {
      if (!url || !/^data:/i.test(url)) return null;
      try {
        const comma = url.indexOf(',');
        if (comma < 0) return null;
        const meta = url.slice(5,comma);
        const payload = url.slice(comma + 1).split('#')[0];
        if (/;base64/i.test(meta)) {
          const binary = atob(payload);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new TextDecoder().decode(bytes);
        }
        return decodeURIComponent(payload);
      } catch(e) { return null; }
    }

    function findNetworkResource(tab,url) {
      const absolute = resolveUrl(url,tab?.url || location.href);
      const log = DevToolsInternal.network.getLog(tab);
      for (let i = log.length - 1; i >= 0; i--) if (log[i].url === absolute) return log[i];
      return null;
    }

    function classify(url,contentType = '') {
      const type = String(contentType || '').toLowerCase();
      if (type.includes('javascript') || /\.(?:js|mjs)(?:[?#]|$)/i.test(url)) return 'js';
      if (type.includes('css') || /\.css(?:[?#]|$)/i.test(url)) return 'css';
      if (type.includes('html') || /\.html?(?:[?#]|$)/i.test(url)) return 'html';
      return 'file';
    }

    function dataType(url) {
      const match = /^data:([^;,]+)/i.exec(url || '');
      return classify('',match ? match[1] : '');
    }

    function buildEntries(tab,doc) {
      const entries = [];
      const seen = new Set();
      const idPrefix = tab.subframe ? 'frame-' + String(tab.id || Math.random().toString(36).slice(2)) + '-' : 'top-' + String(tab.id || 'page') + '-';
      const makeId = (prefix,index) => idPrefix + prefix + index;
      const rawCandidate = tab.page?.rawDocument || getTabState(tab)?.rawDocument || '';
      const raw = !isBlankDocumentSource(rawCandidate) ? rawCandidate : (getTabState(tab)?.documentSource || '');
      const rawDoc = raw ? new DOMParser().parseFromString(raw,'text/html') : null;
      const processedDoc = doc;

      const push = value => {
        if (!value) return;
        value.sourceTab = tab;
        if (!value.id) value.id = makeId('entry-', entries.length);
        if (seen.has(value.id)) return;
        seen.add(value.id);
        entries.push(value);
      };

      const pageUrl = tab.url;
      const pageName = sourceEntryNameFromUrl(pageUrl,0,'index.html');
      push({id:makeId('document-',0),name:pageName,type:'html',url:pageUrl,deliveryUrl:pageUrl,sourcePath:sourcePathFromUrl(pageUrl),activeUrl:pageUrl,original:raw || '// Original document source was not retained.',active:processedDoc.documentElement?.outerHTML || '',kind:'page'});

      const rawScripts = rawDoc ? Array.from(rawDoc.scripts).filter(script => !isBrowserInjectedScript(script)) : [];
      const liveScripts = Array.from(processedDoc.scripts);
      const liveExternalScripts = new Map();
      liveScripts.forEach(script => {
        const rawSrc = script.getAttribute('data-raw-src');
        if (rawSrc) liveExternalScripts.set(resolveUrl(rawSrc,pageUrl),script);
      });
      const liveInlineScripts = liveScripts.filter(script => !script.getAttribute('data-raw-src') && !isBrowserInjectedScript(script) && !script.textContent?.includes('window.__pageRegistry'));
      let liveInlineIndex = 0;
      rawScripts.forEach((script,index) => {
        const rawUrl = script.getAttribute('src');
        const absoluteUrl = rawUrl ? resolveUrl(rawUrl,pageUrl) : null;
        const live = rawUrl ? liveExternalScripts.get(absoluteUrl) : liveInlineScripts[liveInlineIndex++];
        const net = absoluteUrl ? findNetworkResource(tab,absoluteUrl) : null;
        const captured = absoluteUrl ? getSourceResource(tab,absoluteUrl) : null;
        let original = script.textContent || '';
        if (!original && captured?.text != null) original = captured.text;
        if (!original && net?.responseText != null) original = net.responseText;
        const activeUrl = live?.getAttribute('src') || null;
        let active = live ? (live.textContent || decodeDataUriText(activeUrl)) : '';
        if (!original && activeUrl) original = extractWrappedModuleSource(decodeDataUriText(activeUrl) || '');
        if (!active && activeUrl) active = `// Active resource: ${activeUrl}`;
        push({id:makeId('script-',index),name:rawUrl ? sourceEntryNameFromUrl(absoluteUrl,index,'script.js') : `(inline script ${index + 1})`,type:'js',url:absoluteUrl || pageUrl,deliveryUrl:absoluteUrl || pageUrl,sourcePath:sourcePathFromUrl(absoluteUrl || pageUrl),activeUrl:activeUrl || pageUrl,original,active,kind:rawUrl ? 'resource' : 'inline',module:script.getAttribute('type') === 'module' || /\.mjs(?:[?#]|$)/i.test(absoluteUrl || '')});
      });

      const rawStyles = rawDoc ? Array.from(rawDoc.querySelectorAll('style,link[rel~="stylesheet"]')) : [];
      const liveStyles = Array.from(processedDoc.querySelectorAll('style,link[rel~="stylesheet"]'));
      rawStyles.forEach((style,index) => {
        const live = liveStyles[index];
        const rawUrl = style.tagName.toLowerCase() === 'link' ? style.getAttribute('href') : null;
        const absoluteUrl = rawUrl ? resolveUrl(rawUrl,pageUrl) : null;
        const net = absoluteUrl ? findNetworkResource(tab,absoluteUrl) : null;
        const captured = absoluteUrl ? getSourceResource(tab,absoluteUrl) : null;
        let original = style.textContent || '';
        if (!original && captured?.text != null) original = captured.text;
        if (!original && net?.responseText != null) original = net.responseText;
        const activeUrl = live?.getAttribute('href') || null;
        let active = live?.tagName?.toLowerCase() === 'link' ? decodeDataUriText(activeUrl) : (live?.textContent || '');
        if (!active && activeUrl) active = `// Active stylesheet: ${activeUrl}`;
        push({id:makeId('style-',index),name:rawUrl ? sourceEntryNameFromUrl(absoluteUrl,index,'style.css') : `(inline style ${index + 1})`,type:'css',url:absoluteUrl || pageUrl,deliveryUrl:absoluteUrl || pageUrl,sourcePath:sourcePathFromUrl(absoluteUrl || pageUrl),activeUrl:activeUrl || pageUrl,original,active,kind:rawUrl ? 'resource' : 'inline'});
      });

      DevToolsInternal.network.getLog(tab).forEach(req => {
        if (!req.responseText) return;
        if (!DevToolsInternal.network.isTextualContent(req.contentType || '') && !/\.(?:js|mjs|css|html?|json|txt)(?:[?#]|$)/i.test(req.url)) return;
        const id = makeId('network-' + req.id,0);
        if (seen.has(id) || entries.some(item => item.url === req.url)) return;
        push({id,name:sourceEntryNameFromUrl(req.url,entries.length,'resource'),type:classify(req.url,req.contentType),url:req.url,deliveryUrl:req.url,sourcePath:sourcePathFromUrl(req.url),activeUrl:req.url,original:req.responseText,active:req.responseText,kind:'network'});
      });

      // The live document exposes the processed delivery URLs. Keep them visible too,
      // including data: and blob: URLs instead of pretending they are normal files.
      processedDoc.querySelectorAll('[src],[href],[data]').forEach((node,index) => {
        ['src','href','data'].forEach(attrName => {
          const value = node.getAttribute(attrName);
          if (!value || !/^(?:data|blob):/i.test(value)) return;
          const tagName = node.tagName?.toLowerCase() || '';
          const isData = /^data:/i.test(value);
          if (isData && tagName === 'script' && attrName === 'src' && node.getAttribute('data-raw-src')) return;
          if (isData && tagName === 'link' && attrName === 'href' && node.getAttribute('data-raw-href')) return;
          const id = makeId(`${value.slice(0,4).toLowerCase()}-${index}-${attrName}-`,0);
          if (seen.has(id)) return;
          const decoded = isData ? decodeDataUriText(value) : null;
          const type = isData ? dataType(value) : classify(value,'');
          const mediaType = /^data:([^;,]+)/i.exec(value || '')?.[1] || '';
          if (isData && /^image\//i.test(mediaType)) return;
          const label = isData ? value.replace(/^(data:[^,;]+(?:;base64)?,).*/i,'$1…') : value;
          push({id,name:label,type,url:value,deliveryUrl:value,activeUrl:value,original:decoded || '',active:decoded || '',kind:isData ? 'data' : 'blob'});
        });
      });

      const capturedBucket = sourceBuckets.get(tab);
      if (capturedBucket) {
        capturedBucket.forEach((captured,url) => {
          if (!captured?.text) return;
          if (entries.some(item => resolveUrl(item.url || '',tab.url) === url)) return;
          push({
            id:makeId('module-',url),
            name:sourceEntryNameFromUrl(url,entries.length,'module.js'),
            type:'js',
            url,
            deliveryUrl:url,
            activeUrl:url,
            original:captured.text,
            active:captured.text,
            kind:captured.requestType === 'import' ? 'module' : 'network',
            module:captured.requestType === 'import' || /\.mjs(?:[?#]|$)/i.test(url)
          });
        });
      }

      mergeModuleDependencies(tab,entries,push);
      return entries;
    }

    function sourceGroupName(url) {
      const value = String(url || '');
      if (!value) return 'Other';
      if (/^data:/i.test(value)) return 'data:';
      if (/^blob:/i.test(value)) return 'blob:';
      if (/^about:/i.test(value)) return value.split(':')[0] === 'about' ? value : 'about:';
      try {
        const u = new URL(value);
        return u.host || u.hostname || u.protocol.replace(':','');
      } catch(e) {
        return 'Other';
      }
    }

    function sourceDomainLabel(url) {
      const value = String(url || '');
      if (/^data:/i.test(value)) return 'data:';
      if (/^blob:/i.test(value)) {
        try {
          const u = new URL(value);
          return u.origin && u.origin !== 'null' ? u.origin.replace(/^https?:\/\//i,'') : 'blob:';
        } catch(e) { return 'blob:'; }
      }
      if (/^about:srcdoc/i.test(value)) return 'about:srcdoc';
      try {
        const u = new URL(value);
        return (u.host || u.hostname || u.protocol.replace(':',''));
      } catch(e) { return 'Other'; }
    }

    function getFrameChildPage(parentPage,frameElement) {
      const direct = frameElement?.pageEmulator;
      if (direct) return direct;
      const children = Array.isArray(parentPage?.children) ? parentPage.children : [];
      for (const child of children) if (child?.iframe === frameElement) return child;
      return null;
    }

    function isBlankDocumentSource(value) {
      const text = String(value || '').replace(/\s+/g,'').toLowerCase();
      return !text || text === '<html><head></head><body></body></html>' || text === '<html><head></head><body></body></html>\n';
    }

    function isBrowserInjectedScript(value) {
      const code = typeof value === 'string' ? value : (value?.textContent || '');
      if (!code) return false;
      return (
        code.includes('createRuntimeInterceptor') &&
        code.includes('__pageRegistry') &&
        code.includes('__executeCodeModule') &&
        code.includes('__runSyncInterceptor')
      );
    }

    function createSourceSnapshot(doc) {
      if (!doc?.documentElement) return '';
      try {
        const clone = doc.documentElement.cloneNode(true);
        clone.querySelectorAll?.('script').forEach(script => {
          if (isBrowserInjectedScript(script)) script.remove();
        });
        return clone.outerHTML || '';
      } catch(e) {
        return doc.documentElement.outerHTML || '';
      }
    }

    function getDocumentSnapshot(frameElement) {
      try {
        return frameElement?.contentDocument || frameElement?.contentWindow?.document || null;
      } catch(e) { return null; }
    }

    function syncFrameDocument(frameTab,frameElement,notify=true) {
      if (!frameTab || !frameElement) return false;
      const doc = getDocumentSnapshot(frameElement);
      if (!doc?.documentElement) return false;

      const html = doc.documentElement.outerHTML || '';
      if (!html) return false;
      const sourceSnapshot = createSourceSnapshot(doc);

      getTabState(frameTab);
      getTabState(frameTab).processedDocument = html;

      // A dynamically populated srcdoc-like frame may never have a real srcdoc
      // attribute or a request-backed rawDocument. In that case the live document
      // itself is the best available source of the served content. Only replace a
      // missing/blank placeholder so genuine captured source isn't overwritten by
      // the processed DOM later.
      if (isBlankDocumentSource(getTabState(frameTab).rawDocument)) {
        getTabState(frameTab).documentSource = sourceSnapshot || html;
      }

      try {
        const href = frameElement.contentWindow?.location?.href;
        if (href && href !== 'about:blank' && href !== 'about:srcdoc') frameTab.url = href;
      } catch(e) {}

      if (notify && typeof refresh === 'function') {
        if (frameTab.__sourceRefreshQueued) return true;
        frameTab.__sourceRefreshQueued = true;
        requestAnimationFrame(() => {
          frameTab.__sourceRefreshQueued = false;
          try { refresh(); } catch(e) {}
        });
      }
      return true;
    }

    function installFrameDocumentTracker(frameTab,frameElement) {
      if (!frameTab || !frameElement) return;
      const existing = frameDocumentTrackers.get(frameTab);
      const doc = getDocumentSnapshot(frameElement);
      if (!doc) return;
      if (existing?.doc === doc) return;

      if (existing?.observer) {
        try { existing.observer.disconnect(); } catch(e) {}
      }

      const tracker = {doc,observer:null};
      frameDocumentTrackers.set(frameTab,tracker);

      syncFrameDocument(frameTab,frameElement,false);

      try {
        tracker.observer = new MutationObserver(() => syncFrameDocument(frameTab,frameElement,true));
        tracker.observer.observe(doc,{subtree:true,childList:true,attributes:true,characterData:true});
      } catch(e) {}

      try {
        frameElement.addEventListener('load',() => {
          const nextDoc = getDocumentSnapshot(frameElement);
          const current = frameDocumentTrackers.get(frameTab);
          if (!current || current.doc !== nextDoc) installFrameDocumentTracker(frameTab,frameElement);
          syncFrameDocument(frameTab,frameElement,true);
        });
      } catch(e) {}
    }

    function getServedFramePairs(tab,doc) {
      const liveFrames = doc ? Array.from(doc.querySelectorAll('iframe,frame')) : [];
      if (!liveFrames.length) return [];

      // The live frame element is the source of the frame declaration. Its
      // actual document source belongs to the child PageEmulator and is kept
      // in childPage.rawDocument (the exact value passed to setDocument()).
      // Do not reconstruct iframe sources by pairing the parent document's
      // original HTML with live frames: that loses dynamically appended frames
      // and can associate the wrong source with a frame.
      return liveFrames.map(frameElement => ({
        rawElement: frameElement,
        frameElement
      }));
    }

    function buildFrameContexts(tab,doc,parentPage,path,depth) {
      const contexts = [];
      getServedFramePairs(tab,doc).forEach((pair,index) => {
        const childPage = getFrameChildPage(parentPage,pair.frameElement);
        const frameTab = childPage ? pageRecords.get(childPage)?.tab : null;
        if (!frameTab) return;

        const framePath = path.concat(index + 1);
        frameTab.subframe = true;
        frameTab.parentTab = tab;
        frameTab.framePath = framePath;
        frameTab.frameElement = pair.frameElement;
        getTabState(frameTab);

        installFrameDocumentTracker(frameTab,pair.frameElement);
        const frameDoc = getDocumentSnapshot(pair.frameElement);
        const context = {
          tab:frameTab,
          doc:frameDoc,
          parentTab:tab,
          element:pair.frameElement,
          rawElement:pair.rawElement,
          path:framePath,
          depth,
          index,
          children:[]
        };
        context.children = buildFrameContexts(frameTab,frameDoc,childPage,framePath,depth + 1);
        contexts.push(context);
      });
      return contexts;
    }

    function getFrameContexts(rootTab) {
      if (!rootTab?.iframe) return [];
      const doc = rootTab.iframe.contentDocument || rootTab.iframe.contentWindow?.document || null;
      return buildFrameContexts(rootTab,doc,rootTab.page,[],1);
    }

    // Sources hierarchy intentionally uses sourceGroupName/sourceDomainLabel only.
    function buildDomainTree(entries) {
      const root = {type:'domains',name:'',children:new Map()};
      const query = search.toLowerCase();
      const visibleEntries = entries.filter(e => {
        if (!query) return true;
        return `${e.name} ${e.deliveryUrl || ''} ${e.activeUrl || ''}`.toLowerCase().includes(query);
      });

      const addPathEntry = (domain,entry) => {
        const rawUrl = entry.deliveryUrl || entry.url || '';
        const isHierarchical = /^(?:https?|file):/i.test(rawUrl);
        if (!isHierarchical) {
          domain.files = domain.files || [];
          domain.files.push(entry);
          return;
        }

        let pathname = sourcePathFromUrl(rawUrl) || '/';
        pathname = pathname.split('#')[0];
        const parts = pathname.split('/').filter(Boolean).map(part => {
          try { return decodeURIComponent(part); } catch(e) { return part; }
        });

        if (!parts.length) {
          domain.files = domain.files || [];
          domain.files.push(entry);
          return;
        }

        const fileName = parts.pop() || entry.name || 'index';
        let node = domain.path;
        parts.forEach(part => {
          let child = node.children.get(part);
          if (!child) {
            child = {type:'folder',name:part,children:new Map(),files:[]};
            node.children.set(part,child);
          }
          node = child;
        });
        node.files.push(entry);
      };

      visibleEntries.forEach(entry => {
        const key = sourceGroupName(entry.deliveryUrl || entry.url || '');
        let domain = root.children.get(key);
        if (!domain) {
          domain = {
            type:'domain',
            name:sourceDomainLabel(entry.deliveryUrl || entry.url || ''),
            children:new Map(),
            files:[],
            path:{type:'path-root',name:'',children:new Map(),files:[]},
            entryCount:0
          };
          root.children.set(key,domain);
        }
        addPathEntry(domain,entry);
        domain.entryCount++;
      });
      return root;
    }

    function sortedSourceFiles(files) {
      return (files || []).slice().sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));
    }

    function sortedSourceFolders(children) {
      return [...(children || new Map()).values()].sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));
    }

    function renderSourceFileRow(item,depth) {
      const row = document.createElement('div');
      row.className = `p-1 cursor-pointer hover:bg-[#2b2d31] rounded flex items-center gap-1.5 text-[10px] ${entry === item ? 'bg-[#2b2d31] source-entry-selected' : ''}`;
      row.style.paddingLeft = (depth * 12 + 4) + 'px';
      const icon = document.createElement('i');
      icon.className = sourceEntryIconClass(item) + ' w-3 text-center flex-shrink-0';
      const label = document.createElement('span');
      label.className = 'truncate';
      label.textContent = item.name;
      row.dataset.sourceEntry = item.id || '';
      row.title = `${item.deliveryUrl || item.url || ''}${item.activeUrl && item.activeUrl !== item.deliveryUrl ? '\nActive: ' + item.activeUrl : ''}`;
      row.onclick = e => { e.stopPropagation(); openEntry(item); };
      row.append(icon,label);
      return row;
    }

    function renderSourceFolder(node,depth) {
      const wrap = document.createElement('div');
      const parts = createTreeRow(node.name,'fa-solid fa-folder text-yellow-500',depth,true,()=>{},'source-path-folder');
      const contents = document.createElement('div');
      contents.style.display = 'block';

      sortedSourceFolders(node.children).forEach(child => {
        contents.appendChild(renderSourceFolder(child,depth + 1));
      });
      sortedSourceFiles(node.files).forEach(item => {
        contents.appendChild(renderSourceFileRow(item,depth + 1));
      });

      parts.row.onclick = e => {
        e.stopPropagation();
        const collapsed = contents.style.display === 'none';
        contents.style.display = collapsed ? 'block' : 'none';
        parts.caret.textContent = collapsed ? '▼' : '▶';
      };
      wrap.append(parts.row,contents);
      return wrap;
    }

    function domainIconClass() {
      return 'fa-solid fa-cloud text-sky-400';
    }

    function sourceEntryIconClass(item) {
      const type = String(item?.type || '').toLowerCase();
      if (type === 'js') return item?.module ? 'fa-solid fa-cube text-yellow-300' : 'fa-brands fa-js text-yellow-300';
      if (type === 'css') return 'fa-solid fa-file-code text-blue-300';
      if (type === 'html') return 'fa-brands fa-html5 text-orange-400';
      if (type === 'json') return 'fa-solid fa-file-code text-green-300';
      if (type === 'file') return 'fa-solid fa-file text-gray-400';
      if (type === 'data') return 'fa-solid fa-database text-purple-300';
      if (type === 'blob') return 'fa-solid fa-capsules text-purple-300';
      return 'fa-solid fa-file text-gray-400';
    }

    function groupIconClass(type) {
      if (type === 'top') return 'fa-solid fa-window-maximize text-indigo-400';
      if (type === 'frames') return 'fa-solid fa-layer-group text-purple-400';
      if (type === 'frame') return 'fa-solid fa-code-branch text-purple-300';
      return 'fa-solid fa-folder text-yellow-500';
    }

    function createTreeRow(labelText,iconClassName,depth,expanded,onclick,extraClass='') {
      const row = document.createElement('div');
      row.className = `p-1 cursor-pointer hover:bg-[#2b2d31] rounded flex items-center gap-1.5 text-[10px] ${extraClass}`;
      row.style.paddingLeft = (depth * 12 + 4) + 'px';
      const caret = document.createElement('span');
      caret.textContent = expanded ? '▼' : '▶';
      caret.className = 'text-gray-500 w-2 flex-shrink-0';
      const icon = document.createElement('i');
      icon.className = iconClassName + ' w-3 text-center flex-shrink-0';
      const label = document.createElement('span');
      label.className = 'truncate';
      label.textContent = labelText;
      row.append(caret,icon,label);
      return {row,caret,icon,label};
    }

    function renderDomainGroup(domain,depth=1,expanded=true) {
      const wrap = document.createElement('div');
      const rowParts = createTreeRow(domain.name,domainIconClass(),depth,expanded,()=>{},'source-domain-row');
      const contents = document.createElement('div');
      contents.style.display = expanded ? 'block' : 'none';

      const body = document.createElement('div');
      sortedSourceFolders(domain.path?.children).forEach(folder => {
        body.appendChild(renderSourceFolder(folder,depth + 1));
      });
      sortedSourceFiles(domain.path?.files).forEach(item => {
        body.appendChild(renderSourceFileRow(item,depth + 1));
      });
      sortedSourceFiles(domain.files).forEach(item => {
        body.appendChild(renderSourceFileRow(item,depth + 1));
      });
      contents.appendChild(body);

      rowParts.row.onclick = e => {
        e.stopPropagation();
        const collapsed = contents.style.display === 'none';
        contents.style.display = collapsed ? 'block' : 'none';
        rowParts.caret.textContent = collapsed ? '▼' : '▶';
      };
      wrap.append(rowParts.row,contents);
      return wrap;
    }

    function frameLabel(context) {
      const frameTab = context?.tab;
      const number = frameTab?.framePath?.length ? frameTab.framePath.join('.') : String((context?.index || 0) + 1);
      const raw = context?.rawElement;
      const rawSrc = raw?.getAttribute?.('src');
      const rawSrcdoc = raw?.getAttribute?.('srcdoc');
      const url = frameTab?.url || frameTab?.page?.location?.url || frameTab?.iframe?.contentWindow?.location?.href || '';
      const domain = sourceDomainLabel(url);
      const labelDomain = domain && domain !== 'about:srcdoc' ? domain : (rawSrc ? sourceDomainLabel(rawSrc) : (rawSrcdoc != null ? 'srcdoc' : 'about:srcdoc'));
      return labelDomain && labelDomain !== 'about:srcdoc' ? `iframe ${number} — ${labelDomain}` : `iframe ${number}`;
    }

    function renderContextDomains(context,depth=1) {
      const domainTree = buildDomainTree(context.entries || []);
      const wrap = document.createElement('div');
      [...domainTree.children.values()].forEach(domain => wrap.appendChild(renderDomainGroup(domain,depth,true)));
      return wrap;
    }

    function renderFrameBranch(context,depth=1) {
      const wrap = document.createElement('div');
      const expanded = true;
      const parts = createTreeRow(frameLabel(context),groupIconClass('frame'),depth,expanded,()=>{},'source-frame-row');
      const body = document.createElement('div');
      body.style.display = expanded ? 'block' : 'none';
      body.appendChild(renderContextDomains(context,depth + 1));
      const children = Array.isArray(context?.children) ? context.children : [];
      children.forEach(child => body.appendChild(renderFrameBranch(child,depth + 1)));
      parts.row.onclick = e => {
        e.stopPropagation();
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? 'block' : 'none';
        parts.caret.textContent = collapsed ? '▼' : '▶';
      };
      wrap.append(parts.row,body);
      return wrap;
    }

    function renderSourceTree(tab,topEntries,frameContexts) {
      const root = document.createElement('div');

      const topParts = createTreeRow('Top',groupIconClass('top'),0,true,()=>{},'source-top-row');
      const topBody = document.createElement('div');
      topBody.style.display = 'block';
      topBody.appendChild(renderContextDomains({tab,entries:topEntries},1));
      frameContexts.forEach(context => topBody.appendChild(renderFrameBranch(context,1)));
      topParts.row.onclick = e => {
        e.stopPropagation();
        const collapsed = topBody.style.display === 'none';
        topBody.style.display = collapsed ? 'block' : 'none';
        topParts.caret.textContent = collapsed ? '▼' : '▶';
      };
      root.append(topParts.row,topBody);
      return root;
    }


    function clearTab(tab) {
      if (!tab) return;
      sourceBuckets.delete(tab);
      const state = getTabState(tab);
      if (state) {
        state.sourceEntries = [];
        state.documentSource = '';
        state.rawDocument = '';
        state.processedDocument = '';
      }
      const tracker = frameDocumentTrackers.get(tab);
      if (tracker?.observer) { try { tracker.observer.disconnect(); } catch(e) {} }
      frameDocumentTrackers.delete(tab);
      delete tab.__sourceRefreshQueued;
      if (getTabState(tab)) delete getTabState(tab).documentSource;
      for (const [request,pending] of sourceRequests) {
        if (pending?.tab === tab) sourceRequests.delete(request);
      }
      if (tab.id === getActiveTabId()) {
        entry = null;
        const tree = getUIElement('sources-file-tree');
        const editor = getUIElement('sources-editor');
        const info = getUIElement('sources-source-info');
        const title = getUIElement('sources-current-file');
        const deps = getUIElement('sources-dependencies');
        if (tree) tree.innerHTML = '';
        if (editor) { editor.innerHTML = ''; delete editor.dataset.rawSource; }
        if (info) info.textContent = '';
        if (title) title.textContent = 'Select a source…';
        if (deps) { deps.innerHTML = ''; deps.classList.add('hidden'); }
      }
    }

    function refresh() {
      const tree = getUIElement('sources-file-tree');
      if (!tree) return;
      tree.innerHTML = '';
      const tab = getActiveTab();
      if (!tab) return;
      getTabState(tab);
      const doc = DevToolsInternal.util.getActiveDocument();
      if (!doc) return;

      const topEntries = buildEntries(tab,doc);
      const frameContexts = getFrameContexts(tab);
      const allEntries = topEntries.slice();
      frameContexts.forEach(context => {
        if (!context.doc) { context.entries = []; return; }
        context.entries = buildEntries(context.tab,context.doc);
        getTabState(context.tab).sourceEntries = context.entries;
        allEntries.push(...context.entries);
      });
      getTabState(tab).sourceEntries = allEntries;
      tree.appendChild(renderSourceTree(tab,topEntries,frameContexts));

      const current = entry ? allEntries.find(e => e.id === entry.id) : null;
      if (current) openEntry(current);
      else if (allEntries.length) openEntry(allEntries[0]);
    }



    function renderDependencyList(value) {
      const container = getUIElement('sources-dependencies');
      if (!container) return;
      container.innerHTML = '';
      const imports = Array.isArray(value?.imports) ? value.imports : [];
      const importedBy = Array.isArray(value?.importedBy) ? value.importedBy : [];
      if (!imports.length && !importedBy.length) {
        container.classList.add('hidden');
        return;
      }
      container.classList.remove('hidden');

      const makeGroup = (title,items,onClick) => {
        if (!items.length) return;
        const group = document.createElement('div');
        group.className = 'flex items-center gap-1 min-w-0';
        const label = document.createElement('span');
        label.className = 'text-gray-500 flex-shrink-0';
        label.textContent = title + ':';
        group.appendChild(label);
        items.forEach(item => {
          const button = document.createElement('button');
          button.className = 'px-1.5 py-0.5 rounded bg-[#2b2d31] hover:bg-[#3a3d43] text-cyan-300 truncate max-w-[240px] text-[9px]';
          button.title = item.url || '';
          button.textContent = item.name || sourceEntryNameFromUrl(item.url,0,'module.js');
          button.onclick = e => { e.stopPropagation(); onClick(item); };
          group.appendChild(button);
        });
        container.appendChild(group);
      };

      makeGroup('Imports',imports,item => {
        const tab = value?.sourceTab || getActiveTab();
        const list = getTabState(tab)?.sourceEntries || [];
        const found = list.find(e => resolveUrl(e.url || '',tab.url) === item.url);
        if (found) openEntry(found);
      });
      makeGroup('Imported by',importedBy,item => {
        const tab = value?.sourceTab || getActiveTab();
        const list = getTabState(tab)?.sourceEntries || [];
        const found = list.find(e => resolveUrl(e.url || '',tab.url) === item.url);
        if (found) openEntry(found);
      });
    }

    async function openEntry(value) {
      if (!value) return;
      entry = value;
      const title = getUIElement('sources-current-file');
      const info = getUIElement('sources-source-info');
      const editor = getUIElement('sources-editor');
      if (title) title.textContent = value.name;
      if (info) info.textContent = `${mode === 'original' ? 'Original source' : 'Active source'} • Delivered from: ${value.deliveryUrl || value.url || '(inline)'}${value.activeUrl && value.activeUrl !== value.deliveryUrl ? ' • Active: ' + value.activeUrl : ''}`;
      let text = mode === 'original' ? value.original : value.active;
      if (!text && mode === 'active' && /^blob:/i.test(value.activeUrl || '')) {
        try {
          const response = await (window.browserNetwork?.request ? window.browserNetwork.request(value.activeUrl, location.origin, {}, 'devtools-source') : null);
          if (!response) throw new Error('Network request failed.');
          const contentType = response.headers.get('content-type') || '';
          if (DevToolsInternal.network.isTextualContent(contentType)) text = await response.text();
        } catch(e) {}
      }
      const displayText = text || (value.kind === 'blob' || /^data:/i.test(value.url || '') ? `// Delivery URL\n${value.url}` : '// No source available.');
      if (editor) {
        editor.innerHTML = DevToolsInternal.syntax.highlight(displayText,DevToolsInternal.syntax.inferLanguage(value.type,displayText));
        editor.dataset.rawSource = displayText;
        editor.scrollTop = 0;
        editor.scrollLeft = 0;
      }
      renderDependencyList(value);
      getUIQuerySelectorAll('#sources-file-tree .source-entry-selected').forEach(el => el.classList.remove('source-entry-selected')); const selectedRows = getUIQuerySelectorAll('#sources-file-tree [data-source-entry]'); selectedRows.forEach(el => { if (el.dataset.sourceEntry === value.id) el.classList.add('source-entry-selected'); });
    }

    function setMode(value) {
      mode = value;
      getUIElement('sources-mode-original')?.classList.toggle('active',value === 'original');
      getUIElement('sources-mode-active')?.classList.toggle('active',value === 'active');
      if (entry) openEntry(entry);
    }

    function filterSources(value) {
      search = value || '';
      refresh();
    }

    function findInSource(value) {
      const editor = getUIElement('sources-editor');
      if (!editor || !value) return;
      const source = editor.dataset.rawSource || editor.textContent || '';
      const index = source.toLowerCase().indexOf(value.toLowerCase());
      if (index >= 0) {
        editor.focus();
        const startTarget = index;
        const endTarget = index + value.length;
        const walker = document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);
        let node, start = 0, startNode = null, startOffset = 0, endNode = null, endOffset = 0;
        while ((node = walker.nextNode())) {
          const nodeStart = start;
          const nodeEnd = start + node.nodeValue.length;
          if (!startNode && startTarget >= nodeStart && startTarget <= nodeEnd) {
            startNode = node;
            startOffset = startTarget - nodeStart;
          }
          if (!endNode && endTarget >= nodeStart && endTarget <= nodeEnd) {
            endNode = node;
            endOffset = endTarget - nodeStart;
            break;
          }
          start = nodeEnd;
        }
        if (startNode && endNode) {
          const range = document.createRange();
          range.setStart(startNode,startOffset);
          range.setEnd(endNode,endOffset);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }

    async function copyText(value) {
      try {
        await navigator.clipboard.writeText(String(value ?? ''));
        emitEvent('toast','Copied to clipboard','success');
      } catch(e) {
        emitEvent('toast','Clipboard unavailable','error');
      }
    }

    async function copyCurrent() {
      const editor = getUIElement('sources-editor');
      if (editor) await copyText(editor.dataset.rawSource || editor.textContent || '');
    }

    function captureProcessed(tab) {
      if (!tab?.iframe) return;
      const doc = tab.iframe.contentDocument || tab.iframe.contentWindow?.document;
      if (!doc?.documentElement) return;
      getTabState(tab);
      const snapshot = doc.documentElement.outerHTML;
      getTabState(tab).processedDocument = snapshot;
      if (tab.page) tab.page.processedDocument = snapshot;
      DevToolsInternal.ui.refreshActiveViews();
    }

    return { get mode(){return mode;}, refresh, setMode, filter:filterSources, findInSource, copyText, copyCurrent, captureProcessed, openEntry, buildEntries, decodeDataUriText, handleRequestStart, handleRequestEnd, clearTab };
  })(),

  performance: {
    render() {
      const container = getUIElement('perf-metrics-container');
      const tab = getActiveTab();
      if (!container || !tab) return;
      const baseLoad = tab.loadTimeMS || 0;
      const dns = Math.floor(baseLoad * 0.1);
      const tcp = Math.floor(baseLoad * 0.2);
      const req = Math.floor(baseLoad * 0.4);
      const dom = Math.floor(baseLoad * 0.3);
      container.innerHTML = `<div class="mb-4 text-gray-400 text-center text-xs">Total Load Time: <span class="text-white font-bold">${baseLoad}ms</span></div><div class="mb-1 text-gray-400">DNS Lookup (${dns}ms)</div><div class="perf-bar bg-gray-700 w-full"><div class="h-full bg-emerald-500 rounded" style="width:10%"></div></div><div class="mb-1 text-gray-400 mt-3">Initial Connection (${tcp}ms)</div><div class="perf-bar bg-gray-700 w-full"><div class="h-full bg-orange-400 rounded" style="width:25%;margin-left:10%"></div></div><div class="mb-1 text-gray-400 mt-3">Request/Response (${req}ms)</div><div class="perf-bar bg-gray-700 w-full"><div class="h-full bg-blue-500 rounded" style="width:40%;margin-left:35%"></div></div><div class="mb-1 text-gray-400 mt-3">DOM Processing (${dom}ms)</div><div class="perf-bar bg-gray-700 w-full"><div class="h-full bg-purple-500 rounded" style="width:25%;margin-left:75%"></div></div>`;
    },
  },

  application: (() => {
    let type = 'localStorage';
    function load(nextType = type) {
      type = nextType;
      const title = getUIElement('app-storage-title');
      if (title) title.textContent = type === 'cookie' ? 'Cookies' : type === 'localStorage' ? 'Local Storage' : 'Session Storage';
      const tbody = getUIElement('app-storage-body');
      if (!tbody) return;
      tbody.innerHTML = '';
      const tab = getActiveTab();
      const win = tab?.iframe?.contentWindow || null;
      if (!win) return;
      try {
        let items = [];
        if (type === 'cookie') {
          items = win.document.cookie.split(';').filter(c => c.trim()).map(c => { const [k,v] = c.split('='); return {key:k.trim(),value:v ? v.trim() : ''}; });
        } else {
          const storageObj = win[type];
          for (let i = 0; i < storageObj.length; i++) { const k = storageObj.key(i); items.push({key:k,value:storageObj.getItem(k)}); }
        }
        if (items.length === 0) { tbody.innerHTML = `<tr><td colspan="2" class="p-4 text-center text-gray-500 italic">No data found in ${type}</td></tr>`; return; }
        items.forEach(item => tbody.innerHTML += `<tr class="border-b border-gray-800 hover:bg-[#2b2d31]"><td class="p-2 border-r border-gray-800 text-indigo-300 truncate max-w-[120px]" title="${sanitizeHTML(item.key)}">${sanitizeHTML(item.key)}</td><td class="p-2 text-emerald-400 break-all">${sanitizeHTML(item.value)}</td></tr>`);
      } catch(err) {
        tbody.innerHTML = `<tr><td colspan="2" class="p-4 text-rose-400">Access Denied: ${sanitizeHTML(err.message)}</td></tr>`;
      }
    }
    return { get type(){return type;}, load, refresh:() => load(type) };
  })(),
};


  var root = uiRoot;
  var styleElement = null;
  var resizerHandlers = null;
  var pageEventHandlers = new Map();
  var browserConsole = null;

  function bindUI(){
    function q(id){ return getUIElement(id); }
    ['elements','console','sources','network','performance','application'].forEach(function(name){ q('dt-tab-'+name)?.addEventListener('click',function(){ DevToolsInternal.ui.switchTab(name); }); });
    q('dt-clear-active')?.addEventListener('click',function(){ DevToolsInternal.ui.clearActive(); });
    q('dt-panel-close')?.addEventListener('click',function(){ DevToolsInternal.ui.toggle(); });
    q('dt-pick-element')?.addEventListener('click',function(){ DevToolsInternal.elements.togglePicker(); });
    q('dom-tree-filter')?.addEventListener('input',function(){ DevToolsInternal.elements.filter(this.value); });
    q('dom-tree-refresh')?.addEventListener('click',function(){ DevToolsInternal.elements.refresh(); });
    ['html','styles','properties','attributes'].forEach(function(name){ q('element-detail-tab-'+name)?.addEventListener('click',function(){ DevToolsInternal.elements.switchDetailTab(name); }); });
    q('consoleFilter')?.addEventListener('change',function(){ DevToolsInternal.console.filter(); });
    q('console-clear')?.addEventListener('click',function(){ DevToolsInternal.console.clear(); });
    var input=q('consoleInput');
    if(input){
      input.addEventListener('keydown',function(e){ DevToolsInternal.console.handleInput(e); });
      input.addEventListener('input',function(){
        DevToolsInternal.console.setDraft(getActiveTab(),this.value);
        DevToolsInternal.console.resetHistory();
        this.style.height='auto';
        this.style.height=Math.min(this.scrollHeight,120)+'px';
      });
      ConsoleSyntax.attach(input);
    }
    q('sources-refresh')?.addEventListener('click',function(){ DevToolsInternal.sources.refresh(); });
    q('sources-filter')?.addEventListener('input',function(){ DevToolsInternal.sources.filter(this.value); });
    q('sources-mode-original')?.addEventListener('click',function(){ DevToolsInternal.sources.setMode('original'); });
    q('sources-mode-active')?.addEventListener('click',function(){ DevToolsInternal.sources.setMode('active'); });
    q('sources-search')?.addEventListener('input',function(){ DevToolsInternal.sources.findInSource(this.value); });
    q('sources-copy-current')?.addEventListener('click',function(){ DevToolsInternal.sources.copyCurrent(); });
    q('network-record-toggle')?.addEventListener('click',function(){ DevToolsInternal.network.toggleRecording(); });
    q('network-filter')?.addEventListener('input',function(){ DevToolsInternal.network.render(); });
    q('network-status-filter')?.addEventListener('change',function(){ DevToolsInternal.network.render(); });
    q('network-type-filter')?.addEventListener('change',function(){ DevToolsInternal.network.render(); });
    q('network-clear')?.addEventListener('click',function(){ DevToolsInternal.network.clear(); });
    q('performance-refresh')?.addEventListener('click',function(){ DevToolsInternal.performance.render(); });
    ['localStorage','sessionStorage','cookie'].forEach(function(name){ q('app-storage-'+name)?.addEventListener('click',function(){ DevToolsInternal.application.load(name); }); });
    q('application-refresh')?.addEventListener('click',function(){ DevToolsInternal.application.refresh(); });
  }


  function setupUI(){
    root = uiRoot;
    root.innerHTML = DEVTOOLS_UI_HTML;
    var style = document.createElement('style');
    style.textContent = DEVTOOLS_CSS;
    root.appendChild(style);
    styleElement = style;
    bindUI();
    if (window.BrowserConsole && getUIElement('consoleOutput')) {
      browserConsole = new window.BrowserConsole(getUIElement('consoleOutput'), {
        urlCache: cacheMap,
        openURL: function(url,activate){ emitEvent('open-url',url,activate); },
        renderCode: function(code,language,className){ return DevToolsInternal.syntax.makeCode(code,language,className); }
      });
    }
  }

  function setupResizer(){
    var resizer=getUIElement('devtools-resizer');
    if(!resizer) return;
    var resizing=false;
    var down=function(){ resizing=true; resizer.classList.add('active'); document.body.style.cursor='col-resize'; document.body.style.userSelect='none'; };
    var move=function(e){
      if(!resizing) return;
      var panel=getUIElement('devtools-panel');
      if(!panel) return;
      var width=window.innerWidth-e.clientX;
      if(width>=260&&width<=window.innerWidth*.75) panel.style.width=width+'px';
    };
    var up=function(){
      if(!resizing) return;
      resizing=false;
      resizer.classList.remove('active');
      document.body.style.cursor='';
      document.body.style.userSelect='';
    };
    resizer.addEventListener('mousedown',down);
    window.addEventListener('mousemove',move);
    window.addEventListener('mouseup',up);
    resizerHandlers={resizer,down,move,up};
  }

  function removeResizer(){
    if(!resizerHandlers) return;
    var r=resizerHandlers;
    r.resizer.removeEventListener('mousedown',r.down);
    window.removeEventListener('mousemove',r.move);
    window.removeEventListener('mouseup',r.up);
    resizerHandlers=null;
  }


  function toggle(){ DevToolsInternal.ui.toggle(); }
  function open(){
    var panel=getUIElement('devtools-panel');
    if(panel?.classList.contains('hidden')) DevToolsInternal.ui.toggle();
  }
  function close(){
    var panel=getUIElement('devtools-panel');
    if(panel && !panel.classList.contains('hidden')) DevToolsInternal.ui.toggle();
  }

  function installCollector(rootPage,page) {
    var rootData=ensureRootData(rootPage);
    if(!rootData || !page) return;
    var existing=rootData.collectors.get(page);
    if(existing){
      existing.instances.set(instanceToken,{internal:DevToolsInternal});
      existing.users=existing.instances.size;
      return;
    }

    var getOwner=function(){
      var collector=rootData.collectors.get(page);
      if(!collector) return null;
      var first=collector.instances.values().next();
      return first.done ? null : first.value;
    };
    var handlers={
      networkstart:function(request,type){
        var rec=pageRecords.get(page); if(!rec) return;
        if(rec.parent && type === 'iframe' && request?.url) rec.tab.url = request.url;
        var owner=getOwner(); if(!owner) return;
        try { owner.internal.network.handleRequestStart(request,type,rec.tab); } catch(e) {}
        try { owner.internal.sources.handleRequestStart(request,type,rec.tab); } catch(e) {}
      },
      networkend:function(response,request,type){
        var rec=pageRecords.get(page); if(!rec) return;
        var owner=getOwner(); if(!owner) return;
        try { Promise.resolve(owner.internal.network.handleRequestEnd(response,request,type,rec.tab)).catch(function(){}); } catch(e) {}
        try { Promise.resolve(owner.internal.sources.handleRequestEnd(response,request,type,rec.tab)).catch(function(){}); } catch(e) {}
      },
      socketstart:function(url,protocols){
        var rec=pageRecords.get(page); if(!rec) return;
        var owner=getOwner(); if(!owner) return;
        var parsed; try{ parsed=new URL(url); }catch(e){ return; }
        owner.internal.network.handleSocketStart(parsed.href,protocols,rec.tab);
        rootData.events.dispatchEvent('socketstart',rec.tab,parsed.href,protocols);
      },
      socketend:function(response,url,protocols){
        var rec=pageRecords.get(page); if(!rec) return;
        var owner=getOwner(); if(!owner) return;
        var parsed; try{ parsed=new URL(url); }catch(e){ return; }
        owner.internal.network.handleSocketEnd(parsed.href,protocols,response,rec.tab);
        rootData.events.dispatchEvent('socketend',rec.tab,parsed.href,protocols,response);
      },
      websocket:function(url,data){
        var rec=pageRecords.get(page); if(!rec) return;
        var owner=getOwner(); if(!owner) return;
        var parsed; try{ parsed=new URL(url); }catch(e){ return; }
        owner.internal.network.handleWebsocket(parsed.href,data,rec.tab);
        rootData.events.dispatchEvent('websocket',rec.tab,parsed.href,data);
      },
      console:function(method,args){
        var rec=pageRecords.get(page); if(!rec) return;
        var owner=getOwner(); if(!owner) return;
        var sourceTab=rec.tab;
        var rootTab=owner.internal.network.getNetworkRootTab(sourceTab);
        owner.internal.console.recordMessage(rootTab,method,args,sourceTab);
        rootData.events.dispatchEvent('console',sourceTab,method,args);
      },
      error:function(e,loc){
        var rec=pageRecords.get(page); if(!rec) return;
        var owner=getOwner(); if(!owner) return;
        var sourceTab=rec.tab;
        var rootTab=owner.internal.network.getNetworkRootTab(sourceTab);
        owner.internal.console.recordMessage(rootTab,'error',['Uncaught Error: '+e.message+' ('+loc+':'+e.lineno+') '+(e.error?.stack||'')],sourceTab);
        rootData.events.dispatchEvent('error',sourceTab,e,loc);
      },
      iframe:function(obj){
        var rec=pageRecords.get(page); if(!rec) return;
        var child=obj?.iframe?.pageEmulator;
        if(!child || child===page) return;
        rootData.events.dispatchEvent('frame',page,child,obj || {});
      },
      load:function(){
        var rec=pageRecords.get(page); if(!rec) return;
        var owner=getOwner(); if(!owner) return;
        owner.internal.sources.captureProcessed(rec.tab);
        rootData.events.dispatchEvent('documentready',rec.tab);
      }
    };
    rootData.collectors.set(page,{users:1,instances:new Map([[instanceToken,{internal:DevToolsInternal}]]),handlers});
    if(page.network?.addEventListener){
      page.network.addEventListener('requeststart',handlers.networkstart);
      page.network.addEventListener('requestend',handlers.networkend);
      page.network.addEventListener('socketstart',handlers.socketstart);
      page.network.addEventListener('socketend',handlers.socketend);
      page.network.addEventListener('websocket',handlers.websocket);
    }
    page.interceptEvent('console',handlers.console);
    page.interceptEvent('error',handlers.error);
    page.interceptEvent('iframe',handlers.iframe);
    if(page.iframe?.addEventListener) page.iframe.addEventListener('load',handlers.load);
  }

  function releaseCollector(rootPage,page){
    var rootData=rootPage?.devtools;
    if(!rootData) return;
    var collector=rootData.collectors.get(page);
    if(!collector) return;
    collector.instances.delete(instanceToken);
    collector.users=collector.instances.size;
    if(collector.users>0) return;
    var h=collector.handlers;
    if(page.network?.removeEventListener){
      page.network.removeEventListener('requeststart',h.networkstart);
      page.network.removeEventListener('requestend',h.networkend);
      page.network.removeEventListener('socketstart',h.socketstart);
      page.network.removeEventListener('socketend',h.socketend);
      page.network.removeEventListener('websocket',h.websocket);
    }
    if(page.removeEventListener){
      page.removeEventListener('console',h.console);
      page.removeEventListener('error',h.error);
      page.removeEventListener('iframe',h.iframe);
    }
    if(page.iframe?.removeEventListener) page.iframe.removeEventListener('load',h.load);
    rootData.collectors.delete(page);
  }

  function registerPage(page,parentPage){
    if(!created || !page) return;
    var parent=parentPage || (page.parent && page.parent!==false ? page.parent : null);
    var rootPage=getRootPage(parent || page);
    var rootData=ensureRootData(rootPage);
    var previous=activePage;
    var record=pageRecords.get(page);
    if(record){
      if(parent) record.parent=parent;
      if(!parent) activePage=page;
      record.tab.subframe=!!record.parent;
      record.tab.parentTab=record.parent ? pageRecords.get(record.parent)?.tab || null : null;
      return;
    }

    var tab=makeTab(page,parent);
    pageRecords.set(page,{page,parent:parent,rootPage,tab});
    attachedPages.add(page);
    if(!parent) activePage=page;
    if(previous!==activePage) DevToolsInternal.console.resetHistory();
    ensureTabState(tab);
    installCollector(rootPage,page);

    if(!parent){
      var rootEvents=rootData.events;
      var updateHandler=function(){
        if(created && activePage===rootPage) DevToolsInternal.ui.refreshActiveViews();
      };
      rootEvents.addEventListener('documentready',updateHandler);
      var frameHandler=function(parent,child,obj){
        if(!created || parent!==page || !child) return;
        registerPage(child,page);
        var childRecord=pageRecords.get(child);
        if(childRecord){
          childRecord.tab.url=obj?.is_doc ? 'about:srcdoc' : (obj?.src || child.location?.url || childRecord.tab.url);
          childRecord.tab.frameElement=obj?.iframe || childRecord.tab.frameElement;
          childRecord.tab.parentTab=pageRecords.get(page)?.tab || null;
        }
        DevToolsInternal.ui.refreshActiveViews();
      };
      rootEvents.addEventListener('frame',frameHandler);
      pageEventHandlers.set(page,{rootEvents,update:updateHandler,frame:frameHandler});
    }

    var keydown=function(e){
      if(e.key==='F12' || ((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='i')){ e.preventDefault(); toggle(); return true; }
      if(e.key==='Escape' && DevToolsInternal.elements.isPickerActive()){ e.preventDefault(); DevToolsInternal.elements.stopPicker(); return true; }
      if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='c'){ e.preventDefault(); DevToolsInternal.elements.startPicker(); return true; }
    };
    page.interceptEvent('keydown',keydown);
    var handler=pageEventHandlers.get(page) || {};
    handler.keydown=keydown;
    pageEventHandlers.set(page,handler);

    if(page.iframe?.contentDocument?.documentElement) DevToolsInternal.sources.captureProcessed(tab);
  }

  function unregisterPage(page){
    var rec=pageRecords.get(page); if(!rec) return;
    var children=[];
    pageRecords.forEach(function(value,key){ if(value.parent===page) children.push(key); });
    children.forEach(unregisterPage);

    var handlers=pageEventHandlers.get(page);
    if(handlers?.rootEvents && handlers.update){
      handlers.rootEvents.removeEventListener('documentready',handlers.update);
      if(handlers.frame) handlers.rootEvents.removeEventListener('frame',handlers.frame);
    }
    if(handlers?.keydown) page.removeEventListener?.('keydown',handlers.keydown);
    releaseCollector(rec.rootPage,page);
    pageEventHandlers.delete(page);
    pageRecords.delete(page);
    attachedPages.delete(page);

    var rootData=rec.rootPage?.devtools;
    if(rootData && rootData.collectors.size===0 && !Array.from(pageRecords.values()).some(function(r){return r.rootPage===rec.rootPage;})){
      rootData.tabs.clear();
      rootData.events=new EventHandler();
      if(rec.rootPage.devtools===rootData) delete rec.rootPage.devtools;
    }
    if(activePage===page) activePage=Array.from(attachedPages).find(function(p){return !pageRecords.get(p)?.parent;}) || null;
  }

  function setupGlobalHooks(){
    globalHandlers={
      tabChange:function(e){
        var page=e.detail?.page || e.detail?.tab?.page;
        if(!page) return;
        var record=pageRecords.get(page);
        if(!record) return;
        if(record.parent) return;
        activePage=page;
        var bt=e.detail?.tab;
        if(bt){ record.tab.id=bt.id || record.tab.id; record.tab.iframe=bt.iframe || record.tab.iframe; record.tab.url=bt.url || record.tab.url; record.tab.title=bt.title || record.tab.title; }
        if(page.location?.url) record.tab.url=page.location.url;
        DevToolsInternal.console.resetHistory();
        DevToolsInternal.ui.refreshActiveViews();
      },
      tabClosed:function(e){
        var page=e.detail?.page || e.detail?.tab?.page;
        if(page) unregisterPage(page);
      },
      beforeReload:function(e){
        var page=e.detail?.page || e.detail?.tab?.page;
        var record=pageRecords.get(page); if(!record || record.parent) return;
        var clearOnReload=e.detail?.clearDevTools;
        if(clearOnReload==null) clearOnReload=options.clearOnReload!==false && (e.detail?.isReload || e.detail?.isNavigation);
        if(clearOnReload) DevToolsInternal.ui.clearForReload(record.tab);
      },
      navigationStart:function(e){
        var page=e.detail?.page || e.detail?.tab?.page;
        var record=pageRecords.get(page); if(!record) return;
        if(e.detail?.url) record.tab.url=e.detail.url;
        var state=getTabState(record.tab);
        if(state) state.documentSource='';
      },
      documentReady:function(e){
        var page=e.detail?.page || e.detail?.tab?.page;
        var record=pageRecords.get(page); if(!record) return;
        var state=getTabState(record.tab); if(!state) return;
        if(e.detail?.url) record.tab.url=e.detail.url;
        if(e.detail?.rawDocument!=null) state.rawDocument=String(e.detail.rawDocument||'');
        if(e.detail?.processedDocument!=null) state.processedDocument=String(e.detail.processedDocument||'');
        DevToolsInternal.sources.captureProcessed(record.tab);
        if(getRootPage(page)===activePage) DevToolsInternal.ui.refreshActiveViews();
      },
      browserState:function(){ DevToolsInternal.ui.refreshActiveViews(); },
      keydown:function(e){
        if(e.key==='F12' || ((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='i')){ e.preventDefault(); toggle(); return; }
        if(e.key==='Escape' && DevToolsInternal.elements.isPickerActive()){ e.preventDefault(); DevToolsInternal.elements.stopPicker(); return; }
        if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='c' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){ e.preventDefault(); DevToolsInternal.elements.startPicker(); }
      },
      resize:function(){ DevToolsInternal.elements.stopPicker(); }
    };
    window.addEventListener('browser-tab-change',globalHandlers.tabChange);
    window.addEventListener('browser-tab-closed',globalHandlers.tabClosed);
    window.addEventListener('browser-before-reload',globalHandlers.beforeReload);
    window.addEventListener('browser-navigation-start',globalHandlers.navigationStart);
    window.addEventListener('browser-document-ready',globalHandlers.documentReady);
    window.addEventListener('browser-view-refresh',globalHandlers.browserState);
    window.addEventListener('keydown',globalHandlers.keydown);
    window.addEventListener('resize',globalHandlers.resize);
  }

  function removeGlobalHooks(){
    if(!globalHandlers) return;
    window.removeEventListener('browser-tab-change',globalHandlers.tabChange);
    window.removeEventListener('browser-tab-closed',globalHandlers.tabClosed);
    window.removeEventListener('browser-before-reload',globalHandlers.beforeReload);
    window.removeEventListener('browser-navigation-start',globalHandlers.navigationStart);
    window.removeEventListener('browser-document-ready',globalHandlers.documentReady);
    window.removeEventListener('browser-view-refresh',globalHandlers.browserState);
    window.removeEventListener('keydown',globalHandlers.keydown);
    window.removeEventListener('resize',globalHandlers.resize);
    globalHandlers=null;
  }

  function create(options){
    if(created) return;
    created=true;
    setupUI();
    setupResizer();
    setupGlobalHooks();
    var resizer=getUIElement('devtools-resizer');
    if(resizer) resizer.classList.add('hidden');
  }

  function destroy(){
    if(!created) return;
    created=false;
    removeGlobalHooks();
    Array.from(pageRecords.keys()).forEach(unregisterPage);
    pageRecords.clear();
    attachedPages.clear();
    activePage=null;
    try{ DevToolsInternal.elements.stopPicker(); }catch(e){}
    removeResizer();
    if(root) root.innerHTML='';
    root=null;
    uiRoot=null;
    styleElement=null;
    browserConsole=null;
    emitEvent('destroy');
  }

  function runOnPage(page,parentPage){ registerPage(page,parentPage); DevToolsInternal.ui.refreshActiveViews(); }
  function removePage(page){ unregisterPage(page); }

  return {
    create:create,
    destroy:destroy,
    runOnPage:runOnPage,
    removePage:removePage,
    open:open,
    close:close,
    toggle:toggle,
    clearForReload:function(page){
      var target=pageRecords.get(page)?.tab || page;
      return DevToolsInternal.ui.clearForReload(target);
    },
    inspect:function(targetInfo){ return DevToolsInternal.elements.inspect(targetInfo); },
    togglePicker:function(){ return DevToolsInternal.elements.togglePicker(); },
    stopPicker:function(){ return DevToolsInternal.elements.stopPicker(); },
    getPage:function(){ return activePage; }
  };
}

  window.DevTools = class DevTools extends EventHandler {
    constructor(element,options={}) {
      super();
      if(!element || element.nodeType!==1) throw new TypeError('DevTools requires a DOM element');
      this.element=element;
      this.options=options||{};
      this._destroyed=false;
      this._instance=createInstance(element,this.options,this);
      this._instance.create(this.options);
    }
    runOnPage(page,parentPage){ return this._instance.runOnPage(page,parentPage); }
    removePage(page){ return this._instance.removePage(page); }
    open(){ return this._instance.open(); }
    close(){ return this._instance.close(); }
    toggle(){ return this._instance.toggle(); }
    inspect(targetInfo){ return this._instance.inspect(targetInfo); }
    togglePicker(){ return this._instance.togglePicker(); }
    stopPicker(){ return this._instance.stopPicker(); }
    clearForReload(page){ return this._instance.clearForReload(page); }
    getPage(){ return this._instance.getPage(); }
    destroy(){ if(this._destroyed) return; this._destroyed=true; return this._instance.destroy(); }
  };
})();
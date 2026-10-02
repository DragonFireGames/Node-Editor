(function() {
  const factories = window.EditorBuiltinFactories = window.EditorBuiltinFactories || {};
  const aiRoot = window.EditorAI = window.EditorAI || {};
  const CHAT_PREFIX = 'editor.aiChat.';
  const SYSTEM = 'You are the AI coding assistant inside a browser-based code editor. Be practical, precise, and concise. Use Markdown for explanations and fenced code blocks for code. When working on the project, inspect existing files before changing them, preserve the project\'s existing style, and verify changes by running relevant commands when available. The run_command tool uses the editor\'s virtual Node runtime, not a real operating-system shell: never prefix commands with $ and do not assume arbitrary shell features such as pipes or shell redirection are available; simple commands such as echo are supported. For project filesystem work, use the dedicated file tools.';
  const TOOL_PERMISSION_LABELS = {
    readFiles:'Read project files', searchFiles:'Search project', createFiles:'Create files', modifyFiles:'Modify files', deleteFiles:'Delete files',
    runCommands:'Run commands', runScripts:'Run scripts', runProject:'Run project', readOutput:'Read runtime output', readEditor:'Read editor state', modifyEditor:'Modify editor', browser:'Access browser', network:'Network requests'
  };
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function markdown(text) {
    try {
      if (typeof showdown !== 'undefined') return new showdown.Converter({tables:true,ghCodeBlocks:true,openLinksInNewWindow:true}).makeHtml(String(text || ''));
    } catch (_) {}
    return '<p>' + escapeHtml(text).replace(/\n/g,'<br>') + '</p>';
  }
  function sanitizeHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString('<div>' + String(html || '') + '</div>', 'text/html');
    const root = doc.body.firstElementChild;
    const allowed = new Set(['DIV','P','BR','HR','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','EM','I','STRONG','B','DEL','S','TABLE','THEAD','TBODY','TR','TH','TD','A','DETAILS','SUMMARY','SPAN']);
    root.querySelectorAll('*').forEach(el => {
      if (!allowed.has(el.tagName)) { el.replaceWith(...Array.from(el.childNodes)); return; }
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        if (n.startsWith('on') || n === 'style' || n === 'srcdoc') { el.removeAttribute(attr.name); continue; }
        if (n === 'href') {
          try { const u = new URL(attr.value, location.href); if (!['http:','https:','mailto:'].includes(u.protocol)) el.removeAttribute(attr.name); else el.setAttribute('rel','noreferrer noopener'); }
          catch (_) { el.removeAttribute(attr.name); }
          continue;
        }
        if (el.tagName === 'CODE' && n === 'class' && !/^language-[\w+-]+$/.test(attr.value)) el.removeAttribute(attr.name);
        else if (!['class','title','href'].includes(n)) el.removeAttribute(attr.name);
      }
    });
    root.querySelectorAll('script,iframe,object,embed,form,link,meta,style').forEach(x => x.remove());
    return root.innerHTML;
  }
  function getCodeInfo(pre) {
    const code = pre.querySelector('code');
    if (!code) return null;
    const cls = [...code.classList].find(x => x.startsWith('language-') || x.startsWith('lang-')) || '';
    return {code:code.textContent || '', language:cls.replace(/^language-/, '').replace(/^lang-/, '') || 'text'};
  }
  function activeEditor(state) {
    for (const instance of Workbench.getInstances?.() || [state.workbench]) for (const g of instance.groups.values()) {
      const t = g.tabs.find(x => x.id === g.active);
      if (t?.kind === 'file') return t;
    }
    return state.lastTextTab?.kind === 'file' ? state.lastTextTab : null;
  }
  function renderMessage(container, text, onInsertCode) {
    container.innerHTML = sanitizeHtml(markdown(text));
    container.querySelectorAll('pre').forEach(pre => {
      const info = getCodeInfo(pre); if (!info) return;
      const wrap = document.createElement('div'); wrap.className = 'ai-code-wrap';
      pre.parentNode.insertBefore(wrap, pre); wrap.appendChild(pre);
      const bar = document.createElement('div'); bar.className = 'ai-code-bar';
      const label = document.createElement('span'); label.textContent = info.language || 'code';
      const copy = document.createElement('button'); copy.textContent = 'Copy';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(info.code); copy.textContent='Copied'; setTimeout(()=>copy.textContent='Copy',900); } catch (_) {} };
      bar.append(label,copy);
      if (typeof onInsertCode === 'function') {
        const insert = document.createElement('button'); insert.textContent = 'Insert';
        insert.onclick = () => onInsertCode(info.code);
        bar.appendChild(insert);
      }
      wrap.insertBefore(bar, pre);
    });
    container.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noreferrer noopener'; });
  }
  const CHAT_DIR = '.editor/chats';
  const CHAT_INDEX = CHAT_DIR + '/index.json';
  function chatId() { return 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }
  function chatTitle(text) {
    const first = String(text || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || 'New Chat';
    return first.length > 48 ? first.slice(0, 45) + '…' : first;
  }
  function validMessages(messages) {
    return Array.isArray(messages) ? messages.filter(m => m && ['user','assistant'].includes(m.role) && typeof m.content === 'string') : [];
  }
  function makeChatStore(state) {
    let loadedProjectId = null;
    let chats = [];
    const memory = new Map();
    function readJson(path, fallback = null) {
      try {
        if (!state.fs?.existsSync(path)) return fallback;
        const value = JSON.parse(state.fs.readFileSync(path, 'utf8') || 'null');
        return value ?? fallback;
      } catch (_) { return fallback; }
    }
    function writeJson(path, value) {
      state.fs?.mkdirSync?.(CHAT_DIR);
      state.fs?.writeFileSync?.(path, JSON.stringify(value, null, 2));
    }
    function loadChat(id) {
      if (memory.has(id)) return memory.get(id);
      const raw = readJson(CHAT_DIR + '/' + id + '.json', null);
      const chat = raw && typeof raw === 'object' ? {
        id: String(raw.id || id),
        title: String(raw.title || 'New Chat'),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
        messages: validMessages(raw.messages)
      } : {id, title:'New Chat', createdAt:Date.now(), updatedAt:Date.now(), messages:[]};
      memory.set(chat.id, chat);
      return chat;
    }
    function saveChat(chat) {
      if (!state.fs || !chat?.id) return;
      chat.updatedAt = Date.now();
      memory.set(chat.id, chat);
      const meta = chats.find(x => x.id === chat.id);
      if (meta) {
        meta.title = chat.title;
        meta.createdAt = chat.createdAt;
        meta.updatedAt = chat.updatedAt;
        meta.messageCount = chat.messages.length;
      }
      writeJson(CHAT_DIR + '/' + chat.id + '.json', chat);
      writeJson(CHAT_INDEX, {version:1, chats});
      if (!state.loading) state.markDirty?.(CHAT_DIR + '/' + chat.id + '.json');
    }
    function ensureLoaded() {
      const pid = state.projectId || 'global';
      if (loadedProjectId === pid && chats.length) return;
      loadedProjectId = pid;
      chats = [];
      memory.clear();
      const index = readJson(CHAT_INDEX, {version:1,chats:[]});
      if (Array.isArray(index?.chats)) {
        chats = index.chats.map(x => ({id:String(x.id||''),title:String(x.title||'New Chat'),createdAt:Number(x.createdAt)||Date.now(),updatedAt:Number(x.updatedAt)||0,messageCount:Number(x.messageCount)||0})).filter(x=>x.id);
      }
      if (!chats.length) {
        let legacy = [];
        try {
          const legacyRaw = JSON.parse(localStorage.getItem(CHAT_PREFIX + pid) || '[]');
          legacy = validMessages(legacyRaw);
        } catch (_) {}
        const created = createChatInternal(legacy, legacy.length ? chatTitle(legacy.find(m=>m.role==='user')?.content) : 'New Chat', false);
        if (legacy.length) saveChat(created);
        chats = [{id:created.id,title:created.title,createdAt:created.createdAt,updatedAt:created.updatedAt,messageCount:created.messages.length}];
        try { localStorage.removeItem(CHAT_PREFIX + pid); } catch (_) {}
      }
      chats.sort((a,b)=>b.updatedAt-a.updatedAt);
    }
    function createChatInternal(messages, title, persist) {
      const now = Date.now();
      const chat = {id:chatId(),title:title || 'New Chat',createdAt:now,updatedAt:now,messages:validMessages(messages)};
      memory.set(chat.id, chat);
      chats.unshift({id:chat.id,title:chat.title,createdAt:now,updatedAt:now,messageCount:chat.messages.length});
      if (persist) saveChat(chat);
      return chat;
    }
    function create() { ensureLoaded(); return createChatInternal([], 'New Chat', true); }
    function get(id) { ensureLoaded(); return loadChat(id); }
    function list(recentOnly = false) { ensureLoaded(); const ordered=[...chats].sort((a,b)=>b.updatedAt-a.updatedAt); return recentOnly ? ordered.slice(0,12) : ordered; }
    function rename(id, title) { const chat=get(id); chat.title=String(title||'New Chat').trim().slice(0,80)||'New Chat'; saveChat(chat); }
    function touch(id) { const chat=get(id); saveChat(chat); }
    function remove(id) {
      ensureLoaded();
      const idx=chats.findIndex(x=>x.id===id); if(idx<0)return false;
      chats.splice(idx,1); memory.delete(id);
      try { state.fs?.deleteFileSync?.(CHAT_DIR + '/' + id + '.json'); } catch (_) {}
      writeJson(CHAT_INDEX, {version:1,chats});
      if (!state.loading) state.markDirty?.(CHAT_INDEX);
      return true;
    }
    return {ensureLoaded,list,get,create,rename,touch,remove};
  }
  function makeModelLabel(model, registry) {
    if (aiRoot.isHuggingFaceEndpoint?.(model?.endpoint)) {
      const source=registry?.getHuggingFaceKeySource?.(model)||'none';
      return `${model.name} · ${source==='model'?'model key':source==='user'?'your key':source==='shared'?'shared fallback':'no key'}`;
    }
    return model.public ? `${model.name} · no key` : `${model.name}${model.apiKey ? ' · key set' : ''}`;
  }

  function permissionPrompt(request) {
    return new Promise(resolve => {
      const modal=document.createElement('div'); modal.className='editor-modal ai-permission-modal';
      const title=TOOL_PERMISSION_LABELS[request.tool.permission] || request.tool.permission || 'AI action';
      let detail=''; try { detail=JSON.stringify(request.preview||request.args,null,2); } catch(_){detail=String(request.preview||'');}
      modal.innerHTML=`<div class="editor-modal-content ai-permission-content"><button class="editor-modal-close" aria-label="Close">×</button><h2>AI wants permission</h2><p>${escapeHtml(title)}</p><div class="ai-permission-tool">${escapeHtml(request.tool.name)}</div>${detail ? `<pre class="ai-permission-preview">${escapeHtml(detail.slice(0,8000))}</pre>` : ''}<div class="ai-permission-actions"><button data-deny>Deny</button><button data-once>Allow once</button><button data-always>Always allow</button></div></div>`;
      document.body.appendChild(modal); requestAnimationFrame(()=>modal.classList.add('show'));
      const done=v=>{modal.remove();resolve(v);};
      modal.querySelector('[data-deny]').onclick=()=>done('deny'); modal.querySelector('[data-once]').onclick=()=>done('once'); modal.querySelector('[data-always]').onclick=()=>done('always');
      modal.querySelector('.editor-modal-close').onclick=()=>done('deny'); modal.onclick=e=>{if(e.target===modal)done('deny');};
    });
  }
  function settingsModal(registry, permissions, onChange, network) {
    const modal=document.createElement('div'); modal.className='editor-modal ai-settings-modal';
    let editingId='';
    const render=()=>{
      const models=registry.settings.models, providers=registry.providers();
      modal.innerHTML=`<div class="editor-modal-content ai-settings-content"><button class="editor-modal-close" aria-label="Close">×</button><h2>AI Settings</h2><p>Configure models, the extra instructions you give them, and usage behavior.</p><div class="ai-settings-tabs"><button data-settings-tab="models" class="active">Models</button><button data-settings-tab="context">Context</button><button data-settings-tab="analytics">Analytics</button></div><div data-settings-panel="models"><div class="ai-settings-columns"><section><div class="ai-section-title ai-settings-section-heading"><span>Models</span><span class="ai-settings-transfer"><button type="button" data-export-ai>Export JSON</button><button type="button" data-import-ai>Import JSON</button><input data-import-ai-file type="file" accept="application/json,.json" hidden></span></div><label class="ai-check ai-export-keys"><input data-preserve-ai-keys type="checkbox" checked> Preserve API keys in export</label><div class="ai-export-warning">API keys are written to the JSON file in plain text when enabled. Only share the exported file if you are comfortable sharing those keys.</div><div class="ai-model-list">${models.map(m=>`<div class="ai-model-row ${m.id===registry.settings.activeModelId?'active':''}"><div class="ai-model-main"><strong>${escapeHtml(m.name)}</strong><span>${escapeHtml(registry.protocolLabel(m.protocol))} · ${m.supportsTools?'tool calling':'prompt tools'} · ${m.supportsReasoning?'reasoning':'no reasoning'}</span></div><button data-use="${escapeHtml(m.id)}">${m.id===registry.settings.activeModelId?'Active':'Use'}</button>${m.id===aiRoot.DEFAULT_PUBLIC_AI_MODEL.id?'':`<button data-edit="${escapeHtml(m.id)}">Edit</button><button data-remove="${escapeHtml(m.id)}">×</button>`}</div>`).join('')}</div><button class="ai-settings-add" data-add>+ Add model</button><div class="ai-add-model" hidden><label>Provider<select data-provider>${Object.entries(providers).map(([id,p])=>`<option value="${escapeHtml(id)}">${escapeHtml(p.label)}</option>`).join('')}</select></label><label>API format<select data-format>${Object.entries(aiRoot.AI_PROTOCOLS||{}).map(([id,p])=>`<option value="${escapeHtml(id)}">${escapeHtml(p.label)}</option>`).join('')}</select></label><label>Name<input data-name placeholder="My model"></label><label>Endpoint<input data-endpoint placeholder="https://api.example.com/v1"></label><label>Model ID <div class="ai-model-input-row"><input data-model placeholder="model-name"><button type="button" data-browse-models>Browse models</button></div></label><label>API key <input data-key type="password" placeholder="Enter your provider key"></label><label class="ai-check"><input data-remember type="checkbox"> Remember API key on this device</label><label class="ai-check"><input data-tools type="checkbox" checked> Supports native tool calling</label><label class="ai-check"><input data-thinking type="checkbox" checked> Supports reasoning</label><div class="ai-add-hint" data-protocol-hint>Select a provider to fill in its API format and endpoint. You can override the endpoint for compatible services.</div><div class="ai-add-actions"><button data-cancel-model>Cancel</button><button data-save-model>Save model</button></div></div><div class="ai-hf-account"><div class="ai-section-title">Hugging Face</div><label>Your API key<input data-hf-global-key type="password" placeholder="hf_..."></label><label class="ai-check"><input data-hf-global-remember type="checkbox"> Remember your key on this device</label><div class="ai-add-hint">Used for Hugging Face models that do not have their own key. Add a key here or on an individual model.</div></div></section><section><div class="ai-section-title">Permissions</div><div class="ai-permission-list">${Object.entries(permissions.all()).map(([k,v])=>`<label><span>${escapeHtml(TOOL_PERMISSION_LABELS[k]||k)}</span><select data-permission="${k}"><option value="always" ${v==='always'?'selected':''}>Always allow</option><option value="ask" ${v==='ask'?'selected':''}>Ask each time</option><option value="never" ${v==='never'?'selected':''}>Never allow</option></select></label>`).join('')}</div><button data-reset-permissions class="ai-settings-reset">Reset permissions</button></section></div><div class="ai-settings-note">Providers can fill in the API format and default endpoint automatically. Providers may expose either a live model list or a fixed set of known models.</div></div><div data-settings-panel="context" hidden><div class="ai-context-panel"><h3 class="ai-section-title">Model context &amp; instructions</h3><p class="ai-settings-note-inline">These are added to the built-in coding-assistant instructions. They persist on this device and apply to your AI chats.</p><label>Additional instructions<textarea data-custom-instructions placeholder="Example: Prefer small, focused changes. Explain tradeoffs briefly."></textarea></label><label>Agent-only instructions<textarea data-agent-instructions placeholder="Example: Before editing, inspect related files and run a targeted verification after each major change."></textarea></label><label class="ai-check"><input data-show-activity type="checkbox"> Show agent activity in chat</label><h3 class="ai-section-title">Request recovery</h3><label class="ai-check"><input data-retry-429 type="checkbox"> Automatically retry HTTP 429 rate limits</label><div class="ai-retry-grid"><label>Max 429 retries<input data-max-retries type="number" min="0" max="10"></label><label>Base delay (ms)<input data-base-delay type="number" min="250" max="30000" step="250"></label></div><label class="ai-check"><input data-retry-transport type="checkbox"> Retry transport/CORS failures</label><div class="ai-retry-grid"><label>Max transport retries<input data-max-transport-retries type="number" min="0" max="10"></label><label>Transport delay (ms)<input data-transport-delay type="number" min="250" max="30000" step="250"></label></div><p class="ai-settings-note-inline">HTTP responses such as 429 are handled separately from transport failures such as CORS or connection errors.</p><h3 class="ai-section-title">Tool-call recovery</h3><label class="ai-check"><input data-tool-recovery type="checkbox"> Retry supported tool-call parse failures</label><div class="ai-retry-grid"><label>Max recovery retries<input data-tool-recovery-retries type="number" min="0" max="10"></label><span></span></div><p class="ai-settings-note-inline">Providers can opt into a recovery strategy through their API adapter. The agent itself does not special-case providers.</p></div></div><div data-settings-panel="analytics" hidden><div class="ai-analytics-panel"><div class="ai-analytics-cards" data-analytics-cards></div><h3 class="ai-section-title">By model</h3><div data-analytics-models class="ai-analytics-models"></div><button data-reset-analytics class="ai-settings-reset">Reset analytics</button></div></div></div>`;
      modal.querySelector('.editor-modal-close').onclick=()=>modal.remove(); modal.onclick=e=>{if(e.target===modal)modal.remove();};
      const prefs=aiRoot.getAIPreferences?.()||{};
      const tabButtons=[...modal.querySelectorAll('[data-settings-tab]')], panels=[...modal.querySelectorAll('[data-settings-panel]')];
      function selectSettingsTab(name){tabButtons.forEach(b=>b.classList.toggle('active',b.dataset.settingsTab===name));panels.forEach(p=>p.hidden=p.dataset.settingsPanel!==name);if(name==='analytics')renderAnalytics();}
      tabButtons.forEach(b=>b.onclick=()=>selectSettingsTab(b.dataset.settingsTab));
      const customInstructions=modal.querySelector('[data-custom-instructions]'),agentInstructions=modal.querySelector('[data-agent-instructions]'),retry429=modal.querySelector('[data-retry-429]'),maxRetries=modal.querySelector('[data-max-retries]'),baseDelay=modal.querySelector('[data-base-delay]'),retryTransport=modal.querySelector('[data-retry-transport]'),maxTransportRetries=modal.querySelector('[data-max-transport-retries]'),transportDelay=modal.querySelector('[data-transport-delay]'),toolRecovery=modal.querySelector('[data-tool-recovery]'),toolRecoveryRetries=modal.querySelector('[data-tool-recovery-retries]'),showActivity=modal.querySelector('[data-show-activity]');
      customInstructions.value=prefs.customInstructions||''; agentInstructions.value=prefs.agentInstructions||''; retry429.checked=prefs.retry429!==false; maxRetries.value=prefs.max429Retries??5; baseDelay.value=prefs.baseRetryDelay??1500; retryTransport.checked=prefs.retryTransport!==false; maxTransportRetries.value=prefs.maxTransportRetries??2; transportDelay.value=prefs.transportRetryDelay??1000; toolRecovery.checked=prefs.toolRecovery!==false; toolRecoveryRetries.value=prefs.maxToolRecoveryRetries??2; showActivity.checked=prefs.showActivity!==false;
      const savePrefs=()=>{aiRoot.setAIPreferences?.({customInstructions:customInstructions.value,agentInstructions:agentInstructions.value,retry429:retry429.checked,max429Retries:Number(maxRetries.value),baseRetryDelay:Number(baseDelay.value),retryTransport:retryTransport.checked,maxTransportRetries:Number(maxTransportRetries.value),transportRetryDelay:Number(transportDelay.value),toolRecovery:toolRecovery.checked,maxToolRecoveryRetries:Number(toolRecoveryRetries.value),showActivity:showActivity.checked});onChange?.();};
      [customInstructions,agentInstructions,retry429,maxRetries,baseDelay,retryTransport,maxTransportRetries,transportDelay,toolRecovery,toolRecoveryRetries,showActivity].forEach(x=>x.addEventListener('change',savePrefs));
      function fmt(n){return Number(n||0).toLocaleString();}
      function renderAnalytics(){const a=aiRoot.getAIAnalytics?.()||{};const cards=modal.querySelector('[data-analytics-cards]');if(!cards)return;cards.innerHTML=[["Requests",a.requests],["Input tokens",a.inputTokens],["Output tokens",a.outputTokens],["Reasoning tokens",a.reasoningTokens],["Total tokens",a.totalTokens],["429 retries",a.retries429],["Transport retries",a.transportRetries],["Tool recoveries",a.toolRecoveries]].map(([k,v])=>`<div class="ai-analytics-card"><strong>${fmt(v)}</strong><span>${k}</span></div>`).join('');const list=modal.querySelector('[data-analytics-models]');const rows=Object.values(a.byModel||{}).sort((x,y)=>y.totalTokens-x.totalTokens);list.innerHTML=rows.length?rows.map(m=>`<div class="ai-analytics-row"><strong>${escapeHtml(m.name)}</strong><span>${fmt(m.totalTokens)} total · ${fmt(m.inputTokens)} in · ${fmt(m.outputTokens)} out · ${fmt(m.reasoningTokens)} reasoning · ${fmt(m.retries429)} retries</span></div>`).join(''):'<div class="ai-settings-note-inline">No usage recorded yet.</div>';}
      modal.querySelector('[data-reset-analytics]').onclick=()=>{aiRoot.resetAIAnalytics?.();renderAnalytics();};
      const preserveAIKeys=modal.querySelector('[data-preserve-ai-keys]');
      modal.querySelector('[data-export-ai]').onclick=()=>{
        const preserveKeys=!!preserveAIKeys?.checked;
        const payload={version:1,product:'Node-Editor AI Settings',exportedAt:new Date().toISOString(),models:registry.exportSettings?.({preserveKeys})||{},preferences:aiRoot.exportAIPreferences?.()||{},permissions:permissions.all?.()||{}};
        const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob),a=document.createElement('a'); a.href=url; a.download='node-editor-ai-settings.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
        if(preserveKeys) alert('AI settings exported. API keys are included in plain text in this JSON file. Do not share the exported file unless you intend to share those keys.');
      };
      const importInput=modal.querySelector('[data-import-ai-file]');
      modal.querySelector('[data-import-ai]').onclick=()=>importInput.click();
      importInput.onchange=async()=>{
        const file=importInput.files?.[0]; if(!file)return;
        try{
          const payload=JSON.parse(await file.text());
          const modelData=payload.models&&payload.models.models?payload.models:payload;
          if(modelData?.models) registry.importSettings?.(modelData);
          if(payload.preferences) aiRoot.importAIPreferences?.(payload.preferences);
          if(payload.permissions) aiRoot.savePermissions?.(payload.permissions);
          alert('AI settings imported. API keys included in the file have been restored.');
          render(); onChange?.();
        }catch(err){alert(`Could not import AI settings: ${err?.message||err}`);}
        finally{importInput.value='';}
      };
      modal.querySelectorAll('[data-use]').forEach(x=>x.onclick=()=>{registry.setActive(x.dataset.use);editingId='';render();onChange?.();});
      modal.querySelectorAll('[data-remove]').forEach(x=>x.onclick=()=>{registry.remove(x.dataset.remove);editingId='';render();onChange?.();});
      const form=modal.querySelector('.ai-add-model'),add=modal.querySelector('[data-add]'),providerInput=form.querySelector('[data-provider]'),formatInput=form.querySelector('[data-format]'),endpointInput=form.querySelector('[data-endpoint]'),nameInput=form.querySelector('[data-name]'),modelInput=form.querySelector('[data-model]'),keyInput=form.querySelector('[data-key]'),hint=form.querySelector('[data-protocol-hint]');
      const hfGlobalKey=modal.querySelector('[data-hf-global-key]'),hfGlobalRemember=modal.querySelector('[data-hf-global-remember]');
      hfGlobalKey.value=registry.getHuggingFaceApiKey?.()||''; hfGlobalRemember.checked=!!registry.settings.huggingFaceRememberKey;
      function updateProviderFields(force=true){
        const id=providerInput.value, preset=registry.provider(id)||registry.provider('custom');
        formatInput.value=preset.protocol; formatInput.disabled=id!=='custom';
        if(force){
          endpointInput.value=preset.endpoint||'';
          modelInput.value=preset.model||'';
          keyInput.value='';
          form.querySelector('[data-tools]').checked=preset.supportsTools!==false;
          form.querySelector('[data-thinking]').checked=preset.supportsReasoning!==false;
          if(!nameInput.value.trim() && preset.name) nameInput.value=preset.model ? `${preset.name} • ${preset.model.split('/').pop()}` : preset.name;
        }
        if(id==='groq')hint.textContent='Groq uses OpenAI-compatible chat completions. Enter your Groq API key, then Browse models for the live /models list.';
        else if(id==='huggingface')hint.textContent='Hugging Face Router uses OpenAI Chat Completions. Browse models queries its live /v1/models list.';
        else if(id==='google-gemini')hint.textContent='Google Gemini uses the native generateContent API. Browse models uses GET /v1beta/models and only shows models that advertise generateContent.';
        else hint.textContent='Custom provider. Choose or override the API format and endpoint as needed.';
      }
      function openModelBrowser(providerId){
        const provider=registry.provider(providerId),config=provider?.modelBrowser,browser=document.createElement('div');
        if(!config){alert(`${providers[providerId]?.label||providerId} does not have a model browser yet.`);return;}
        browser.className='editor-modal ai-hf-browser-modal';
        const title=providers[providerId]?.label||providerId,showFree=!!config.freeFilter;
        browser.innerHTML=`<div class="editor-modal-content ai-hf-browser-content"><button class="editor-modal-close" aria-label="Close">×</button><h2>${escapeHtml(title)} Models</h2><p>Models currently available through this provider.</p><div class="ai-hf-browser-toolbar"><input data-model-search placeholder="Search model IDs…">${showFree?'<label class="ai-check"><input data-model-free type="checkbox"> Free only</label>':''}<button data-model-refresh>Refresh</button></div><div class="ai-hf-browser-status" data-model-status>Loading models…</div><div class="ai-hf-browser-list" data-model-list></div></div>`;
        document.body.appendChild(browser); requestAnimationFrame(()=>browser.classList.add('show'));
        const search=browser.querySelector('[data-model-search]'),free=browser.querySelector('[data-model-free]'),status=browser.querySelector('[data-model-status]'),list=browser.querySelector('[data-model-list]');
        let all=[];
        browser.querySelector('.editor-modal-close').onclick=()=>browser.remove(); browser.onclick=e=>{if(e.target===browser)browser.remove();};
        function modelId(model){return String(model?.[config.idField||'id']||model?.id||'').replace(/^models\//,'');}
        function modelIsEligible(model){const filter=config.filter;if(filter==='generateContent')return Array.isArray(model?.supportedGenerationMethods)&&model.supportedGenerationMethods.includes('generateContent');return true;}
        async function load(){
          status.textContent='Loading models…'; list.innerHTML='';
          try {
            if(!network?.request) throw new Error('Network API is unavailable.');
            const key=String(keyInput?.value||'').trim() || (providerId==='huggingface' ? registry.getHuggingFaceRequestKey?.()||'' : '');
            if(!key) throw new Error(`Enter your ${title} API key first.`);
            const base=String(endpointInput.value||provider.endpoint||'').replace(/\/+$/,'');
            if(!base) throw new Error(`${title} has no model-list endpoint configured.`);
            all=[]; let nextToken='',pages=0;
            do {
              let url=base+(config.path||'/models');
              const query=[]; if(config.query)query.push(config.query); if(nextToken)query.push('pageToken='+encodeURIComponent(nextToken)); if(query.length)url+=(url.includes('?')?'&':'?')+query.join('&');
              const headers=config.auth==='bearer'?{Authorization:'Bearer '+key}:config.auth==='google'?{'x-goog-api-key':key}:{};
              const response=await network.request(new Request(url,{headers}),'ai');
              if(!response)throw new Error(`No response from ${title}.`);
              if(!response.ok)throw new Error(`${title} returned ${response.status}: ${await response.text()}`);
              const data=await response.json();
              const page=Array.isArray(data?.[config.responseKey||'data'])?data[config.responseKey||'data']:[];
              all.push(...page.filter(modelIsEligible));
              nextToken=config.kind==='dynamic'?(data?.nextPageToken||''):'';
              pages++;
            } while(nextToken&&pages<10);
            if(nextToken)status.textContent='Showing the first 10 model-list pages.';
            renderList();
          } catch(e){status.textContent=e?.message||String(e);}
        }
        function renderList(){
          const q=search.value.trim().toLowerCase(),onlyFree=!!free?.checked;
          const rows=all.filter(m=>{
            const id=modelId(m).toLowerCase(); if(!id)return false;
            if(q&&!id.includes(q)&&!String(m.displayName||'').toLowerCase().includes(q))return false;
            if(m.active===false)return false;
            if(onlyFree){const pricing=m.pricing||m.providers?.[0]?.pricing;const freeNow=Array.isArray(m.providers)?m.providers.some(p=>p.is_free===true||(p.pricing&&Number(p.pricing.input)===0&&Number(p.pricing.output)===0)):!!pricing&&(Number(pricing.input??pricing.prompt??-1)===0&&Number(pricing.output??pricing.completion??-1)===0);if(!freeNow)return false;}
            return true;
          }).slice(0,200);
          status.textContent=`${rows.length}${rows.length===200?'+':''} model${rows.length===1?'':'s'} shown`;
          list.innerHTML=rows.map(m=>{
            const id=modelId(m),ctx=Number(m.context_window||m.context_length||m.inputTokenLimit||0),owner=m.owned_by||m.publisher||'',display=m.displayName||'',meta=providerId==='google-gemini'?[display,ctx?ctx.toLocaleString()+' input ctx':'',m.version?String(m.version):''].filter(Boolean).join(' · '):providerId==='huggingface'?`${Array.isArray(m.providers)?m.providers.length:0} provider${Array.isArray(m.providers)&&m.providers.length===1?'':'s'}${ctx?' · '+ctx.toLocaleString()+' ctx':''}`:`${owner?owner+' · ':''}${ctx?ctx.toLocaleString()+' ctx':''}`;
            return `<div class="ai-hf-model-row"><div class="ai-model-main"><strong>${escapeHtml(id)}</strong><span>${escapeHtml(meta||'available')}</span></div><button data-pick="${escapeHtml(id)}">Use</button></div>`;
          }).join('');
          list.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{modelInput.value=b.dataset.pick;if(!endpointInput.value)endpointInput.value=provider.endpoint||'';if(!nameInput.value.trim()||nameInput.value===provider.name)nameInput.value=`${title} • ${b.dataset.pick.split('/').pop()}`;form.querySelector('[data-tools]').checked=provider.supportsTools!==false;form.querySelector('[data-thinking]').checked=provider.supportsReasoning!==false;browser.remove();});
        }
        search.oninput=renderList; if(free)free.onchange=renderList; browser.querySelector('[data-model-refresh]').onclick=load; load();
      }
      form.querySelector('[data-browse-models]').onclick=()=>openModelBrowser(providerInput.value);
      providerInput.onchange=()=>updateProviderFields(true);
      endpointInput.oninput=()=>{if(providerInput.value==='custom')hint.textContent='Custom provider. The endpoint and API format will be used as entered.';};
      function fill(model){editingId=model?.id||'';form.hidden=false;const providerId=registry.providerForModel(model);providerInput.value=providerId;formatInput.value=model?.protocol||registry.provider(providerId)?.protocol||'openai-chat';formatInput.disabled=providerId!=='custom';nameInput.value=model?.name||'';endpointInput.value=model?.endpoint||'';modelInput.value=model?.model||'';keyInput.value=model?.apiKey||'';form.querySelector('[data-remember]').checked=!!model?.rememberKey;form.querySelector('[data-tools]').checked=model?.supportsTools!==false;form.querySelector('[data-thinking]').checked=model?.supportsReasoning!==false;form.querySelector('[data-save-model]').textContent=editingId?'Save changes':'Save model';updateProviderFields(false);}
      add.onclick=()=>{form.hidden=!form.hidden;if(!form.hidden&&!editingId){providerInput.value='custom';formatInput.value='openai-chat';formatInput.disabled=false;nameInput.value='';endpointInput.value='';modelInput.value='';keyInput.value='';form.querySelector('[data-tools]').checked=true;form.querySelector('[data-thinking]').checked=true;hint.textContent='Select a provider to fill in its API format and endpoint.';}};
      modal.querySelectorAll('[data-edit]').forEach(x=>x.onclick=()=>{const model=registry.settings.models.find(m=>m.id===x.dataset.edit);if(model)fill(model);});
      modal.querySelector('[data-cancel-model]').onclick=()=>{editingId='';form.hidden=true;};
      modal.querySelector('[data-save-model]').onclick=()=>{const provider=providerInput.value.trim()||'custom',preset=registry.provider(provider)||registry.provider('custom'),name=nameInput.value.trim(),endpoint=endpointInput.value.trim(),modelId=modelInput.value.trim(),apiKey=keyInput.value,remember=form.querySelector('[data-remember]').checked,tools=form.querySelector('[data-tools]').checked,thinking=form.querySelector('[data-thinking]').checked,protocol=provider==='custom'?formatInput.value:preset.protocol;if(!name||!endpoint||!modelId){alert('Name, endpoint, and model ID are required.');return;}registry.setHuggingFaceApiKey(hfGlobalKey.value,hfGlobalRemember.checked);registry.save();const id=editingId||'model-'+Math.random().toString(36).slice(2);try{const clean=registry.add({id,provider,name,endpoint,model:modelId,apiKey,rememberKey:remember,supportsTools:tools,supportsReasoning:thinking,requiresKey:!!apiKey,protocol});registry.setActive(clean.id);editingId='';render();onChange?.();}catch(e){alert(e?.message||String(e));}};
      hfGlobalKey.onchange=()=>{registry.setHuggingFaceApiKey(hfGlobalKey.value,hfGlobalRemember.checked);registry.save();onChange?.();}; hfGlobalRemember.onchange=()=>{registry.setHuggingFaceApiKey(hfGlobalKey.value,hfGlobalRemember.checked);registry.save();onChange?.();};
      modal.querySelectorAll('[data-permission]').forEach(x=>x.onchange=()=>{permissions.set(x.dataset.permission,x.value);onChange?.();});
      modal.querySelector('[data-reset-permissions]').onclick=()=>{permissions.reset();render();onChange?.();};
      if(editingId){const model=registry.settings.models.find(m=>m.id===editingId);if(model)fill(model);}
    };
    document.body.appendChild(modal);render();requestAnimationFrame(()=>modal.classList.add('show'));
  }

  factories.ai = function(ctx) {
    const {state, onOpen, runConfigured}=ctx;
    const updateStatus = state.updateStatus;
    let currentGroup = null, currentTab = null;
    const registry=new aiRoot.ProviderRegistry();
    const permissions=new aiRoot.PermissionManager();
    const chatStore=makeChatStore(state);
    let currentChatId='';
    let chatMessages=[];
    let loadedProjectId=null;
    let agentMode=false, busy=false, controller=null, editingIndex=-1;
    const toolset=aiRoot.makeAITools({state,openFile:onOpen,onRefresh:()=>{state.fileManager?.refresh?.();updateStatus?.();},runConfigured,ensureNodeRuntime:()=>state.ensureNodeRuntime?.()});
    const agent=new aiRoot.AIAgent({client:new aiRoot.AIClient(registry,state.browserNetwork||window.__sharedBrowserNetwork),tools:toolset,permissions,requestPermission:permissionPrompt,emit:()=>{}});
    function syncChats() {
      const pid=state.projectId || 'global';
      if (loadedProjectId===pid && currentChatId) return;
      loadedProjectId=pid;
      chatStore.ensureLoaded();
      const recent=chatStore.list(false);
      if (!currentChatId || !recent.some(x=>x.id===currentChatId)) currentChatId=recent[0]?.id || chatStore.create().id;
      const chat=chatStore.get(currentChatId);
      chatMessages=chat.messages;
    }
    function currentChat() { syncChats(); return chatStore.get(currentChatId); }
    function activeMessages() { return chatMessages.map(m=>({role:m.role,content:m.content})); }
    function persist() { const chat=currentChat(); chat.messages=chatMessages; chatStore.touch(chat.id); }
    function beginEdit(index) {
      if (busy || !Number.isInteger(index) || chatMessages[index]?.role !== 'user') return;
      const view=getAIView(); if (!view) return;
      const input=view.t?._viewElement?.querySelector?.('[data-input]') || view.g?.viewBody?.querySelector?.('[data-input]');
      if (!input) return;
      editingIndex=index;
      input.value=chatMessages[index].content;
      input.focus();
      input.setSelectionRange(input.value.length,input.value.length);
      const send=view.t?._viewElement?.querySelector?.('[data-send]');
      if (send) send.textContent='Resend';
    }
    function cancelEdit() { editingIndex=-1; }
    function resendMessage(index,text,g,t,tree) {
      if (!Number.isInteger(index) || chatMessages[index]?.role !== 'user') return;
      chatMessages=chatMessages.slice(0,index);
      editingIndex=-1;
      persist();
      sendMessage(text,g,t,tree);
    }
    function getAIView() {
      let t=currentTab;
      if (!t || t.kind !== 'builtin' || t.builtin !== 'ai') return null;
      let g=t.group?.ownerWorkbench?.groups?.get(t.group.id) || null;
      if (!g || !g.tabs.includes(t)) {
        for (const instance of Workbench.getInstances?.() || [state.workbench]) for (const gg of instance.groups.values()) {
          const found=gg.tabs.find(x=>x===t || (x.id===t.id && x.kind==='builtin' && x.builtin==='ai'));
          if (found) { t=found; g=gg; break; }
        }
      }
      if (!g || !g.tabs.includes(t)) return null;
      return {g,t};
    }
    function addMessage(chat,role,text,index,message){const row=document.createElement('div');row.className='ai-message '+(role==='user'?'ai-user':'ai-assistant');if(role==='assistant'&&message?.activity?.length){const activity=renderActivity(chat,message.activity,false);row.appendChild(activity);}const bubble=document.createElement('div');bubble.className='ai-bubble';if(role==='user')bubble.textContent=text;else renderMessage(bubble,text,code=>insertCode(code));row.appendChild(bubble);if(role==='user'&&Number.isInteger(index)){const edit=document.createElement('button');edit.className='ai-edit-message';edit.textContent='✎';edit.title='Edit and resend';edit.setAttribute('aria-label','Edit and resend prompt');edit.disabled=busy;edit.onclick=()=>beginEdit(index);row.appendChild(edit);}chat.appendChild(row);return bubble;}
    async function insertCode(code){
      const tab=activeEditor(state); if(!tab){alert('Open a text file to insert this snippet.');return;} if(!tab.editor){onOpen?.(tab.path);setTimeout(()=>insertCode(code),150);return;}
      const tool=toolset.map.get('insert_code'); if(!tool)return;
      try { await (async()=>{const policy=permissions.get(tool.permission);if(policy==='never')throw new Error('Editor modification permission is disabled.');if(policy==='ask'){const d=await permissionPrompt({tool,args:{code},preview:{path:tab.path,code:code.slice(0,4000)}});if(d==='deny')return;if(d==='always')permissions.set(tool.permission,'always');}await tool.execute({code});})(); } catch(e){alert(e?.message||String(e));}
    }
    function systemPrompt(forAgent=false) {
      const context=aiRoot.buildContext(state,{maxFileChars:20000});
      const toolNames=toolset.list().map(x=>x.name).join(', ');
      const prefs=aiRoot.getAIPreferences?.()||{};
      const custom=String(prefs.customInstructions||'').trim();
      const agentExtra=forAgent?String(prefs.agentInstructions||'').trim():'';
      return [SYSTEM,custom?`User instructions:\n${custom}`:'',agentExtra?`Agent instructions:\n${agentExtra}`:'',`Current project context:\n${context}\n\nAvailable tools: ${toolNames}. Use tools rather than guessing file contents. Do not claim a change was made unless the tool succeeded.`].filter(Boolean).join('\n\n');
    }
    function chatManageModal() {
      const modal=document.createElement('div'); modal.className='editor-modal ai-chat-manage-modal';
      const render=()=>{
        const chats=chatStore.list(false);
        modal.innerHTML=`<div class="editor-modal-content ai-chat-manage-content"><button class="editor-modal-close" aria-label="Close">×</button><h2>Chats</h2><p>Your conversations are saved in <code>.editor/chats/</code> inside this project.</p><div class="ai-chat-list">${chats.map(c=>`<div class="ai-chat-row ${c.id===currentChatId?'active':''}"><div class="ai-chat-main"><strong>${escapeHtml(c.title)}</strong><span>${c.messageCount} messages · ${new Date(c.updatedAt||c.createdAt).toLocaleString()}</span></div><button data-open="${escapeHtml(c.id)}">Open</button><button data-rename="${escapeHtml(c.id)}">Rename</button>${chats.length>1?`<button data-delete="${escapeHtml(c.id)}">Delete</button>`:''}</div>`).join('')}</div><button data-new-chat class="ai-settings-add">+ New chat</button></div>`;
        modal.querySelector('.editor-modal-close').onclick=()=>modal.remove();
        modal.onclick=e=>{if(e.target===modal)modal.remove();};
        modal.querySelector('[data-new-chat]').onclick=()=>{newChat();modal.remove();};
        modal.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{switchChat(b.dataset.open);modal.remove();});
        modal.querySelectorAll('[data-rename]').forEach(b=>b.onclick=()=>{const chat=chatStore.get(b.dataset.rename);const title=prompt('Chat name:',chat.title);if(title!=null){chatStore.rename(chat.id,title);render();}});
        modal.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>{if(!confirm('Delete this chat?'))return;const id=b.dataset.delete;if(id===currentChatId){const ordered=chatStore.list(false).filter(x=>x.id!==id);chatStore.remove(id);currentChatId=ordered[0]?.id||chatStore.create().id;chatMessages=chatStore.get(currentChatId).messages;loadedProjectId=state.projectId||'global';}else chatStore.remove(id);render();});
      };
      document.body.appendChild(modal);render();requestAnimationFrame(()=>modal.classList.add('show'));
    }
    function switchChat(id) {
      if (busy || !id || id===currentChatId) return;
      const view=getAIView(); if (!view) return;
      persist();
      currentChatId=id;
      chatMessages=chatStore.get(id).messages;
      render(view.g,view.t);
    }
    function newChat() {
      if (busy) return;
      const view=getAIView(); if (!view) return;
      persist();
      const chat=chatStore.create();
      currentChatId=chat.id;
      chatMessages=chat.messages;
      render(view.g,view.t);
    }
    function renameCurrent() {
      const view=getAIView(); if (!view) return;
      const chat=currentChat();
      const title=prompt('Chat name:',chat.title);
      if(title!=null){chatStore.rename(chat.id,title);render(view.g,view.t);}
    }
    function formatWait(seconds){const n=Math.max(0,Math.ceil(Number(seconds)||0));if(n<60)return `${n}s`;const m=Math.floor(n/60),s=n%60;return s?`${m}m ${s}s`:`${m}m`;}
    function render(g, t) {
      currentGroup = g || currentGroup || state.workbench?.getFirstLeaf?.();
      currentTab = t || currentTab || currentGroup?.tabs?.find(x => x.builtin === 'ai');
      if (!currentGroup || !currentTab) return;
      syncChats();
      let tree = currentTab._viewElement;
      if (!tree || tree.parentNode !== currentGroup.viewBody) {
        tree = document.createElement('div');
        tree.className = 'builtin-ai';
        currentTab._viewElement = tree;
        currentGroup.viewBody.appendChild(tree);
      }
      tree.style.display = '';
      const model=registry.active(); const chats=chatStore.list(true); const current=currentChat();
      if(!model.supportsTools) agentMode=false;
      tree.innerHTML=`<div class="ai-panel-inner"><div class="ai-header"><div class="ai-header-left"><strong>AI Chat</strong><span class="ai-model-label">${escapeHtml(makeModelLabel(model,registry))}</span></div><div class="ai-header-right"><select class="ai-chat-select" data-chat-select ${busy?'disabled':''} title="Recent chats">${chats.map(c=>`<option value="${escapeHtml(c.id)}" ${c.id===currentChatId?'selected':''}>${escapeHtml(c.title)}</option>`).join('')}${!chats.length?'<option>No chats</option>':''}</select><div class="ai-head-actions"><button data-chat-manage ${busy?'disabled':''} title="Manage chats" aria-label="Manage chats">☰</button><button data-new ${busy?'disabled':''} title="New chat" aria-label="New chat">＋</button><button data-settings title="AI Settings" aria-label="AI Settings">⚙</button></div></div></div><div class="ai-chat" data-chat></div><div class="ai-horde-status" data-status ${busy?'':'hidden'}>${busy?'Working…':''}</div><div class="ai-compose"><textarea data-input placeholder="Ask anything about your project…" rows="3"></textarea><div class="ai-compose-bar"><label class="ai-agent-toggle"><input data-agent type="checkbox" ${agentMode?'checked':''} ${model.supportsTools?'':'disabled'}> Agent mode${model.supportsTools?'':' (not supported by this model)'}</label><label class="ai-agent-steps">Steps <input data-agent-steps type="number" min="1" max="100" step="1" value="${Math.max(1,Math.min(100,Number(agent.maxSteps)||24))}" ${model.supportsTools?'':'disabled'}></label><button data-stop ${busy?'':'disabled'}>Stop</button><button class="primary" data-send ${busy?'disabled':''}>Send</button></div></div></div>`;
      const chat=tree.querySelector('[data-chat]');
      for(let i=0;i<chatMessages.length;i++){const m=chatMessages[i];addMessage(chat,m.role,m.content,i,m);}
      tree.querySelector('[data-agent]').onchange=e=>{agentMode=e.target.checked;};
      const stepsInput=tree.querySelector('[data-agent-steps]');
      stepsInput.onchange=()=>{const n=Math.max(1,Math.min(100,Math.floor(Number(stepsInput.value)||24)));agent.maxSteps=n;stepsInput.value=n;};
      tree.querySelector('[data-settings]').onclick=()=>settingsModal(registry,permissions,()=>{persist();render(g,t);},state.browserNetwork||window.__sharedBrowserNetwork);
      tree.querySelector('[data-chat-select]').onchange=e=>switchChat(e.target.value);
      tree.querySelector('[data-chat-manage]').onclick=()=>chatManageModal();
      tree.querySelector('[data-new]').onclick=()=>newChat();
      tree.querySelector('[data-stop]').onclick=()=>{controller?.abort();agent.client.cancel();busy=false;render(g,t);};
      const input=tree.querySelector('[data-input]'); const send=tree.querySelector('[data-send]');
      const submit=async()=>{const text=input.value.trim();if(!text||busy)return;if(editingIndex>=0){const index=editingIndex;input.value='';resendMessage(index,text,g,t,tree);}else{input.value='';await sendMessage(text,g,t,tree);}};
      send.textContent=editingIndex>=0?'Resend':'Send';
      send.onclick=submit; input.addEventListener('keydown',e=>{if(e.key==='Enter' && !e.shiftKey){e.preventDefault();submit();}});
      if(editingIndex>=0){const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.title='Cancel prompt editing';cancel.onclick=()=>{cancelEdit();render(g,t);};send.parentNode.insertBefore(cancel,send);}
      if(chatMessages.length)chat.scrollTop=chat.scrollHeight;
    }
    async function sendMessage(text,g,t,tree){
      if(!g?.viewBody || !t) return;
      const chatRecord=currentChat();
      busy=true; controller=new AbortController();
      chatMessages.push({role:'user',content:text});
      if(chatRecord.title==='New Chat') chatStore.rename(chatRecord.id,chatTitle(text));
      persist();
      render(g,t);
      await new Promise(resolve => requestAnimationFrame(resolve));
      tree=t._viewElement || tree;
      const chat=tree.querySelector('[data-chat]');
      if(!chat) { busy=false; controller=null; return; }
      const setStatus=text=>{const el=tree.querySelector('[data-status]');if(!el)return;el.replaceChildren(document.createTextNode(text||''));el.hidden=!text;};
      const prefs=aiRoot.getAIPreferences?.()||{}; const liveActivity=agentMode&&prefs.showActivity!==false?beginActivity(chat,true):null;
      const bubble=addMessage(chat,'assistant',''); if(liveActivity && bubble.parentNode?.parentNode===chat) chat.insertBefore(liveActivity.host,bubble.parentNode); let partial='';
      try {
        if(agentMode){
          agent.emit=event=>{
            if(event.type==='assistant'){partial=event.text||partial;renderMessage(bubble,partial,code=>insertCode(code));chat.scrollTop=chat.scrollHeight;}
            else if(event.type==='tool_call'){appendActivity(liveActivity,{kind:'tool_call',name:event.name,args:event.args});}
            else if(event.type==='tool_result'){appendActivity(liveActivity,{kind:'tool_result',name:event.name,args:event.args,result:event.result,ok:event.ok});}
            else if(event.type==='step'){appendActivity(liveActivity,{kind:'step',text:`Step ${event.step}/${event.maxSteps}`});tree.querySelector('[data-status]')?.replaceChildren(document.createTextNode(`Step ${event.step}/${event.maxSteps}`));}
            else if(event.type==='retry'){appendActivity(liveActivity,{kind:'retry',text:`Rate limited — retrying in ${Math.ceil(event.waitMs/1000)}s (attempt ${event.attempt}/${event.maxRetries})`});} else if(event.type==='request_retry' || event.type==='transport_retry'){appendActivity(liveActivity,{kind:'transport_retry',text:`Network request failed — retrying in ${Math.ceil((event.waitMs||0)/1000)}s (attempt ${event.attempt}/${event.maxRetries})`});} else if(event.type==='request_response'){appendActivity(liveActivity,{kind:'request_response',text:`HTTP ${event.status}${event.ok?'':' · error'}`});}
            else if(event.type==='provider_retry'){appendActivity(liveActivity,{kind:'retry',text:event.text||`Retrying ${event.model||''}`.trim()});}
            else if(event.type==='request_start'){appendActivity(liveActivity,{kind:'request_start',text:`Requesting ${event.model} (${event.protocol})…`});}
            else if(event.type==='reasoning_summary'){appendActivity(liveActivity,{kind:'reasoning_summary',text:event.text});} else if(event.type==='reasoning'){appendActivity(liveActivity,{kind:'reasoning',text:event.text||'Model reasoning is active.'});}
          };
          const messages=activeMessages(); const prompt=systemPrompt(true); const result=await agent.run([{role:'system',content:prompt},...messages],{systemPrompt:prompt,maxTokens:2048,retryTransport:prefs.retryTransport,maxTransportRetries:prefs.maxTransportRetries,transportRetryDelay:prefs.transportRetryDelay,onRetry:info=>agent.emit?.({type:info?.kind==='tool_parse_recovery'?'provider_retry':info?.kind==='transport_retry'?'transport_retry':'retry',...info})}); partial=result.text||partial; renderMessage(bubble,partial,code=>insertCode(code)); const activityData=liveActivity?.items||[]; chatMessages.push({role:'assistant',content:partial,activity:activityData}); if(liveActivity)liveActivity.details.open=false;
        } else {
          const messages=[{role:'system',content:systemPrompt(false)},...activeMessages()];
          const model=agent.client.model();
          const queueStatus=info=>{
            if(model.protocol!=='ai-horde') return;
            const wait=Number(info?.waitTime);
            const position=Number(info?.queuePosition);
            if(info?.done){setStatus('');return;}
            if(info?.waiting){
              const pos=Number.isFinite(position)?Math.max(1,Math.floor(position)+1):null;
              const waitText=Number.isFinite(wait)&&wait>0?` • ~${formatWait(wait)}`:'';
              setStatus(pos?`Queue: #${pos}${waitText}`:`Queued${waitText}`);
            } else if(info?.processing){
              setStatus(Number.isFinite(wait)&&wait>0?`Processing • ~${formatWait(wait)}`:'Processing…');
            } else {
              setStatus('Waiting for Horde…');
            }
          };
          for await(const chunk of agent.client.stream(messages,{thinking:true,maxTokens:2048,temperature:.7,topP:.9,signal:controller.signal,systemPrompt:systemPrompt(false),onQueueStatus:queueStatus,onRetry:info=>setStatus(info?.kind==='tool_parse_recovery' ? (info.text||'Retrying tool-call generation…') : info?.kind==='transport_retry' ? `Network retry in ${Math.ceil((info.waitMs||0)/1000)}s (attempt ${info.attempt}/${info.maxRetries})` : `Rate limited — retrying in ${Math.ceil(info.waitMs/1000)}s (attempt ${info.attempt}/${info.maxRetries})`)})){partial=chunk.text||partial;renderMessage(bubble,partial,code=>insertCode(code));chat.scrollTop=chat.scrollHeight;}
          chatMessages.push({role:'assistant',content:partial});
        }
        persist();
      } catch(e) {
        if(e?.name!=='AbortError') { partial=`**Error:** ${e?.message||String(e)}`; renderMessage(bubble,partial); if(liveActivity) appendActivity(liveActivity,{kind:'error',text:e?.message||String(e)}); const activityData=liveActivity?.items||[]; chatMessages.push({role:'assistant',content:partial,activity:activityData}); if(liveActivity) liveActivity.details.open=false; persist(); }
      } finally { busy=false; controller=null; render(g,t); }
    }
    function activityValue(value,maxChars=20000){let text;try{text=JSON.stringify(value,null,2);}catch(_){text=String(value);}text=String(text??'');return text.length<=maxChars?text:text.slice(0,maxChars)+`\n… [truncated ${text.length-maxChars} characters]`;}
    function activitySummary(items){const list=items||[];const steps=list.filter(x=>x?.kind==='step').length;const tools=list.filter(x=>x?.kind==='tool_call').length;const retries=list.filter(x=>['retry','transport_retry','provider_retry'].includes(x?.kind)).length;const parts=['Agent activity'];if(steps)parts.push(`${steps} step${steps===1?'':'s'}`);if(tools)parts.push(`${tools} tool${tools===1?'':'s'}`);if(retries)parts.push(`${retries} retr${retries===1?'y':'ies'}`);return parts.join(' · ');}
    function renderActivity(chat,items,open){
      const details=document.createElement('details'); details.className='ai-activity'; details.open=!!open;
      const summary=document.createElement('summary'); summary.textContent=activitySummary(items); details.appendChild(summary);
      const body=document.createElement('div'); body.className='ai-activity-body'; details.appendChild(body);
      const activity={body,items:items||[],details}; for(const item of (items||[])) appendActivity(activity,item); summary.textContent=activitySummary(activity.items);
      return details;
    }
    function beginActivity(chat,open){
      const details=renderActivity(chat,[],open); const body=details.querySelector('.ai-activity-body');
      chat.appendChild(details); return {details,body,host:details,items:[]};
    }
    function appendActivity(activity,item){
      if(!activity?.body)return;
      if(activity.items)activity.items.push(item);
      const row=document.createElement('div'); row.className='ai-activity-row';
      if(typeof item==='string'){row.textContent=item;}
      else if(item.kind==='tool_call'){row.innerHTML=`<strong>Tool call: ${escapeHtml(item.name)}</strong><pre>${escapeHtml(activityValue(item.args||{}))}</pre>`;}
      else if(item.kind==='tool_result'){const suffix=Number.isFinite(Number(item.durationMs))?` · ${Math.max(0,Math.round(item.durationMs))} ms`:'';row.innerHTML=`<strong>${item.ok?'Tool result':'Tool error'}: ${escapeHtml(item.name)}${suffix}</strong><pre>${escapeHtml(activityValue(item.result))}</pre>`;}
      else if(item.kind==='step'){row.innerHTML=`<strong>Agent step</strong><span>${escapeHtml(String(item.text||''))}</span>`;}
      else if(item.kind==='request_start'){row.innerHTML=`<strong>Model request</strong><span>${escapeHtml(String(item.text||''))}</span>`;}
      else if(item.kind==='request_response'){row.innerHTML=`<strong>HTTP response</strong><span>${escapeHtml(String(item.text||''))}</span>`;}
      else if(item.kind==='reasoning_summary'){row.innerHTML=`<strong>Reasoning summary</strong><pre>${escapeHtml(String(item.text||''))}</pre>`;}
      else if(item.kind==='reasoning'){row.innerHTML=`<strong>Reasoning</strong><pre>${escapeHtml(String(item.text||''))}</pre>`;}
      else if(item.kind==='error'){row.innerHTML=`<strong>Error</strong><pre>${escapeHtml(String(item.text||''))}</pre>`;}
      else {row.innerHTML=`<strong>${escapeHtml(item.kind||'Activity')}</strong><span>${escapeHtml(String(item.text||''))}</span>`;}
      activity.body.appendChild(row);
      if(activity.details){const summary=activity.details.querySelector('summary');if(summary)summary.textContent=activitySummary(activity.items);activity.details.scrollIntoView?.({block:'nearest'});}
    }
    return {
      title:'AI',
      icon:'<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3.8c-4.1 0-7.4 2.3-7.4 6.8 0 2.1 1 3.5 2.5 4.6-.2 1.9-1 3.2-2 4.7 2.1-.2 4.1-1 5.7-2.3.4.1.8.1 1.2.1 4.7 0 7.4-2.8 7.4-7.1 0-4.5-3.3-6.8-7.4-6.8Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.8 10.5h6.4M12 7.3v6.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      render(g,t){ render(g,t); },
      openSettings:()=>settingsModal(registry,permissions,()=>{persist();render(currentGroup);},state.browserNetwork||window.__sharedBrowserNetwork),
      registry,
      permissions,
      getHistory:()=>chatMessages,
      getChats:()=>chatStore.list(false),
      newChat,
      manageChats:chatManageModal,
      renameChat:renameCurrent
    };
  };


})();

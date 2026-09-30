(function() {
  const factories = window.EditorBuiltinFactories = window.EditorBuiltinFactories || {};
  const aiRoot = window.EditorAI = window.EditorAI || {};
  const CHAT_PREFIX = 'editor.aiChat.';
  const SYSTEM = 'You are the AI coding assistant inside a browser-based code editor. Be practical, precise, and concise. Use Markdown for explanations and fenced code blocks for code. When working on the project, inspect existing files before changing them, preserve the project\'s existing style, and verify changes by running relevant commands when available.';
  const TOOL_PERMISSION_LABELS = {
    readFiles:'Read project files', searchFiles:'Search project', createFiles:'Create files', modifyFiles:'Modify files', deleteFiles:'Delete files',
    runCommands:'Run commands', runScripts:'Run scripts', runProject:'Run project', readOutput:'Read runtime output', readEditor:'Read editor state', modifyEditor:'Modify editor', browser:'Access browser'
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
      const models=registry.settings.models, protocols=registry.protocols();
      modal.innerHTML=`<div class="editor-modal-content ai-settings-content"><button class="editor-modal-close" aria-label="Close">×</button><h2>AI Settings</h2><p>Choose a model, select its API format, add your own endpoint, and control what the coding agent may do.</p><div class="ai-settings-columns"><section><div class="ai-section-title">Models</div><div class="ai-model-list">${models.map(m=>`<div class="ai-model-row ${m.id===registry.settings.activeModelId?'active':''}"><div class="ai-model-main"><strong>${escapeHtml(m.name)}</strong><span>${escapeHtml(registry.protocolLabel(m.protocol))} · ${m.supportsTools?'tool calling':'prompt tools'} · ${m.supportsReasoning?'reasoning':'no reasoning'}</span></div><button data-use="${escapeHtml(m.id)}">${m.id===registry.settings.activeModelId?'Active':'Use'}</button>${m.id===aiRoot.DEFAULT_PUBLIC_AI_MODEL.id?'':`<button data-edit="${escapeHtml(m.id)}">Edit</button><button data-remove="${escapeHtml(m.id)}">×</button>`}</div>`).join('')}</div><button class="ai-settings-add" data-add>+ Add model</button><div class="ai-add-model" hidden><label>Provider / API format<select data-protocol><option value="">Auto-detect</option>${Object.entries(protocols).map(([id,p])=>`<option value="${id}">${escapeHtml(p.label)}</option>`).join('')}</select></label><label>Name<input data-name placeholder="My model"></label><label>Endpoint<input data-endpoint placeholder="https://api.example.com/v1"></label><label>Model ID <div class="ai-model-input-row"><input data-model placeholder="model-name"><button type="button" data-browse-hf>Browse Hugging Face</button></div></label><label>API key <input data-key type="password" placeholder="Optional"></label><label class="ai-check"><input data-remember type="checkbox"> Remember API key on this device</label><label class="ai-check"><input data-tools type="checkbox" checked> Supports native tool calling</label><label class="ai-check"><input data-thinking type="checkbox" checked> Supports reasoning</label><div class="ai-add-hint" data-protocol-hint>Select an API format or enter a known provider endpoint and use Auto-detect.</div><div class="ai-add-actions"><button data-cancel-model>Cancel</button><button data-save-model>Save model</button></div></div><div class="ai-hf-account"><div class="ai-section-title">Hugging Face</div><label>Your API key<input data-hf-global-key type="password" placeholder="hf_..."></label><label class="ai-check"><input data-hf-global-remember type="checkbox"> Remember your key on this device</label><div class="ai-add-hint">Used for Hugging Face models that do not have their own key. Add a key here or on an individual model.</div></div></section><section><div class="ai-section-title">Permissions</div><div class="ai-permission-list">${Object.entries(permissions.all()).map(([k,v])=>`<label><span>${escapeHtml(TOOL_PERMISSION_LABELS[k]||k)}</span><select data-permission="${k}"><option value="always" ${v==='always'?'selected':''}>Always allow</option><option value="ask" ${v==='ask'?'selected':''}>Ask each time</option><option value="never" ${v==='never'?'selected':''}>Never allow</option></select></label>`).join('')}</div><button data-reset-permissions class="ai-settings-reset">Reset permissions</button></section></div><div class="ai-settings-note">Hugging Face Router uses the OpenAI Chat Completions API. Browse Hugging Face queries its live <code>/v1/models</code> list, including provider availability, pricing, context length, and tool support.</div></div>`;
      modal.querySelector('.editor-modal-close').onclick=()=>modal.remove(); modal.onclick=e=>{if(e.target===modal)modal.remove();};
      modal.querySelectorAll('[data-use]').forEach(x=>x.onclick=()=>{registry.setActive(x.dataset.use);editingId='';render();onChange?.();});
      modal.querySelectorAll('[data-remove]').forEach(x=>x.onclick=()=>{registry.remove(x.dataset.remove);editingId='';render();onChange?.();});
      const form=modal.querySelector('.ai-add-model'),add=modal.querySelector('[data-add]'),protocolInput=form.querySelector('[data-protocol]'),endpointInput=form.querySelector('[data-endpoint]'),hint=form.querySelector('[data-protocol-hint]');
      const browseHF=modal.querySelector('[data-browse-hf]');
      const hfGlobalKey=modal.querySelector('[data-hf-global-key]'),hfGlobalRemember=modal.querySelector('[data-hf-global-remember]');
      hfGlobalKey.value=registry.getHuggingFaceApiKey?.()||''; hfGlobalRemember.checked=!!registry.settings.huggingFaceRememberKey;
      function openHFModels(){
        const browser=document.createElement('div'); browser.className='editor-modal ai-hf-browser-modal';
        browser.innerHTML='<div class="editor-modal-content ai-hf-browser-content"><button class="editor-modal-close" aria-label="Close">×</button><h2>Hugging Face Models</h2><p>Models currently served through Hugging Face Inference Providers.</p><div class="ai-hf-browser-toolbar"><input data-hf-search placeholder="Search model IDs…"><select data-hf-provider><option value="">All providers</option></select><label class="ai-check"><input data-hf-free type="checkbox"> Free only</label><button data-hf-refresh>Refresh</button></div><div class="ai-hf-browser-status" data-hf-status>Loading models…</div><div class="ai-hf-browser-list" data-hf-list></div></div>';
        document.body.appendChild(browser); requestAnimationFrame(()=>browser.classList.add('show'));
        const keyInput=form.querySelector('[data-key]'), search=browser.querySelector('[data-hf-search]'),provider=browser.querySelector('[data-hf-provider]'),free=browser.querySelector('[data-hf-free]'),status=browser.querySelector('[data-hf-status]'),list=browser.querySelector('[data-hf-list]');
        let all=[];
        browser.querySelector('.editor-modal-close').onclick=()=>browser.remove(); browser.onclick=e=>{if(e.target===browser)browser.remove();};
        async function load(){
          status.textContent='Loading models…'; list.innerHTML='';
          try {
            if(!network?.request) throw new Error('Network API is unavailable.');
            const key=String(keyInput?.value||'').trim()||registry.getHuggingFaceRequestKey?.()||'';
            if(!key) throw new Error('Enter a Hugging Face API key first.');
            const response=await network.request(new Request('https://router.huggingface.co/v1/models',{headers:{Authorization:'Bearer '+key}}),'ai');
            if(!response) throw new Error('No response from Hugging Face.');
            if(!response.ok) throw new Error(`Hugging Face returned ${response.status}: ${await response.text()}`);
            const data=await response.json(); all=Array.isArray(data?.data)?data.data:[];
            const names=new Set(); for(const model of all) for(const p of model.providers||[]) if(p.provider)names.add(p.provider);
            provider.innerHTML='<option value="">All providers</option>'+[...names].sort().map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
            renderList();
          } catch(e){status.textContent=e?.message||String(e);}
        }
        function renderList(){
          const q=search.value.trim().toLowerCase(), pv=provider.value;
          const rows=all.filter(m=>{
            if(q&&!String(m.id||'').toLowerCase().includes(q))return false;
            const providers=Array.isArray(m.providers)?m.providers:[];
            if(pv&&!providers.some(p=>p.provider===pv))return false;
            if(free.checked&&!providers.some(p=>p.is_free===true || (p.pricing && Number(p.pricing.input)===0 && Number(p.pricing.output)===0)))return false;
            return true;
          }).slice(0,150);
          status.textContent=`${rows.length}${rows.length===150?'+':''} model${rows.length===1?'':'s'} shown`;
          list.innerHTML=rows.map(m=>{
            const providers=Array.isArray(m.providers)?m.providers:[],live=providers.filter(p=>p.status==='live'),freeNow=providers.some(p=>p.is_free===true || (p.pricing && Number(p.pricing.input)===0 && Number(p.pricing.output)===0)),tools=providers.some(p=>p.supports_tools===true),ctx=Math.max(0,...providers.map(p=>Number(p.context_length)||0));
            return `<div class="ai-hf-model-row"><div class="ai-model-main"><strong>${escapeHtml(m.id||'')}</strong><span>${live.length} provider${live.length===1?'':'s'}${freeNow?' · free':''}${tools?' · tools':''}${ctx?' · '+ctx.toLocaleString()+' ctx':''}</span></div><button data-pick="${escapeHtml(m.id||'')}">Use</button></div>`;
          }).join('');
          list.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{form.querySelector('[data-model]').value=b.dataset.pick; if(!endpointInput.value)endpointInput.value='https://router.huggingface.co/v1'; if(!protocolInput.value)protocolInput.value='openai-chat'; if(!form.querySelector('[data-name]').value)form.querySelector('[data-name]').value='Hugging Face • '+b.dataset.pick.split('/').pop(); updateHint(); browser.remove();});
        }
        search.oninput=renderList; provider.onchange=renderList; free.onchange=renderList; browser.querySelector('[data-hf-refresh]').onclick=load; load();
      }
      browseHF.onclick=openHFModels;
      function updateHint(){const selected=protocolInput.value, inferred=registry.inferProtocol(endpointInput.value);if(selected)hint.textContent=`Using ${registry.protocolLabel(selected)}.`;else if(inferred)hint.textContent=`Auto-detected: ${registry.protocolLabel(inferred)}.`;else hint.textContent='The endpoint format is not known yet. Choose a supported API format explicitly, or this provider will be reported as unsupported.';}
      protocolInput.onchange=updateHint;endpointInput.oninput=updateHint;
      function fill(model){editingId=model?.id||'';form.hidden=false;protocolInput.value=model?.protocol||'';form.querySelector('[data-name]').value=model?.name||'';endpointInput.value=model?.endpoint||'';form.querySelector('[data-model]').value=model?.model||'';form.querySelector('[data-key]').value=model?.apiKey||'';form.querySelector('[data-remember]').checked=!!model?.rememberKey;form.querySelector('[data-tools]').checked=model?.supportsTools!==false;form.querySelector('[data-thinking]').checked=model?.supportsReasoning!==false;form.querySelector('[data-save-model]').textContent=editingId?'Save changes':'Save model';updateHint();}
      add.onclick=()=>{form.hidden=!form.hidden;updateHint();};
      modal.querySelectorAll('[data-edit]').forEach(x=>x.onclick=()=>{const model=registry.settings.models.find(m=>m.id===x.dataset.edit);if(model)fill(model);});
      modal.querySelector('[data-cancel-model]').onclick=()=>{editingId='';form.hidden=true;};
      modal.querySelector('[data-save-model]').onclick=()=>{const selectedProtocol=protocolInput.value.trim(),name=form.querySelector('[data-name]').value.trim(),endpoint=endpointInput.value.trim(),modelId=form.querySelector('[data-model]').value.trim(),apiKey=form.querySelector('[data-key]').value,remember=form.querySelector('[data-remember]').checked,tools=form.querySelector('[data-tools]').checked,thinking=form.querySelector('[data-thinking]').checked;const protocol=selectedProtocol||registry.inferProtocol(endpoint);if(!name||!endpoint||!modelId){alert('Name, endpoint, and model ID are required.');return;}if(!protocol){alert('This provider uses an unsupported API format. Choose a supported API format explicitly, or this provider will be reported as unsupported.');return;}registry.setHuggingFaceApiKey(hfGlobalKey.value,hfGlobalRemember.checked);registry.save();const id=editingId||'model-'+Math.random().toString(36).slice(2);try{const clean=registry.add({id,name,endpoint,model:modelId,apiKey,rememberKey:remember,supportsTools:tools,supportsReasoning:thinking,requiresKey:!!apiKey,protocol});registry.setActive(clean.id);editingId='';render();onChange?.();}catch(e){alert(e?.message||String(e));}};
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
    let agentMode=false, busy=false, controller=null;
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
    function addMessage(chat,role,text){const row=document.createElement('div');row.className='ai-message '+(role==='user'?'ai-user':'ai-assistant');const bubble=document.createElement('div');bubble.className='ai-bubble';if(role==='user')bubble.textContent=text;else renderMessage(bubble,text,code=>insertCode(code));row.appendChild(bubble);chat.appendChild(row);return bubble;}
    async function insertCode(code){
      const tab=activeEditor(state); if(!tab){alert('Open a text file to insert this snippet.');return;} if(!tab.editor){onOpen?.(tab.path);setTimeout(()=>insertCode(code),150);return;}
      const tool=toolset.map.get('insert_code'); if(!tool)return;
      try { await (async()=>{const policy=permissions.get(tool.permission);if(policy==='never')throw new Error('Editor modification permission is disabled.');if(policy==='ask'){const d=await permissionPrompt({tool,args:{code},preview:{path:tab.path,code:code.slice(0,4000)}});if(d==='deny')return;if(d==='always')permissions.set(tool.permission,'always');}await tool.execute({code});})(); } catch(e){alert(e?.message||String(e));}
    }
    function systemPrompt() {
      const context=aiRoot.buildContext(state,{maxFileChars:20000});
      const toolNames=toolset.list().map(x=>x.name).join(', ');
      return SYSTEM+'\n\n'+`Current project context:\n${context}\n\nAvailable tools: ${toolNames}. Use tools rather than guessing file contents. Do not claim a change was made unless the tool succeeded.`;
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
      tree.innerHTML=`<div class="ai-panel-inner"><div class="ai-header"><div class="ai-header-left"><strong>AI Chat</strong><span class="ai-model-label">${escapeHtml(makeModelLabel(model,registry))}</span></div><div class="ai-header-right"><select class="ai-chat-select" data-chat-select ${busy?'disabled':''} title="Recent chats">${chats.map(c=>`<option value="${escapeHtml(c.id)}" ${c.id===currentChatId?'selected':''}>${escapeHtml(c.title)}</option>`).join('')}${!chats.length?'<option>No chats</option>':''}</select><div class="ai-head-actions"><button data-chat-manage ${busy?'disabled':''} title="Manage chats" aria-label="Manage chats">☰</button><button data-new ${busy?'disabled':''} title="New chat" aria-label="New chat">＋</button><button data-settings title="AI Settings" aria-label="AI Settings">⚙</button></div></div></div><div class="ai-chat" data-chat></div><div class="ai-horde-status" data-status ${busy?'':'hidden'}>${busy?'Working…':''}</div><div class="ai-compose"><textarea data-input placeholder="Ask anything about your project…" rows="3"></textarea><div class="ai-compose-bar"><label class="ai-agent-toggle"><input data-agent type="checkbox" ${agentMode?'checked':''} ${model.supportsTools?'':'disabled'}> Agent mode${model.supportsTools?'':' (not supported by this model)'}</label><button data-stop ${busy?'':'disabled'}>Stop</button><button class="primary" data-send ${busy?'disabled':''}>Send</button></div></div></div>`;
      const chat=tree.querySelector('[data-chat]');
      for(const m of chatMessages) addMessage(chat,m.role,m.content);
      tree.querySelector('[data-agent]').onchange=e=>{agentMode=e.target.checked;};
      tree.querySelector('[data-settings]').onclick=()=>settingsModal(registry,permissions,()=>{persist();render(g,t);},state.browserNetwork||window.__sharedBrowserNetwork);
      tree.querySelector('[data-chat-select]').onchange=e=>switchChat(e.target.value);
      tree.querySelector('[data-chat-manage]').onclick=()=>chatManageModal();
      tree.querySelector('[data-new]').onclick=()=>newChat();
      tree.querySelector('[data-stop]').onclick=()=>{controller?.abort();agent.client.cancel();busy=false;render(g,t);};
      const input=tree.querySelector('[data-input]'); const send=tree.querySelector('[data-send]');
      const submit=async()=>{const text=input.value.trim();if(!text||busy)return;input.value='';await sendMessage(text,g,t,tree);};
      send.onclick=submit; input.addEventListener('keydown',e=>{if(e.key==='Enter' && !e.shiftKey){e.preventDefault();submit();}});
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
      const bubble=addMessage(chat,'assistant',''); let partial='';
      try {
        if(agentMode){
          agent.emit=event=>{
            if(event.type==='assistant'){partial=event.text||partial;renderMessage(bubble,partial,code=>insertCode(code));chat.scrollTop=chat.scrollHeight;}
            else if(event.type==='tool_call'){appendActivity(chat,`Using ${event.name}…`);}
            else if(event.type==='tool_result'){appendActivity(chat,event.ok?`✓ ${event.name}`:`✗ ${event.name}: ${event.result?.error||'failed'}`);}
            else if(event.type==='step'){tree.querySelector('[data-status]')?.replaceChildren(document.createTextNode(`Step ${event.step}/${event.maxSteps}`));}
          };
          const messages=activeMessages(); const result=await agent.run([{role:'system',content:systemPrompt()},...messages],{systemPrompt:systemPrompt(),maxTokens:2048}); partial=result.text||partial; renderMessage(bubble,partial,code=>insertCode(code)); chatMessages.push({role:'assistant',content:partial});
        } else {
          const messages=[{role:'system',content:systemPrompt()},...activeMessages()];
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
          for await(const chunk of agent.client.stream(messages,{thinking:true,maxTokens:2048,temperature:.7,topP:.9,signal:controller.signal,systemPrompt:systemPrompt(),onQueueStatus:queueStatus})){partial=chunk.text||partial;renderMessage(bubble,partial,code=>insertCode(code));chat.scrollTop=chat.scrollHeight;}
          chatMessages.push({role:'assistant',content:partial});
        }
        persist();
      } catch(e) {
        if(e?.name!=='AbortError') { partial=`**Error:** ${e?.message||String(e)}`; renderMessage(bubble,partial); chatMessages.push({role:'assistant',content:partial}); persist(); }
      } finally { busy=false; controller=null; render(g,t); }
    }
    function appendActivity(chat,text){const row=document.createElement('div');row.className='ai-activity';row.textContent=text;chat.appendChild(row);chat.scrollTop=chat.scrollHeight;}
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

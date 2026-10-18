(function() {
  const root = window.EditorAI = window.EditorAI || {};
  const HF_KEY_STORAGE = 'editor.aiHuggingFaceKey';
  const STORAGE_KEY = 'editor.aiModels.v2';
  const PROTOCOLS = {
    'openai-chat': {label:'OpenAI Chat Completions', tools:true},
    'openai-responses': {label:'OpenAI Responses', tools:true},
    'anthropic-messages': {label:'Anthropic Messages', tools:true},
    'google-gemini': {label:'Google Gemini', tools:true},
    'cohere-v2': {label:'Cohere Chat v2', tools:true},
    'gradio-space': {label:'Gradio Space', tools:false},
    'local-transformers': {label:'Local Browser Model', tools:false}
  };
  const PROVIDERS = {
    local: {label:'Local Browser Model', protocol:'local-transformers', endpoint:'', name:'Local browser model', model:'', supportsTools:false, supportsAgentTools:true, supportsReasoning:false, supportsStreaming:true, modelBrowser:null},
    huggingface: {label:'Hugging Face', protocol:'openai-chat', endpoint:'https://router.huggingface.co/v1', name:'Hugging Face', model:'', supportsTools:true, supportsReasoning:true, supportsStreaming:true, modelBrowser:{kind:'dynamic',path:'/models',auth:'bearer',responseKey:'data',idField:'id',freeFilter:true}},
    groq: {label:'Groq', protocol:'openai-chat', endpoint:'https://api.groq.com/openai/v1', name:'Groq', model:'openai/gpt-oss-120b', supportsTools:true, supportsReasoning:true, supportsStreaming:true, modelBrowser:{kind:'dynamic',path:'/models',auth:'bearer',responseKey:'data',idField:'id',freeFilter:false}, chatOptions:[
      {match:/gpt-oss/i,body:{include_reasoning:true}},
      {match:/^(?:qwen\/)?qwen3(?:\.|\-|$)/i,body:{reasoning_format:'parsed'}}
    ], toolCallRecovery:{status:400,errorCodes:['output_parse_failed'],strategy:'lower-temperature',maxRetries:2,factor:.5,minTemperature:.2}},
    'google-gemini': {label:'Google Gemini', protocol:'google-gemini', endpoint:'https://generativelanguage.googleapis.com', name:'Google Gemini', model:'gemini-3.8-flash', supportsTools:true, supportsReasoning:true, supportsStreaming:true, modelBrowser:{kind:'dynamic',path:'/v1beta/models',auth:'google',responseKey:'models',idField:'baseModelId',query:'pageSize=1000',filter:'generateContent',freeFilter:false}},
    custom: {label:'Custom', protocol:'openai-chat', endpoint:'', name:'', model:'', supportsTools:true, supportsReasoning:true, supportsStreaming:true, modelBrowser:null}
  };
  function isHuggingFaceEndpoint(endpoint){return /(?:^|\.)huggingface\.co(?:\/|$)/i.test(String(endpoint||''));}
  function getStoredHuggingFaceKey(){try{return String(localStorage.getItem(HF_KEY_STORAGE)||'').trim();}catch(_){return '';}}
  function setStoredHuggingFaceKey(key){try{if(key)localStorage.setItem(HF_KEY_STORAGE,key);else localStorage.removeItem(HF_KEY_STORAGE);}catch(_){}}
  function cleanModel(model) {
    model = model && typeof model === 'object' ? model : {};
    let protocol = String(model.protocol || '').trim();
    const kind = String(model.kind || '').trim();
    if (!protocol) protocol = kind === 'gradio-space' ? 'gradio-space' : 'openai-chat';
    if (!PROTOCOLS[protocol]) protocol = inferProtocol(model.endpoint) || '';
    const local = protocol === 'local-transformers' || !!model.local;
    return {
      id:String(model.id || '').trim(), provider:String(model.provider || '').trim(), name:String(model.name || model.model || 'Unnamed Model').trim(),
      kind:protocol, protocol, endpoint:String(model.endpoint || '').trim(),
      remoteModel:String(model.remoteModel || model.model || '').trim(), model:String(model.model || model.remoteModel || '').trim(),
      apiKey:String(model.apiKey || ''), anonymousAuth:String(model.anonymousAuth || ''), rememberKey:!!model.rememberKey,
      requiresKey:model.requiresKey !== undefined ? !!model.requiresKey : !local,
      supportsTools:model.supportsTools !== false, supportsAgentTools:!!model.supportsAgentTools,
      supportsReasoning:model.supportsReasoning !== false, supportsStreaming:model.supportsStreaming !== false,
      public:!!model.public, useSharedKeys:model.useSharedKeys !== false, local, builtInLocal:!!model.builtInLocal
    };
  }
  function inferProtocol(endpoint) {
    const url=String(endpoint || '').toLowerCase();
    if (!url) return '';
    if (url.includes('api.anthropic.com')) return 'anthropic-messages';
    if (url.includes('generativelanguage.googleapis.com')) return 'google-gemini';
    if (url.includes('api.cohere.com')) return 'cohere-v2';
    if (url.includes('/responses') || url.includes('api.openai.com')) return 'openai-responses';
    if (url.includes('hf.space')) return 'gradio-space';
    if (/chat\/completions|\/v1(?:\/)?$/i.test(url) || /openrouter|groq|together|fireworks|deepseek|mistral|x\.ai|xai|blockrun|huggingface|ollama/i.test(url)) return 'openai-chat';
    return '';
  }
  function loadModels() {
    let parsed=null;
    try { parsed=JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) {}
    if (!parsed) {
      try { const old=JSON.parse(localStorage.getItem('editor.aiModels.v1') || 'null'); if (old) parsed=old; } catch (_) {}
    }
    const stored=Array.isArray(parsed?.models) ? parsed.models.map(cleanModel).filter(x=>x.id && x.protocol && (x.protocol==='local-transformers' ? x.model : x.endpoint)) : [];
    const builtinDefaults=(root.LOCAL_MODELS||[]).map(cleanModel);
    const allBuiltinIds=new Set(builtinDefaults.map(x=>x.id));
    const disabledBuiltInIds=new Set(Array.isArray(parsed?.disabledBuiltInIds)?parsed.disabledBuiltInIds.map(String):[]);
    const storedById=new Map(stored.filter(x=>allBuiltinIds.has(x.id)).map(x=>[x.id,x]));
    let builtins=builtinDefaults.filter(base=>!disabledBuiltInIds.has(base.id)).map(base=>{
      const saved=storedById.get(base.id);
      return saved ? cleanModel({...base,name:saved.name||base.name,model:saved.model||base.model,remoteModel:saved.model||base.model}) : base;
    });
    const custom=stored.filter(x=>!allBuiltinIds.has(x.id));
    let models=[...builtins,...custom];
    if(!models.length){
      disabledBuiltInIds.clear();
      builtins=builtinDefaults;
      models=[...builtins];
    }
    const huggingFaceApiKey=String(parsed?.huggingFaceApiKey || getStoredHuggingFaceKey() || '').trim();
    let active=parsed?.activeModelId;
    if(!active || !models.some(x=>x.id===active)) active=models[0]?.id||'';
    return {activeModelId:active,models,disabledBuiltInIds:[...disabledBuiltInIds],huggingFaceApiKey,huggingFaceRememberKey:!!parsed?.huggingFaceRememberKey};
  }
  function saveModels(settings) {
    const builtinDefaults=(root.LOCAL_MODELS||[]).map(cleanModel);
    const allBuiltinIds=new Set(builtinDefaults.map(x=>x.id));
    const disabledBuiltInIds=new Set(Array.isArray(settings?.disabledBuiltInIds)?settings.disabledBuiltInIds.map(String):[]);
    const input=(settings?.models || []).map(cleanModel);
    const builtins=builtinDefaults.filter(base=>!disabledBuiltInIds.has(base.id)).map(base=>{
      const edited=input.find(x=>x.id===base.id);
      return edited ? cleanModel({...base,name:edited.name||base.name,model:edited.model||base.model,remoteModel:edited.model||base.model}) : base;
    });
    const builtinOverrides=builtins.filter((model,index)=>{
      const base=builtinDefaults.find(x=>x.id===model.id);
      return base&&(model.name!==base.name||model.model!==base.model);
    });
    const custom=input.filter(x=>x.id && !allBuiltinIds.has(x.id) && x.protocol && (x.protocol==='local-transformers' ? x.model : x.endpoint));
    let models=[...builtins,...custom];
    if(!models.length){
      disabledBuiltInIds.clear();
      models=builtinDefaults;
    }
    const active=models.some(x=>x.id===settings?.activeModelId) ? settings.activeModelId : (models[0]?.id||'');
    const rememberHF=!!settings?.huggingFaceRememberKey;
    const storedModels=[...builtinOverrides,...custom].map(x=>x.rememberKey?x:{...x,apiKey:''});
    const stored={version:4,activeModelId:active,disabledBuiltInIds:[...disabledBuiltInIds],huggingFaceApiKey:rememberHF?String(settings?.huggingFaceApiKey||'').trim():'',huggingFaceRememberKey:rememberHF,models:storedModels};
    try { localStorage.setItem(STORAGE_KEY,JSON.stringify(stored)); } catch (_) {}
    return {activeModelId:active,models,disabledBuiltInIds:[...disabledBuiltInIds],huggingFaceApiKey:String(settings?.huggingFaceApiKey||getStoredHuggingFaceKey()||'').trim(),huggingFaceRememberKey:rememberHF};
  }
  function get(settings) { return (settings?.models || []).find(x=>x.id===settings.activeModelId) || settings?.models?.[0] || null; }
  function protocolLabel(id) { return PROTOCOLS[id]?.label || 'Unsupported API format'; }
  class ProviderRegistry {
    constructor(){ this.settings=loadModels(); this.sharedKeyCursor=0; this.settings=saveModels(this.settings); }
    getHuggingFaceApiKey(){return String(this.settings.huggingFaceApiKey||'').trim();}
    setHuggingFaceApiKey(key,remember){const value=String(key||'').trim();this.settings.huggingFaceApiKey=value;this.settings.huggingFaceRememberKey=!!remember;if(remember)setStoredHuggingFaceKey(value);else setStoredHuggingFaceKey('');}
    clearHuggingFaceApiKey(){this.settings.huggingFaceApiKey='';setStoredHuggingFaceKey('');}
    getHuggingFaceKeySource(model){if(model?.apiKey)return 'model';if(this.getHuggingFaceApiKey())return 'user';return 'none';}
    getHuggingFaceRequestKey(custom=''){return String(custom||'').trim() || this.getHuggingFaceApiKey();}
    active(){ return get(this.settings); }
    setActive(id){ if(this.settings.models.some(x=>x.id===id)){this.settings.activeModelId=id;this.settings=saveModels(this.settings);} }
    add(model){
      const protocol=String(model.protocol || model.kind || '').trim() || inferProtocol(model.endpoint);
      if (!PROTOCOLS[protocol]) throw new Error(`Unsupported AI API format. Supported formats: ${Object.values(PROTOCOLS).map(x=>x.label).join(', ')}.`);
      const clean=cleanModel({...model,protocol,kind:protocol,id:model.id || 'model-'+Math.random().toString(36).slice(2)});
      const local=clean.local||clean.protocol==='local-transformers';
      if(!clean.id || (!local&&!clean.endpoint) || !clean.model) throw new Error(local?'A local model needs a name and model ID.':'A model needs a name, endpoint, and model ID.');
      const existing=this.settings.models.findIndex(x=>x.id===clean.id);
      if(existing>=0)this.settings.models[existing]=clean;else this.settings.models.push(clean);
      this.settings=saveModels(this.settings);
      return clean;
    }
    remove(id){
      if(!this.settings.models.some(x=>x.id===id) || this.settings.models.length<=1)return false;
      const builtinIds=new Set((root.LOCAL_MODELS||[]).map(x=>x.id));
      if(builtinIds.has(id)){
        this.settings.disabledBuiltInIds=Array.from(new Set([...(this.settings.disabledBuiltInIds||[]),id]));
      }
      this.settings.models=this.settings.models.filter(x=>x.id!==id);
      if(this.settings.activeModelId===id)this.settings.activeModelId=this.settings.models[0]?.id||'';
      this.settings=saveModels(this.settings);
      return true;
    }
    resetDefaults(){
      const models=(root.LOCAL_MODELS||[]).map(cleanModel);
      const activeModelId=String(root.DEFAULT_LOCAL_MODEL_ID||models[0]?.id||'');
      if(!models.length)throw new Error('No built-in AI models are configured.');
      this.settings={
        activeModelId,
        models,
        disabledBuiltInIds:[],
        huggingFaceApiKey:String(this.settings.huggingFaceApiKey||''),
        huggingFaceRememberKey:!!this.settings.huggingFaceRememberKey
      };
      this.settings=saveModels(this.settings);
      return this.settings;
    }
    save(){this.settings=saveModels(this.settings);return this.settings;}
    exportSettings(options={}){
      const preserveKeys=options.preserveKeys!==false;
      return {version:2,activeModelId:this.settings.activeModelId,disabledBuiltInIds:[...(this.settings.disabledBuiltInIds||[])],huggingFaceApiKey:preserveKeys?String(this.settings.huggingFaceApiKey||''):'',huggingFaceRememberKey:preserveKeys?!!this.settings.huggingFaceRememberKey:false,models:(this.settings.models||[]).map(x=>{const model={...x}; if(preserveKeys) model.apiKey=String(x.apiKey||''); else {model.apiKey=''; model.rememberKey=false;} return model;})};
    }
    importSettings(payload){
      if(!payload || typeof payload!=='object' || !Array.isArray(payload.models)) throw new Error('Invalid AI model settings JSON.');
      const imported=payload.models.map(x=>cleanModel({...x,rememberKey:!!x.rememberKey || !!x.apiKey})).filter(x=>x.id && x.protocol && x.model && (x.protocol==='local-transformers' || x.endpoint));
      if(!imported.length)throw new Error('At least one valid AI model is required.');
      const ids=new Set();
      for(const model of imported){ if(ids.has(model.id)) throw new Error(`Duplicate model ID: ${model.id}`); ids.add(model.id); }
      const active=String(payload.activeModelId||'');
      this.settings={activeModelId:active,models:imported,disabledBuiltInIds:Array.isArray(payload.disabledBuiltInIds)?payload.disabledBuiltInIds.map(String):[],huggingFaceApiKey:String(payload.huggingFaceApiKey||''),huggingFaceRememberKey:!!payload.huggingFaceRememberKey};
      this.settings=saveModels(this.settings);
      if(this.settings.huggingFaceRememberKey) setStoredHuggingFaceKey(this.settings.huggingFaceApiKey);
      else setStoredHuggingFaceKey('');
      return this.settings;
    }
    isHuggingFace(model){return isHuggingFaceEndpoint(model?.endpoint);}
    protocolLabel(id){return protocolLabel(id);}
    inferProtocol(endpoint){return inferProtocol(endpoint);}
    providers(){return {...PROVIDERS};}
    provider(id){return PROVIDERS[id] ? {...PROVIDERS[id]} : null;}
    providerForModel(model){
      if(model?.local || model?.protocol==='local-transformers')return 'local';
      if(model?.provider && PROVIDERS[model.provider])return model.provider;
      const endpoint=String(model?.endpoint||'').toLowerCase();
      if(endpoint.includes('api.groq.com'))return 'groq';
      if(endpoint.includes('generativelanguage.googleapis.com'))return 'google-gemini';
      if(endpoint.includes('router.huggingface.co'))return 'huggingface';
      return 'custom';
    }
      protocols(){return {...PROTOCOLS};}
  }
  root.isHuggingFaceEndpoint=isHuggingFaceEndpoint;
  root.getStoredHuggingFaceKey=getStoredHuggingFaceKey;
  root.AI_PROTOCOLS=PROTOCOLS;
  root.AI_PROVIDERS=PROVIDERS;
  root.ProviderRegistry=ProviderRegistry;
  root.loadModels=loadModels;
  root.saveModels=saveModels;
  root.inferProtocol=inferProtocol;
  root.protocolLabel=protocolLabel;
})();

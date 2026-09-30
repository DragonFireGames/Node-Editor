(function() {
  const root = window.EditorAI = window.EditorAI || {};
  const DEFAULT_PUBLIC_ENDPOINT = 'https://api.llmfaucet.dev/v1';
  const DEFAULT_PUBLIC_MODEL = 'auto:coding';
  const STORAGE_KEY = 'editor.aiModels.v2';
  const PROTOCOLS = {
    'openai-chat': {label:'OpenAI Chat Completions', tools:true},
    'openai-responses': {label:'OpenAI Responses', tools:true},
    'anthropic-messages': {label:'Anthropic Messages', tools:true},
    'google-gemini': {label:'Google Gemini', tools:true},
    'cohere-v2': {label:'Cohere Chat v2', tools:true},
    'gradio-space': {label:'Gradio Space', tools:false}
  };
  const DEFAULT_MODEL = {
    id:'public-llmfaucet-auto-coding', name:'LLM Faucet • Auto Coding', kind:'openai-chat', protocol:'openai-chat',
    endpoint:DEFAULT_PUBLIC_ENDPOINT, remoteModel:DEFAULT_PUBLIC_MODEL, model:DEFAULT_PUBLIC_MODEL,
    apiKey:'', anonymousAuth:'free', rememberKey:false, requiresKey:false, supportsTools:true, supportsReasoning:true, public:true
  };
  const LEGACY_PUBLIC_IDS = new Set(['public-qwen35','public-blockrun-gpt-oss']);
  function cleanModel(model) {
    model = model && typeof model === 'object' ? model : {};
    let protocol = String(model.protocol || '').trim();
    const kind = String(model.kind || '').trim();
    if (!protocol) protocol = kind === 'gradio-space' ? 'gradio-space' : 'openai-chat';
    if (!PROTOCOLS[protocol]) protocol = inferProtocol(model.endpoint) || '';
    return {
      id:String(model.id || '').trim(), name:String(model.name || model.model || 'Unnamed Model').trim(),
      kind:protocol, protocol, endpoint:String(model.endpoint || '').trim(),
      remoteModel:String(model.remoteModel || model.model || '').trim(), model:String(model.model || model.remoteModel || '').trim(),
      apiKey:String(model.apiKey || ''), anonymousAuth:String(model.anonymousAuth || ''), rememberKey:!!model.rememberKey,
      requiresKey:model.requiresKey !== false, supportsTools:model.supportsTools !== false,
      supportsReasoning:model.supportsReasoning !== false, public:!!model.public
    };
  }
  function inferProtocol(endpoint) {
    const url=String(endpoint || '').toLowerCase();
    if (!url) return '';
    if (url.includes('api.anthropic.com')) return 'anthropic-messages';
    if (url.includes('generativelanguage.googleapis.com') || url.includes('generativelanguage.googleapis.com')) return 'google-gemini';
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
      try {
        const old=JSON.parse(localStorage.getItem('editor.aiModels.v1') || 'null');
        if (old) parsed=old;
      } catch (_) {}
    }
    const models=Array.isArray(parsed?.models) ? parsed.models.map(cleanModel).filter(x=>x.id && x.endpoint && x.protocol) : [];
    for (let i=models.length-1;i>=0;i--) if (LEGACY_PUBLIC_IDS.has(models[i].id)) models.splice(i,1);
    if (!models.some(x=>x.id===DEFAULT_MODEL.id)) models.unshift({...DEFAULT_MODEL});
    let active=parsed?.activeModelId;
    if (!models.some(x=>x.id===active) || LEGACY_PUBLIC_IDS.has(active)) active=DEFAULT_MODEL.id;
    return {activeModelId:active,models};
  }
  function saveModels(settings) {
    const models=(settings?.models || []).map(cleanModel).filter(x=>x.id && x.endpoint && x.protocol);
    if (!models.some(x=>x.id===DEFAULT_MODEL.id)) models.unshift({...DEFAULT_MODEL});
    const active=models.some(x=>x.id===settings?.activeModelId) ? settings.activeModelId : models[0].id;
    const stored={version:2,activeModelId:active,models:models.map(x=>x.rememberKey ? x : {...x,apiKey:''})};
    try { localStorage.setItem(STORAGE_KEY,JSON.stringify(stored)); } catch (_) {}
    return {activeModelId:active,models};
  }
  function get(settings) { return (settings?.models || []).find(x=>x.id===settings.activeModelId) || settings?.models?.[0] || {...DEFAULT_MODEL}; }
  function protocolLabel(id) { return PROTOCOLS[id]?.label || 'Unsupported API format'; }
  class ProviderRegistry {
    constructor(){ this.settings=loadModels(); this.settings=saveModels(this.settings); }
    active(){ return get(this.settings); }
    setActive(id){ if(this.settings.models.some(x=>x.id===id)){this.settings.activeModelId=id;this.settings=saveModels(this.settings);} }
    add(model){
      const protocol=String(model.protocol || model.kind || '').trim() || inferProtocol(model.endpoint);
      if (!PROTOCOLS[protocol]) throw new Error(`Unsupported AI API format. Supported formats: ${Object.values(PROTOCOLS).map(x=>x.label).join(', ')}.`);
      const clean=cleanModel({...model,protocol,kind:protocol,id:model.id || 'model-'+Math.random().toString(36).slice(2)});
      if(!clean.id || !clean.endpoint || !clean.model) throw new Error('A model needs a name, endpoint, and model ID.');
      const existing=this.settings.models.findIndex(x=>x.id===clean.id);
      if(existing>=0)this.settings.models[existing]=clean;else this.settings.models.push(clean);
      this.settings=saveModels(this.settings);
      return clean;
    }
    remove(id){
      if(id===DEFAULT_MODEL.id)return false;
      this.settings.models=this.settings.models.filter(x=>x.id!==id);
      this.settings=saveModels(this.settings); return true;
    }
    save(){this.settings=saveModels(this.settings);return this.settings;}
    protocolLabel(id){return protocolLabel(id);}
    inferProtocol(endpoint){return inferProtocol(endpoint);}
    protocols(){return {...PROTOCOLS};}
  }
  root.DEFAULT_PUBLIC_AI_MODEL=DEFAULT_MODEL;
  root.AI_PROTOCOLS=PROTOCOLS;
  root.ProviderRegistry=ProviderRegistry;
  root.loadModels=loadModels;
  root.saveModels=saveModels;
  root.inferProtocol=inferProtocol;
  root.protocolLabel=protocolLabel;
})();

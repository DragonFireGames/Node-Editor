(function() {
  const root = window.EditorAI = window.EditorAI || {};
  const DEFAULT_PUBLIC_ENDPOINT = 'https://aihorde.net/api/v2';
  const DEFAULT_PUBLIC_MODEL = 'aphrodite/TheDrummer/Cydonia-24B-v4.3';
  const DEFAULT_PUBLIC_NAME = 'AI Horde • Cydonia 24B';
  const HF_KEY_STORAGE = 'editor.aiHuggingFaceKey';
  const STORAGE_KEY = 'editor.aiModels.v2';
  const PROTOCOLS = {
    'openai-chat': {label:'OpenAI Chat Completions', tools:true},
    'ai-horde': {label:'AI Horde Native', tools:false},
    'openai-responses': {label:'OpenAI Responses', tools:true},
    'anthropic-messages': {label:'Anthropic Messages', tools:true},
    'google-gemini': {label:'Google Gemini', tools:true},
    'cohere-v2': {label:'Cohere Chat v2', tools:true},
    'gradio-space': {label:'Gradio Space', tools:false}
  };
  function isHuggingFaceEndpoint(endpoint){return /(?:^|\.)huggingface\.co(?:\/|$)/i.test(String(endpoint||''));}
  function getStoredHuggingFaceKey(){try{return String(localStorage.getItem(HF_KEY_STORAGE)||'').trim();}catch(_){return '';}}
  function setStoredHuggingFaceKey(key){try{if(key)localStorage.setItem(HF_KEY_STORAGE,key);else localStorage.removeItem(HF_KEY_STORAGE);}catch(_){}}
  const DEFAULT_MODEL = {
    id:'public-aihorde-cydonia', name:DEFAULT_PUBLIC_NAME, kind:'ai-horde', protocol:'ai-horde',
    endpoint:DEFAULT_PUBLIC_ENDPOINT, remoteModel:DEFAULT_PUBLIC_MODEL, model:DEFAULT_PUBLIC_MODEL,
    apiKey:'', anonymousAuth:'0000000000', rememberKey:false, requiresKey:false, supportsTools:false, supportsReasoning:false, supportsStreaming:false, public:true, useSharedKeys:false
  };
  const LEGACY_PUBLIC_IDS = new Set(['public-qwen35','public-blockrun-gpt-oss','public-llmfaucet-auto-coding','public-hf-gpt-oss-120b']);
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
      supportsReasoning:model.supportsReasoning !== false, supportsStreaming:model.supportsStreaming !== false, public:!!model.public, useSharedKeys:model.useSharedKeys !== false
    };
  }
  function inferProtocol(endpoint) {
    const url=String(endpoint || '').toLowerCase();
    if (!url) return '';
    if (url.includes('api.anthropic.com')) return 'anthropic-messages';
    if (url.includes('generativelanguage.googleapis.com') || url.includes('generativelanguage.googleapis.com')) return 'google-gemini';
    if (url.includes('api.cohere.com')) return 'cohere-v2';
    if (url.includes('aihorde.net') || url.includes('oai.aihorde.net')) return 'ai-horde';
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
    const huggingFaceApiKey=String(parsed?.huggingFaceApiKey || getStoredHuggingFaceKey() || '').trim();
    for (let i=models.length-1;i>=0;i--) {
      if (LEGACY_PUBLIC_IDS.has(models[i].id) || models[i].id===DEFAULT_MODEL.id) models.splice(i,1);
    }
    models.unshift({...DEFAULT_MODEL});
    let active=parsed?.activeModelId;
    if (!models.some(x=>x.id===active) || LEGACY_PUBLIC_IDS.has(active)) active=DEFAULT_MODEL.id;
    return {activeModelId:active,models,huggingFaceApiKey,huggingFaceRememberKey:!!parsed?.huggingFaceApiKey};
  }
  function saveModels(settings) {
    const models=(settings?.models || []).map(cleanModel).filter(x=>x.id && x.endpoint && x.protocol);
    for (let i=models.length-1;i>=0;i--) { if (models[i].id===DEFAULT_MODEL.id) models.splice(i,1); }
    models.unshift({...DEFAULT_MODEL});
    const active=models.some(x=>x.id===settings?.activeModelId) ? settings.activeModelId : models[0].id;
    const rememberHF=!!settings?.huggingFaceRememberKey;const stored={version:2,activeModelId:active,huggingFaceApiKey:rememberHF?String(settings?.huggingFaceApiKey||'').trim():'',models:models.map(x=>x.rememberKey ? x : {...x,apiKey:''})};
    try { localStorage.setItem(STORAGE_KEY,JSON.stringify(stored)); } catch (_) {}
    return {activeModelId:active,models,huggingFaceApiKey:String(settings?.huggingFaceApiKey||getStoredHuggingFaceKey()||'').trim(),huggingFaceRememberKey:!!settings?.huggingFaceRememberKey};
  }
  function get(settings) { return (settings?.models || []).find(x=>x.id===settings.activeModelId) || settings?.models?.[0] || {...DEFAULT_MODEL}; }
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
    isHuggingFace(model){return isHuggingFaceEndpoint(model?.endpoint);}
    protocolLabel(id){return protocolLabel(id);}
    inferProtocol(endpoint){return inferProtocol(endpoint);}
    protocols(){return {...PROTOCOLS};}
  }
  root.DEFAULT_PUBLIC_AI_MODEL=DEFAULT_MODEL;
  root.isHuggingFaceEndpoint=isHuggingFaceEndpoint;
  root.getStoredHuggingFaceKey=getStoredHuggingFaceKey;
  root.AI_PROTOCOLS=PROTOCOLS;
  root.ProviderRegistry=ProviderRegistry;
  root.loadModels=loadModels;
  root.saveModels=saveModels;
  root.inferProtocol=inferProtocol;
  root.protocolLabel=protocolLabel;
})();

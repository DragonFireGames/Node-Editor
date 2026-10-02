(function() {
  const root = window.EditorAI = window.EditorAI || {};
  const PREFS_KEY = 'editor.aiPreferences.v1';
  const ANALYTICS_KEY = 'editor.aiAnalytics.v1';
  const DEFAULTS = { retry429:true, max429Retries:5, baseRetryDelay:1500, retryTransport:true, maxTransportRetries:2, transportRetryDelay:1000, toolRecovery:true, maxToolRecoveryRetries:2, customInstructions:'', agentInstructions:'', showActivity:true };
  function read(key,fallback){try{const v=JSON.parse(localStorage.getItem(key)||'null');return v&&typeof v==='object'?v:fallback;}catch(_){return fallback;}}
  function save(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch(_) {}}
  function getAIPreferences(){return {...DEFAULTS,...read(PREFS_KEY,{})};}
  function setAIPreferences(patch){const next={...getAIPreferences(),...(patch||{})};next.max429Retries=Math.max(0,Math.min(10,Number(next.max429Retries)||0));next.baseRetryDelay=Math.max(250,Math.min(30000,Number(next.baseRetryDelay)||1500));next.maxTransportRetries=Math.max(0,Math.min(10,Number(next.maxTransportRetries)||0));next.transportRetryDelay=Math.max(250,Math.min(30000,Number(next.transportRetryDelay)||1000));next.maxToolRecoveryRetries=Math.max(0,Math.min(10,Number(next.maxToolRecoveryRetries)||0));save(PREFS_KEY,next);return next;}
  function blankAnalytics(){return {version:1,requests:0,retries429:0,transportRetries:0,toolRecoveries:0,inputTokens:0,outputTokens:0,reasoningTokens:0,totalTokens:0,toolCalls:0,runs:0,byModel:{},lastAt:0};}
  function getAnalytics(){const x={...blankAnalytics(),...read(ANALYTICS_KEY,{})};x.byModel=x.byModel&&typeof x.byModel==='object'?x.byModel:{};return x;}
  function recordAnalytics(info={}){
    const a=getAnalytics(),model=info.model||{},id=String(model.id||model.model||'unknown'),u=info.usage||{};
    const input=Number(u.input_tokens??u.prompt_tokens??0)||0, output=Number(u.output_tokens??u.completion_tokens??0)||0, reasoning=Number(u.output_tokens_details?.reasoning_tokens??u.reasoning_tokens??0)||0, total=Number(u.total_tokens??(input+output))||0;
    a.requests+=Number(info.request)||0; a.retries429+=Number(info.retries429)||0; a.transportRetries+=Number(info.transportRetry)||0; a.toolRecoveries+=Number(info.toolRecovery)||0; a.toolCalls+=Number(info.toolCall)||0; a.runs+=Number(info.run)||0;
    a.inputTokens+=input; a.outputTokens+=output; a.reasoningTokens+=reasoning; a.totalTokens+=total; a.lastAt=Date.now();
    const m=a.byModel[id]||{name:model.name||id,requests:0,inputTokens:0,outputTokens:0,reasoningTokens:0,totalTokens:0,retries429:0};
    m.requests+=Number(info.request)||0; m.inputTokens+=input; m.outputTokens+=output; m.reasoningTokens+=reasoning; m.totalTokens+=total; m.retries429+=Number(info.retries429)||0; m.name=model.name||m.name||id; a.byModel[id]=m;
    save(ANALYTICS_KEY,a); return a;
  }
  function resetAnalytics(){const a=blankAnalytics();save(ANALYTICS_KEY,a);return a;}
  function exportPreferences(){return {...getAIPreferences()};}
  function importPreferences(value){return setAIPreferences(value||{});}
  root.getAIPreferences=getAIPreferences; root.setAIPreferences=setAIPreferences; root.exportAIPreferences=exportPreferences; root.importAIPreferences=importPreferences; root.getAIAnalytics=getAnalytics; root.recordAnalytics=recordAnalytics; root.resetAIAnalytics=resetAnalytics;
})();

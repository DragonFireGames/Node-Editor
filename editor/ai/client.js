(function() {
  const root = window.EditorAI = window.EditorAI || {};
  function trimEndpoint(url){return String(url || '').replace(/\/+$/,'');}
  function appendPath(endpoint,path){const base=trimEndpoint(endpoint);return new RegExp(path.replace('/','\\/')+'$','i').test(base)?base:base+path;}
  function completionUrl(model){return appendPath(model.endpoint,'/chat/completions');}
  function responseUrl(model){return appendPath(model.endpoint,'/responses');}
  function anthropicUrl(model){const base=trimEndpoint(model.endpoint);if(/\/v1\/messages$/i.test(base))return base;if(/\/v1$/i.test(base))return base+'/messages';return base+'/v1/messages';}
  function cohereUrl(model){const base=trimEndpoint(model.endpoint);return /\/v2\/chat$/i.test(base)?base:base.replace(/\/v2$/i,'')+'/v2/chat';}
  function googleUrl(model,stream){
    let endpoint=trimEndpoint(model.endpoint), modelId=encodeURIComponent(String(model.model||'').replace(/^models\//,''));
    if(/:(?:streamGenerateContent|generateContent)$/i.test(endpoint)) return endpoint;
    endpoint=endpoint.replace(/\/v1beta(?:\/models)?$/i,'').replace(/\/models$/i,'');
    return endpoint+'/v1beta/models/'+modelId+':'+(stream?'streamGenerateContent?alt=sse':'generateContent');
  }

  function hordeHeaders(model){
    const headers={'Content-Type':'application/json','Client-Agent':'Node-Editor-AI/1.0'};
    const key=model.apiKey||model.anonymousAuth||'0000000000';
    if(key)headers.apikey=key;
    return headers;
  }
  function hordePrompt(messages){
    const lines=[];
    for(const m of messages){
      const role=m.role||'user';
      if(role==='system')lines.push('<|system|>\n'+textOf(m.content));
      else if(role==='assistant')lines.push('<|assistant|>\n'+textOf(m.content));
      else lines.push('<|user|>\n'+textOf(m.content));
    }
    lines.push('<|assistant|>\n');
    return lines.join('\n');
  }

  function parseSSEBlock(block){const data=String(block||'').split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');if(!data||data==='[DONE]')return null;try{return JSON.parse(data);}catch(_){return data;}}
  async function* streamResponse(response,signal){
    if(!response.body){const text=await response.text();yield text;return;}
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const parts=buffer.split(/\r?\n\r?\n/);buffer=parts.pop()||'';for(const part of parts)yield part;if(signal?.aborted)throw new DOMException('Aborted','AbortError');}
    buffer+=decoder.decode();if(buffer.trim())yield buffer;
  }
  function textOf(value){
    if(typeof value==='string')return value;
    if(Array.isArray(value))return value.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).join('');
    if(value?.text)return String(value.text);
    return '';
  }
  function normalizeToolCalls(calls){
    if(!Array.isArray(calls))return [];
    return calls.map((x,i)=>{
      const fn=x?.function || x?.functionCall || x?.function_call || x;
      const name=fn?.name || x?.name;
      const args=fn?.arguments ?? fn?.args ?? x?.arguments ?? x?.input ?? {};
      if(!name)return null;
      return {id:String(x?.id || x?.call_id || ('call-'+i+'-'+Math.random().toString(36).slice(2))),type:'function',function:{name:String(name),arguments:typeof args==='string'?args:JSON.stringify(args)}};
    }).filter(Boolean);
  }
  function normalizeChatData(data){
    const msg=data?.choices?.[0]?.message;
    if(msg)return {role:'assistant',content:textOf(msg.content),tool_calls:normalizeToolCalls(msg.tool_calls),reasoning_content:msg.reasoning_content||msg.reasoning||'',reasoning_kind:(msg.reasoning||msg.reasoning_content)?'reasoning':'',_usage:data?.usage||null};
    return {role:'assistant',content:textOf(data?.output_text || data?.text || ''),tool_calls:[],reasoning_content:data?.reasoning_content||'',_usage:data?.usage||null};
  }
  function normalizeResponsesData(data){
    const output=Array.isArray(data?.output)?data.output:[];let content=String(data?.output_text || '');const calls=[];let reasoning='';
    for(const item of output){
      if(item?.type==='message'){
        const parts=Array.isArray(item.content)?item.content:[];
        for(const part of parts) if(part?.type==='output_text') content += content ? (part.text===content?'':part.text) : (part.text||'');
      } else if(item?.type==='function_call') calls.push({id:item.call_id||item.id,type:'function',function:{name:item.name,arguments:typeof item.arguments==='string'?item.arguments:JSON.stringify(item.arguments||{})}});
      else if(item?.type==='reasoning') reasoning += textOf(item.summary || item.content || '');
    }
    return {role:'assistant',content,tool_calls:calls,reasoning_content:reasoning,reasoning_kind:reasoning?'summary':'',_usage:data?.usage||null};
  }
  function normalizeAnthropicData(data){
    let content='',calls=[];
    for(const item of data?.content || []){
      if(item?.type==='text')content+=item.text||'';
      else if(item?.type==='tool_use')calls.push({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.input||{})}});
    }
    return {role:'assistant',content,tool_calls:calls,reasoning_content:'',_usage:data?.usage||null};
  }
  function normalizeGeminiData(data){
    let content='',calls=[];
    const parts=data?.candidates?.[0]?.content?.parts || [];
    for(const p of parts){
      if(p?.text)content+=p.text;
      if(p?.functionCall?.name){
        calls.push({id:p.functionCall.id||('call-'+Math.random().toString(36).slice(2)),type:'function',function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})},_gemini:p,_geminiCallId:p.functionCall.id||null});
      }
    }
    return {role:'assistant',content,tool_calls:calls,reasoning_content:'',reasoning_kind:'',_geminiContent:data?.candidates?.[0]?.content||null};
  }
  function normalizeCohereData(data){
    const msg=data?.message || {};let content=textOf(msg.content);let calls=normalizeToolCalls(msg.tool_calls || msg.toolCalls);return {role:'assistant',content,tool_calls:calls,reasoning_content:'',_usage:data?.usage||null};
  }
  function openAIToolCall(c){return {id:c?.id,type:'function',function:{name:c?.function?.name||c?.name||'',arguments:typeof c?.function?.arguments==='string'?c.function.arguments:JSON.stringify(c?.function?.arguments||{})}};}
  function openAIChatMessages(messages){return messages.map(m=>{if(m.role==='tool')return {role:'tool',tool_call_id:m.tool_call_id||m.id,name:m.name,content:String(m.content||'')};return {role:m.role,content:String(m.content||''),...(Array.isArray(m.tool_calls)&&m.tool_calls.length?{tool_calls:m.tool_calls.map(openAIToolCall)}:{})};});}
  function responseInput(messages){
    return messages.flatMap(m=>{
      if(m.role==='tool')return [{type:'function_call_output',call_id:m.tool_call_id||m.id,output:String(m.content||'')}];
      const role=m.role==='assistant'?'assistant':m.role==='system'?'developer':'user';
      return [{type:'message',role,content:[{type:'input_text',text:String(m.content||'')}]}].concat((m.tool_calls||[]).map(c=>({type:'function_call',call_id:c.id,name:c.function?.name,arguments:c.function?.arguments||'{}'})));
    });
  }
  function anthropicMessages(messages){
    let system='';const out=[];
    for(const m of messages){
      if(m.role==='system'){system+=(system?'\n\n':'')+String(m.content||'');continue;}
      if(m.role==='tool'){
        const block={type:'tool_result',tool_use_id:m.tool_call_id||m.id,content:String(m.content||'')};
        const last=out[out.length-1];if(last?.role==='user' && Array.isArray(last.content))last.content.push(block);else out.push({role:'user',content:[block]});continue;
      }
      if(m.role==='assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length){
        const content=[];if(m.content)content.push({type:'text',text:String(m.content)});for(const c of m.tool_calls)content.push({type:'tool_use',id:c.id,name:c.function?.name,input:parseJSON(c.function?.arguments)});out.push({role:'assistant',content});
      } else out.push({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'')});
    }
    return {system,messages:out};
  }
  function geminiMessages(messages){
    let system='';const contents=[];
    for(const m of messages){
      if(m.role==='system'){system+=(system?'\n\n':'')+String(m.content||'');continue;}
      if(m.role==='tool'){
        const response={functionResponse:{name:m.name||'',response:parseJSON(m.content)}};
        if(m._geminiCallId)response.functionResponse.id=m._geminiCallId;
        contents.push({role:'user',parts:[response]});continue;
      }
      if(m.role==='assistant' && m._geminiContent){
        contents.push(m._geminiContent);
        continue;
      }
      const parts=[];if(m.content)parts.push({text:String(m.content)});for(const c of m.tool_calls||[])parts.push({functionCall:{...(c._gemini?.functionCall||{}),name:c.function?.name,args:parseJSON(c.function?.arguments)}});
      contents.push({role:m.role==='assistant'?'model':'user',parts:parts.length?parts:[{text:''}]});
    }
    return {system,contents};
  }
  function cohereMessages(messages){return messages.map(m=>m.role==='tool'?{role:'tool',content:[{type:'tool_result',tool_call_id:m.tool_call_id||m.id,content:String(m.content||'')}]}:{role:m.role,content:String(m.content||''),...(m.tool_calls?.length?{tool_calls:m.tool_calls}:{} )});}
  function parseJSON(text){try{return JSON.parse(text||'{}');}catch(_){return {value:String(text||'')};}}
  function toolsFor(model,tools){
    if(!Array.isArray(tools)||!tools.length)return undefined;
    const protocol=model.protocol;
    if(protocol==='anthropic-messages')return tools.map(t=>({name:t.function?.name,description:t.function?.description,input_schema:t.function?.parameters||{type:'object',properties:{}}}));
    if(protocol==='google-gemini')return [{functionDeclarations:tools.map(t=>{
      const parameters=t.function?.parameters||{type:'object',properties:{}};
      return {name:t.function?.name,description:t.function?.description||'',parametersJsonSchema:JSON.parse(JSON.stringify(parameters))};
    })}];
    if(protocol==='openai-responses')return tools.map(t=>({type:'function',name:t.function?.name,description:t.function?.description,parameters:t.function?.parameters||{type:'object',properties:{}}}));
    return tools;
  }
  function modelAuthKey(model,registry){if(model?.apiKey)return model.apiKey;if(root.isHuggingFaceEndpoint?.(model?.endpoint)){const userKey=registry?.getHuggingFaceApiKey?.()||'';if(userKey)return userKey;if(model.useSharedKeys!==false)return registry?.nextSharedHuggingFaceKey?.()||'';}return model?.anonymousAuth||'';}
  function supportsOpenAIReasoningSummary(model){
    const endpoint=String(model?.endpoint||'').toLowerCase();
    return model?.protocol==='openai-responses' && /(?:^|\/\/)api\.openai\.com(?:\/|$)/i.test(endpoint);
  }
  function providerDefinition(model,registry){
    const explicit=String(model?.provider||'').trim();
    const inferred=registry?.providerForModel?.(explicit==='custom'?{...model,provider:''}:model) || '';
    const id=explicit && explicit!=='custom' ? explicit : inferred;
    return id ? (registry?.provider?.(id) || {}) : {};
  }
  function chatProviderOptions(model,registry){
    const rules=providerDefinition(model,registry).chatOptions;
    if(!Array.isArray(rules)) return {};
    const id=String(model?.model||'');
    const rule=rules.find(x=>{
      const matcher=x?.match;
      if(!matcher)return false;
      try { if('lastIndex' in matcher) matcher.lastIndex=0; return typeof matcher.test==='function' ? !!matcher.test(id) : false; } catch(_) { return false; }
    });
    return rule?.body && typeof rule.body==='object' ? {...rule.body} : {};
  }
  function toolCallRecoveryDefinition(model,registry){
    const value=providerDefinition(model,registry).toolCallRecovery;
    return value && typeof value==='object' ? value : null;
  }
  async function detectToolCallParseFailure(response,model,registry){
    const strategy=toolCallRecoveryDefinition(model,registry);
    if(!strategy || response?.status!==Number(strategy.status||400)) return null;
    try {
      const data=await response.clone().json();
      const code=String(data?.error?.code||'');
      const message=String(data?.error?.message||'');
      const codes=Array.isArray(strategy.errorCodes)?strategy.errorCodes.map(String):[];
      if(!codes.includes(code) && !codes.some(x=>x && message.toLowerCase().includes(x.toLowerCase()))) return null;
      return {strategy,data};
    } catch(_) { return null; }
  }
  function nextRecoveryTemperature(current,strategy){
    const value=Number.isFinite(Number(current)) ? Number(current) : .7;
    const factor=Number.isFinite(Number(strategy?.factor)) ? Number(strategy.factor) : .5;
    const min=Number.isFinite(Number(strategy?.minTemperature)) ? Number(strategy.minTemperature) : .2;
    return Math.max(min,Math.min(1,value*factor));
  }
  function authHeaders(model,extra={},registry){const headers={'Content-Type':'application/json',...extra};const key=modelAuthKey(model,registry);if(key){if(model.protocol==='google-gemini')headers['x-goog-api-key']=key;else if(model.protocol==='anthropic-messages')headers['x-api-key']=key;else headers.Authorization='Bearer '+key;}return headers;}
  function requestConfig(model,messages,options,stream,registry){
    const tools=model.supportsTools===false ? undefined : toolsFor(model,options.tools), maxTokens=Math.max(16, options.maxTokens ?? 2048), temperature=options.temperature ?? .7;
    switch(model.protocol){
      case 'openai-chat':return {url:completionUrl(model),headers:authHeaders(model,{},registry),body:{model:model.model,messages:openAIChatMessages(messages),temperature,max_tokens:maxTokens,stream,...(stream?{stream_options:{include_usage:true}}:{}),...chatProviderOptions(model,registry),...(tools?{tools,tool_choice:options.tool_choice||'auto'}:{})}};
      case 'openai-responses':return {url:responseUrl(model),headers:authHeaders(model,{},registry),body:{model:model.model,input:responseInput(messages),stream,...(supportsOpenAIReasoningSummary(model)?{reasoning:{summary:'auto'}}:{}),...(tools?{tools,tool_choice:options.tool_choice||'auto'}:{})}};
      case 'anthropic-messages':{const x=anthropicMessages(messages);return {url:anthropicUrl(model),headers:authHeaders(model,{'anthropic-version':'2023-06-01'},registry),body:{model:model.model,max_tokens:maxTokens,system:x.system,messages:x.messages,stream,temperature,...(tools?{tools,tool_choice:{type:'auto'}}:{})}};}
      case 'google-gemini':{const x=geminiMessages(messages);return {url:googleUrl(model,stream),headers:authHeaders(model,{},registry),body:{contents:x.contents,...(x.system?{systemInstruction:{parts:[{text:x.system}]} }:{}),...(tools?{tools}:{}),generationConfig:{maxOutputTokens:maxTokens}}};}
      case 'cohere-v2':return {url:cohereUrl(model),headers:authHeaders(model,{},registry),body:{model:model.model,messages:cohereMessages(messages),stream,temperature,max_tokens:maxTokens,...(tools?{tools}:{})}};
      default:throw new Error(`Unsupported AI API format "${model.protocol||model.kind||'unknown'}". Open Settings and choose a supported API format.`);
    }
  }
  async function responseErrorMessage(response,prefix='AI request failed'){
    const status=Number(response?.status)||0;
    let raw=''; try{raw=await response.text();}catch(_){}
    let detail='';
    try{const data=JSON.parse(raw);const err=data?.error||data;if(err?.message)detail=String(err.message);if(err?.code)detail+=(detail?' ':'')+`[${String(err.code)}]`;}catch(_){}
    if(!detail)detail=raw.trim();
    if(detail.length>8000)detail=detail.slice(0,8000)+'…';
    return `${prefix} (${status}): ${detail || response?.statusText || 'Unknown error'}`;
  }
  function parseRateLimitReset(value){
    const text=String(value||'').trim();
    if(!text)return 0;
    const m=text.match(/([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m)?/i);
    if(!m)return 0;
    const n=Number(m[1]);
    if(!Number.isFinite(n))return 0;
    const unit=(m[2]||'s').toLowerCase();
    return unit==='ms'?n/1000:unit==='m'?n*60:n;
  }
  class AIClient {
    constructor(registry,network){this.registry=registry;this.network=network || window.__sharedBrowserNetwork || null;this.abortController=null;}
    model(){return this.registry.active();}
    async request(url,options={}){
      const init={...options};
      if(!this.network || typeof this.network.request!=='function') throw new Error('AI network is not initialized.');
      const model=this.model();
      const headers=new Headers(init.headers||{});
      const requestInit={...init,headers};
      const prefs=root.getAIPreferences?.() || {};
      const maxRetries=Math.max(0,Math.min(10,Number(options.max429Retries ?? prefs.max429Retries ?? 5)));
      const retryEnabled=options.retry429 !== false && prefs.retry429 !== false;
      const maxTransportRetries=Math.max(0,Math.min(10,Number(options.maxTransportRetries ?? prefs.maxTransportRetries ?? 2)));
      const retryTransport=options.retryTransport !== false && prefs.retryTransport !== false;
      const transportDelay=Math.max(250,Math.min(30000,Number(options.transportRetryDelay ?? prefs.transportRetryDelay ?? 1000)));
      let attempt=0,transportAttempt=0;
      while(true){
        if(options.signal?.aborted) throw new DOMException('Aborted','AbortError');
        const request=new Request(url,requestInit);
        let response=null, transportError=null;
        try { response=await this.network.request(request,'ai'); } catch(e) { transportError=e; }
        if(!response){
          if(retryTransport && transportAttempt<maxTransportRetries){
            transportAttempt++;
            const waitMs=Math.min(30000,transportDelay*Math.pow(2,transportAttempt-1)+Math.floor(Math.random()*250));
            root.recordAnalytics?.({model,transportRetry:1,request:1});
            options.onRetry?.({kind:'transport_retry',attempt:transportAttempt,maxRetries:maxTransportRetries,waitMs,status:0,model,error:transportError?.message||'No endpoint returned a response.'});
            await new Promise(resolve=>setTimeout(resolve,waitMs));
            continue;
          }
          if(transportError) throw transportError;
          throw new Error('AI network request failed: no endpoint returned a response.');
        }
        options.onResponse?.({status:response.status,ok:response.ok,url:response.url||url,attempt:transportAttempt+1,model});
        if(response.status!==429 || !retryEnabled || attempt>=maxRetries) return response;
        const retryAfter=Number(response.headers?.get?.('retry-after')||0);
        const reset=String(response.headers?.get?.('x-ratelimit-reset-tokens')||'');
        const resetSeconds=parseRateLimitReset(reset);
        const base=Math.max(250,Number(options.baseRetryDelay ?? prefs.baseRetryDelay ?? 1500));
        const exponential=Math.min(30000,base*Math.pow(2,attempt));
        const waitMs=Math.max(250,Math.min(60000, (retryAfter>0?retryAfter*1000:resetSeconds>0?resetSeconds*1000:exponential) + Math.floor(Math.random()*350)));
        attempt++;
        root.recordAnalytics?.({model,retries429:1});
        options.onRetry?.({attempt,maxRetries,waitMs,status:429,model});
        try { await response.text(); } catch(_) {}
        await new Promise(resolve=>setTimeout(resolve,waitMs));
      }
    }
    cancel(){this.abortController?.abort();this.abortController=null;}
    async completeHorde(messages,options,model){
      const base=trimEndpoint(model.endpoint).replace(/\/v2$/i,'/v2');
      const headers=hordeHeaders(model);
      const maxLength=Math.min(512,Math.max(16,options.maxTokens??256));
      const body={prompt:hordePrompt(messages),params:{max_length:maxLength,max_context_length:Math.min(4096,Math.max(512,options.maxContextLength??4096)),temperature:options.temperature??.7,top_p:options.topP??.9,n:1},models:[model.model],trusted_workers:false};
      const response=await this.request(base+'/generate/text/async',{method:'POST',headers,signal:options.signal,body:JSON.stringify(body)});
      if(!response.ok)throw new Error(`AI Horde request failed (${response.status}): ${await response.text()}`);
      const job=await response.json();
      if(!job?.id)throw new Error(`AI Horde did not return a generation ID: ${JSON.stringify(job)}`);
      options.onQueueStatus?.({queuePosition:job.queue_position,waitTime:job.wait_time,waiting:true,processing:false,done:false});
      let lastStatusAt=Date.now();
      let lastSignature='';
      while(true){
        if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
        await new Promise(resolve=>setTimeout(resolve,1500));
        if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
        const statusResponse=await this.request(base+'/generate/text/status/'+encodeURIComponent(job.id),{headers:{'Client-Agent':'Node-Editor-AI/1.0',apikey:headers.apikey},signal:options.signal});
        if(!statusResponse.ok)throw new Error(`AI Horde status failed (${statusResponse.status}): ${await statusResponse.text()}`);
        const status=await statusResponse.json();
        const queuePosition=Number.isFinite(status.queue_position)?status.queue_position:null;
        const waitTime=Number.isFinite(status.wait_time)?status.wait_time:null;
        const waiting=(status.waiting||0)>0;
        const processing=(status.processing||0)>0;
        const finished=!!(status.finished||status.done);
        const signature=JSON.stringify({queuePosition,waitTime,waiting,processing,finished,faulted:!!status.faulted,generations:Array.isArray(status.generations)?status.generations.length:0});
        if(signature!==lastSignature){lastSignature=signature;lastStatusAt=Date.now();}
        options.onQueueStatus?.({queuePosition,waitTime,waiting,processing,done:!!status.done,finished});
        if(status.faulted)throw new Error(`AI Horde generation faulted: ${JSON.stringify(status)}`);
        if(status.done || status.finished){
          const generation=status.generations?.[0];
          return {role:'assistant',content:textOf(generation?.text||status.text||''),tool_calls:[],reasoning_content:''};
        }
        if(!waiting && !processing && Date.now()-lastStatusAt>10*60*1000){
          throw new Error('AI Horde generation stopped reporting progress for 10 minutes.');
        }
      }
    }

    async complete(messages,options={}){
      const model=options.model||this.model();
      if(model.protocol==='gradio-space')return await this.completeGradio(messages,options,model);
      if(model.protocol==='ai-horde')return await this.completeHorde(messages,options,model);
      let temperature=options.temperature??.7;
      let response=null;
      const prefs=root.getAIPreferences?.()||{};
      const recovery=toolCallRecoveryDefinition(model,this.registry);
      const recoveryEnabled=options.toolRecovery!==false && prefs.toolRecovery!==false && !!recovery;
      const recoveryRetries=Math.max(0,Math.min(10,Number(options.maxToolRecoveryRetries??prefs.maxToolRecoveryRetries??recovery?.maxRetries??0)));
      for(let parseAttempt=0;parseAttempt<=recoveryRetries;parseAttempt++){
        const requestOptions={...options,temperature};
        const cfg=requestConfig(model,messages,requestOptions,false,this.registry);
        response=await this.request(cfg.url,{method:'POST',headers:cfg.headers,signal:options.signal,body:JSON.stringify(cfg.body),onRetry:options.onRetry,onResponse:options.onResponse,max429Retries:options.max429Retries,baseRetryDelay:options.baseRetryDelay,retry429:options.retry429,retryTransport:options.retryTransport,maxTransportRetries:options.maxTransportRetries,transportRetryDelay:options.transportRetryDelay});
        if(response.ok) break;
        const parseFailure=recoveryEnabled ? await detectToolCallParseFailure(response,model,this.registry) : null;
        if(!parseFailure || parseAttempt>=recoveryRetries || recovery?.strategy!=='lower-temperature') break;
        temperature=nextRecoveryTemperature(temperature,recovery);
        root.recordAnalytics?.({model,toolRecovery:1}); options.onRetry?.({kind:'tool_parse_recovery',attempt:parseAttempt+1,maxRetries:recoveryRetries,waitMs:0,status:response.status,model,text:`Tool-call parsing failed; retrying with temperature ${temperature.toFixed(2)} (attempt ${parseAttempt+2}/${recoveryRetries+1}).`});
      }
      if(!response?.ok)throw new Error(await responseErrorMessage(response));
      const data=await response.json();
      let result;
      if(model.protocol==='openai-responses')result=normalizeResponsesData(data);
      else if(model.protocol==='anthropic-messages')result=normalizeAnthropicData(data);
      else if(model.protocol==='google-gemini')result=normalizeGeminiData(data);
      else if(model.protocol==='cohere-v2')result=normalizeCohereData(data);
      else result=normalizeChatData(data);
      root.recordAnalytics?.({model,usage:result._usage,request:1});
      return result;
    }
    async completeGradio(messages,options,model){const result={role:'assistant',content:'',reasoning_content:''};for await(const chunk of this.streamGradio(messages,options,model)){result.content=chunk.text||result.content;result.reasoning_content=chunk.reasoning||result.reasoning_content;}return result;}
    async *stream(messages,options={}){
      const model=options.model||this.model();this.cancel();const controller=new AbortController();this.abortController=controller;
      try {
        if(model.protocol==='gradio-space')yield* this.streamGradio(messages,{...options,signal:controller.signal},model);
        else if(model.protocol==='ai-horde') { const result=await this.completeHorde(messages,{...options,signal:controller.signal},model); yield {text:result.content||'',delta:result.content||'',reasoning:''}; }
        else if(model.supportsStreaming===false) { const result=await this.complete(messages,{...options,signal:controller.signal}); yield {text:result.content||'',delta:result.content||'',reasoning:result.reasoning_content||''}; }
        else if(['openai-chat','openai-responses','anthropic-messages','google-gemini'].includes(model.protocol))yield* this.streamNative(messages,{...options,signal:controller.signal},model);
        else {const result=await this.complete(messages,{...options,signal:controller.signal});yield {text:result.content||'',delta:result.content||'',reasoning:result.reasoning_content||''};}
      } finally {if(this.abortController===controller)this.abortController=null;}
    }
    async *streamNative(messages,options,model){
      let temperature=options.temperature??.7;
      let response=null;
      const prefs=root.getAIPreferences?.()||{};
      const recovery=toolCallRecoveryDefinition(model,this.registry);
      const recoveryEnabled=options.toolRecovery!==false && prefs.toolRecovery!==false && !!recovery;
      const recoveryRetries=Math.max(0,Math.min(10,Number(options.maxToolRecoveryRetries??prefs.maxToolRecoveryRetries??recovery?.maxRetries??0)));
      for(let parseAttempt=0;parseAttempt<=recoveryRetries;parseAttempt++){
        const requestOptions={...options,temperature};
        const cfg=requestConfig(model,messages,requestOptions,true,this.registry);
        response=await this.request(cfg.url,{method:'POST',headers:cfg.headers,signal:options.signal,body:JSON.stringify(cfg.body),onRetry:options.onRetry,onResponse:options.onResponse,max429Retries:options.max429Retries,baseRetryDelay:options.baseRetryDelay,retry429:options.retry429,retryTransport:options.retryTransport,maxTransportRetries:options.maxTransportRetries,transportRetryDelay:options.transportRetryDelay});
        if(response.ok) break;
        const parseFailure=recoveryEnabled ? await detectToolCallParseFailure(response,model,this.registry) : null;
        if(!parseFailure || parseAttempt>=recoveryRetries || recovery?.strategy!=='lower-temperature') break;
        temperature=nextRecoveryTemperature(temperature,recovery);
        root.recordAnalytics?.({model,toolRecovery:1}); options.onRetry?.({kind:'tool_parse_recovery',attempt:parseAttempt+1,maxRetries:recoveryRetries,waitMs:0,status:response.status,model,text:`Tool-call parsing failed; retrying with temperature ${temperature.toFixed(2)} (attempt ${parseAttempt+2}/${recoveryRetries+1}).`});
      }
      if(!response?.ok)throw new Error(await responseErrorMessage(response));
      let full='',reasoning='',lastReasoning='',usage=null;
      for await(const block of streamResponse(response,options.signal)){
        let data=parseSSEBlock(block); if(data==null){try{data=JSON.parse(String(block).trim())}catch(_){continue;}}
        usage=data?.usage||data?.usageMetadata||data?.response?.usage||usage;
        if(model.protocol==='openai-chat'){
          const delta=data?.choices?.[0]?.delta||{};const text=delta.content||'';const think=delta.reasoning_content||delta.reasoning||'';
          if(text){full+=text;yield {text:full,delta:text,reasoning};} if(think){reasoning+=think;yield {text:full,delta:'',reasoning,reasoningKind:'reasoning'};}
        } else if(model.protocol==='openai-responses'){
          const type=data?.type||'';if(type==='response.output_text.delta'){const text=data.delta||'';full+=text;yield {text:full,delta:text,reasoning};} else if(type==='response.reasoning_summary_text.delta'){const delta=data.delta||'';if(delta){reasoning+=delta;yield {text:full,delta:'',reasoning,reasoningKind:'summary'};}} else if(type==='response.reasoning_summary_text.done'){const text=data.text||'';if(text){reasoning=text;yield {text:full,delta:'',reasoning,reasoningKind:'summary'};}}
        } else if(model.protocol==='anthropic-messages'){
          const type=data?.type||'';if(type==='content_block_delta'){const d=data.delta||{};if(d.type==='text_delta'&&d.text){full+=d.text;yield {text:full,delta:d.text,reasoning};}else if(d.type==='thinking_delta'&&d.thinking){reasoning+=d.thinking;yield {text:full,delta:'',reasoning};}}
        } else if(model.protocol==='google-gemini'){
          const parts=data?.candidates?.[0]?.content?.parts||[];for(const p of parts){if(p?.text){full+=p.text;yield {text:full,delta:p.text,reasoning};}}
        }
        if(reasoning!==lastReasoning){lastReasoning=reasoning;}
      }
      if(usage){root.recordAnalytics?.({model,usage,request:1});yield {text:full,delta:'',reasoning,usage};}
    }
    async *streamGradio(messages,options,model){
      const endpoint=trimEndpoint(model.endpoint),history=[];
      for(const m of messages){if(m.role==='user')history.push([m.content,'']);else if(m.role==='assistant'){const last=history[history.length-1];if(last&&last[1]==='')last[1]=typeof m.content==='string'?m.content:'';else history.push(['',typeof m.content==='string'?m.content:'']);}}
      const lastUser=[...messages].reverse().find(x=>x.role==='user')?.content||'',cleanedHistory=history.slice(0,-1),thinkingMode=options.thinking===false?'⚡ Fast Mode  (direct answer)':'🧠 Thinking Mode  (chain-of-thought reasoning)';
      const payload={data:[typeof lastUser==='string'?lastUser:JSON.stringify(lastUser),cleanedHistory,model.remoteModel||model.model,thinkingMode,'',options.systemPrompt||'',options.maxTokens||2048,options.temperature??.7,options.topP??.9]};let submit=null,usedPath='';
      for(const path of ['/gradio/gradio_api/call/chat','/gradio_api/call/chat']){const response=await this.request(endpoint+path,{method:'POST',headers:authHeaders(model,{},this.registry),body:JSON.stringify(payload),signal:options.signal});if(response.status===404)continue;if(!response.ok)throw new Error(`Public model request failed (${response.status}): ${await response.text()}`);submit=await response.json();usedPath=path;break;}
      if(!submit?.event_id)throw new Error('Public model did not return a Gradio event ID.');
      const eventResponse=await this.request(endpoint+usedPath+'/'+encodeURIComponent(submit.event_id),{signal:options.signal,headers:model.apiKey?{'Authorization':'Bearer '+model.apiKey}:{}});if(!eventResponse.ok)throw new Error(`Public model stream failed (${eventResponse.status}): ${await eventResponse.text()}`);
      let previous='',reasoning='';
      for await(const block of streamResponse(eventResponse,options.signal)){const event=parseSSEBlock(block);if(!event)continue;const type=String(event.event||''),parsed=event.data!==undefined?event.data:event;let value=parsed;if(typeof value==='string'){try{value=JSON.parse(value)}catch(_){}}if(type==='error')throw new Error(Array.isArray(value)?value.join(' '):String(value));let text=value;if(Array.isArray(text))text=text[0];if(text&&typeof text==='object'&&text.data!==undefined)text=text.data;if(Array.isArray(text))text=text[0];if(typeof text!=='string')continue;if(text===previous)continue;if(text.length>=previous.length&&text.startsWith(previous))previous=text;else previous=text;const match=previous.match(/<details>\s*<summary>.*?<\/summary>[\s\S]*?<\/details>\s*/i);if(match){reasoning=match[0].replace(/<[^>]+>/g,'').replace(/^\s*Reasoning Chain.*?\n/i,'').trim();yield {text:previous,delta:'',reasoning};}else yield {text:previous,delta:previous,reasoning};}
    }
  }
  root.AIClient=AIClient;
})();

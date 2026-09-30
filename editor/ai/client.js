(function() {
  const root = window.EditorAI = window.EditorAI || {};
  function trimEndpoint(url){return String(url || '').replace(/\/+$/,'');}
  function appendPath(endpoint,path){const base=trimEndpoint(endpoint);return new RegExp(path.replace('/','\\/')+'$','i').test(base)?base:base+path;}
  function completionUrl(model){return appendPath(model.endpoint,'/chat/completions');}
  function responseUrl(model){return appendPath(model.endpoint,'/responses');}
  function anthropicUrl(model){const base=trimEndpoint(model.endpoint);if(/\/v1\/messages$/i.test(base))return base;if(/\/v1$/i.test(base))return base+'/messages';return base+'/v1/messages';}
  function cohereUrl(model){const base=trimEndpoint(model.endpoint);return /\/v2\/chat$/i.test(base)?base:base.replace(/\/v2$/i,'')+'/v2/chat';}
  function googleUrl(model,stream){
    const endpoint=trimEndpoint(model.endpoint), modelId=encodeURIComponent(model.model.replace(/^models\//,''));
    if (/:(?:streamGenerateContent|generateContent)$/i.test(endpoint)) return endpoint;
    return endpoint.replace(/\/models$/i,'')+'/v1beta/models/'+modelId+':'+(stream?'streamGenerateContent':'generateContent');
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
    if(msg)return {role:'assistant',content:textOf(msg.content),tool_calls:normalizeToolCalls(msg.tool_calls),reasoning_content:msg.reasoning_content||msg.reasoning||''};
    return {role:'assistant',content:textOf(data?.output_text || data?.text || ''),tool_calls:[],reasoning_content:data?.reasoning_content||''};
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
    return {role:'assistant',content,tool_calls:calls,reasoning_content:reasoning};
  }
  function normalizeAnthropicData(data){
    let content='',calls=[];
    for(const item of data?.content || []){
      if(item?.type==='text')content+=item.text||'';
      else if(item?.type==='tool_use')calls.push({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.input||{})}});
    }
    return {role:'assistant',content,tool_calls:calls,reasoning_content:''};
  }
  function normalizeGeminiData(data){
    let content='',calls=[];
    const parts=data?.candidates?.[0]?.content?.parts || [];
    for(const p of parts){if(p?.text)content+=p.text;if(p?.functionCall?.name)calls.push({id:p.functionCall.id||('call-'+Math.random().toString(36).slice(2)),type:'function',function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})}});}
    return {role:'assistant',content,tool_calls:calls,reasoning_content:''};
  }
  function normalizeCohereData(data){
    const msg=data?.message || {};let content=textOf(msg.content);let calls=normalizeToolCalls(msg.tool_calls || msg.toolCalls);return {role:'assistant',content,tool_calls:calls,reasoning_content:''};
  }
  function openAIChatMessages(messages){return messages.map(m=>{if(m.role==='tool')return {role:'tool',tool_call_id:m.tool_call_id||m.id,name:m.name,content:String(m.content||'')};return {...m};});}
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
        const response={functionResponse:{name:m.name||'',response:parseJSON(m.content)}};contents.push({role:'user',parts:[response]});continue;
      }
      const parts=[];if(m.content)parts.push({text:String(m.content)});for(const c of m.tool_calls||[])parts.push({functionCall:{name:c.function?.name,args:parseJSON(c.function?.arguments)}});
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
    if(protocol==='google-gemini')return [{functionDeclarations:tools.map(t=>({name:t.function?.name,description:t.function?.description,parameters:t.function?.parameters||{type:'object',properties:{}}}))}];
    if(protocol==='openai-responses')return tools.map(t=>({type:'function',name:t.function?.name,description:t.function?.description,parameters:t.function?.parameters||{type:'object',properties:{}}}));
    return tools;
  }
  function authHeaders(model,extra={}){const headers={'Content-Type':'application/json',...extra};const key=model.apiKey||model.anonymousAuth||'';if(key){if(model.protocol==='google-gemini')headers['x-goog-api-key']=key;else if(model.protocol==='anthropic-messages')headers['x-api-key']=key;else headers.Authorization='Bearer '+key;}return headers;}
  function requestConfig(model,messages,options,stream){
    const tools=toolsFor(model,options.tools), maxTokens=options.maxTokens ?? 2048, temperature=options.temperature ?? .7;
    switch(model.protocol){
      case 'openai-chat':return {url:completionUrl(model),headers:authHeaders(model),body:{model:model.model,messages:openAIChatMessages(messages),temperature,max_tokens:maxTokens,stream,...(tools?{tools,tool_choice:options.tool_choice||'auto'}:{})}};
      case 'openai-responses':return {url:responseUrl(model),headers:authHeaders(model),body:{model:model.model,input:responseInput(messages),stream,...(options.systemPrompt?{}:{}),...(tools?{tools,tool_choice:options.tool_choice||'auto'}:{})}};
      case 'anthropic-messages':{const x=anthropicMessages(messages);return {url:anthropicUrl(model),headers:authHeaders(model,{'anthropic-version':'2023-06-01'}),body:{model:model.model,max_tokens:maxTokens,system:x.system,messages:x.messages,stream,temperature,...(tools?{tools,tool_choice:{type:'auto'}}:{})}};}
      case 'google-gemini':{const x=geminiMessages(messages);return {url:googleUrl(model,stream),headers:authHeaders(model),body:{contents:x.contents,...(x.system?{systemInstruction:{parts:[{text:x.system}]} }:{}),...(tools?{tools}:{}),generationConfig:{temperature,maxOutputTokens:maxTokens}}};}
      case 'cohere-v2':return {url:cohereUrl(model),headers:authHeaders(model),body:{model:model.model,messages:cohereMessages(messages),stream,temperature,max_tokens:maxTokens,...(tools?{tools}:{})}};
      default:throw new Error(`Unsupported AI API format "${model.protocol||model.kind||'unknown'}". Open Settings and choose a supported API format.`);
    }
  }
  class AIClient {
    constructor(registry,network){this.registry=registry;this.network=network || window.__sharedBrowserNetwork || null;this.abortController=null;}
    model(){return this.registry.active();}
    async request(url,options={}){
      const init={...options};
      if(!this.network || typeof this.network.request!=='function') throw new Error('AI network is not initialized.');
      const request=new Request(url,init);
      const response=await this.network.request(request,'ai');
      if(!response) throw new Error('AI network request failed: no endpoint returned a response.');
      return response;
    }
    cancel(){this.abortController?.abort();this.abortController=null;}
    async complete(messages,options={}){
      const model=options.model||this.model();
      if(model.protocol==='gradio-space')return await this.completeGradio(messages,options,model);
      const cfg=requestConfig(model,messages,options,false);
      const response=await this.request(cfg.url,{method:'POST',headers:cfg.headers,signal:options.signal,body:JSON.stringify(cfg.body)});
      if(!response.ok)throw new Error(`AI request failed (${response.status}): ${await response.text()}`);
      const data=await response.json();
      if(model.protocol==='openai-responses')return normalizeResponsesData(data);
      if(model.protocol==='anthropic-messages')return normalizeAnthropicData(data);
      if(model.protocol==='google-gemini')return normalizeGeminiData(data);
      if(model.protocol==='cohere-v2')return normalizeCohereData(data);
      return normalizeChatData(data);
    }
    async completeGradio(messages,options,model){const result={role:'assistant',content:'',reasoning_content:''};for await(const chunk of this.streamGradio(messages,options,model)){result.content=chunk.text||result.content;result.reasoning_content=chunk.reasoning||result.reasoning_content;}return result;}
    async *stream(messages,options={}){
      const model=options.model||this.model();this.cancel();const controller=new AbortController();this.abortController=controller;
      try {
        if(model.protocol==='gradio-space')yield* this.streamGradio(messages,{...options,signal:controller.signal},model);
        else if(['openai-chat','openai-responses','anthropic-messages'].includes(model.protocol))yield* this.streamNative(messages,{...options,signal:controller.signal},model);
        else {const result=await this.complete(messages,{...options,signal:controller.signal});yield {text:result.content||'',delta:result.content||'',reasoning:result.reasoning_content||''};}
      } finally {if(this.abortController===controller)this.abortController=null;}
    }
    async *streamNative(messages,options,model){
      const cfg=requestConfig(model,messages,options,true);const response=await this.request(cfg.url,{method:'POST',headers:cfg.headers,signal:options.signal,body:JSON.stringify(cfg.body)});
      if(!response.ok)throw new Error(`AI request failed (${response.status}): ${await response.text()}`);
      let full='',reasoning='',lastReasoning='';
      for await(const block of streamResponse(response,options.signal)){
        let data=parseSSEBlock(block); if(data==null){try{data=JSON.parse(String(block).trim())}catch(_){continue;}}
        if(model.protocol==='openai-chat'){
          const delta=data?.choices?.[0]?.delta||{};const text=delta.content||'';const think=delta.reasoning_content||delta.reasoning||'';
          if(text){full+=text;yield {text:full,delta:text,reasoning};} if(think){reasoning+=think;yield {text:full,delta:'',reasoning};}
        } else if(model.protocol==='openai-responses'){
          const type=data?.type||'';if(type==='response.output_text.delta'){const text=data.delta||'';full+=text;yield {text:full,delta:text,reasoning};}
        } else if(model.protocol==='anthropic-messages'){
          const type=data?.type||'';if(type==='content_block_delta'){const d=data.delta||{};if(d.type==='text_delta'&&d.text){full+=d.text;yield {text:full,delta:d.text,reasoning};}else if(d.type==='thinking_delta'&&d.thinking){reasoning+=d.thinking;yield {text:full,delta:'',reasoning};}}
        }
        if(reasoning!==lastReasoning){lastReasoning=reasoning;}
      }
    }
    async *streamGradio(messages,options,model){
      const endpoint=trimEndpoint(model.endpoint),history=[];
      for(const m of messages){if(m.role==='user')history.push([m.content,'']);else if(m.role==='assistant'){const last=history[history.length-1];if(last&&last[1]==='')last[1]=typeof m.content==='string'?m.content:'';else history.push(['',typeof m.content==='string'?m.content:'']);}}
      const lastUser=[...messages].reverse().find(x=>x.role==='user')?.content||'',cleanedHistory=history.slice(0,-1),thinkingMode=options.thinking===false?'⚡ Fast Mode  (direct answer)':'🧠 Thinking Mode  (chain-of-thought reasoning)';
      const payload={data:[typeof lastUser==='string'?lastUser:JSON.stringify(lastUser),cleanedHistory,model.remoteModel||model.model,thinkingMode,'',options.systemPrompt||'',options.maxTokens||2048,options.temperature??.7,options.topP??.9]};let submit=null,usedPath='';
      for(const path of ['/gradio/gradio_api/call/chat','/gradio_api/call/chat']){const response=await this.request(endpoint+path,{method:'POST',headers:authHeaders(model),body:JSON.stringify(payload),signal:options.signal});if(response.status===404)continue;if(!response.ok)throw new Error(`Public model request failed (${response.status}): ${await response.text()}`);submit=await response.json();usedPath=path;break;}
      if(!submit?.event_id)throw new Error('Public model did not return a Gradio event ID.');
      const eventResponse=await this.request(endpoint+usedPath+'/'+encodeURIComponent(submit.event_id),{signal:options.signal,headers:model.apiKey?{'Authorization':'Bearer '+model.apiKey}:{}});if(!eventResponse.ok)throw new Error(`Public model stream failed (${eventResponse.status}): ${await eventResponse.text()}`);
      let previous='',reasoning='';
      for await(const block of streamResponse(eventResponse,options.signal)){const event=parseSSEBlock(block);if(!event)continue;const type=String(event.event||''),parsed=event.data!==undefined?event.data:event;let value=parsed;if(typeof value==='string'){try{value=JSON.parse(value)}catch(_){}}if(type==='error')throw new Error(Array.isArray(value)?value.join(' '):String(value));let text=value;if(Array.isArray(text))text=text[0];if(text&&typeof text==='object'&&text.data!==undefined)text=text.data;if(Array.isArray(text))text=text[0];if(typeof text!=='string')continue;if(text===previous)continue;if(text.length>=previous.length&&text.startsWith(previous))previous=text;else previous=text;const match=previous.match(/<details>\s*<summary>.*?<\/summary>[\s\S]*?<\/details>\s*/i);if(match){reasoning=match[0].replace(/<[^>]+>/g,'').replace(/^\s*Reasoning Chain.*?\n/i,'').trim();yield {text:previous,delta:'',reasoning};}else yield {text:previous,delta:previous,reasoning};}
    }
  }
  root.AIClient=AIClient;
})();

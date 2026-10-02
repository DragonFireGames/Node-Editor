(function() {
  const root = window.EditorAI = window.EditorAI || {};
  function toolSchema(tools) { return tools.list().map(t => ({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters||{type:'object',properties:{}}}})); }
  function parseToolProtocol(text) {
    const out=[]; const re=/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g; let m;
    while((m=re.exec(text))){try{const x=JSON.parse(m[1]);if(x?.name)out.push({id:'proto-'+Math.random().toString(36).slice(2),name:x.name,arguments:x.arguments||{}})}catch(_){} }
    return out;
  }
  function stripToolProtocol(text) { return String(text||'').replace(/<tool_call>[\s\S]*?<\/tool_call>/g,'').trim(); }
  function stringifyResult(value, maxChars=120000) {
    let text;
    try { text=JSON.stringify(value); } catch(_) { text=String(value); }
    text=String(text ?? '');
    if(text.length<=maxChars)return text;
    return text.slice(0,maxChars)+`\n… [truncated ${text.length-maxChars} characters]`;
  }
  class AIAgent {
    constructor(options) { Object.assign(this,options); this.maxSteps=options.maxSteps||24; this.running=false; }
    async permission(tool,args,resultPreview) {
      const name=tool.permission || 'ask'; const manager=this.permissions;
      const policy=manager?.get(name) || 'ask';
      if(policy==='always')return true;
      if(policy==='never')throw new Error(`Permission denied: ${tool.name}`);
      if(typeof this.requestPermission!=='function')throw new Error(`Permission required: ${tool.name}`);
      const decision=await this.requestPermission({tool,args,preview:resultPreview});
      if(decision==='always')manager?.set(name,'always');
      if(decision==='deny' || decision===false)throw new Error(`Permission denied: ${tool.name}`);
      return true;
    }
    async executeTool(call) {
      const started=performance.now?.() ?? Date.now();
      let tool=this.tools.map.get(call?.name);
      let args={};
      try {
        if(!tool) throw new Error(`Unknown tool: ${call?.name || 'unnamed tool'}`);
        args=typeof call.arguments==='string' ? JSON.parse(call.arguments||'{}') : (call.arguments||{});
        if(!args || typeof args!=='object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
        this.emit?.({type:'tool_call',name:tool.name,args});
        await this.permission(tool,args,call.preview || args);
        const result=await tool.execute(args);
        const durationMs=Math.max(0,Math.round((performance.now?.() ?? Date.now())-started));
        this.emit?.({type:'tool_result',name:tool.name,args,result,ok:true,durationMs});
        return result;
      } catch(e) {
        const durationMs=Math.max(0,Math.round((performance.now?.() ?? Date.now())-started));
        const error={error:e?.message||String(e)};
        if(!tool) error.tool=call?.name||'';
        if(/Permission denied|Permission required/.test(error.error)) error.permissionDenied=true;
        this.emit?.({type:'tool_result',name:tool?.name||call?.name||'unknown',args,result:error,ok:false,durationMs});
        return error;
      }
    }
    async run(messages, options={}) {
      if(this.running)throw new Error('An AI task is already running.');
      this.running=true;
      try {
        const model=this.client.model();
        const toolDefs=toolSchema(this.tools);
        const canNative=!!model.supportsTools;
        const working=messages.map(x=>({role:x.role,content:x.content,...(x.tool_call_id?{tool_call_id:x.tool_call_id}:{}),...(x.name?{name:x.name}:{}),...(Array.isArray(x.tool_calls)?{tool_calls:x.tool_calls}:{}),...(x.role==='assistant'&&x._geminiContent?{_geminiContent:x._geminiContent}:{}),...(x._geminiCallId?{_geminiCallId:x._geminiCallId}: {})}));
        if(!canNative){
          const instructions = '\n\nYou have access to project tools. When a tool is needed, output exactly one or more tags in this format:\n<tool_call>{"name":"read_file","arguments":{"path":"file.js"}}</tool_call>\nDo not put tool calls inside Markdown code fences. Use valid JSON arguments matching the schemas below. After receiving tool results, continue the task.\n\nTool schemas:\n' + this.tools.list().map(t => JSON.stringify({name:t.name,description:t.description,parameters:t.parameters||{type:'object',properties:{}}})).join('\n');
          if(working[0]?.role === 'system') working[0] = {...working[0], content:working[0].content + instructions};
          else working.unshift({role:'system',content:(options.systemPrompt||'') + instructions});
        }
        let finalText=''; let reasoning='';
        for(let step=0;step<this.maxSteps;step++){
          this.emit?.({type:'step',step:step+1,maxSteps:this.maxSteps});
          if(canNative){
            this.emit?.({type:'request_start',model:model.model||model.id||'model',protocol:model.protocol||model.kind||'unknown',step:step+1,maxSteps:this.maxSteps});
            const msg=await this.client.complete(working,{model,tools:toolDefs,systemPrompt:options.systemPrompt,thinking:true,maxTokens:options.maxTokens,onRetry:options.onRetry,max429Retries:options.max429Retries,baseRetryDelay:options.baseRetryDelay,retry429:options.retry429,retryTransport:options.retryTransport,maxTransportRetries:options.maxTransportRetries,transportRetryDelay:options.transportRetryDelay,onResponse:info=>this.emit?.({type:'request_response',...info})});
            const think=msg.reasoning_content||msg.reasoning||''; if(think){reasoning+=think;this.emit?.({type:msg.reasoning_kind==='summary'?'reasoning_summary':'reasoning',text:think});}
            const calls=Array.isArray(msg.tool_calls)?msg.tool_calls.map((x,i)=>({id:x.id||x._geminiCallId||`tool-${Date.now()}-${i}`,name:x.function?.name,arguments:x.function?.arguments||'{}',_geminiCallId:x._geminiCallId||null})).filter(x=>x.name):[];
            if(!calls.length){ finalText=String(msg.content||''); working.push({role:'assistant',content:finalText}); this.emit?.({type:'final',text:finalText,reasoning}); return {text:finalText,reasoning}; }
            working.push({role:'assistant',content:msg.content||'',tool_calls:msg.tool_calls,_geminiContent:msg._geminiContent||null});
            for(const call of calls){ const result=await this.executeTool(call); working.push({role:'tool',tool_call_id:call.id,_geminiCallId:call._geminiCallId,name:call.name,content:stringifyResult(result)}); }
          } else {
            let text=''; let lastReasoning='';
            this.emit?.({type:'request_start',model:model.model||model.id||'model',protocol:model.protocol||model.kind||'unknown',step:step+1,maxSteps:this.maxSteps});
            const streamOptions={model,systemPrompt:options.systemPrompt,thinking:true,maxTokens:options.maxTokens,onRetry:options.onRetry,max429Retries:options.max429Retries,baseRetryDelay:options.baseRetryDelay,retry429:options.retry429};
            for await(const chunk of this.client.stream(working,streamOptions)){text=chunk.text||text; if(chunk.reasoning&&chunk.reasoning!==lastReasoning){const delta=chunk.reasoning.slice(lastReasoning.length);if(delta){reasoning+=delta;this.emit?.({type:chunk.reasoningKind==='summary'?'reasoning_summary':'reasoning',text:delta});}lastReasoning=chunk.reasoning;} this.emit?.({type:'assistant',text});}
            const calls=parseToolProtocol(text);
            if(!calls.length){finalText=stripToolProtocol(text);this.emit?.({type:'final',text:finalText,reasoning});return {text:finalText,reasoning};}
            const clean=stripToolProtocol(text);working.push({role:'assistant',content:clean});
            for(const call of calls){const result=await this.executeTool(call);working.push({role:'user',content:`Tool result for ${call.name}:\n${stringifyResult(result)}`});}
          }
        }
        throw new Error('The agent reached its tool-step limit.');
      } finally { this.running=false; }
    }
  }
  root.AIAgent=AIAgent;
})();

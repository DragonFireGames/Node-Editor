(function(){
  const root=window.EditorAI=window.EditorAI||{};
  function generatedText(result,fallback){
    const value=result&&result[0]&&result[0].generated_text;
    if(Array.isArray(value)){
      const last=value[value.length-1];
      if(typeof last==='string')return last;
      if(last&&typeof last.content==='string')return last.content;
    }
    if(typeof value==='string')return value;
    return String(fallback||'');
  }
  class LocalModelManager{
    constructor(){this.libraryPromise=null;this.generator=null;this.loadedModelId='';this.loading=false;this.progress=0;this.statusText='';this.device='';this.dtype='';this.stopper=null;this.listeners=new Set();}
    subscribe(fn){if(typeof fn!=='function')return ()=>{};this.listeners.add(fn);fn(this.status());return ()=>this.listeners.delete(fn);}
    status(){return {loading:this.loading,loadedModelId:this.loadedModelId,loaded:!!this.generator,progress:this.progress,text:this.statusText,device:this.device,dtype:this.dtype};}
    emit(patch){Object.assign(this,patch||{});const state=this.status();for(const fn of this.listeners){try{fn(state);}catch(e){console.warn('Local AI status listener failed:',e);}}}
    isLoaded(id){return !!this.generator&&(!id||this.loadedModelId===String(id));}
    async library(){if(!this.libraryPromise)this.libraryPromise=import(root.LOCAL_MODEL_LIBRARY_URL||'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1');return this.libraryPromise;}
    async unload(notify=true){const old=this.generator;this.generator=null;this.loadedModelId='';this.stopper=null;if(old&&old.dispose){try{await old.dispose();}catch(e){console.warn('Local AI model disposal failed:',e);}}if(notify)this.emit({loading:false,progress:0,statusText:'Model unloaded.'});}
    async load(model){
      if(!model||model.protocol!=='local-transformers')throw new Error('Not a local browser model.');
      if(this.loading)throw new Error('A local model is already loading.');
      if(this.isLoaded(model.id)){this.emit({loading:false,progress:100,statusText:model.model+' ready.'});return model;}
      this.loading=true;this.progress=0;this.device=(navigator.gpu?'webgpu':'wasm');this.dtype=(this.device==='webgpu'?'q4f16':'q4');
      this.statusText='Loading '+model.model+'…';this.emit({loading:true,progress:0,statusText:this.statusText});
      try{
        const lib=await this.library();
        if(lib.env){lib.env.useBrowserCache=true;lib.env.allowRemoteModels=true;lib.env.allowLocalModels=false;}
        await this.unload(false);this.loading=true;this.device=(navigator.gpu?'webgpu':'wasm');this.dtype=(this.device==='webgpu'?'q4f16':'q4');
        this.emit({loading:true,progress:0,statusText:this.device.toUpperCase()+' · loading '+model.model+'…'});
        const progress=info=>{
          let p=Number(info&&info.progress);if(!Number.isFinite(p))p=null;if(info&&info.status==='ready')p=100;
          if(p!=null)this.progress=Math.max(0,Math.min(100,p));
          const file=String((info&&((info.file||info.name)))||'').trim();
          const suffix=file?' · '+file.split('/').pop():'';
          this.statusText=this.device.toUpperCase()+' · loading '+model.model+suffix+(p!=null?' · '+p.toFixed(1)+'%':'');
          this.emit({loading:true});
        };
        this.generator=await lib.pipeline('text-generation',model.model,{device:this.device,dtype:this.dtype,progress_callback:progress});
        this.loadedModelId=model.id;this.loading=false;this.progress=100;this.statusText=this.device.toUpperCase()+' · '+model.model+' ready';this.emit({loading:false,progress:100,statusText:this.statusText});return model;
      }catch(e){this.generator=null;this.loadedModelId='';this.loading=false;this.emit({loading:false,progress:0,statusText:'Model load failed: '+(e&&e.message||String(e))});throw e;}
    }
    cancel(){try{if(this.stopper&&this.stopper.interrupt)this.stopper.interrupt();}catch(_){}}
    requireGenerator(){if(!this.generator)throw new Error('No local AI model is loaded. Open AI Settings and load a local model.');return this.generator;}
    async generate(messages,options,onText){
      const generator=this.requireGenerator();if(options&&options.signal&&options.signal.aborted)throw new DOMException('Aborted','AbortError');
      let generated='';const lib=await this.library();const Stopper=lib.InterruptableStoppingCriteria;const stopper=Stopper?new Stopper():null;this.stopper=stopper;
      const streamer=new lib.TextStreamer(generator.tokenizer,{skip_prompt:true,skip_special_tokens:true,callback_function:piece=>{generated+=String(piece||'');if(onText)onText(generated,String(piece||''));}});
      const abort=()=>this.cancel();if(options&&options.signal&&options.signal.addEventListener)options.signal.addEventListener('abort',abort,{once:true});
      try{
        const result=await generator(messages,{max_new_tokens:Math.max(64,Math.min(4096,Number(options&&options.maxTokens)||1024)),do_sample:true,temperature:options&&options.temperature!=null?options.temperature:.7,top_p:options&&options.topP!=null?options.topP:.9,streamer:streamer,...(stopper?{stopping_criteria:[stopper]}:{})});
        if(options&&options.signal&&options.signal.aborted)throw new DOMException('Aborted','AbortError');
        return generatedText(result,generated)||generated;
      }finally{if(options&&options.signal&&options.signal.removeEventListener)options.signal.removeEventListener('abort',abort);if(this.stopper===stopper)this.stopper=null;}
    }
    async complete(messages,options){return {role:'assistant',content:await this.generate(messages,options||{}),tool_calls:[],reasoning_content:''};}
    async *stream(messages,options){
      let last='';const queue=[];let waiting=null,done=false,error=null;
      const wake=()=>{done=true;if(waiting){const resolve=waiting;waiting=null;resolve();}};
      const generation=this.generate(messages,options||{},(text,delta)=>{last=text;queue.push({text,delta,reasoning:''});if(waiting){const resolve=waiting;waiting=null;resolve();}}).then(final=>{if(final&&final!==last){queue.push({text:final,delta:final.slice(last.length),reasoning:''});}}).catch(e=>{error=e;}).finally(wake);
      while(!done||queue.length){if(!queue.length)await new Promise(resolve=>{waiting=resolve;});while(queue.length)yield queue.shift();}
      await generation;if(error)throw error;
    }
  }
  root.LocalModelManager=LocalModelManager;
})();
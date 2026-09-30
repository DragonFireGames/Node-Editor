(function() {
  const root = window.EditorAI = window.EditorAI || {};
  function normalize(path) {
    const out = [];
    for (const part of String(path || '').replace(/\\/g,'/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { out.pop(); continue; }
      out.push(part);
    }
    return out.join('/');
  }
  function textFile(path) {
    const n = String(path).split('/').pop().toLowerCase();
    const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
    return new Set(['js','mjs','cjs','ts','tsx','jsx','json','html','htm','css','md','txt','xml','svg','yaml','yml','py','java','c','h','cpp','hpp','cc','rs','go','wgsl','glsl','vert','frag','shader','toml','ini','env','sh','bat','ps1','vue','svelte']).has(ext) || !ext;
  }
  function quoteCommand(path) { return /[\s"']/.test(path) ? '"' + String(path).replace(/"/g,'\\"') + '"' : String(path); }
  function currentTab(state) {
    if (!state?.workbench) return null;
    for (const instance of Workbench.getInstances?.() || [state.workbench]) for (const g of instance.groups.values()) {
      const t = g.tabs.find(x => x.id === g.active);
      if (t) return t;
    }
    return null;
  }
  function fileDiff(oldText, newText) {
    oldText = String(oldText || ''); newText = String(newText || '');
    if (oldText === newText) return '';
    const oldLines = oldText.split(/\r?\n/), newLines = newText.split(/\r?\n/);
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
    let oldEnd = oldLines.length - 1, newEnd = newLines.length - 1;
    while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd--; newEnd--; }
    const removed = oldLines.slice(start, oldEnd + 1).slice(0, 80).map(x => '- ' + x);
    const added = newLines.slice(start, newEnd + 1).slice(0, 80).map(x => '+ ' + x);
    return [...removed, ...added].join('\n');
  }
  function makeTools(options) {
    const {state, openFile, onRefresh, runConfigured, ensureNodeRuntime} = options;
    const tools = new Map();
    function add(def) { tools.set(def.name, def); }
    add({name:'list_files', permission:'readFiles', description:'List project files and optionally directories.', parameters:{type:'object',properties:{directories:{type:'boolean'}},additionalProperties:false}, execute:async args => ({files:state.fs?.listFilesSync?.() || [], directories:args.directories ? state.fs?.listDirectoriesSync?.() || [] : undefined})});
    add({name:'read_file', permission:'readFiles', description:'Read a UTF-8 text file from the project.', parameters:{type:'object',required:['path'],properties:{path:{type:'string'}}}, execute:async args => { const path=normalize(args.path); if(!state.fs?.existsSync(path)) throw new Error(`File not found: ${path}`); const value=state.fs.readFileSync(path,'utf8'); if (value == null) throw new Error(`Unable to read: ${path}`); return {path,content:String(value)}; }});
    add({name:'search_project', permission:'searchFiles', description:'Search text files in the project, case-insensitive.', parameters:{type:'object',required:['query'],properties:{query:{type:'string'},path:{type:'string'},maxResults:{type:'number'}}}, execute:async args => {
      const query=String(args.query||'').toLowerCase(); if(!query) return {results:[]}; const prefix=normalize(args.path||''); const limit=Math.max(1,Math.min(500,Number(args.maxResults)||100)); const results=[];
      for(const path of state.fs?.listFilesSync?.()||[]) { if(prefix && path!==prefix && !path.startsWith(prefix+'/')) continue; if(!textFile(path)) continue; let content=''; try{content=String(state.fs.readFileSync(path,'utf8')||'')}catch(_){continue;} const lines=content.split(/\r?\n/); for(let i=0;i<lines.length;i++){let from=0;const lower=lines[i].toLowerCase();while(from<lower.length){const col=lower.indexOf(query,from);if(col<0)break;results.push({path,line:i+1,column:col+1,text:lines[i]});if(results.length>=limit)return {results};from=col+Math.max(query.length,1);}}} return {results};
    }});
    add({name:'create_file', permission:'createFiles', description:'Create a new text file in the project.', parameters:{type:'object',required:['path','content'],properties:{path:{type:'string'},content:{type:'string'}}}, execute:async args => { const path=normalize(args.path); if(!path)throw new Error('Invalid file path.'); if(state.fs.existsSync(path))throw new Error(`File already exists: ${path}`); state.fs.writeFileSync(path,String(args.content??'')); state.markDirty?.(path); onRefresh?.(); return {path,created:true}; }});
    add({name:'write_file', permission:'modifyFiles', description:'Replace the contents of an existing file.', parameters:{type:'object',required:['path','content'],properties:{path:{type:'string'},content:{type:'string'}}}, execute:async args => { const path=normalize(args.path); if(!state.fs.existsSync(path))throw new Error(`File not found: ${path}`); const old=String(state.fs.readFileSync(path,'utf8')||''); const content=String(args.content??''); state.fs.writeFileSync(path,content); state.markDirty?.(path); onRefresh?.(); return {path,changed:old!==content,diff:fileDiff(old,content)}; }});
    add({name:'delete_file', permission:'deleteFiles', description:'Delete a file or directory from the project.', parameters:{type:'object',required:['path'],properties:{path:{type:'string'},directory:{type:'boolean'}}}, execute:async args => { const path=normalize(args.path); if(!path)throw new Error('Cannot delete the project root.'); const isDir=!!args.directory || state.fs.isDirectorySync?.(path); const ok=isDir ? state.fs.deleteDirectorySync(path) : state.fs.deleteFileSync(path); if(!ok)throw new Error(`Nothing deleted at ${path}`); state.markDirty?.(path); onRefresh?.(); return {path,deleted:true,directory:isDir}; }});
    add({name:'get_active_file', permission:'readEditor', description:'Get the active editor file, cursor, and selection.', parameters:{type:'object',properties:{includeContent:{type:'boolean'}},additionalProperties:false}, execute:async args => { const t=currentTab(state); if(!t || t.kind!=='file')return {path:null}; const model=t.editor?.getModel?.(); const selection=t.editor?.getSelection?.(); const result={path:t.path,view:t.view||null}; if(t.editor?.getPosition)result.cursor=t.editor.getPosition(); if(selection && model)result.selection=model.getValueInRange(selection); if(args.includeContent)result.content=String(t.editor?.getValue?.()||state.fs.readFileSync(t.path,'utf8')||''); return result; }});
    add({name:'open_file', permission:'readEditor', description:'Open a file in the editor.', parameters:{type:'object',required:['path'],properties:{path:{type:'string'}}}, execute:async args => { const path=normalize(args.path); if(!state.fs?.existsSync(path))throw new Error(`File not found: ${path}`); openFile?.(path); return {opened:path}; }});
    add({name:'insert_code', permission:'modifyEditor', description:'Insert code at the current editor selection or cursor.', parameters:{type:'object',required:['code'],properties:{code:{type:'string'}}}, execute:async args => { const t=currentTab(state); if(!t?.editor)throw new Error('There is no active text editor.'); const editor=t.editor; const model=editor.getModel?.(); if(!model)throw new Error('The active editor has no model.'); const selection=editor.getSelection?.(); const range=selection || {startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:1}; editor.executeEdits('ai',[{range,text:String(args.code),forceMoveMarkers:true}]); state.markDirty?.(t.path); state.updateStatus?.(); return {path:t.path,inserted:true}; }});
    add({name:'run_command', permission:'runCommands', description:'Run a command in the virtual Node runtime terminal.', parameters:{type:'object',required:['command'],properties:{command:{type:'string'}}}, execute:async args => { const runner=await ensureNodeRuntime?.(); if(!runner)throw new Error('Node runtime is unavailable for this project.'); attachOutput(runner); const command=String(args.command||'').trim(); if(!command)throw new Error('Command is empty.'); const start=outputBuffer.length; const result=await runner.terminalCommand(command); return {command,result,output:outputBuffer.slice(start)}; }});
    add({name:'run_script', permission:'runScripts', description:'Run a project JavaScript file with the virtual Node runtime.', parameters:{type:'object',required:['path'],properties:{path:{type:'string'}}}, execute:async args => { const runner=await ensureNodeRuntime?.(); if(!runner)throw new Error('Node runtime is unavailable for this project.'); attachOutput(runner); const path=normalize(args.path); if(!state.fs?.existsSync(path))throw new Error(`File not found: ${path}`); const start=outputBuffer.length; const result=await runner.terminalCommand('node '+quoteCommand(path)); return {path,result,output:outputBuffer.slice(start)}; }});
    add({name:'run_project', permission:'runProject', description:'Run the configured project and open its browser preview.', parameters:{type:'object',properties:{},additionalProperties:false}, execute:async () => { await runConfigured?.(); return {running:true}; }});
    const outputBuffer = [];
    let attachedRunner = null;
    let onConsole = null;
    let onError = null;
    function attachOutput(runner) {
      if(attachedRunner===runner)return;
      if(attachedRunner){attachedRunner.removeEventListener?.('console',onConsole);attachedRunner.removeEventListener?.('error',onError);}
      attachedRunner=runner; if(!runner)return;
      onConsole=(method,args)=>{outputBuffer.push({type:method,args:Array.isArray(args)?args:[]});if(outputBuffer.length>250)outputBuffer.splice(0,outputBuffer.length-250);};
      onError=(error,source)=>{outputBuffer.push({type:'error',args:[error?.message||String(error),source||'']});if(outputBuffer.length>250)outputBuffer.splice(0,outputBuffer.length-250);};
      runner.addEventListener?.('console',onConsole);runner.addEventListener?.('error',onError);
    }
    add({name:'get_runtime_output', permission:'readOutput', description:'Read recent output/errors from the Node runtime.', parameters:{type:'object',properties:{clear:{type:'boolean'}},additionalProperties:false}, execute:async args => { const runner=state.nodeEmulator; if(runner)attachOutput(runner); const result=outputBuffer.slice(-100); if(args.clear)outputBuffer.length=0; return {running:!!runner,output:result}; }});
    add({name:'get_browser_state', permission:'browser', description:'Inspect the editor browser preview.', parameters:{type:'object',properties:{},additionalProperties:false}, execute:async () => { const info=state.browserFrame; if(!info)return {available:false}; let url='';let title='';try{url=info.contentWindow?.getStartupUrl?.()||info.contentWindow?.location?.href||''}catch(_){} try{title=info.contentWindow?.document?.title||''}catch(_){} return {available:true,url,title}; }});
    function getBrowserFrame() {
      let active = null;
      try { active = currentTab(state); } catch (_) {}
      if (active?.kind === 'builtin' && active.builtin === 'browser') {
        const info = state.browserTabs?.get(active.id);
        if (info?.frame?.contentWindow) return info.frame;
      }
      if (state.browserFrame?.contentWindow) return state.browserFrame;
      for (const info of state.browserTabs?.values?.() || []) if (info?.frame?.contentWindow) return info.frame;
      return null;
    }
    function getBrowserWindow() {
      const frame = getBrowserFrame();
      return frame?.contentWindow || null;
    }
    add({name:'get_browser_tabs', permission:'browser', description:'List tabs in the active editor Browser, including the active tab.', parameters:{type:'object',properties:{},additionalProperties:false}, execute:async () => { const win=getBrowserWindow(); if(!win)return {available:false,tabs:[]}; return {available:true,tabs:win.getAIBrowserTabs?.()||[]}; }});
    add({name:'open_browser_tab', permission:'browser', description:'Open a new tab in the editor Browser.', parameters:{type:'object',required:['url'],properties:{url:{type:'string'},activate:{type:'boolean'}}}, execute:async args => { const win=getBrowserWindow(); if(!win?.openAIBrowserTab)throw new Error('Browser tab controls are unavailable.'); const id=win.openAIBrowserTab(String(args.url||''),args.activate!==false); if(!id)throw new Error('Browser tab could not be opened.'); return {opened:true,id}; }});
    add({name:'switch_browser_tab', permission:'browser', description:'Switch the active tab in the editor Browser.', parameters:{type:'object',required:['tabId'],properties:{tabId:{type:'string'}}}, execute:async args => { const win=getBrowserWindow(); if(!win?.switchAIBrowserTab)throw new Error('Browser tab controls are unavailable.'); return await win.switchAIBrowserTab(String(args.tabId)); }});
    add({name:'navigate_browser_tab', permission:'browser', description:'Navigate an existing Browser tab to a URL.', parameters:{type:'object',required:['tabId','url'],properties:{tabId:{type:'string'},url:{type:'string'}}}, execute:async args => { const win=getBrowserWindow(); if(!win?.navigateAIBrowserTab)throw new Error('Browser navigation controls are unavailable.'); return await win.navigateAIBrowserTab(String(args.tabId),String(args.url||'')); }});
    add({name:'close_browser_tab', permission:'browser', description:'Close a Browser tab.', parameters:{type:'object',required:['tabId'],properties:{tabId:{type:'string'}}}, execute:async args => { const win=getBrowserWindow(); if(!win?.closeAIBrowserTab)throw new Error('Browser tab controls are unavailable.'); return win.closeAIBrowserTab(String(args.tabId)); }});
    add({name:'reload_browser_tab', permission:'browser', description:'Reload a Browser tab.', parameters:{type:'object',properties:{tabId:{type:'string'}},additionalProperties:false}, execute:async args => { const win=getBrowserWindow(); if(!win?.reloadAIBrowserTab)throw new Error('Browser tab controls are unavailable.'); return await win.reloadAIBrowserTab(args.tabId?String(args.tabId):null); }});
    add({name:'get_browser_html', permission:'browser', description:'Read the rendered HTML of a Browser tab. This is the sanitized page DOM visible to the emulated page, not editor internals.', parameters:{type:'object',properties:{tabId:{type:'string'},maxChars:{type:'number'}},additionalProperties:false}, execute:async args => { const win=getBrowserWindow(); if(!win?.getAIBrowserHTML)throw new Error('Browser HTML inspection is unavailable.'); return win.getAIBrowserHTML(args.tabId?String(args.tabId):null,args.maxChars); }});
    add({name:'run_browser_console', permission:'browser', description:'Run JavaScript in a Browser tab using its DevTools-style console execution context and return the result.', parameters:{type:'object',required:['code'],properties:{tabId:{type:'string'},code:{type:'string'}}}, execute:async args => { const win=getBrowserWindow(); if(!win?.runAIBrowserConsole)throw new Error('Browser console is unavailable.'); return await win.runAIBrowserConsole(args.tabId?String(args.tabId):null,String(args.code||'')); }});
    add({name:'browser_network_request', permission:'network', description:'Make an arbitrary HTTP request through the editor Network API. The request uses the normal Network endpoint chain, so proxy/direct fallback rules still apply. Returns status, headers, and textual/JSON response data.', parameters:{type:'object',required:['url'],properties:{url:{type:'string'},method:{type:'string'},headers:{type:'object'},body:{type:'string'},maxChars:{type:'number'}},additionalProperties:false}, execute:async args => { const network=state.browserNetwork||window.__sharedBrowserNetwork; if(!network?.request)throw new Error('Network API is unavailable.'); const url=String(args.url||'').trim(); if(!url)throw new Error('URL is required.'); const method=String(args.method||'GET').toUpperCase(); const headers={...(args.headers&&typeof args.headers==='object'?args.headers:{})}; const init={method,headers}; if(args.body!=null && !['GET','HEAD'].includes(method))init.body=String(args.body); const response=await network.request(new Request(url,init),'ai'); if(!response)throw new Error('No endpoint returned a response.'); const maxChars=Math.max(1000,Math.min(500000,Number(args.maxChars)||100000)); const raw=await response.text(); let json=null; try{json=JSON.parse(raw);}catch(_){} return {url:response.url||url,status:response.status,statusText:response.statusText,ok:response.ok,headers:Object.fromEntries(response.headers.entries()),text:raw.slice(0,maxChars),json,truncated:raw.length>maxChars,totalLength:raw.length}; }});
    add({name:'get_browser_output', permission:'browser', description:'Read recent console errors and output from emulated browser pages.', parameters:{type:'object',properties:{limit:{type:'number'},clear:{type:'boolean'}},additionalProperties:false}, execute:async args => { const win=state.browserFrame?.contentWindow; if(!win)return {available:false,output:[]}; const output=win.getAIBrowserOutput?.({limit:Math.max(1,Math.min(200,Number(args.limit)||100))}) || []; if(args.clear)win.clearAIBrowserOutput?.(); return {available:true,output}; }});
    return {map:tools, list:()=>[...tools.values()]};
  }
  root.makeAITools = makeTools;
})();

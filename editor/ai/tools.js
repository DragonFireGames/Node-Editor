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
    add({name:'exit_early', permission:'none', description:'Finish the task immediately and return the supplied message directly as the final answer. Use when all necessary tool work is complete and no further tool or model turn is needed. Put the complete answer or summary in message; do not leave the message empty.', parameters:{type:'object',properties:{message:{type:'string',description:'Optional final message to show the user.'}},additionalProperties:false}, execute:async args => ({exitEarly:true,message:String(args?.message||'')})});
    add({name:'list_files', permission:'readFiles', description:'List project files and optionally directories.', parameters:{type:'object',properties:{directories:{type:'boolean'}},additionalProperties:false}, execute:async args => ({files:state.fs?.listFilesSync?.() || [], directories:args.directories ? state.fs?.listDirectoriesSync?.() || [] : undefined})});
    add({name:'read_file', permission:'readFiles', description:'Read a UTF-8 text file from the project.', parameters:{type:'object',required:['path'],properties:{path:{type:'string'},startLine:{type:'integer',minimum:1},endLine:{type:'integer',minimum:1},maxChars:{type:'integer',minimum:1000,maximum:500000}},additionalProperties:false}, execute:async args => { const path=normalize(args.path); if(!state.fs?.existsSync(path)) throw new Error(`File not found: ${path}`); const value=state.fs.readFileSync(path,'utf8'); if (value == null) throw new Error(`Unable to read: ${path}`); let content=String(value); const hasRange=args.startLine!=null||args.endLine!=null; if(hasRange){ const lines=content.split(/\r?\n/); const start=Math.max(1,Number(args.startLine)||1); const end=Math.min(lines.length,Math.max(start,Number(args.endLine)||lines.length)); content=lines.slice(start-1,end).join('\n'); } const maxChars=Math.max(1000,Math.min(500000,Number(args.maxChars)||200000)); const truncated=content.length>maxChars; if(truncated)content=content.slice(0,maxChars); return {path,content,startLine:hasRange?Math.max(1,Number(args.startLine)||1):1,endLine:hasRange?Math.min(String(value).split(/\r?\n/).length,Math.max(1,Number(args.endLine)||String(value).split(/\r?\n/).length)):String(value).split(/\r?\n/).length,truncated,totalChars:String(value).length}; }});
    add({name:'search_project', permission:'searchFiles', description:'Search text files in the project, case-insensitive.', parameters:{type:'object',required:['query'],properties:{query:{type:'string'},path:{type:'string'},maxResults:{type:'number',minimum:1,maximum:500}} ,additionalProperties:false}, execute:async args => {
      const query=String(args.query||'').toLowerCase(); if(!query) return {results:[]}; const prefix=normalize(args.path||''); const limit=Math.max(1,Math.min(500,Number(args.maxResults)||100)); const results=[];
      for(const path of state.fs?.listFilesSync?.()||[]) { if(prefix && path!==prefix && !path.startsWith(prefix+'/')) continue; if(!textFile(path)) continue; let content=''; try{content=String(state.fs.readFileSync(path,'utf8')||'')}catch(_){continue;} const lines=content.split(/\r?\n/); for(let i=0;i<lines.length;i++){let from=0;const lower=lines[i].toLowerCase();while(from<lower.length){const col=lower.indexOf(query,from);if(col<0)break;results.push({path,line:i+1,column:col+1,text:lines[i]});if(results.length>=limit)return {results};from=col+Math.max(query.length,1);}}} return {results};
    }});
    add({name:'create_file', permission:'createFiles', description:'Create a new text file in the project.', parameters:{type:'object',required:['path','content'],properties:{path:{type:'string'},content:{type:'string'}},additionalProperties:false}, execute:async args => { const path=normalize(args.path); if(!path)throw new Error('Invalid file path.'); if(state.fs.existsSync(path))throw new Error(`File already exists: ${path}`); state.fs.writeFileSync(path,String(args.content??'')); state.markDirty?.(path); onRefresh?.(); return {path,created:true}; }});
    add({name:'write_file', permission:'modifyFiles', description:'Create a new text file or replace the contents of an existing file.', parameters:{type:'object',required:['path','content'],properties:{path:{type:'string'},content:{type:'string'}},additionalProperties:false}, execute:async args => { const path=normalize(args.path); if(!path)throw new Error('Invalid file path.'); const exists=!!state.fs.existsSync(path); const old=exists?String(state.fs.readFileSync(path,'utf8')||''):''; const content=String(args.content??''); state.fs.writeFileSync(path,content); state.markDirty?.(path); onRefresh?.(); return {path,created:!exists,changed:!exists||old!==content,diff:exists?fileDiff(old,content):null}; }});
    add({name:'delete_file', permission:'deleteFiles', description:'Delete a file or directory from the project.', parameters:{type:'object',required:['path'],properties:{path:{type:'string'},directory:{type:'boolean'}},additionalProperties:false}, execute:async args => { const path=normalize(args.path); if(!path)throw new Error('Cannot delete the project root.'); const isDir=!!args.directory || state.fs.isDirectorySync?.(path); const ok=isDir ? state.fs.deleteDirectorySync(path) : state.fs.deleteFileSync(path); if(!ok)throw new Error(`Nothing deleted at ${path}`); state.markDirty?.(path); onRefresh?.(); return {path,deleted:true,directory:isDir}; }});
    add({name:'move_file', permission:'modifyFiles', description:'Move or rename a file or directory without reading its contents into the agent.', parameters:{type:'object',required:['source','destination'],properties:{source:{type:'string',description:'Existing file or directory path.'},destination:{type:'string',description:'New file or directory path.'}},additionalProperties:false}, execute:async args => { const source=normalize(args.source); const destination=normalize(args.destination); if(!source)throw new Error('Source path is required.'); if(!destination)throw new Error('Destination path is required.'); if(source===destination)return {source,destination,moved:false}; if(!state.fs?.existsSync(source) && !state.fs?.isDirectorySync?.(source))throw new Error(`Path not found: ${source}`); const isDir=!!state.fs.isDirectorySync?.(source); state.fs.moveSync(source,destination); state.markDirty?.(source); state.markDirty?.(destination); state.fileManager?.onMove?.(source,destination,isDir); onRefresh?.(); return {source,destination,moved:true,directory:isDir}; }});    add({name:'copy_file', permission:'modifyFiles', description:'Copy a file or directory without reading its contents into the agent.', parameters:{type:'object',required:['source','destination'],properties:{source:{type:'string',description:'Existing file or directory path.'},destination:{type:'string',description:'New file or directory path.'}},additionalProperties:false}, execute:async args => { const source=normalize(args.source); const destination=normalize(args.destination); if(!source)throw new Error('Source path is required.'); if(!destination)throw new Error('Destination path is required.'); if(!state.fs?.existsSync(source) && !state.fs?.isDirectorySync?.(source))throw new Error(`Path not found: ${source}`); if(state.fs.existsSync(destination) || state.fs.isDirectorySync?.(destination))throw new Error(`Destination already exists: ${destination}`); if(source===destination)throw new Error('Source and destination are the same.'); if(destination.startsWith(source+'/'))throw new Error('Cannot copy a path into itself.'); const isDir=!!state.fs.isDirectorySync?.(source); const files=(isDir ? state.fs.listFilesSync().filter(path=>path===source||path.startsWith(source+'/')) : [source]); for(const path of files){ const target=destination+path.slice(source.length); state.fs.writeFileSync(target,state.fs.readFileSync(path,'binary')); } state.markDirty?.(destination); onRefresh?.(); return {source,destination,copied:true,directory:isDir,files:files.length}; }});
    add({name:'get_file_info', permission:'readFiles', description:'Get filesystem metadata without reading a file into the agent.', parameters:{type:'object',required:['path'],properties:{path:{type:'string'}},additionalProperties:false}, execute:async args => { const path=normalize(args.path); if(!path)throw new Error('Path is required.'); const isDir=!!state.fs?.isDirectorySync?.(path); if(!state.fs?.existsSync(path) && !isDir)throw new Error(`Path not found: ${path}`); if(isDir){ const prefix=path+'/'; const files=(state.fs.listFilesSync?.()||[]).filter(p=>p===path||p.startsWith(prefix)); const dirs=(state.fs.listDirectoriesSync?.()||[]).filter(p=>p===path||p.startsWith(prefix)); return {path,type:'directory',fileCount:files.length,directoryCount:dirs.length}; } const data=state.fs.readFileSync(path,'binary'); const bytes=data?.byteLength ?? data?.length ?? 0; return {path,type:'file',size:bytes,extension:(path.match(/\.([^.\/]+)$/)?.[1]||'').toLowerCase(),textFile:textFile(path)}; }});
    add({name:'find_files', permission:'searchFiles', description:'Find project files by glob-like path pattern without reading their contents.', parameters:{type:'object',properties:{pattern:{type:'string'},path:{type:'string'},extension:{type:'string'},maxResults:{type:'number',minimum:1,maximum:2000}},additionalProperties:false}, execute:async args => { const pattern=String(args.pattern||'').trim(); const prefix=normalize(args.path||''); const extension=String(args.extension||'').trim().toLowerCase(); const limit=Math.max(1,Math.min(2000,Number(args.maxResults)||500)); const files=state.fs?.listFilesSync?.()||[]; const globToRegex=g=>{let out='';for(let i=0;i<g.length;i++){const c=g[i];if(c==='*'){if(g[i+1]==='*'){out+='.*';i++;}else out+='[^/]*';}else if(c==='?')out+='[^/]';else out+=c.replace(/[\\^$+?.()|{}\[\]]/g,'\\$&');}return new RegExp('^'+out+'$','i');}; const re=pattern?globToRegex(pattern):null; const results=[]; for(const file of files){if(prefix&&file!==prefix&&!file.startsWith(prefix+'/'))continue;if(extension&&!file.toLowerCase().endsWith(extension.startsWith('.')?extension:'.'+extension))continue;if(re&&!re.test(file))continue;results.push(file);if(results.length>=limit)break;} return {pattern:pattern||null,results}; }});
    add({name:'replace_in_files', permission:'modifyFiles', description:'Replace text across selected project files without requiring the agent to rewrite whole files.', parameters:{type:'object',required:['search','replace'],properties:{search:{type:'string'},replace:{type:'string'},path:{type:'string'},regex:{type:'boolean'},caseSensitive:{type:'boolean'},maxFiles:{type:'number'},dryRun:{type:'boolean'}},additionalProperties:false}, execute:async args => { const search=String(args.search??''); if(!search)throw new Error('Search text is required.'); const replacement=String(args.replace??''); const prefix=normalize(args.path||''); const maxFiles=Math.max(1,Math.min(500,Number(args.maxFiles)||100)); let matcher; try { matcher=args.regex ? new RegExp(search,args.caseSensitive?'g':'gi') : new RegExp(search.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&'),args.caseSensitive?'g':'gi'); } catch(e){throw new Error(`Invalid search pattern: ${e.message}`);} const changes=[]; for(const path of state.fs?.listFilesSync?.()||[]){if(changes.length>=maxFiles)break;if(prefix&&path!==prefix&&!path.startsWith(prefix+'/'))continue;if(!textFile(path))continue;let old='';try{old=String(state.fs.readFileSync(path,'utf8')||'')}catch(_){continue;} matcher.lastIndex=0;const matches=old.match(matcher);if(!matches?.length)continue;const next=old.replace(matcher,replacement);changes.push({path,count:matches.length,changed:old!==next});if(!args.dryRun&&old!==next){state.fs.writeFileSync(path,next);state.markDirty?.(path);}} if(!args.dryRun)onRefresh?.(); return {changed:changes.filter(x=>x.changed).length,files:changes,dryRun:!!args.dryRun}; }});


    add({name:'get_active_file', permission:'readEditor', description:'Get the active editor file, cursor, and selection.', parameters:{type:'object',properties:{includeContent:{type:'boolean'}},additionalProperties:false}, execute:async args => { const t=currentTab(state); if(!t || t.kind!=='file')return {path:null}; const model=t.editor?.getModel?.(); const selection=t.editor?.getSelection?.(); const result={path:t.path,view:t.view||null}; if(t.editor?.getPosition)result.cursor=t.editor.getPosition(); if(selection && model)result.selection=model.getValueInRange(selection); if(args.includeContent)result.content=String(t.editor?.getValue?.()||state.fs.readFileSync(t.path,'utf8')||''); return result; }});
    add({name:'open_file', permission:'readEditor', description:'Open a file in the editor.', parameters:{type:'object',required:['path'],properties:{path:{type:'string'}}}, execute:async args => { const path=normalize(args.path); if(!state.fs?.existsSync(path))throw new Error(`File not found: ${path}`); openFile?.(path); return {opened:path}; }});
    add({name:'insert_code', permission:'modifyEditor', description:'Insert code at the current editor selection or cursor.', parameters:{type:'object',required:['code'],properties:{code:{type:'string'}}}, execute:async args => { const t=currentTab(state); if(!t?.editor)throw new Error('There is no active text editor.'); const editor=t.editor; const model=editor.getModel?.(); if(!model)throw new Error('The active editor has no model.'); const selection=editor.getSelection?.(); const range=selection || {startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:1}; editor.executeEdits('ai',[{range,text:String(args.code),forceMoveMarkers:true}]); state.markDirty?.(t.path); state.updateStatus?.(); return {path:t.path,inserted:true}; }});
    add({name:'run_command', permission:'runCommands', description:"Run a short-lived command in the editor's virtual Node runtime, not a real OS shell. Do not include the terminal prompt character ($). Supported commands are pwd, cd, cat, echo, printf, true, false, whoami, hostname, env, which, ls/dir, node, and npm. Do not use this tool to start a long-running server or watcher such as 'node server.js', 'npm start', 'npm run start', or 'npm run dev'; use run_project for the configured project instead. Shell features such as pipes and redirection are not supported; use the project/editor tools for filesystem operations instead.", parameters:{type:'object',required:['command'],properties:{command:{type:'string',description:'Command only, without a leading shell prompt such as $. Supported commands: pwd, cd, cat, echo, printf, true, false, whoami, hostname, env, which, ls/dir, node, npm.'}}}, execute:async args => {
      const runner=await ensureNodeRuntime?.();
      if(!runner)throw new Error('Node runtime is unavailable for this project.');
      attachOutput(runner);
      const command=String(args.command||'').trim();
      if(!command)throw new Error('Command is empty.');
      const longRunning=/^(?:(?:npm|npx)\s+(?:run\s+)?(?:start|dev|serve|watch)\b|node(?:js)?\s+.+)$/i.test(command);
      if(longRunning) throw new Error('This command appears to start a long-running process. Use run_project to run the configured application instead of run_command.');
      const start=outputBuffer.length;
      const result=await runner.terminalCommand(command);
      return {command,result,output:outputBuffer.slice(start)};
    }});
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
    add({name:'open_browser_tab', permission:'browser', description:'Open a new tab in the editor Browser.', parameters:{type:'object',required:['url'],properties:{url:{type:'string'},activate:{type:'boolean'}},additionalProperties:false}, execute:async args => { const win=getBrowserWindow(); if(!win?.openAIBrowserTab)throw new Error('Browser tab controls are unavailable.'); const id=win.openAIBrowserTab(String(args.url||''),args.activate!==false); if(!id)throw new Error('Browser tab could not be opened.'); return {opened:true,id}; }});
    add({name:'switch_browser_tab', permission:'browser', description:'Switch the active tab in the editor Browser.', parameters:{type:'object',required:['tabId'],properties:{tabId:{type:'string'}}}, execute:async args => { const win=getBrowserWindow(); if(!win?.switchAIBrowserTab)throw new Error('Browser tab controls are unavailable.'); return await win.switchAIBrowserTab(String(args.tabId)); }});
    add({name:'navigate_browser_tab', permission:'browser', description:'Navigate an existing Browser tab to a URL.', parameters:{type:'object',required:['tabId','url'],properties:{tabId:{type:'string'},url:{type:'string'}}}, execute:async args => { const win=getBrowserWindow(); if(!win?.navigateAIBrowserTab)throw new Error('Browser navigation controls are unavailable.'); return await win.navigateAIBrowserTab(String(args.tabId),String(args.url||'')); }});
    add({name:'close_browser_tab', permission:'browser', description:'Close a Browser tab.', parameters:{type:'object',required:['tabId'],properties:{tabId:{type:'string'}}}, execute:async args => { const win=getBrowserWindow(); if(!win?.closeAIBrowserTab)throw new Error('Browser tab controls are unavailable.'); return win.closeAIBrowserTab(String(args.tabId)); }});
    add({name:'reload_browser_tab', permission:'browser', description:'Reload a Browser tab.', parameters:{type:'object',properties:{tabId:{type:'string'}},additionalProperties:false}, execute:async args => { const win=getBrowserWindow(); if(!win?.reloadAIBrowserTab)throw new Error('Browser tab controls are unavailable.'); return await win.reloadAIBrowserTab(args.tabId?String(args.tabId):null); }});
    add({name:'get_browser_html', permission:'browser', description:'Read the rendered HTML of a Browser tab. This is the sanitized page DOM visible to the emulated page, not editor internals.', parameters:{type:'object',properties:{tabId:{type:'string'},maxChars:{type:'number'}},additionalProperties:false}, execute:async args => { const win=getBrowserWindow(); if(!win?.getAIBrowserHTML)throw new Error('Browser HTML inspection is unavailable.'); return win.getAIBrowserHTML(args.tabId?String(args.tabId):null,args.maxChars); }});
    add({name:'run_browser_console', permission:'browser', description:'Run JavaScript in a Browser tab using its DevTools-style console execution context and return the result.', parameters:{type:'object',required:['code'],properties:{tabId:{type:'string'},code:{type:'string'}},additionalProperties:false}, execute:async args => { const win=getBrowserWindow(); if(!win?.runAIBrowserConsole)throw new Error('Browser console is unavailable.'); return await win.runAIBrowserConsole(args.tabId?String(args.tabId):null,String(args.code||'')); }});
    add({name:'browser_network_request', permission:'network', description:'Make an arbitrary HTTP request through the editor Network API. The request uses the normal Network endpoint chain, so proxy/direct fallback rules still apply. Returns status, headers, and textual/JSON response data.', parameters:{type:'object',required:['url'],properties:{url:{type:'string'},method:{type:'string'},headers:{type:'object'},body:{type:'string'},maxChars:{type:'number'}},additionalProperties:false}, execute:async args => { const network=state.browserNetwork||window.__sharedBrowserNetwork; if(!network?.request)throw new Error('Network API is unavailable.'); const url=String(args.url||'').trim(); if(!url)throw new Error('URL is required.'); const method=String(args.method||'GET').toUpperCase(); const headers={...(args.headers&&typeof args.headers==='object'?args.headers:{})}; const init={method,headers}; if(args.body!=null && !['GET','HEAD'].includes(method))init.body=String(args.body); const response=await network.request(new Request(url,init),'ai'); if(!response)throw new Error('No endpoint returned a response.'); const maxChars=Math.max(1000,Math.min(500000,Number(args.maxChars)||100000)); const raw=await response.text(); let json=null; try{json=JSON.parse(raw);}catch(_){} return {url:response.url||url,status:response.status,statusText:response.statusText,ok:response.ok,headers:Object.fromEntries(response.headers.entries()),text:raw.slice(0,maxChars),json,truncated:raw.length>maxChars,totalLength:raw.length}; }});
    add({name:'get_browser_output', permission:'browser', description:'Read recent console errors and output from emulated browser pages.', parameters:{type:'object',properties:{limit:{type:'number'},clear:{type:'boolean'}},additionalProperties:false}, execute:async args => { const win=state.browserFrame?.contentWindow; if(!win)return {available:false,output:[]}; const output=win.getAIBrowserOutput?.({limit:Math.max(1,Math.min(200,Number(args.limit)||100))}) || []; if(args.clear)win.clearAIBrowserOutput?.(); return {available:true,output}; }});
    // Built-in GitHub tools. These use the editor's existing OAuth session and are
    // deliberately permission-gated separately from generic network access.
    const github = window.GitHubService;
    const requireGitHub = () => {
      if (!github?.isSignedIn?.()) throw new Error('Sign in to GitHub from the editor Profile before using GitHub tools.');
      return github;
    };
    add({name:'github_status', permission:'githubRead', description:'Check whether the user is signed in to GitHub and return the signed-in account.', parameters:{type:'object',properties:{},additionalProperties:false}, execute:async () => {
      const service=github;
      if (!service?.isSignedIn?.()) return {signedIn:false,user:null};
      const user=service.getUser?.() || null;
      return {signedIn:true,user:user ? {login:user.login,name:user.name,avatarUrl:user.avatar_url||user.avatarUrl||''} : null};
    }});
    add({name:'github_list_repositories', permission:'githubRead', description:'List repositories available to the signed-in GitHub account.', parameters:{type:'object',properties:{},additionalProperties:false}, execute:async () => {
      return requireGitHub().listRepositories();
    }});
    add({name:'github_get_repository', permission:'githubRead', description:'Get metadata for a GitHub repository.', parameters:{type:'object',required:['owner','repo'],properties:{owner:{type:'string'},repo:{type:'string'}},additionalProperties:false}, execute:async args => {
      return requireGitHub().getRepository(String(args.owner||''),String(args.repo||''));
    }});
    add({name:'github_create_repository', permission:'githubWrite', description:'Create a GitHub repository for the signed-in user.', parameters:{type:'object',required:['name'],properties:{name:{type:'string'},description:{type:'string'},privateRepo:{type:'boolean'},autoInit:{type:'boolean'}},additionalProperties:false}, execute:async args => {
      const result=await requireGitHub().createRepository({name:String(args.name||''),description:String(args.description||''),privateRepo:!!args.privateRepo,autoInit:args.autoInit!==false});
      return {id:result?.id,name:result?.name,fullName:result?.full_name,url:result?.html_url,defaultBranch:result?.default_branch};
    }});
    add({name:'github_list_branches', permission:'githubRead', description:'List branches in a GitHub repository.', parameters:{type:'object',required:['owner','repo'],properties:{owner:{type:'string'},repo:{type:'string'}},additionalProperties:false}, execute:async args => {
      return requireGitHub().listBranches(String(args.owner||''),String(args.repo||''));
    }});
    add({name:'github_list_commits', permission:'githubRead', description:'List recent commits for a GitHub repository branch.', parameters:{type:'object',required:['owner','repo'],properties:{owner:{type:'string'},repo:{type:'string'},branch:{type:'string'},count:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}, execute:async args => {
      return requireGitHub().listCommits(String(args.owner||''),String(args.repo||''),String(args.branch||'main'),Math.max(1,Math.min(100,Number(args.count)||20)));
    }});
    add({name:'github_compare_working_tree', permission:'githubRead', description:'Compare the current editor workspace with a GitHub repository branch and report added, modified, and deleted files.', parameters:{type:'object',required:['owner','repo','branch'],properties:{owner:{type:'string'},repo:{type:'string'},branch:{type:'string'}},additionalProperties:false}, execute:async args => {
      const service=requireGitHub();
      const remote=await service.getRemoteState(String(args.owner||''),String(args.repo||''),String(args.branch||'main'));
      const changes=await service.compareWorkingTree(state.fs,remote.tree);
      return {remoteCommitSha:remote.commitSha,changes:changes.map(x=>({path:x.path,type:x.type}))};
    }});
    add({name:'github_commit_and_push', permission:'githubWrite', description:'Commit the current editor workspace changes to a GitHub repository branch and push them. This changes the remote repository.', parameters:{type:'object',required:['owner','repo','branch','message'],properties:{owner:{type:'string'},repo:{type:'string'},branch:{type:'string'},message:{type:'string'}},additionalProperties:false}, execute:async args => {
      const result=await requireGitHub().commitAndPush({owner:String(args.owner||''),repo:String(args.repo||''),branch:String(args.branch||'main'),message:String(args.message||''),fs:state.fs});
      return {changed:!!result.changed,commitSha:result.commitSha,changes:(result.changes||[]).map(x=>({path:x.path,type:x.type}))};
    }});
    add({name:'github_read_file', permission:'githubRead', description:'Read a text file from a GitHub repository using the signed-in account.', parameters:{type:'object',required:['owner','repo','path'],properties:{owner:{type:'string'},repo:{type:'string'},path:{type:'string'}},additionalProperties:false}, execute:async args => {
      const service=requireGitHub();
      const path=String(args.path||'').replace(/^\/+/, '');
      const data=await service.request('/repos/'+encodeURIComponent(String(args.owner||''))+'/'+encodeURIComponent(String(args.repo||''))+'/contents/'+path.split('/').map(encodeURIComponent).join('/'));
      if(Array.isArray(data)) return {directory:true,entries:data.map(x=>({name:x.name,path:x.path,type:x.type,sha:x.sha}))};
      if(!data?.content) throw new Error('GitHub returned no file content.');
      const binary=atob(String(data.content).replace(/\s/g,''));
      const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
      const content=new TextDecoder().decode(bytes);
      return {path:data.path,sha:data.sha,content};
    }});
    add({name:'github_write_file', permission:'githubWrite', description:'Create or replace a text file in a GitHub repository. This changes the remote repository.', parameters:{type:'object',required:['owner','repo','path','content','message'],properties:{owner:{type:'string'},repo:{type:'string'},path:{type:'string'},content:{type:'string'},message:{type:'string'},sha:{type:'string',description:'Current blob SHA when replacing an existing file. If omitted, the tool reads it first.'}},additionalProperties:false}, execute:async args => {
      const service=requireGitHub();
      const owner=String(args.owner||''), repoName=String(args.repo||''), path=String(args.path||'').replace(/^\/+/, '');
      let sha=String(args.sha||'');
      if(!sha){
        try {
          const current=await service.request('/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repoName)+'/contents/'+path.split('/').map(encodeURIComponent).join('/'));
          sha=String(current?.sha||'');
        } catch(e) {
          if(e?.status!==404) throw e;
        }
      }
      const bytes=new TextEncoder().encode(String(args.content??''));
      let binary=''; for(let p=0;p<bytes.length;p+=0x8000) binary+=String.fromCharCode(...bytes.subarray(p,Math.min(p+0x8000,bytes.length)));
      const body={message:String(args.message||''),content:btoa(binary)}; if(sha) body.sha=sha;
      const result=await service.request('/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repoName)+'/contents/'+path.split('/').map(encodeURIComponent).join('/'),{method:'PUT',body:JSON.stringify(body)});
      return {written:true,path,sha:result?.content?.sha||null,commitSha:result?.commit?.sha||null};
    }});
    add({name:'github_delete_file', permission:'githubWrite', description:'Delete a file from a GitHub repository. This changes the remote repository.', parameters:{type:'object',required:['owner','repo','path','message'],properties:{owner:{type:'string'},repo:{type:'string'},path:{type:'string'},message:{type:'string'},sha:{type:'string',description:'The current blob SHA. If omitted, the tool reads the file first.'}},additionalProperties:false}, execute:async args => {
      const service=requireGitHub();
      const owner=String(args.owner||''), repoName=String(args.repo||''), path=String(args.path||'').replace(/^\/+/, '');
      let sha=String(args.sha||'');
      if(!sha){ const current=await service.request('/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repoName)+'/contents/'+path.split('/').map(encodeURIComponent).join('/')); sha=String(current?.sha||''); }
      if(!sha) throw new Error('A current file SHA is required to delete a GitHub file.');
      const result=await service.request('/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repoName)+'/contents/'+path.split('/').map(encodeURIComponent).join('/'),{method:'DELETE',body:JSON.stringify({message:String(args.message||''),sha})});
      return {deleted:true,path,commitSha:result?.commit?.sha||null};
    }});
    for (const extensionTool of window.EditorExtensionAPI?.getAITools?.() || []) add(extensionTool);
    return {map:tools, list:()=>[...tools.values()]};
  }
  root.makeAITools = makeTools;
})();

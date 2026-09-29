(function(){
  class BrowserConsole {
    constructor(element,options={}){
      if(!element||element.nodeType!==1)throw new TypeError('BrowserConsole requires a DOM element');
      this.element=element;this.options=options||{};this.urlCache=this.options.urlCache||{};this.renderCode=this.options.renderCode||null;this.openURL=this.options.openURL||null;
      BrowserConsole.ensureStyles();
    }
    isNearBottom(e=this.element,t=24){return !e||e.scrollHeight-e.scrollTop-e.clientHeight<=t}
    scrollToBottom(e=this.element){if(e)e.scrollTop=e.scrollHeight}
    getList(){let l=this.element.querySelector(':scope > .console-log-list');if(!l){l=document.createElement('div');l.className='console-log-list';this.element.appendChild(l)}return l}
    add(node,options={}){if(!node)return null;const follow=this.isNearBottom();const c=document.createElement('div');c.style.marginLeft='4px';c.className=options.className||'log-line';c.appendChild(node);this.getList().appendChild(c);if(follow||options.forceBottom)this.scrollToBottom();return c}
    clear(){this.element.innerHTML=''}
    filterText(text){if(!text)return document.createTextNode('');let rest=String(text);const frag=document.createDocumentFragment();for(const i in this.urlCache){const original=this.urlCache[i];if(!original)continue;const parts=rest.split(original);if(parts.length<2)continue;frag.appendChild(document.createTextNode(parts[0]));const link=document.createElement('span');link.className='log-url';link.textContent=i;if(this.openURL)link.addEventListener('click',()=>this.openURL(original,true));frag.appendChild(link);rest=parts.slice(1).join(original)}frag.appendChild(document.createTextNode(rest));return frag}
    styledSpan(text,cls){const s=document.createElement('span');s.classList.add('log',...(Array.isArray(cls)?cls:[cls]));try{s.appendChild(typeof text==='string'?this.filterText(text):document.createTextNode(String(text)))}catch(e){s.textContent=String(text)}return s}
    deepCopy(value,map=new Map()){if(typeof value!=='object'||value===null)return value;if(map.has(value))return map.get(value);try{if(value?.outerHTML)return value;let copy;if(value instanceof Array){copy=value.constructor.from(value);copy._length=value.length}else copy=Object.create(Object.getPrototypeOf(value));if(value.constructor&&!value.constructor.toString().includes('[native code]'))copy._constructor=value.constructor;map.set(value,copy);for(const k in value)if(Object.prototype.hasOwnProperty.call(value,k))copy[k]=this.deepCopy(value[k],map);return copy}catch(e){if(e.message&&e.message.includes('cross-origin'))return BrowserConsole.CORS_ERROR;throw e}}
    renderValue(value,targetWin=window){const type=typeof value;if(value===null)return this.styledSpan('null','log-null');if(type==='string')return this.styledSpan(`"${value}"`,'log-string');if(type==='number')return this.styledSpan(value,'log-number');if(type==='boolean')return this.styledSpan(value,'log-boolean');if(type==='undefined')return this.styledSpan('undefined','log-undefined');if(type==='function'){const d=document.createElement('details'),s=document.createElement('summary');d.className='log-details';s.appendChild(this.styledSpan(value.name||'function','log-function'));d.appendChild(s);d.appendChild(this.renderCode?this.renderCode(value.toString(),'javascript','log-function-source'):Object.assign(document.createElement('pre'),{className:'log-function-source',textContent:value.toString()}));return d}if(type==='object'){try{if(value instanceof HTMLElement||(targetWin?.HTMLElement&&value instanceof targetWin.HTMLElement)){let html='';try{html=value.outerHTML}catch(e){html='[unrenderable element]'}if(this.renderCode)return this.renderCode(html,'html','log-html');const pre=document.createElement('pre');pre.className='log log-html';pre.textContent=html;return pre}}catch(e){}const snap=this.deepCopy(value);if(snap===BrowserConsole.CORS_ERROR)return this.styledSpan('[CORS Error]','log-circular');const d=document.createElement('details'),s=document.createElement('summary');d.className='log-details';try{if(value instanceof Promise||(targetWin?.Promise&&value instanceof targetWin.Promise)){s.appendChild(this.styledSpan('Promise',['log-promise']));d.appendChild(s);const inner=document.createElement('div');inner.style.marginLeft='15px';const status=this.styledSpan('[pending]',['log-promise','log-promise-pending']);inner.appendChild(status);d.appendChild(inner);Promise.resolve(value).then(v=>{status.textContent='[resolved] ';status.className='log log-promise log-promise-resolved';inner.appendChild(this.renderValue(v,targetWin))}).catch(e=>{status.textContent='[rejected] '+String(e);status.className='log log-promise log-promise-rejected'});return d}}catch(e){}s.appendChild(this.styledSpan(value?.constructor?.name||'Object','log-class'));d.appendChild(s);d._logSnapshot=snap;const keys=Object.keys(snap||{});if(Array.isArray(snap)?snap.length===0:keys.length===0)d.appendChild(this.styledSpan('[empty]','log-empty'));else d.addEventListener('toggle',()=>{if(d.open&&!d._populated){const inner=document.createElement('div');inner.style.marginLeft='15px';for(const prop in snap)if(Object.prototype.hasOwnProperty.call(snap,prop)){const line=document.createElement('div');line.appendChild(this.styledSpan(prop+': ','log-property'));line.appendChild(this.renderValue(snap[prop],targetWin));inner.appendChild(line)}d.appendChild(inner);d._populated=true}});return d}return this.styledSpan(String(value),'log-other')}
    addValues(values,targetWin=window){
      const nodes=(values||[]).map(v=>this.renderValue(v,targetWin));
      if(!nodes.length)return null;
      const follow=this.isNearBottom();
      const c=document.createElement('div');
      c.style.marginLeft='4px';
      c.className='log-line';
      for(const node of nodes)c.appendChild(node);
      this.getList().appendChild(c);
      if(follow)this.scrollToBottom();
      return c;
    }
    log(...args){return this.addValues(args)}
    logText(...args){const c=document.createElement('div');c.style.marginLeft='4px';c.className='log-line';const frag=document.createDocumentFragment();args.forEach((value,index)=>{if(index)frag.appendChild(document.createTextNode(' '));frag.appendChild(document.createTextNode(String(value??'')))});c.appendChild(frag);const follow=this.isNearBottom();this.getList().appendChild(c);if(follow)this.scrollToBottom();return c}
    text(...args){return this.logText(...args)}
    info(...args){return this.log(...args)} debug(...args){return this.log(...args)}
    warn(...args){return this.add(this.createWarning(args.length===1?args[0]:args.map(String).join(' ')))}
    error(...args){return this.add(this.createError(args.length===1?args[0]:args.map(v=>{try{return typeof v==='object'?JSON.stringify(v):String(v)}catch(e){return String(v)}}).join(' ')))}
    dir(value,targetWin=window){return this.add(this.renderValue(value,targetWin))}
    createText(text){return this.styledSpan(String(text??''),'log')}
    createError(text){const s=document.createElement('span');s.className='log log-error';s.appendChild(this.filterText(String(text??'')));return s}
    createWarning(text){const s=document.createElement('span');s.className='log log-warning';s.appendChild(this.filterText(String(text??'')));return s}
  }
  BrowserConsole.CORS_ERROR={};
  BrowserConsole.ensureStyles=function(){
    if(document.getElementById('browser-console-styles'))return;
    const style=document.createElement('style');style.id='browser-console-styles';
    style.textContent=`
      .browser-console-log-list{min-height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-end}
      .console-log-list{min-height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-end}
      .console-empty-state{padding:2px 4px}
      .log{display:inline;line-height:1.4;vertical-align:top;margin:0;padding:0;font-family:monospace;user-select:text}
      .log-number{color:#61afef}.log-string{color:#98c379;white-space:pre-wrap;word-break:break-all}.log-boolean{color:#d19a66}
      .log-null,.log-undefined,.log-empty{color:#7f848e;font-style:italic}.log-property{color:#abb2bf}.log-class{color:#e5c07b;font-weight:bold}
      .log-function{color:#e06c75}.log-function-source{color:#7f848e;font-size:11px;margin-top:2px}.log-dropdown{display:inline-block;margin:0 4px}
      .log-html{color:#98c379;font-weight:500;word-break:break-all}.log-error{color:#f44747;background:rgba(244,71,71,.12);padding:3px 6px;border-radius:4px;display:block;border-left:3px solid #f44747;margin:2px 0}
      .log-warning{color:#e5c07b;background:rgba(229,192,123,.12);padding:3px 6px;border-radius:4px;display:block;border-left:3px solid #e5c07b;margin:2px 0}
      .log-details{display:inline-block;margin:0 4px 0 0}.log-promise{color:#c678dd;font-style:italic}.log-circular,.log-promise-rejected{color:#f44747;font-style:italic}
      .log-url{text-decoration:underline;cursor:pointer;color:#61afef}.log-url:hover{font-weight:bold}.log-line{border-bottom:1px solid rgba(255,255,255,.04);padding:4px 0;word-wrap:break-word;font-family:monospace;font-size:11px}
      .console-log-list{width:100%}
    `;
    document.head.appendChild(style);
  };
  window.BrowserConsole=BrowserConsole;
})();

// dependencies:
// network.js

// Default SVG Globe favicon
const DEFAULT_FAVICON = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%239aa0a6' stroke-width='2'><circle cx='12' cy='12' r='10'/><line x1='2' y1='12' x2='22' y2='12'/><path d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'/></svg>";

// Configurable Proxy Settings
const browserQuery = new URLSearchParams(window.location.search);

let appSettings = {
  primaryProxy: (window.WorkerConfig && window.WorkerConfig.proxy) || "",
  fallbackProxy: "",
  searchEngine: "https://mojeek.com/search?q=",
  useFallback: false,
  obscureURL: true,
  defaultTab: "https://example.com",
  clearDevToolsOnReload: true,
  autoDownload: false,
};

var browserNetwork = null;
var sharedBrowserNetwork = null;
try {
  if (window.parent && window.parent !== window) {
    sharedBrowserNetwork = window.parent.__sharedBrowserNetwork || null;
  }
} catch (e) {}

browserNetwork = sharedBrowserNetwork || new Network();
window.browserNetwork = browserNetwork;
browserNetwork.addEventListener('requeststart',function(request, type){
  updateLoadingProgress(30);
});
browserNetwork.addEventListener('socketstart',function(absoluteUrl, protocols) {
  var url;
  try { url = new URL(absoluteUrl); } catch(e) { return; }
});
browserNetwork.addEventListener('socketend',async function(socket, absoluteUrl, protocols) {
  var url;
  try { url = new URL(absoluteUrl); } catch(e) { return; }
});
browserNetwork.addEventListener('requestend',async function(response, request, type){
  if (!response) return;
  updateLoadingProgress(80);
});
browserNetwork.addEventListener('websocket',async function(absoluteUrl,data) {
  var url = new URL(absoluteUrl);
});

var primaryProxyEndpoint;
var fallbackProxyEndpoint;
var browserDefaultFallbackEndpoint;
if (browserNetwork.__browserBaseEndpoints) {
  primaryProxyEndpoint = browserNetwork.__browserBaseEndpoints.primary;
  fallbackProxyEndpoint = browserNetwork.__browserBaseEndpoints.fallback;
  browserDefaultFallbackEndpoint = browserNetwork.__browserBaseEndpoints.defaultFallback;
} else {
  primaryProxyEndpoint = new ProxyNetworkEndpoint(appSettings.primaryProxy, appSettings.obscureURL);
  fallbackProxyEndpoint = new ProxyNetworkEndpoint(appSettings.fallbackProxy, appSettings.obscureURL, appSettings.useFallback);
  browserDefaultFallbackEndpoint = new NetworkEndpoint();
  browserDefaultFallbackEndpoint.__browserDefaultFallback = true;
  browserNetwork.appendEndpoint(browserDefaultFallbackEndpoint);
  browserNetwork.appendEndpoint(primaryProxyEndpoint);
  browserNetwork.appendEndpoint(fallbackProxyEndpoint);
  browserNetwork.__browserBaseEndpoints = {
    primary: primaryProxyEndpoint,
    fallback: fallbackProxyEndpoint,
    defaultFallback: browserDefaultFallbackEndpoint
  };
}

function updateNetworkSettings() {
  primaryProxyEndpoint.proxy = appSettings.primaryProxy;
  primaryProxyEndpoint.obscureURL = appSettings.obscureURL;
  fallbackProxyEndpoint.proxy = appSettings.fallbackProxy;
  fallbackProxyEndpoint.obscureURL = appSettings.obscureURL;
  fallbackProxyEndpoint.enabled = appSettings.useFallback;
}


window.addEventListener('error', function(e) {
  const error = e?.error;
  const message = error?.stack || error?.message || e?.message || `Script error at ${e?.filename || 'unknown'}:${e?.lineno || 0}`;
  console.error("Uncaught Error: " + message);
});

var bookmarks = [
  // { title: "Minecraft", url: "https://eaglercraft.q13x.com/1.8-wasm/" },
  // { title: "Wikipedia", url: "https://www.wikipedia.org/" },
  // { title: "Hacker News", url: "https://news.ycombinator.com" },
  // { title: "Test", url: "https://getsamplefiles.com/download/7z/sample-1.7z" },
  // { title: "WatermelonKatana", url: "https://watermelonkatana.onrender.com" },
  // { title: "Pathtracer", url: "https://dragonfiregames.github.io/WebGPU-Pathtracer/" },
];

function setStorageItem(key,value) {
  localStorage.setItem(key,JSON.stringify(value));
}
function getStorageItem(key) {
  var item = localStorage.getItem(key);
  return item ? JSON.parse(item) : null;
}

function getEditorBrowserStateBridge() {
  try {
    if (window.parent && window.parent !== window) return window.parent.__editorBrowserStateBridge || null;
  } catch (e) {}
  return null;
}

function normalizeBrowserState(state) {
  const value = state && typeof state === 'object' ? state : {};
  const settings = value.settings && typeof value.settings === 'object' ? value.settings : {};
  const storedBookmarks = Array.isArray(value.bookmarks) ? value.bookmarks : [];
  const normalizedBookmarks = storedBookmarks.map(bookmark => ({
    title: typeof bookmark?.title === 'string' ? bookmark.title : String(bookmark?.title || bookmark?.url || ''),
    url: typeof bookmark?.url === 'string' ? bookmark.url : String(bookmark?.url || ''),
    favicon: typeof bookmark?.favicon === 'string' ? bookmark.favicon : DEFAULT_FAVICON,
    faviconUrl: typeof bookmark?.faviconUrl === 'string' ? bookmark.faviconUrl : (typeof bookmark?.url === 'string' ? bookmark.url : '')
  })).filter(bookmark => bookmark.url);
  return { settings: { ...settings }, bookmarks: normalizedBookmarks };
}

function loadEditorBrowserState() {
  const bridge = getEditorBrowserStateBridge();
  try {
    const stored = bridge?.read?.();
    if (stored) {
      const state = normalizeBrowserState(stored);
      appSettings = { ...appSettings, ...state.settings };
      bookmarks = state.bookmarks;
      return true;
    }
  } catch (e) {}
  return false;
}

let editorBrowserStateUnsubscribe = null;
function subscribeEditorBrowserState() {
  if (editorBrowserStateUnsubscribe) return;
  const bridge = getEditorBrowserStateBridge();
  try {
    editorBrowserStateUnsubscribe = bridge?.subscribe?.(state => {
      if (!state) return;
      const next = normalizeBrowserState(state);
      appSettings = { ...appSettings, ...next.settings };
      bookmarks = next.bookmarks;
      try { updateSettings(); } catch (_) {}
      renderBookmarks();
      updateBookmarkStar();
      refreshAllBookmarkIcons(false);
    }) || null;
  } catch (e) {
    editorBrowserStateUnsubscribe = null;
  }
}

window.addEventListener('pagehide', () => {
  try { editorBrowserStateUnsubscribe?.(); } catch (_) {}
  editorBrowserStateUnsubscribe = null;
});

// setTimeout(function(){
//   bookmarks = getStorageItem('bookmarks') || bookmarks;
//   appSettings = getStorageItem('history') || appSettings;
//   updateSettings();
//   tabs = getStorageItem('tabs') || tabs;
//   activeTabId = getStorageItem('activeTab');
//   var tab = getActiveTab();
//   if (tab) navigateToInTab(tab,tab.url,true,true);
//   updateToolbarUI();
//   renderBookmarks();
//   if (tabs.length == 0) {
//   }
// 
// },1);

try {
  const savedAppSettings = getStorageItem('appSettings');
  if (savedAppSettings) appSettings = { ...appSettings, ...savedAppSettings };
  const savedBookmarks = getStorageItem('bookmarks');
  if (Array.isArray(savedBookmarks)) bookmarks = normalizeBrowserState({ bookmarks: savedBookmarks }).bookmarks;
} catch(e) {}
loadEditorBrowserState();
subscribeEditorBrowserState();
appSettings.primaryProxy = String(window.WorkerConfig?.proxy || '');

function saveBrowserState() {
  const normalizedBookmarks = bookmarks.map(bookmark => ({
    title: typeof bookmark?.title === 'string' ? bookmark.title : String(bookmark?.title || bookmark?.url || ''),
    url: typeof bookmark?.url === 'string' ? bookmark.url : String(bookmark?.url || ''),
    favicon: typeof bookmark?.favicon === 'string' ? bookmark.favicon : DEFAULT_FAVICON,
    faviconUrl: typeof bookmark?.faviconUrl === 'string' ? bookmark.faviconUrl : (typeof bookmark?.url === 'string' ? bookmark.url : '')
  })).filter(bookmark => bookmark.url);
  const bridge = getEditorBrowserStateBridge();
  try {
    if (bridge?.write) bridge.write({ settings: { ...appSettings }, bookmarks: normalizedBookmarks });
    else setStorageItem('bookmarks',normalizedBookmarks);
  } catch (e) {
    setStorageItem('bookmarks',normalizedBookmarks);
  }
  setStorageItem('history',history);
  setStorageItem('tabs',tabs.map(tab => {
    var serialized_tab = { ...tab };
    delete serialized_tab.iframe;
    delete serialized_tab.page;
    return serialized_tab;
  }));
  setStorageItem('activeTab',activeTabId);
}

let historyLog = [];
let tabs = [];
let activeTabId = null;
let closedTabsStack = [];
let contextMenuTarget = null;
let downloads = [];
let downloadId = 0;
const downloadBlobCache = new Map();
function saveDownloadHistory() {
  try {
    setStorageItem('downloads',downloads.filter(d => d.status !== 'downloading').slice(-100).map(d => ({
      id:d.id,url:d.url,name:d.name,status:d.status,progress:d.progress || 0,received:d.received || 0,total:d.total || 0,
      size:d.size || 0,startedAt:d.startedAt,finishedAt:d.finishedAt || 0,error:d.error || '',autoDownloaded:!!d.autoDownloaded
    })));
  } catch(e) {}
}
function loadDownloadHistory() {
  try {
    const saved = getStorageItem('downloads');
    if (!Array.isArray(saved)) return;
    downloads = saved.map(d => ({...d,id:Number(d.id) || 0})).filter(d => d.url && d.id > 0);
    downloadId = downloads.reduce((max,d) => Math.max(max,d.id),0);
  } catch(e) {}
}
function formatDownloadSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function formatDownloadTime(value) {
  try { return new Date(value).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}); } catch(e) { return ''; }
}
async function putDownloadCache(id,blob) {
  if (blob instanceof Blob) downloadBlobCache.set(id,blob);
}
async function getDownloadCache(id) {
  return downloadBlobCache.get(id) || null;
}
async function deleteDownloadCache(id) {
  downloadBlobCache.delete(id);
}
function getDownloadName(url,filename,response) {
  if (typeof filename === 'string' && filename.trim()) return filename.trim();
  const disposition = response?.headers?.get('content-disposition') || '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename=(?:"([^"]+)"|([^;]+))/i);
  if (match) {
    const value = (match[1] || match[2] || match[3] || '').trim();
    if (value) {
      try { return decodeURIComponent(value); } catch(e) { return value; }
    }
  }
  for (const candidate of [response?.url,response?.source_url,response?.requested_url,url]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') continue;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length) {
        const value = decodeURIComponent(parts[parts.length - 1]);
        if (value) return value;
      }
    } catch(e) {}
  }
  for (const candidate of [url,response?.requested_url,response?.source_url,response?.url]) {
    if (!candidate) continue;
    const fragmentMatch = String(candidate).match(/#f=([^&#]+)/i);
    if (fragmentMatch) {
      try { return decodeURIComponent(fragmentMatch[1]); } catch(e) { return fragmentMatch[1]; }
    }
  }
  return 'download';
}
function releaseDownloadPreviewUrl(item) {
  if (!item?._previewUrl) return;
  try { URL.revokeObjectURL(item._previewUrl); } catch(e) {}
  item._previewUrl = null;
}
function createDownloadPreviewIcon(item) {
  const wrap = document.createElement('div');
  wrap.className = 'download-item-icon';
  const contentType = String(item?.contentType || '').toLowerCase();
  if (item?.status === 'failed') {
    wrap.classList.add('text-red-500');
    wrap.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
    return wrap;
  }
  if (contentType.startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'download-preview-thumb';
    img.alt = '';
    img.loading = 'lazy';
    img.title = 'Image preview';
    wrap.appendChild(img);
    if (item._previewUrl) img.src = item._previewUrl;
    else if (!item._previewLoading && item.status === 'complete') {
      item._previewLoading = true;
      getDownloadCache(item.id).then(blob => {
        if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) return;
        if (!item._previewUrl) item._previewUrl = URL.createObjectURL(blob);
        if (img.isConnected) img.src = item._previewUrl;
      }).catch(() => {}).finally(() => { item._previewLoading = false; });
    }
    return wrap;
  }
  wrap.innerHTML = '<i class="fa-solid fa-file-lines text-[13px]"></i>';
  return wrap;
}
function renderDownloads() {
  const list = document.getElementById('downloads-list');
  const empty = document.getElementById('downloads-empty');
  const badge = document.getElementById('downloads-badge');
  if (!list) return;
  list.innerHTML = '';
  const active = downloads.filter(d => d.status === 'downloading');
  if (badge) { badge.textContent = active.length ? String(active.length) : ''; badge.classList.toggle('hidden',!active.length); }
  if (empty) empty.classList.toggle('hidden',downloads.length > 0);
  downloads.slice().reverse().forEach(d => {
    const row = document.createElement('div');
    row.className = 'download-item';
    if (d.status === 'complete') {
      row.classList.add('cursor-pointer');
      row.title = 'Click to save file or drag into a file upload';
      row.draggable = true;
      row.ondragstart = (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        let token = '';
        try {
          const blob = downloadBlobCache.get(d.id);
          if (blob instanceof Blob) {
            const file = new File([blob],d.name || 'download',{type:d.contentType || blob.type || 'application/octet-stream',lastModified:d.finishedAt || Date.now()});
            const bridge = window.parent && window.parent !== window ? window.parent.__editorFileDropBridge : null;
            token = bridge?.register?.(file) || '';
          }
        } catch (_) {}
        e.dataTransfer.setData('application/x-proxy-download',token);
        e.dataTransfer.setData('application/x-proxy-download-id',String(d.id));
        e.dataTransfer.setData('text/plain',d.name || 'download');
      };
      row.onclick = () => saveCachedDownload(d.id);
    }
    const icon = createDownloadPreviewIcon(d);
    if (d.status === 'downloading' && !String(d.contentType || '').toLowerCase().startsWith('image/')) {
      icon.innerHTML = '<i class="fa-solid fa-download"></i>';
    }
    const main = document.createElement('div');
    main.className = 'download-item-main';
    const top = document.createElement('div');
    top.className = 'download-item-top';
    const name = document.createElement('span');
    name.className = 'download-item-name';
    name.title = d.url || d.name;
    name.textContent = d.name || 'Download';
    const status = document.createElement('span');
    status.className = 'download-item-status';
    status.textContent = d.status === 'downloading' ? `${Math.round(d.progress || 0)}%` : d.status === 'failed' ? 'Failed' : formatDownloadTime(d.finishedAt || d.startedAt);
    top.append(name,status);
    const sub = document.createElement('div');
    sub.className = 'download-item-sub';
    sub.textContent = d.status === 'downloading' ? `${formatDownloadSize(d.received)}${d.total ? ' / ' + formatDownloadSize(d.total) : ''}` : d.status === 'failed' ? (d.error || 'Download failed') : d.autoDownloaded ? `${formatDownloadSize(d.size)} • Downloaded` : `${formatDownloadSize(d.size)} • Click to save`;
    main.append(top,sub);
    if (d.status === 'downloading') {
      const track = document.createElement('div');
      track.className = 'download-progress-track';
      const bar = document.createElement('div');
      bar.className = 'download-progress-bar';
      bar.style.width = `${Math.max(0,Math.min(100,d.progress || 0))}%`;
      track.appendChild(bar);
      main.appendChild(track);
    }
    row.append(icon,main);
    list.appendChild(row);
  });
}
var downloadsOpen = false;
function showDownloads() {
  const panel = document.getElementById('downloads-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  renderDownloads();
  downloadsOpen = true;
}
function toggleDownloads() {
  const panel = document.getElementById('downloads-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderDownloads();
  downloadsOpen = !downloadsOpen;
}
async function clearDownloads() {
  const removed = downloads.filter(d => d.status !== 'downloading');
  downloads = downloads.filter(d => d.status === 'downloading');
  removed.forEach(releaseDownloadPreviewUrl);
  await Promise.all(removed.map(d => deleteDownloadCache(d.id)));
  saveDownloadHistory();
  renderDownloads();
}
function beginDownload(url,filename) {
  const item = {
    id:++downloadId,url,name:(typeof filename === 'string' && filename) ? filename : 'download',
    status:'downloading',progress:0,received:0,total:0,startedAt:Date.now(),autoDownloaded:false
  };
  downloads.push(item);
  showDownloads();
  return item;
}
async function performDownload(url,filename) {
  const item = beginDownload(url,filename);
  try {
    const response = await browserNetwork.request(url,undefined,{},'download');
    if (!response || !response.ok) throw new Error(`HTTP error! status: ${response?.status || 0}`);
    item.name = getDownloadName(url,filename,response);
    item.contentType = response.headers?.get('content-type') || '';
    const total = parseInt(response.headers?.get('content-length') || '0',10) || 0;
    item.total = total;
    const chunks = [];
    let received = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value) {
          chunks.push(part.value);
          received += part.value.byteLength;
        }
        item.received = received;
        item.progress = total ? received / total * 100 : Math.min(99,Math.max(1,received / (1024 * 1024)));
        renderDownloads();
      }
    } else {
      const buffer = await response.arrayBuffer();
      chunks.push(new Uint8Array(buffer));
      received = buffer.byteLength;
      item.received = received;
      item.progress = 100;
      renderDownloads();
    }
    const blob = new Blob(chunks,{type:response.headers?.get('content-type') || 'application/octet-stream'});
    item.size = blob.size;
    item.received = blob.size;
    item.progress = 100;
    item.status = 'complete';
    item.finishedAt = Date.now();
    await putDownloadCache(item.id,blob);
    if (appSettings.autoDownload) {
      await saveCachedDownload(item.id);
      item.autoDownloaded = true;
    }
    saveDownloadHistory();
    renderDownloads();
    showDownloads();
    return blob;
  } catch(e) {
    item.status = 'failed';
    item.error = e?.message || String(e);
    item.finishedAt = Date.now();
    saveDownloadHistory();
    renderDownloads();
    showDownloads();
    throw e;
  }
}
async function saveCachedDownload(id) {
  const item = downloads.find(d => d.id === id);
  if (!item || item.status !== 'complete') return;
  const blob = await getDownloadCache(id);
  if (!blob) {
    showToast('The cached file is no longer available.','error');
    return;
  }
  const blobUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = item.name || 'download';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl),30000);
  }
}

let uploadModal = null;
let uploadModalInput = null;
function uploadInputFiles(input,files) {
  if (!input || !files || !files.length) return false;
  try {
    const view = input.ownerDocument?.defaultView || window;
    const dataTransfer = new view.DataTransfer();
    for (const file of files) dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    const EventCtor = view.Event || Event;
    input.dispatchEvent(new EventCtor('input',{bubbles:true}));
    input.dispatchEvent(new EventCtor('change',{bubbles:true}));
    return true;
  } catch(e) {
    console.error('Failed to assign files to upload input:',e);
    return false;
  }
}
function uploadAcceptsFile(input,file) {
  const accept = String(input?.getAttribute?.('accept') || '').trim();
  if (!accept) return true;
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  return accept.split(',').map(v => v.trim().toLowerCase()).filter(Boolean).some(token => {
    if (token === '*/*') return true;
    if (token.endsWith('/*')) return type.startsWith(token.slice(0,-1));
    if (token.startsWith('.')) return name.endsWith(token);
    return type === token;
  });
}
let wereDownloadsOpen = false;
function closeUploadPicker() {
  if (!uploadModal) return;
  uploadModal.remove();
  uploadModal = null;
  uploadModalInput = null;
  if (!wereDownloadsOpen) toggleDownloads();
}
async function openUploadPicker(input, openDownloads=true) {
  if (!input || input.disabled) return;
  closeUploadPicker();
  if (openDownloads) {
    wereDownloadsOpen = downloadsOpen;
    showDownloads();
  } else {
    wereDownloadsOpen = true;
  }
  uploadModalInput = input;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.style.zIndex = '20000';
  overlay.style.background = 'rgba(0,0,0,0.7)';
  overlay.style.backdropFilter = 'blur(2px)';
  overlay.style.pointerEvents = 'auto';
  const box = document.createElement('div');
  box.className = 'modal-box';
  box.style.maxWidth = '440px';
  box.style.pointerEvents = 'auto';
  box.style.position = 'relative';
  box.style.zIndex = '20001';
  const header = document.createElement('div');
  header.className = 'flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800';
  const title = document.createElement('h3');
  title.className = 'font-bold text-base flex items-center gap-2 text-indigo-400';
  title.innerHTML = '<i class="fa-solid fa-file-arrow-up"></i> Choose a file';
  const close = document.createElement('button');
  close.className = 'text-gray-400 hover:text-white';
  close.innerHTML = '<i class="fa-solid fa-xmark text-lg"></i>';
  close.onclick = closeUploadPicker;
  header.append(title,close);
  const body = document.createElement('div');
  body.className = 'p-4 flex flex-col gap-3';
  const info = document.createElement('div');
  info.className = 'text-xs text-gray-400';
  const accept = input.getAttribute('accept');
  info.textContent = accept ? `Accepted: ${accept}` : (input.multiple ? 'Multiple files accepted.' : 'Choose one file.');
  const drop = document.createElement('div');
  drop.className = 'border border-dashed border-gray-600 rounded-lg p-6 text-center bg-[#202124] hover:border-indigo-500 transition-colors';
  drop.innerHTML = '<i class="fa-solid fa-cloud-arrow-up text-2xl text-gray-500"></i><div class="mt-2 text-sm text-gray-200">Drop a downloaded file here</div><div class="mt-1 text-[11px] text-gray-500">or choose a file from this device</div>';
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.className = 'mt-4 block w-full text-xs text-gray-300';
  if (accept) picker.setAttribute('accept',accept);
  if (input.multiple) picker.multiple = true;
  if (input.hasAttribute('capture')) picker.setAttribute('capture',input.getAttribute('capture') || '');
  if (input.hasAttribute('webkitdirectory')) picker.setAttribute('webkitdirectory','');
  picker.onchange = () => {
    const files = Array.from(picker.files || []);
    if (!files.length) return;
    const accepted = files.filter(file => uploadAcceptsFile(input,file));
    if (accepted.length !== files.length) {
      showToast('One or more selected files do not match the upload type.','error');
      return;
    }
    if (uploadInputFiles(input,input.multiple ? accepted : accepted.slice(0,1))) closeUploadPicker();
  };
  drop.addEventListener('dragover',e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; drop.classList.add('border-indigo-500'); });
  drop.addEventListener('dragleave',() => drop.classList.remove('border-indigo-500'));
  drop.addEventListener('drop',async e => {
    e.preventDefault();
    drop.classList.remove('border-indigo-500');
    const rawId = e.dataTransfer.getData('application/x-proxy-download-id');
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return;
    const item = downloads.find(d => d.id === id && d.status === 'complete');
    if (!item) return;
    try {
      const blob = await getDownloadCache(id);
      if (!blob) throw new Error('The downloaded file is no longer cached.');
      const file = new File([blob],item.name || 'download',{type:item.contentType || blob.type || 'application/octet-stream',lastModified:item.finishedAt || Date.now()});
      if (!uploadAcceptsFile(input,file)) {
        showToast(`This file does not match the upload type.`, 'error');
        return;
      }
      if (uploadInputFiles(input,[file])) closeUploadPicker();
    } catch(err) {
      showToast(err?.message || 'Unable to use the downloaded file.','error');
    }
  });
  body.append(info,drop,picker);
  box.append(header,body);
  overlay.appendChild(box);
  uploadModal = overlay;
  document.body.appendChild(overlay);
}
window.addEventListener('keydown',e => { if (e.key === 'Escape' && uploadModal) closeUploadPicker(); });
const cacheMap = {};
var devtoolsHost = document.createElement('div');
devtoolsHost.id = 'devtools-host';
devtoolsHost.className = 'devtools-host';
document.getElementById('main-viewport-area').appendChild(devtoolsHost);
devtoolsHost.style.display = 'contents';
var browserDevTools = new DevTools(devtoolsHost,{cacheMap});
browserDevTools.addEventListener('toast',function(message,type){ showToast(message,type); });
browserDevTools.addEventListener('open-url',function(url,activate){ createNewTab(url,activate); });
browserDevTools.addEventListener('toggle',function(open){
  document.getElementById('btn-devtools')?.classList.toggle('active-toggle',!!open);
});
loadDownloadHistory();


function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto px-4 py-2.5 rounded-lg shadow-lg text-xs font-semibold flex items-center gap-2 text-white transition-all transform translate-y-2 opacity-0 duration-200 ${
    type === 'error' ? 'bg-rose-600' : type === 'success' ? 'bg-emerald-600' : 'bg-indigo-600'
  }`;
  toast.innerHTML = `<i class="fa-solid ${type === 'error' ? 'fa-circle-exclamation' : type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}"></i> ${message}`;
  container.appendChild(toast);

  setTimeout(() => { toast.classList.remove('translate-y-2', 'opacity-0'); }, 10);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
  if (id === 'history-modal') renderHistoryLog();
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}


// Generates DataURIs natively using standard Blob and FileReader from Response
async function createDataUri(response) {
  if (!response) return null;
  try {
    const blob = await response.clone().blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (response.source_url) cacheMap[response.source_url] = reader.result;

        let defaultName = '';

        // 1. Try checking the Content-Disposition header first
        if (response.headers) {
          const disposition = response.headers.get('content-disposition');
          if (disposition && disposition.includes('filename=')) {
            // Regex handles optional quotes around filenames safely
            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
            const matches = filenameRegex.exec(disposition);
            if (matches && matches[1]) {
              defaultName = matches[1].replace(/['"]/g, '').trim();
            }
          }
        }

        // 2. Fall back to your URL extraction method if header parsing failed
        if (!defaultName && response.source_url) {
          defaultName = getFileNameFromURL(response.source_url,'');
        }

        if (defaultName) defaultName = "#f="+defaultName;

        resolve(reader.result+defaultName);
      }
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch(e) {
    window.logError("DataURI conversion failed: " + e.message);
    return null;
  }
};

async function updateTabMetadata(tab) {
  tab.favicon = DEFAULT_FAVICON;
  tab.faviconUrl = tab.url;
  try {
    const doc = tab.iframe.contentDocument || tab.iframe.contentWindow.document;
    if (!doc) return;

    const titleEl = doc.querySelector('title');
    tab.title = (titleEl && titleEl.textContent.trim()) ? titleEl.textContent.trim() : tab.url;

    let dynamicBaseOrigin = "https://example.com";
    try { dynamicBaseOrigin = new URL(tab.url).origin; } catch(e) {}

    const iconEl = doc.querySelector('link[rel*="icon"]');
    if (iconEl && iconEl.getAttribute('href')) {
      const rawFaviconUrl = iconEl.getAttribute('data-raw-src') || iconEl.getAttribute('href');
      const absFaviconUrl = new URL(rawFaviconUrl, dynamicBaseOrigin).href;
      const file = await tab.page.network.request(absFaviconUrl, dynamicBaseOrigin, {}, 'favicon');
      const icon = file ? await createDataUri(file) : null;
      if (icon) tab.favicon = icon;
    } else {
      tab.favicon = DEFAULT_FAVICON;
    }
  } catch (e) {
    if (!tab.favicon) tab.favicon = DEFAULT_FAVICON;
  }
  renderTabStrip();
  updateBookmarkStar();
  await refreshBookmarkIcon(tab);
}

const menuEl = document.getElementById('custom-context-menu');

let browserChromeFullscreen = ['1', 'true', 'yes'].includes(String(browserQuery.get('hideBrowserBar') || '').toLowerCase());
let browserChromeRevealTimer = null;

function setBrowserChromeReveal(visible) {
  document.body.classList.toggle('chrome-hover-reveal', visible);
}

function setBrowserChromeHidden(hidden) {
  browserChromeFullscreen = !!hidden;
  document.body.classList.toggle('browser-chrome-fullscreen', browserChromeFullscreen);
  const icon = document.getElementById('btn-browser-fullscreen')?.querySelector('i');
  icon?.classList.toggle('fa-expand', !browserChromeFullscreen);
  icon?.classList.toggle('fa-compress', browserChromeFullscreen);
  const button = document.getElementById('btn-browser-fullscreen');
  if (button) button.title = browserChromeFullscreen ? 'Show Browser Bar' : 'Hide Browser Bar';
  if (!browserChromeFullscreen) setBrowserChromeReveal(false);
}

function toggleBrowserFullscreen() {
  setBrowserChromeHidden(!browserChromeFullscreen);
  document.body.classList.toggle('browser-chrome-fullscreen', browserChromeFullscreen);
}

function showBrowserBarOnHover() {
  if (!browserChromeFullscreen) return;
  clearTimeout(browserChromeRevealTimer);
  setBrowserChromeReveal(true);
}

function hideBrowserBarAfterHover() {
  if (!browserChromeFullscreen) return;
  clearTimeout(browserChromeRevealTimer);
  browserChromeRevealTimer = setTimeout(() => setBrowserChromeReveal(false), 250);
}

function showBrowserChromeContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  showContextMenu(event.clientX, event.clientY, {
    target: event.target,
    tagName: event.target?.tagName || 'DIV',
    linkUrl: null,
    mediaSrc: null,
    rawMediaSrc: null,
    mediaType: null
  });
}

function blockBrowserChromeContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  hideContextMenu();
}

function showTabStripContextMenu(event) {
  if (event.target.closest?.('.tab')) return;
  event.preventDefault();
  event.stopPropagation();
  showSimpleContextMenu(event.clientX,event.clientY,[
    {label:'New Tab',shortcut:'Ctrl+T',action:() => createNewTab(appSettings.defaultTab,true)},
    {label:'Reopen Closed Tab',shortcut:'Ctrl+Shift+T',disabled:closedTabsStack.length === 0,action:() => restoreClosedTab()}
  ]);
}

function showSimpleContextMenu(clientX,clientY,items) {
  contextMenuTarget = null;
  menuEl.innerHTML = '';
  items.forEach(item => {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'menu-separator';
      menuEl.appendChild(sep);
      return;
    }
    const div = document.createElement('div');
    div.className = `menu-item ${item.disabled ? 'disabled' : ''}`;
    const label = document.createElement('span');
    label.textContent = item.label;
    div.appendChild(label);
    if (item.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.className = 'menu-shortcut';
      shortcut.textContent = item.shortcut;
      div.appendChild(shortcut);
    }
    if (!item.disabled) {
      div.onclick = e => {
        e.stopPropagation();
        hideContextMenu();
        item.action();
      };
    }
    menuEl.appendChild(div);
  });
  menuEl.style.display = 'block';
  const menuWidth = menuEl.offsetWidth;
  const menuHeight = menuEl.offsetHeight;
  const posX = clientX + menuWidth > window.innerWidth ? window.innerWidth - menuWidth - 8 : clientX;
  const posY = clientY + menuHeight > window.innerHeight ? window.innerHeight - menuHeight - 8 : clientY;
  menuEl.style.left = `${Math.max(8,posX)}px`;
  menuEl.style.top = `${Math.max(8,posY)}px`;
}

function installBrowserChromeInteractions() {
  ['nav-bar','bookmarks-bar'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.addEventListener('contextmenu', blockBrowserChromeContextMenu);
  });

  const tabStrip = document.getElementById('tab-strip');
  const tabsList = document.getElementById('tabs-list');
  if (tabStrip) tabStrip.addEventListener('contextmenu', showTabStripContextMenu);
  if (tabsList) tabsList.addEventListener('contextmenu', function(event) {
    if (!event.target.closest?.('.tab')) return;
    showBrowserChromeContextMenu(event);
  });

  const reveal = document.getElementById('browser-chrome-reveal');
  if (reveal) {
    reveal.addEventListener('mouseenter', showBrowserBarOnHover);
    reveal.addEventListener('mouseleave', hideBrowserBarAfterHover);
  }

  ['tab-strip','nav-bar','bookmarks-bar'].forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('mouseenter', showBrowserBarOnHover);
    element.addEventListener('mouseleave', hideBrowserBarAfterHover);
  });
}

function hideContextMenu() {
  menuEl.style.display = 'none';
  contextMenuTarget = null;
}

function showContextMenu(clientX, clientY, targetInfo) {
  menuEl.style.position = 'fixed';
  menuEl.style.transform = 'none';
  contextMenuTarget = targetInfo;
  const tab = getActiveTab();
  const canBack = tab && tab.page.historyIndex > 0;
  const canForward = tab && tab.page.historyIndex < tab.page.history.length - 1;

  let menuItems = [];

  if (targetInfo.tagName == "CANVAS") {
    const canvas = targetInfo.target;
    menuItems.push({
      label: 'Save Image As...',
      action: () => {
        const fileName = prompt('Enter file name:', 'canvas-image');
        if (fileName === null) return; // User canceled the prompt

        const sanitizedName = fileName.trim() || 'canvas-image';
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `${sanitizedName}.png`;
        link.href = dataUrl;
        link.click();
      }
    });
    menuItems.push({
      label: 'Copy Image',
      action: async () => {
        try {
          canvas.toBlob(async (blob) => {
            if (blob) {
              await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
              ]);
              showToast('Image copied to clipboard!');
            }
          }, 'image/png');
        } catch (err) {
          showToast('Failed to copy image.');
        }
      }
    });
    menuItems.push({ type: 'separator' });
  }

  if (targetInfo.linkUrl) {
    menuItems.push({ label: 'Open Link in New Tab', action: () => createNewTab(targetInfo.linkUrl, true) });
    menuItems.push({ label: 'Open Link in Background Tab', action: () => createNewTab(targetInfo.linkUrl, false) });
    menuItems.push({
      label: 'Copy Link Address',
      action: () => {
        navigator.clipboard.writeText(targetInfo.linkUrl);
        showToast('Link copied to clipboard!');
      }
    });
    menuItems.push({ type: 'separator' });
  }

  if (targetInfo.mediaSrc) {
    const typeName = targetInfo.mediaType || 'Media';
    const targetMediaUrl = targetInfo.rawMediaSrc || targetInfo.mediaSrc;

    menuItems.push({ label: `Open ${typeName} in New Tab`, action: () => createNewTab(targetMediaUrl, true) });
    if (targetInfo.tagName === "IMG") {
      menuItems.push({
        label: 'Save Image As...',
        action: () => {
          const targetMediaUrl = targetInfo.rawMediaSrc || targetInfo.mediaSrc;
          if (!targetMediaUrl) return;
          
          let defaultName = getDownloadName(targetMediaUrl,'',null) || 'downloaded-image.png';
          const fileName = prompt('Enter file name:', defaultName);
          if (fileName === null) return;
          const sanitizedName = fileName.trim() || defaultName;
          performDownload(targetMediaUrl,sanitizedName).catch(() => {});
        }
      });
      menuItems.push({
        label: 'Copy Image',
        action: async () => {
          const targetMediaUrl = targetInfo.rawMediaSrc || targetInfo.mediaSrc;
          if (!targetMediaUrl) return;
          try {
            const response = await fetch(targetMediaUrl);
            const blob = await response.blob();
            
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type]: blob })
            ]);
            showToast('Image copied to clipboard!');
          } catch (err) {
            showToast('Failed to copy image.');
          }
        }
      });
    }
    menuItems.push({
      label: `Copy ${typeName} Address`,
      action: () => {
        navigator.clipboard.writeText(targetMediaUrl);
        showToast(`${typeName} address copied!`);
      }
    });
    menuItems.push({ type: 'separator' });
  }

  menuItems.push({ label: 'Back', disabled: !canBack, action: () => goBack() });
  menuItems.push({ label: 'Forward', disabled: !canForward, action: () => goForward() });
  menuItems.push({ label: 'Reload', shortcut: 'Ctrl+R', action: () => reloadCurrentTab() });
  menuItems.push({ type: 'separator' });

  menuItems.push({ label: 'New Tab', shortcut: 'Ctrl+T', action: () => createNewTab(appSettings.defaultTab, true) });
  menuItems.push({ label: 'Reopen Closed Tab', shortcut: 'Ctrl+Shift+T', disabled: closedTabsStack.length === 0, action: () => restoreClosedTab() });
  menuItems.push({ label: 'Close Tab', shortcut: 'Ctrl+W', action: () => { if (activeTabId) closeTab(activeTabId); } });
  menuItems.push({ type: 'separator' });

  // Inspect Element in Right-Click Context Menu
  menuItems.push({
    label: 'Inspect Element',
    shortcut: 'F12 / Ctrl+Shift+I',
    action: () => browserDevTools?.inspect(targetInfo)
  });

  menuEl.innerHTML = '';
  menuItems.forEach(item => {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'menu-separator';
      menuEl.appendChild(sep);
    } else {
      const div = document.createElement('div');
      div.className = `menu-item ${item.disabled ? 'disabled' : ''}`;
      div.innerHTML = `<span>${item.label}</span>${item.shortcut ? `<span class="menu-shortcut">${item.shortcut}</span>` : ''}`;
      if (!item.disabled) {
        div.onclick = (e) => {
          e.stopPropagation();
          hideContextMenu();
          item.action();
        };
      }
      menuEl.appendChild(div);
    }
  });

  menuEl.style.display = 'block';
  const menuWidth = menuEl.offsetWidth;
  const menuHeight = menuEl.offsetHeight;
  const posX = (clientX + menuWidth > window.innerWidth) ? window.innerWidth - menuWidth - 8 : clientX;
  const posY = (clientY + menuHeight > window.innerHeight) ? window.innerHeight - menuHeight - 8 : clientY;

  menuEl.style.left = `${posX}px`;
  menuEl.style.top = `${posY}px`;
}

window.addEventListener('click', hideContextMenu);
window.addEventListener('resize', hideContextMenu);

window.__aiBrowserOutput = window.__aiBrowserOutput || [];
function recordAIBrowserOutput(type, args) {
  var safe = [];
  for (var value of (Array.isArray(args) ? args : [args])) {
    try {
      if (value === null || typeof value !== "object") safe.push(value);
      else if (value instanceof Error) safe.push(value.message || String(value));
      else safe.push(JSON.parse(JSON.stringify(value)));
    } catch (_) {
      try { safe.push(String(value)); } catch (_) { safe.push("[unserializable]"); }
    }
  }
  window.__aiBrowserOutput.push({type:type, args:safe, tabId:arguments[2] || null, time:Date.now()});
  if (window.__aiBrowserOutput.length > 300) window.__aiBrowserOutput.splice(0,window.__aiBrowserOutput.length - 300);
}
function createNewPage(iframe,parentPage=null) {
  var page = new PageEmulator(iframe,{network:browserNetwork});
  browserDevTools?.runOnPage(page,parentPage);
  page.addEventListener?.('console',function(method,args){ recordAIBrowserOutput(method,args,page.tab?.id || null); });
  page.addEventListener?.('error',function(error,source){ recordAIBrowserOutput('error',[error?.message || String(error || 'Unknown error'),source || ''],page.tab?.id || null); });
  page.rawDocument = '';
  page.processedDocument = '';
  if (page.network?.addEventListener) {
    page.network.addEventListener('requeststart',function(){ updateLoadingProgress(30); });
    page.network.addEventListener('requestend',function(){ updateLoadingProgress(80); });
  }
  page.interceptEvent('iframe-create',function(obj){
    if (obj.iframe.pageEmulator) return obj.iframe.pageEmulator;

    var page2 = createNewPage(obj.iframe,page);
    page.addChild(page2);

    page2.setLocation('about:blank',page.location?.origin || 'http://localhost:3000');

    var parentTab = page.tab || null;
    var frameId = 'frame-' + Math.random().toString(36).slice(2,9);

    page2.tab = {
      id: frameId,
      iframe: obj.iframe,
      page: page2,
      subframe: true,
      parentTab: parentTab,
      frameElement: obj.iframe,
      url: 'about:blank',
      title: 'iframe',
    };

    obj.iframe.addEventListener('load',() => {
      if (!page2.tab) return;
      try {
        page2.tab.url = page2.location?.url || page2.tab.url;
      } catch(e) {}
    });

    return page2;
  });

  page.interceptEvent('embed-create',function(obj){
    if (!obj.embed || obj.embed.__embedFrame) return obj.embed?.__embedFrame || null;

    var embed = obj.embed;

    // The real <embed> remains exactly where the page put it. Do not wrap or
    // reparent it: that can change the replaced element's intrinsic layout
    // size and makes getBoundingClientRect() collapse to 0x0.
    var frame = document.createElement('iframe');
    frame.setAttribute('data-embed-frame','1');
    frame.setAttribute('frameborder','0');
    frame.style.position = 'fixed';
    frame.style.border = '0';
    frame.style.margin = '0';
    frame.style.padding = '0';
    frame.style.background = 'transparent';
    frame.style.zIndex = '2147483646';
    frame.style.display = 'block';
    frame.style.visibility = 'visible';
    frame.style.opacity = '1';

    // Render the emulated document in a separate overlay. The <embed>'s CSS
    // controls its placeholder only; it must not leak visibility/opacity into
    // the renderer, since the renderer is the thing replacing it visually.
    // The embed belongs to an emulated page, so the renderer must live in
    // that same document. Appending it to the editor's document makes the
    // frame invisible/mispositioned because its coordinates are relative to
    // the embedded page's viewport.
    var ownerDocument = embed.ownerDocument || document;
    var ownerWindow = ownerDocument.defaultView || window;
    ownerDocument.body?.appendChild(frame);
    embed.style.opacity = '0';
    embed.style.pointerEvents = 'none';
    embed.__embedFrame = frame;

    function syncBounds(){
      if (!embed.isConnected || !frame.isConnected) return;
      var r = embed.getBoundingClientRect();
      var style = ownerWindow.getComputedStyle ? ownerWindow.getComputedStyle(embed) : null;
      var visible = !style || (style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none');
      frame.style.left = r.left + 'px';
      frame.style.top = r.top + 'px';
      frame.style.width = Math.max(0,r.width) + 'px';
      frame.style.height = Math.max(0,r.height) + 'px';
      frame.style.display = 'block';
      frame.style.visibility = visible ? 'visible' : 'hidden';
      frame.style.opacity = visible ? '1' : '0';
      frame.style.pointerEvents = visible ? 'auto' : 'none';
    }
    embed.__syncEmbedBounds = syncBounds;
    ownerWindow.addEventListener('resize',syncBounds);
    ownerWindow.addEventListener('scroll',syncBounds,true);
    var embedStyleObserver = ownerWindow.MutationObserver ? new ownerWindow.MutationObserver(syncBounds) : null;
    if (embedStyleObserver) {
      embedStyleObserver.observe(embed,{attributes:true,attributeFilter:['style','class','hidden']});
      embed.__embedStyleObserver = embedStyleObserver;
    }
    syncBounds();
    var syncAttempts = 0;
    function retrySync(){
      syncBounds();
      if (++syncAttempts < 120) ownerWindow.requestAnimationFrame?.(retrySync);
    }
    ownerWindow.requestAnimationFrame?.(retrySync);
    ownerWindow.setTimeout?.(syncBounds,0);
    ownerWindow.setTimeout?.(syncBounds,50);

    var page2 = createNewPage(frame,page);
    page.addChild(page2);
    return page2;
  });

  page.interceptEvent('embed-navigate',async function(obj){
    var embed = obj.embed;
    if (!embed) return;

    var frame = embed.__embedFrame;
    var page2 = frame?.pageEmulator;
    if (!page2) {
      page2 = createNewPage(frame,page);
      page.addChild(page2);
    }

    var navigationId = obj.navigationId;
    if (navigationId !== undefined && embed.__embedNavigationId !== navigationId) return;
    if (!obj.src) return;

    var baseUrl = page.location?.url || page.location?.origin || 'http://localhost:3000/';
    var targetUrl;
    try {
      targetUrl = new URL(obj.src,baseUrl);
    } catch(e) {
      return;
    }

    page2.setLocation(targetUrl.href,targetUrl.origin);
    if (page2.tab) page2.tab.url = targetUrl.href;

    const res = await page2.network.request(targetUrl.href,targetUrl.origin,{},'embed');
    if (navigationId !== undefined && embed.__embedNavigationId !== navigationId) return;
    if (!res || !res.ok) return;

    var rawHtml = await window.getDocumentContent(res,targetUrl.href,targetUrl.origin,obj);
    if (navigationId !== undefined && embed.__embedNavigationId !== navigationId) return;

    page2.rawDocument = String(rawHtml || '');
    await page2.setDocument(rawHtml, true, targetUrl.href);
    embed.__syncEmbedBounds?.();
  });

  page.interceptEvent('iframe-navigate',async function(obj){
    var page2 = obj.iframe.pageEmulator;

    if (!page2) {
      alert("Page not found!");
      return;
    }

    var navigationId = obj.navigationId;

    if (navigationId !== undefined && obj.iframe.__iframeNavigationId !== navigationId) return;

    if (obj.is_doc) {
      page2.setLocation('about:srcdoc',page.location?.origin || 'http://localhost:3000');
      if (page2.tab) page2.tab.url = 'about:srcdoc';

      page2.rawDocument = String(obj.srcdoc || '');

      if (navigationId !== undefined && obj.iframe.__iframeNavigationId !== navigationId) return;

      await page2.setDocument(obj.srcdoc || '');
      return;
    }

    if (!obj.src) return;

    var baseUrl = page.location?.url || page.location?.origin || 'http://localhost:3000/';
    var targetUrl;

    try {
      targetUrl = new URL(obj.src,baseUrl);
    } catch(e) {
      return;
    }

    page2.setLocation(targetUrl.href,targetUrl.origin);
    if (page2.tab) page2.tab.url = targetUrl.href;

    const res = await page2.network.request(targetUrl.href,targetUrl.origin,{},'iframe');

    if (navigationId !== undefined && obj.iframe.__iframeNavigationId !== navigationId) return;
    if (!res || !res.ok) return;

    var rawHtml = await window.getDocumentContent(res,targetUrl.href,targetUrl.origin,obj);

    if (navigationId !== undefined && obj.iframe.__iframeNavigationId !== navigationId) return;

    page2.rawDocument = String(rawHtml || '');
    await page2.setDocument(rawHtml);
  });

  page.interceptEvent('hidecontext',async function(){
    window.hideContextMenu();
    if (window.keepAlive) window.keepAlive.start();
  });
  page.interceptEvent('showcontext', function(...args){
    window.showContextMenu(...args);
  });
  page.interceptEvent('keydown', function(e){

    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (['t', 'w', 'r', 'l', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(key) || (e.shiftKey && key === 't')) {
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true
        }));
      }
    }
  });
  page.interceptEvent('navigate', function(url, ...args) {
    const resolved = new URL(url, page.location.url).href;
    if (page.tab.subframe) renderTabContent(page.tab, resolved);
    else navigateToInTab(page.tab, resolved, ...args);
   return page.tab;
  });
  page.interceptEvent('open', function(resolved, activateTab) {
    return window.createNewTab(resolved, activateTab).page;
  });
  page.interceptEvent('download', async function(resolved, activateTab, filename) {
    return await performDownload(resolved,filename);
  });
  page.interceptEvent('upload', function(input) {
    openUploadPicker(input);
    return true;
  });
  page.addRuntimeInterceptor(function(){
    addEventListener(window, 'click', function(e) {
      sendEvent('hidecontext');
    });

    function enableLongTouchContextMenu(targetElement, duration = 500) {
      let touchTimer = null;
      let isLongPress = false;

      // 1. Handle the start of a touch
      addEventListener(targetElement, 'touchstart', (event) => {
        document.body.style['--webkit']

        // Only track single-finger touches
        if (event.touches.length > 1) return;

        isLongPress = false;

        // Start a timer for the specified duration
        touchTimer = setTimeout(() => {
          isLongPress = true;
          
          // Get touch coordinates for the event position
          const touch = event.touches[0];

          var betterTarget = document.elementFromPoint(touch.clientX, touch.clientY);

          // Create and initialize a standard contextmenu event
          const contextMenuEvent = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: touch.clientX,
            clientY: touch.clientY,
            screenX: touch.screenX,
            screenY: touch.screenY,
          });

          // Dispatch the event onto the target element
          betterTarget.dispatchEvent(contextMenuEvent);
        }, duration);
      }, { passive: true });

      // 2. Cancel the timer if the finger moves significantly
      addEventListener(targetElement, 'touchmove', () => {
        if (touchTimer) {
          clearTimeout(touchTimer);
          touchTimer = null;
        }
      }, { passive: true });

      // 3. Clean up and prevent default click actions if it was a long press
      addEventListener(targetElement, 'touchend', (event) => {
        if (touchTimer) {
          clearTimeout(touchTimer);
          touchTimer = null;
        }

        // If it was a long press, prevent native ghost clicks or selection behavior
        if (isLongPress) {
          event.preventDefault();
        }
      });

      // 4. Cancel timer if the touch is interrupted (e.g. system alert pops up)
      addEventListener(targetElement, 'touchcancel', () => {
        if (touchTimer) {
          clearTimeout(touchTimer);
          touchTimer = null;
        }
      });
    }
    enableLongTouchContextMenu(window, 500);

    addEventListener(window, 'contextmenu', function(e) {
      e.preventDefault();

      const link = e.target.closest('a');
      const img = e.target.closest('img');
      const video = e.target.closest('video');
      const audio = e.target.closest('audio');
      let contextX = Number(e.clientX) || 0;
      let contextY = Number(e.clientY) || 0;
      let contextPage = pageEmulator;
      const contextSeen = new Set();
      while (contextPage && !contextSeen.has(contextPage)) {
        contextSeen.add(contextPage);
        const frame = contextPage.iframe;
        if (!frame) break;
        try {
          const rect = frame.getBoundingClientRect();
          contextX += rect.left + (frame.clientLeft || 0);
          contextY += rect.top + (frame.clientTop || 0);
        } catch (err) {}
        contextPage = contextPage.parent && contextPage.parent !== false ? contextPage.parent : null;
      }

      let mediaSrc = null;
      let rawMediaSrc = null;
      let mediaType = null;

      if (img) {
        mediaType = 'Image';
        mediaSrc = img.getAttribute('src') || parseSrcSet(img.getAttribute('srcset')||'')[0]?.url;
        rawMediaSrc = img.getAttribute('data-raw-src') || parseSrcSet(img.getAttribute('data-raw-srcdoc')||'')[0]?.url || mediaSrc;
      } else if (video) {
        mediaType = 'Video';
        const srcEl = video.querySelector('source') || video;
        mediaSrc = srcEl ? srcEl.getAttribute('src') : null;
        rawMediaSrc = srcEl ? (srcEl.getAttribute('data-raw-src') || mediaSrc) : null;
      } else if (audio) {
        mediaType = 'Audio';
        const srcEl = audio.querySelector('source') || audio;
        mediaSrc = srcEl ? srcEl.getAttribute('src') : null;
        rawMediaSrc = srcEl ? (srcEl.getAttribute('data-raw-src') || mediaSrc) : null;
      }

      sendEvent('showcontext',
        contextX,
        contextY,
        {
          target: e.target,
          tagName: e.target.tagName,
          linkUrl: link ? new URL(link.getAttribute('href'), CURRENT_PAGE_URL).href : null,
          mediaSrc: mediaSrc,
          rawMediaSrc: rawMediaSrc ? new URL(rawMediaSrc, CURRENT_PAGE_URL).href : null,
          mediaType: mediaType
        }
      );
    });

    addEventListener(window, 'keydown', function(e) {
      sendEvent('keydown',e);
    });
  });
  return page;
}
// Tie it to a user interaction (like starting a countdown or entering a dashboard)
document.addEventListener('click', () => {
  if (window.keepAlive) window.keepAlive.start();
});

function createNewTab(initialUrl = appSettings.defaultTab, activate = true) {
  const tabId = 'tab-' + Math.random().toString(36).substring(2, 9);
  
  const iframe = document.createElement('iframe');
  iframe.id = `iframe-${tabId}`;
  iframe.className = 'tab-iframe';
  document.getElementById('viewport-container').appendChild(iframe);

  var page = createNewPage(iframe);

  const newTab = {
    id: tabId,
    url: initialUrl,
    title: initialUrl,
    favicon: DEFAULT_FAVICON,
    iframe: iframe,
    page: page,
  };

  page.tab = newTab;

  iframe.addEventListener('load', () => { updateTabMetadata(newTab); window.dispatchEvent(new CustomEvent('browser-view-refresh')); });
  tabs.push(newTab);
  
  if (activate || tabs.length === 1) {
    switchTab(tabId);
  } else {
    renderTabStrip();
  }
  
  navigateToInTab(newTab, initialUrl, true);
  return newTab;
}

function restoreClosedTab() {
  if (closedTabsStack.length === 0) return;
  const closedTabState = closedTabsStack.pop();
  const newTab = createNewTab(closedTabState.url, true);
  newTab.page.history = closedTabState.history;
  newTab.page.historyIndex = closedTabState.historyIndex;
  updateToolbarUI();
  showToast('Restored closed tab');
}

function switchTab(tabId) {
  activeTabId = tabId;
  tabs.forEach(t => {
    const isTarget = t.id === tabId;
    t.iframe.classList.toggle('active', isTarget);
  });

  renderTabStrip();
  updateToolbarUI();
  const active = getActiveTab();
  if (active) window.dispatchEvent(new CustomEvent('browser-tab-change',{detail:{tab:active,page:active.page}}));
}

function closeTab(tabId, event) {
  if (event) event.stopPropagation();

  const index = tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;

  const tabToRemove = tabs[index];
  window.dispatchEvent(new CustomEvent('browser-tab-closed',{detail:{tab:tabToRemove,page:tabToRemove.page}}));
  const currentUrl = tabToRemove.page.history[tabToRemove.page.historyIndex] || appSettings.defaultTab;

  closedTabsStack.push({
    url: currentUrl,
    history: [...tabToRemove.page.history],
    historyIndex: tabToRemove.page.historyIndex
  });

  tabToRemove.iframe.remove();
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    createNewTab(appSettings.defaultTab);
    return;
  }

  if (activeTabId === tabId) {
    const nextActiveIndex = Math.max(0, index - 1);
    switchTab(tabs[nextActiveIndex].id);
  } else {
    renderTabStrip();
  }
}

function switchTabByIndex(index) {
  if (index >= 0 && index < tabs.length) {
    switchTab(tabs[index].id);
  }
}

function updateLoadingProgress(val) {
  const bar = document.getElementById('loading-progress');
  if (!bar) return;
  bar.style.opacity = '1';
  bar.style.width = val + '%';
  if (val >= 100) {
    setTimeout(() => {
      bar.style.opacity = '0';
      setTimeout(() => { bar.style.width = '0%'; }, 300);
    }, 200);
  }
}

function getActiveTab() {
  return tabs.find(t => t.id === activeTabId);
}

function getTabByIframeWindow(win) {
  return tabs.find(t => t.iframe.contentWindow === win);
}

async function navigateTo(rawUrl, isNewNavigation = true) {
  const activeTab = getActiveTab();
  if (!activeTab) return;
  await navigateToInTab(activeTab, rawUrl, isNewNavigation);
}

async function navigateToInTab(tab, rawUrl, isNewNavigation = true, reloadCurrentTab = true, isReload = false) {
  const startTime = performance.now();
  const hasLoadedDocument = !!tab._hasLoadedDocument;
  let absoluteUrl = rawUrl.trim();
  if (!absoluteUrl.startsWith('http') && !absoluteUrl.startsWith('data:')  && !absoluteUrl.startsWith('blob:')) {
    absoluteUrl = absoluteUrl.includes('.') && !absoluteUrl.includes(' ') ? 'https://' + absoluteUrl : appSettings.searchEngine + encodeURIComponent(absoluteUrl);
  }
  
  tab.url = absoluteUrl;
  window.dispatchEvent(new CustomEvent('browser-before-reload',{detail:{tab,page:tab.page,isReload:!!isReload,isNavigation:hasLoadedDocument,clearDevTools:hasLoadedDocument && appSettings.clearDevToolsOnReload!==false}}));
  window.dispatchEvent(new CustomEvent('browser-navigation-start',{detail:{tab,page:tab.page,url:absoluteUrl}}));

  if (isNewNavigation) {
    tab.page.history = tab.page.history.slice(0, tab.page.historyIndex + 1);
    tab.page.history.push(absoluteUrl);
    tab.page.historyIndex = tab.page.history.length - 1;
    
    historyLog.unshift({ url: absoluteUrl, time: new Date().toLocaleTimeString() });
  }

  if (reloadCurrentTab) {
    updateLoadingProgress(20);
    await renderTabContent(tab, absoluteUrl);
    tab._hasLoadedDocument = true;
    tab.loadTimeMS = Math.floor(performance.now() - startTime);
    updateLoadingProgress(100);
  }


  if (tab.id === activeTabId) {
    updateToolbarUI();
  }
}

async function getDocumentContent(response, url, origin, page) {
  var rawHtml;
  const contentType = response.headers.get('content-type') || 'text/html';
  const title = getFileNameFromURL(url, "Document")
  const ext = title.split('.').pop().toLowerCase();

  // Handle 7z Archives
  if (contentType.includes("application/x-7z-compressed") || ext === "7z") {
    rawHtml = await get7zGalleryDocument(response, url, origin, page);
  } else if (contentType.includes("text/html")) {
    rawHtml = await response.clone().text();
  } else if (contentType.includes("image/")) {
    rawHtml = `<html>
      <head>
        <title>${title}</title>
      </head>
      <body style="margin:0;background:#1e1e1e;">
        <div style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;padding:0;">
          <img src="${await createDataUri(response)}" style="max-width:90%;max-height:90%;object-fit:contain;"/>
        </div>
      </body>
    </html>`;
  } else if (contentType.includes("audio/")) {
    rawHtml = `<html>
      <head>
        <title>${title}</title>
      </head>
      <body style="margin:0;background:#1e1e1e;">
        <div style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;padding:0;">
          <audio controls src="${await createDataUri(response)}"></audio>
        </div>
      </body>
    </html>`;
  } else if (contentType.includes("video/")) {
    rawHtml = `<html>
      <head>
        <title>${title}</title>
      </head>
      <body style="margin:0;background:#1e1e1e;">
        <div style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;padding:0;">
          <video controls style="max-width:90%;max-height:90%;object-fit:contain;">
            <source src="${await createDataUri(response)}" type="${contentType}">
          </video>
        </div>
      </body>
    </html>`;
  } else {
    rawHtml = `<html>
      <head>
        <title>${title}</title>
      </head>
      <body style="margin:0;background:#1e1e1e;">
        <pre style="font-family:monospace;padding:2px;color:#eeeeee;">${sanitizeHTML(await response.clone().text())}</pre>
      </body>
    </html>`;
  }

  return rawHtml;
}
function sanitizeHTML(text) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}
async function get7zGalleryDocument(input, url, origin, page) {
  var iframe = page.iframe;
  function updateProgress(barId, percent, text) {
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      const bar = doc.getElementById(barId);
      const label = doc.getElementById(barId + '-text');
      const percentLabel = doc.getElementById(barId.replace('-bar', '-percent'));
      
      const clamped = Math.min(100, Math.max(0, percent));
      if (bar) bar.style.width = `${clamped}%`;
      if (percentLabel) percentLabel.textContent = `${Math.round(clamped)}%`;
      if (label && text) label.textContent = text;
    } catch (e) {}
  }

  if (iframe) {
    const initialLoadingHtml = `<html>
      <head>
        <title>Loading Archive...</title>
      </head>
      <body style="margin:0; background:#1e1e1e; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; color:#ffffff;">
        <div style="background:#2a2a2a; padding:30px; border-radius:10px; width:360px; box-shadow:0 4px 10px rgba(0,0,0,0.5);">
          <h3 style="margin-top:0; margin-bottom:20px; font-size:16px; text-align:center;">Processing Archive</h3>
          
          <div style="margin-bottom:18px;">
            <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:6px;">
              <span id="download-bar-text">Connecting...</span>
              <span id="download-percent">0%</span>
            </div>
            <div style="background:#1e1e1e; border-radius:4px; height:8px; overflow:hidden;">
              <div id="download-bar" style="background:#0066cc; width:0%; height:100%; transition:width 0.1s linear;"></div>
            </div>
          </div>

          <div>
            <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:6px;">
              <span id="unzip-bar-text">Waiting to extract...</span>
              <span id="unzip-percent">0%</span>
            </div>
            <div style="background:#1e1e1e; border-radius:4px; height:8px; overflow:hidden;">
              <div id="unzip-bar" style="background:#00ff66; width:0%; height:100%; transition:width 0.1s linear;"></div>
            </div>
          </div>
        </div>
      </body>
    </html>`;

    page.setDocument(initialLoadingHtml);
  }

  // 1. Download tracking with precise bytes computation
  let uint8Data;
  if (input instanceof Response) {
    const contentLength = input.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

    if (totalBytes && input.body) {
      const reader = input.body.getReader();
      let receivedLength = 0;
      let chunks = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        
        const percent = (receivedLength / totalBytes) * 100;
        const mbReceived = (receivedLength / (1024 * 1024)).toFixed(1);
        const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);
        updateProgress('download-bar', percent, `Downloading (${mbReceived} / ${mbTotal} MB)`);
      }

      uint8Data = new Uint8Array(receivedLength);
      let position = 0;
      for (let chunk of chunks) {
        uint8Data.set(chunk, position);
        position += chunk.length;
      }
    } else {
      updateProgress('download-bar', 50, 'Downloading file...');
      const buffer = await input.arrayBuffer();
      uint8Data = new Uint8Array(buffer);
    }
    const finalSizeMb = (uint8Data.length / (1024 * 1024)).toFixed(1);
    updateProgress('download-bar', 100, `Download complete (${finalSizeMb} MB)`);
  } else {
    updateProgress('download-bar', 100, 'File loaded into memory');
    uint8Data = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  }

  // 2. Initialize 7z-wasm with stdout interception for real extraction percentages
  await wait(0);
  updateProgress('unzip-bar', 5, 'Initializing runtime...');
  if (!window.SevenZip) {
    let attempts = 0;
    while (!window.SevenZip && attempts < 20) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
  }
  if (!window.SevenZip) {
    throw new Error("Failed to load 7z-wasm runtime module.");
  }

  updateProgress('unzip-bar', 15, 'Starting WebAssembly engine...');
  await wait(0);
  
  let currentFileExtractionCount = 0;
  const sevenZip = await window.SevenZip({
    print: function(text) {
      // 7-Zip stdout reports live progress strings like " 19% 6 - filename.jpg" or standalone digits
      if (text) {
        const match = text.match(/(\d+)%/);
        if (match) {
          const percentVal = parseInt(match[1], 10);
          // Scale extraction portion between 20% and 95% on the progress bar
          const mappedProgress = 20 + (percentVal * 0.75);
          
          // Clean up the text to show the current file being processed nicely
          let statusText = text.trim();
          if (statusText.length > 35) {
            statusText = 'Extracting: ...' + statusText.slice(-30);
          }
          updateProgress('unzip-bar', mappedProgress, statusText);
        }
      }
    },
    printErr: function(text) {
      // Catch potential warnings/errors silently or handle if needed
    }
  });

  let extractedFiles = [];

  try {
    updateProgress('unzip-bar', 18, 'Writing archive to virtual FS...');
    await wait(0);
    const inputPath = '/input_' + Math.random().toString(36).substring(7) + '.7z';
    const outputDir = '/output_' + Math.random().toString(36).substring(7);

    try {
      sevenZip.FS.mkdir(outputDir);
    } catch (e) {}

    sevenZip.FS.writeFile(inputPath, uint8Data);
    
    updateProgress('unzip-bar', 20, 'Extracting files...');
    await wait(0);
    sevenZip.callMain(['x', inputPath, `-o${outputDir}`, '-y']);

    async function readDirRecursive(dirPath, baseDir = dirPath) {
      const entries = sevenZip.FS.readdir(dirPath);
      let files = [];

      for (const entry of entries) {
        if (entry === '.' || entry === '..') continue;
        const fullPath = `${dirPath}/${entry}`;
        const stats = sevenZip.FS.stat(fullPath);

        if (sevenZip.FS.isDir(stats.mode)) {
          files = files.concat(await readDirRecursive(fullPath, baseDir));
        } else if (sevenZip.FS.isFile(stats.mode)) {
          const relativePath = fullPath.substring(baseDir.length + 1);
          const data = sevenZip.FS.readFile(fullPath);
          files.push({
            name: relativePath,
            path: relativePath,
            data: data,
            isDir: false,
            isDirectory: false
          });
        }
      }
      return files;
    }

    updateProgress('unzip-bar', 96, 'Parsing extracted filesystem...');
    await wait(0);
    extractedFiles = await readDirRecursive(outputDir);

    try {
      sevenZip.FS.unlink(inputPath);
    } catch (e) {}
  } catch (err) {
    console.error('7z extraction failed:', err);
    updateProgress('unzip-bar', 100, 'Extraction failed');
    await wait(0);
  }

  updateProgress('unzip-bar', 100, 'Extraction complete');
  await wait(0);

  try {

  // 3. Generate Gallery HTML
  let galleryItemsHtml = '';

  for (const file of extractedFiles) {
    if (file.isDir || file.isDirectory) continue;

    const fileName = (file.name || file.path).split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();
    
    let contentHtml = '';
    
    const blob = new File([file.data], fileName, { type: typeof inferMime === 'function' ? inferMime(fileName) : '' });
    const downloadUrl = URL.createObjectURL(blob)+'#f='+fileName;

    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) {
      contentHtml = `<img src="${downloadUrl}" alt="${fileName}" style="max-width:100%; max-height:180px; object-fit:contain; display:block; margin:auto;" />`;
    } else if (['txt', 'js', 'json', 'html', 'css', 'md', 'log'].includes(ext)) {
      const textDecoder = new TextDecoder();
      const textContent = textDecoder.decode(file.data);
      const safeText = textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      contentHtml = `<pre style="font-family:monospace; font-size:11px; height:180px; overflow:auto; background:#121212; color:#00ff66; padding:8px; margin:0; border-radius:4px;">${safeText}</pre>`;
    } else {
      continue;
    }

    galleryItemsHtml += `
      <div style="background:#2a2a2a; border-radius:8px; padding:12px; display:flex; flex-direction:column; justify-content:space-between; width:220px; box-shadow:0 4px 6px rgba(0,0,0,0.3);">
        <div style="height:180px; display:flex; align-items:center; justify-content:center; overflow:hidden; background:#1e1e1e; border-radius:4px;">
          ${contentHtml}
        </div>
        <div style="margin-top:10px;">
          <p style="color:#ffffff; font-family:sans-serif; font-size:13px; margin:0 0 8px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${fileName}">${fileName}</p>
          <a href="${downloadUrl}" download="${fileName}" style="display:block; text-align:center; background:#0066cc; color:#ffffff; text-decoration:none; padding:6px 12px; border-radius:4px; font-family:sans-serif; font-size:12px; font-weight:bold;">
            Download
          </a>
        </div>
      </div>`;
  }

  if (!galleryItemsHtml) {
    galleryItemsHtml = `<p style="color:#888; font-family:sans-serif;">No supported image or text files found in this archive.</p>`;
  }

  return `<html>
    <head>
      <title>Archive Gallery</title>
    </head>
    <body style="margin:0; background:#1e1e1e; padding:20px;">
      <div style="display:flex; flex-wrap:wrap; gap:16px; justify-content:center;">
        ${galleryItemsHtml}
      </div>
    </body>
  </html>`;
  }catch(e) {alert(e.message)}
}

async function renderTabContent(tab, url) {
  tab.url = url;
  let origin = "https://example.com";
  try { origin = new URL(url).origin; } catch(e) {}

  var response = await tab.page.network.request(url, origin, {
    headers:{
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': origin || 'https://google.com'
    }
  }, 'page-load');
  for (var i = 0; i < 5 && (!response || !response.ok); i++) {
    await wait(i * 1000);
    response = await tab.page.network.request(url, origin, {}, 'page-load');
  }

  if (!response) {
    //tab.iframe.removeAttribute('srcdoc');
    //tab.iframe.src = url;
    tab.iframe.removeAttribute('src');
    tab.iframe.srcdoc = `<div style="font-family: sans-serif; padding: 40px; text-align: center; color: #333;">
      <h2 style="color: #e53e3e;">Proxy Connection Failed</h2>
      <p>Could not load standard URL: <code>${url}</code></p>
      <p style="color: #718096; font-size: 0.9em;">Reason: Most likely blocked</p>
      <button onclick="window.parent.reloadCurrentTab()" style="padding: 8px 16px; background: #5865f2; color: white; border: none; border-radius: 4px; cursor: pointer; margin-top: 10px;">Retry Request</button>
    </div>`;
    return;
  }

  if (!(response instanceof Response) || !response.ok) {
    tab.iframe.removeAttribute('src');
    tab.iframe.srcdoc = `<div style="font-family: sans-serif; padding: 40px; text-align: center; color: #333;">
      <h2 style="color: #e53e3e;">Proxy Connection Failed</h2>
      <p>Could not load standard URL: <code>${url}</code></p>
      <p style="color: #718096; font-size: 0.9em;">Reason: ${response?.message || 'CORS or Proxy Error'}</p>
      <button onclick="window.parent.reloadCurrentTab()" style="padding: 8px 16px; background: #5865f2; color: white; border: none; border-radius: 4px; cursor: pointer; margin-top: 10px;">Retry Request</button>
    </div>`;
    return;
  }

  tab.page.rawDocument = '';
  tab.page.processedDocument = '';
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) tab.page.rawDocument = await response.clone().text();
  } catch(e) {}

  var rawHtml = await getDocumentContent(response, url, origin, tab.page);
  tab.page.setLocation(url, origin);
  await tab.page.setDocument(rawHtml);
  tab.page.processedDocument = rawHtml;
  window.dispatchEvent(new CustomEvent('browser-document-ready',{detail:{tab,page:tab.page,rawDocument:tab.page.rawDocument,processedDocument:rawHtml,url}}));
}


function goBack() {
  const tab = getActiveTab();
  if (tab && tab.page.historyIndex > 0) {
    tab.page.historyIndex--;
    navigateToInTab(tab, tab.page.history[tab.page.historyIndex], false);
  }
}

function goForward() {
  const tab = getActiveTab();
  if (tab && tab.page.historyIndex < tab.page.history.length - 1) {
    tab.page.historyIndex++;
    navigateToInTab(tab, tab.page.history[tab.page.historyIndex], false);
  }
}

async function updateTabMetadata(tab) {
  try {
    const doc = tab.iframe.contentDocument || tab.iframe.contentWindow.document;
    if(doc) {
      const t = doc.querySelector('title');
      tab.title = t ? t.textContent : tab.url;
      const i = doc.querySelector('link[rel*="icon"]');
      if (i && i.href) tab.favicon = i.href;
    }
  } catch(e) {}
  renderTabStrip();
  await refreshBookmarkIcon(tab);
}

function reloadCurrentTab() {
  const tab = getActiveTab();
  if (tab && tab.page.historyIndex >= 0) {
    if (appSettings.clearDevToolsOnReload !== false) {
      try { browserDevTools?.clearForReload(tab.page); } catch(e) {}
    }
    navigateToInTab(tab, tab.page.history[tab.page.historyIndex], false, true, true);
  }
}

function handleUrlSubmit(e) {
  e.preventDefault();
  let inputUrl = document.getElementById('url-bar').value.trim();
  if (inputUrl) navigateTo(inputUrl, true);
}

function renderTabStrip() {
  const container = document.getElementById('tabs-list');
  container.innerHTML = '';

  tabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = `tab ${tab.id === activeTabId ? 'active' : ''}`;
    tabEl.draggable = true;
    tabEl.dataset.tabId = tab.id;
    tabEl.onclick = () => {
      if (!tabEl._wasDragged) switchTab(tab.id);
      tabEl._wasDragged = false;
    };

    tabEl.onauxclick = (e) => {
      if (e.button === 1) closeTab(tab.id, e);
    };

    tabEl.addEventListener('dragstart', (e) => {
      tabEl._wasDragged = false;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.id);
      tabEl.classList.add('dragging');
    });

    tabEl.addEventListener('dragend', () => {
      tabEl.classList.remove('dragging');
      setTimeout(() => { tabEl._wasDragged = false; }, 0);
    });

    tabEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    tabEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData('text/plain');
      if (!draggedId || draggedId === tab.id) return;

      const fromIndex = tabs.findIndex(t => t.id === draggedId);
      const toIndex = tabs.findIndex(t => t.id === tab.id);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

      const [draggedTab] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, draggedTab);
      tabEl._wasDragged = true;
      saveBrowserState();
      renderTabStrip();
    });

    const displayTitle = tab.title || tab.url;

    tabEl.innerHTML = `
      <img class="tab-favicon" src="${tab.favicon}" onerror="this.src=\`${DEFAULT_FAVICON}\`" alt="icon">
      <span class="tab-title" title="${displayTitle}">${displayTitle}</span>
      <span class="tab-close" onclick="closeTab('${tab.id}', event)">✕</span>
    `;
    container.appendChild(tabEl);
  });
}

function updateToolbarUI() {
  const tab = getActiveTab();
  if (!tab) return;

  const currentUrl = tab.page.history[tab.page.historyIndex] || '';
  document.getElementById('url-bar').value = currentUrl;

  const iconEl = document.getElementById('protocol-icon');
  if (currentUrl.startsWith('https://')) {
    iconEl.className = 'fa-solid fa-lock protocol-icon';
  } else if (currentUrl.startsWith('http://')) {
    iconEl.className = 'fa-solid fa-lock-open protocol-icon http';
  } else {
    iconEl.className = 'fa-solid fa-cube protocol-icon local';
  }

  document.getElementById('btn-back').disabled = tab.page.historyIndex <= 0;
  document.getElementById('btn-forward').disabled = tab.page.historyIndex >= tab.page.history.length - 1;

  renderTabStrip();
  updateBookmarkStar();
}

function showBookmarkContextMenu(event,index) {
  const bookmark = bookmarks[index];
  if (!bookmark) return;
  event.preventDefault();
  event.stopPropagation();
  showSimpleContextMenu(event.clientX,event.clientY,[
    {label:'Open',action:() => navigateTo(bookmark.url,true)},
    {label:'Open in New Tab',action:() => createNewTab(bookmark.url,true)},
    {label:'Open in Background Tab',action:() => createNewTab(bookmark.url,false)},
    {type:'separator'},
    {label:'Rename',action:() => {
      const title = prompt('Bookmark name:',bookmark.title || bookmark.url);
      if (title === null) return;
      const value = title.trim();
      if (!value) return;
      bookmark.title = value;
      renderBookmarks();
      saveBrowserState();
    }},
    {label:'Edit URL',action:() => {
      const url = prompt('Bookmark URL:',bookmark.url);
      if (url === null) return;
      const value = url.trim();
      if (!value) return;
      bookmark.url = value;
      bookmark.favicon = DEFAULT_FAVICON;
      bookmark.faviconUrl = bookmark.url;
      renderBookmarks();
      saveBrowserState();
      refreshBookmarkIcon(getActiveTab(),true);
      refreshAllBookmarkIcons();
    }},
    {label:'Copy Link Address',action:() => navigator.clipboard.writeText(bookmark.url)},
    {type:'separator'},
    {label:'Remove Bookmark',action:() => {
      bookmarks.splice(index,1);
      renderBookmarks();
      updateBookmarkStar();
      saveBrowserState();
    }}
  ]);
}

function renderBookmarks() {
  const container = document.getElementById('bookmarks-list');
  if (!container) return;
  const bar = document.getElementById('bookmarks-bar');
  container.innerHTML = '';
  if (bar) bar.style.display = bookmarks.length ? '' : 'none';
  bookmarks.forEach((bm,index) => {
    const btn = document.createElement('button');
    btn.className = 'bookmark-btn';
    btn.draggable = true;
    btn.dataset.bookmarkIndex = index;
    const img = document.createElement('img');
    img.className = 'bookmark-favicon';
    img.width = 14;
    img.height = 14;
    img.src = bm.favicon || DEFAULT_FAVICON;
    img.onerror = () => { img.onerror = null; img.src = DEFAULT_FAVICON; };
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = bm.title || bm.url;
    btn.append(img,label);
    btn.onclick = () => navigateTo(bm.url, true);
    btn.oncontextmenu = e => showBookmarkContextMenu(e,index);
    btn.ondragstart = e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain',String(index));
      btn.classList.add('dragging');
    };
    btn.ondragend = () => btn.classList.remove('dragging');
    btn.ondragover = e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    };
    btn.ondrop = e => {
      e.preventDefault();
      e.stopPropagation();
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = index;
      if (!Number.isInteger(from) || from === to || from < 0 || from >= bookmarks.length) return;
      const [moved] = bookmarks.splice(from,1);
      bookmarks.splice(from < to ? to - 1 : to,0,moved);
      renderBookmarks();
      saveBrowserState();
    };
    container.appendChild(btn);
  });
  container.ondragover = e => e.preventDefault();
  container.ondrop = e => {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (!Number.isInteger(from) || from < 0 || from >= bookmarks.length) return;
    const [moved] = bookmarks.splice(from,1);
    bookmarks.push(moved);
    renderBookmarks();
    saveBrowserState();
  };
}

async function refreshBookmarkIcon(tab, force=false) {
  if (!tab?.url) return;
  const bm = bookmarks.find(b => b.url === tab.url);
  if (!bm) return;
  try {
    if (!force && tab.faviconUrl === tab.url && typeof tab.favicon === 'string' && tab.favicon && tab.favicon !== DEFAULT_FAVICON) {
      bm.favicon = tab.favicon;
      bm.faviconUrl = tab.url;
      renderBookmarks();
      saveBrowserState();
      return;
    }
    const doc = tab.iframe?.contentDocument || tab.iframe?.contentWindow?.document || null;
    let iconUrl = '';
    if (doc) {
      const iconEl = doc.querySelector('link[rel*="icon"]');
      if (iconEl) iconUrl = iconEl.getAttribute('data-raw-src') || iconEl.getAttribute('href') || '';
    }
    let baseUrl = tab.url;
    try { baseUrl = new URL(tab.url).href; } catch(e) {}
    let origin = 'https://example.com';
    try { origin = new URL(baseUrl).origin; } catch(e) {}
    if (!iconUrl) iconUrl = new URL('/favicon.ico',baseUrl).href;
    else iconUrl = new URL(iconUrl,baseUrl).href;

    if (tab.faviconUrl === tab.url && tab.favicon === DEFAULT_FAVICON && !iconUrl) {
      bm.favicon = DEFAULT_FAVICON;
      bm.faviconUrl = bm.url;
      renderBookmarks();
      saveBrowserState();
      return;
    }
    if (!force && bm.favicon && bm.favicon !== DEFAULT_FAVICON && bm.faviconUrl === bm.url) return;
    const file = await tab.page?.network?.request(iconUrl,origin,{},'bookmark-favicon');
    const icon = file ? await createDataUri(file) : null;
    if (icon) {
      bm.favicon = icon;
      bm.faviconUrl = bm.url;
    } else {
      bm.favicon = DEFAULT_FAVICON;
      bm.faviconUrl = bm.url;
    }
  } catch(e) {
    bm.favicon = bm.favicon && bm.faviconUrl === bm.url ? bm.favicon : DEFAULT_FAVICON;
    bm.faviconUrl = bm.url;
  }
  renderBookmarks();
  saveBrowserState();
}

window.refreshBookmarkIcon = refreshBookmarkIcon;
window.refreshAllBookmarkIcons = refreshAllBookmarkIcons;

async function refreshAllBookmarkIcons(force=false) {
  const active = getActiveTab();
  for (const bm of bookmarks) {
    const tab = tabs.find(t => t.url === bm.url) || (active?.url === bm.url ? active : null);
    if (tab) await refreshBookmarkIcon(tab,force);
    else if (force || !bm.favicon) {
      try {
        const url = new URL(bm.url);
        const file = await browserNetwork.request(new URL('/favicon.ico',url).href,url.origin,{},'bookmark-favicon');
        const icon = file ? await createDataUri(file) : null;
        if (icon) bm.favicon = icon;
      } catch(e) {}
      if (!bm.favicon) bm.favicon = DEFAULT_FAVICON;
    }
  }
  renderBookmarks();
  saveBrowserState();
}

function updateBookmarkStar() {
  const tab = getActiveTab();
  const star = document.getElementById('bookmark-star');
  if (!tab || !star) return;
  
  const isBookmarked = bookmarks.some(b => b.url === tab.url);
  star.className = isBookmarked ? 'fa-solid fa-star text-yellow-400' : 'fa-regular fa-star text-gray-400';
}

function toggleBookmarkCurrent() {
  const tab = getActiveTab();
  if (!tab) return;

  const idx = bookmarks.findIndex(b => b.url === tab.url);
  if (idx >= 0) {
    bookmarks.splice(idx, 1);
    showToast('Removed from bookmarks');
  } else {
    bookmarks.push({ title: tab.title || tab.url, url: tab.url, favicon: tab.favicon || DEFAULT_FAVICON, faviconUrl: tab.url });
    showToast('Added to bookmarks!', 'success');
    refreshBookmarkIcon(tab,true);
  }
  renderBookmarks();
  updateBookmarkStar();
}

function renderHistoryLog() {
  const container = document.getElementById('history-log-list');
  container.innerHTML = '';
  if (historyLog.length === 0) {
    container.innerHTML = '<div class="text-xs text-gray-500 italic p-2">No browsing history recorded yet.</div>';
    return;
  }
  historyLog.forEach(item => {
    const div = document.createElement('div');
    div.className = 'p-2 bg-gray-800 border border-gray-700 rounded flex justify-between items-center text-xs hover:bg-gray-750 cursor-pointer';
    div.innerHTML = `<span class="truncate text-indigo-300 font-mono">${item.url}</span> <span class="text-gray-500 text-[10px]">${item.time}</span>`;
    div.onclick = () => {
      navigateTo(item.url, true);
      closeModal('history-modal');
    };
    container.appendChild(div);
  });
}

function clearHistoryLog() {
  historyLog = [];
  renderHistoryLog();
  showToast('Browsing history cleared');
}

function updateSettings() {
  appSettings.primaryProxy = String(window.WorkerConfig?.proxy || '');
  document.getElementById('setting-default-tab').value = appSettings.defaultTab;
  document.getElementById('setting-proxy-url').value = appSettings.primaryProxy;
  document.getElementById('setting-fallback-proxy-url').value = appSettings.fallbackProxy;
  document.getElementById('setting-search-engine').value = appSettings.searchEngine;
  document.getElementById('setting-fallback-enable').checked = appSettings.useFallback;
  document.getElementById('setting-obscure-url').checked = appSettings.obscureURL;
  document.getElementById('setting-clear-devtools-reload').checked = appSettings.clearDevToolsOnReload;
  document.getElementById('setting-autodownload').checked = appSettings.autoDownload;
  updateNetworkSettings();
}

function saveSettings() {
  appSettings.defaultTab = document.getElementById('setting-default-tab').value;
  appSettings.primaryProxy = String(window.WorkerConfig?.proxy || '');
  appSettings.fallbackProxy = document.getElementById('setting-fallback-proxy-url').value;
  appSettings.searchEngine = document.getElementById('setting-search-engine').value;
  appSettings.useFallback = document.getElementById('setting-fallback-enable').checked;
  appSettings.obscureURL = document.getElementById('setting-obscure-url').checked;
  appSettings.clearDevToolsOnReload = document.getElementById('setting-clear-devtools-reload').checked;
  appSettings.autoDownload = document.getElementById('setting-autodownload').checked;
  try { setStorageItem('appSettings',appSettings); } catch (_) {}
  saveBrowserState();
  updateNetworkSettings();
  closeModal('settings-modal');
  showToast('Settings updated', 'success');
}

// Browser embedding/startup contract.
// Standalone pages use ?start=...; the editor uses ?defer=1 so the runtime
// endpoint can be installed before the first navigation.
let browserStartupDeferred = browserQuery.get('defer') === '1' || browserQuery.get('defer') === 'true';

function normalizeBrowserStartupUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(?:data|blob):/i.test(value)) return value;
  if (value.includes('.') && !value.includes(' ')) return 'https://' + value;
  return value;
}

function getStartupUrl() {
  const configuredDefault = browserQuery.get('default');
  const configuredStart = browserQuery.get('start');
  if (configuredDefault) {
    const normalizedDefault = normalizeBrowserStartupUrl(configuredDefault);
    if (normalizedDefault) appSettings.defaultTab = normalizedDefault;
  }
  return normalizeBrowserStartupUrl(configuredStart) || appSettings.defaultTab;
}

function setBrowserDefaultTab(url) {
  const normalized = normalizeBrowserStartupUrl(url) || appSettings.defaultTab || 'https://example.com';
  appSettings.defaultTab = normalized;
  try { updateSettings(); } catch (_) {}
  try { setStorageItem('appSettings', appSettings); } catch (_) {}
  return normalized;
}

async function loadBrowserURL(url = appSettings.defaultTab, activate = true) {
  const normalized = normalizeBrowserStartupUrl(url) || appSettings.defaultTab;
  let tab = getActiveTab();
  if (!tab) tab = createNewTab(normalized, activate);
  else await navigateToInTab(tab, normalized, true);
  return tab;
}

window.getStartupUrl = getStartupUrl;
window.setBrowserDefaultTab = setBrowserDefaultTab;
window.setBrowserChromeHidden = setBrowserChromeHidden;
window.loadBrowserURL = loadBrowserURL;
window.getAIBrowserOutput = function(options={}) {
  var records = window.__aiBrowserOutput || [];
  var tabId = options.tabId || null;
  var out = tabId ? records.filter(function(x){ return x.tabId === tabId; }) : records;
  return out.slice(-(Number(options.limit) || 100));
};
window.clearAIBrowserOutput = function(){ window.__aiBrowserOutput = []; };

function aiSerializeValue(value, depth=0, seen=new WeakSet()) {
  if (value === undefined) return '[undefined]';
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value) + 'n';
  if (typeof value === 'function') return String(value);
  if (depth > 3) return '[Object]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (value.outerHTML) return String(value.outerHTML).slice(0, 30000);
      if (Array.isArray(value)) return value.slice(0, 100).map(v => aiSerializeValue(v, depth + 1, seen));
      const out = {};
      for (const key of Object.keys(value).slice(0, 100)) {
        try { out[key] = aiSerializeValue(value[key], depth + 1, seen); } catch (_) { out[key] = '[Unreadable]'; }
      }
      return out;
    } finally { seen.delete(value); }
  }
  return String(value);
}

window.getAIBrowserTabs = function() {
  return tabs.map((tab, index) => ({
    id: tab.id,
    index,
    active: tab.id === activeTabId,
    title: String(tab.title || ''),
    url: String(tab.url || tab.page?.history?.[tab.page.historyIndex] || '')
  }));
};
window.openAIBrowserTab = function(url, activate=true) {
  return createNewTab(String(url || appSettings.defaultTab), activate !== false)?.id || null;
};
window.switchAIBrowserTab = function(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) throw new Error('Browser tab not found: ' + tabId);
  switchTab(tab.id);
  return {id:tab.id,title:tab.title,url:tab.url,active:true};
};
window.navigateAIBrowserTab = async function(tabId, url) {
  const tab = tabs.find(t => t.id === tabId) || getActiveTab();
  if (!tab) throw new Error('No browser tab is available.');
  await navigateToInTab(tab, String(url || ''), true);
  return {id:tab.id,title:tab.title,url:tab.url};
};
window.closeAIBrowserTab = function(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) throw new Error('Browser tab not found: ' + tabId);
  closeTab(tab.id);
  return {closed:tab.id};
};
window.reloadAIBrowserTab = async function(tabId) {
  const tab = tabs.find(t => t.id === tabId) || getActiveTab();
  if (!tab) throw new Error('No browser tab is available.');
  await navigateToInTab(tab, tab.url || appSettings.defaultTab, false, true, true);
  return {id:tab.id,url:tab.url,reloaded:true};
};
window.getAIBrowserHTML = function(tabId, maxChars=100000) {
  const tab = tabs.find(t => t.id === tabId) || getActiveTab();
  if (!tab?.iframe?.contentDocument?.documentElement) throw new Error('Browser tab has no rendered document yet.');
  const html = String(tab.iframe.contentDocument.documentElement.outerHTML || '');
  const limit = Math.max(1000, Math.min(500000, Number(maxChars) || 100000));
  return {id:tab.id,url:tab.url,title:tab.title,html:html.slice(0,limit),truncated:html.length>limit,totalLength:html.length};
};
window.runAIBrowserConsole = async function(tabId, code) {
  const tab = tabs.find(t => t.id === tabId) || getActiveTab();
  if (!tab?.page?.runCommand) throw new Error('Browser tab console is not available.');
  const text = String(code || '').trim();
  if (!text) throw new Error('Console command is empty.');
  const result = await tab.page.runCommand(text);
  return {id:tab.id,code:text,value:aiSerializeValue(result?.value),result:aiSerializeValue(result)};
};

setBrowserChromeHidden(browserChromeFullscreen);

// Global Key Bindings Handler (F12, DevTools, Ctrl Shortcuts)
installBrowserChromeInteractions();

window.addEventListener('keydown', function(e) {
  if (e.key === 'F11') {
    e.preventDefault();
    toggleBrowserFullscreen();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase();
    if (e.shiftKey && key === 't') { e.preventDefault(); restoreClosedTab(); return; }
    if (key === 't' && !e.shiftKey) { e.preventDefault(); createNewTab(appSettings.defaultTab, true); return; }
    if (key === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); return; }
    if (key === 'r') { e.preventDefault(); reloadCurrentTab(); return; }
    if (key === 'l') { e.preventDefault(); const b = document.getElementById('url-bar'); b.focus(); b.select(); return; }
    if (key >= '1' && key <= '9') { e.preventDefault(); switchTabByIndex(key === '9' ? tabs.length - 1 : parseInt(key, 10) - 1); return; }
  }
});

async function initializeDeployment() {
  const d = window.__deploymentConfig;
  if (!d?.repo) return;
  const parsed = new URL(d.repo);
  if (parsed.hostname !== 'github.com') throw new Error('Deployment repository must be a GitHub repository.');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Invalid GitHub deployment repository.');
  const owner = parts[0], repo = parts[1].replace(/\.git$/,'');
  let fs = null;
  const downloadRevision = async ref => {
    const archiveUrl = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${encodeURIComponent(ref).replace(/%2F/g,'/')}`;
    const archive = await browserNetwork.request(archiveUrl, undefined, {}, 'deployment');
    if (!archive?.ok) throw new Error('GitHub deployment download failed.');
    return await FileSystem.create(new File([await archive.blob()], `${repo}.zip`, {type:'application/zip'}), {sync:false});
  };
  fs = await downloadRevision(d.commit && d.commit !== 'latest' ? d.commit : (d.branch || 'main'));
  let meta = {}, run = {};
  try { meta = JSON.parse(fs.readFileSync('.editor/project.json','utf8') || '{}'); } catch (_) {}
  try { run = JSON.parse(fs.readFileSync('.editor/config.json','utf8') || '{}'); } catch (_) {}
  const saved = meta.deployment && typeof meta.deployment === 'object' ? meta.deployment : {};
  if (d.commit !== 'latest' && !d.commit && saved.commit) {
    fs = await downloadRevision(saved.commit);
    try { meta = JSON.parse(fs.readFileSync('.editor/project.json','utf8') || '{}'); } catch (_) {}
    try { run = JSON.parse(fs.readFileSync('.editor/config.json','utf8') || '{}'); } catch (_) {}
  }
  const usePeerServer = d.peerServer === null ? !!(meta.deployment?.usePeerServer) : !!d.peerServer;
  if (usePeerServer) { try { browserNetwork.prependEndpoint(new PeerEndpoint()); } catch (e) { console.warn('Peer network unavailable:', e); } }
  const target = d.url || saved.url || `${run.domain || 'http://localhost:3000'}${run.path || '/'}`;
  const targetUrl = new URL(target);
  const rootfolder = String(run.rootfolder || '/').replace(/^\/+|\/+$/g,'');
  const runfile = '/' + String(run.runfile || '/index.html').replace(/^\/+/, '');
  let endpoint;
  if (run.serverType === 'node') {
    const emulator = new NodeEmulator({domain:targetUrl.origin, rootfolder, pathPrefix:targetUrl.pathname === '/' ? '/' : targetUrl.pathname.replace(/\/$/,''), filesystem:fs, fileSystemSync:false, network:browserNetwork, env:{NODE_ENV:'production',USER:'browser_user'}});
    endpoint = emulator.endpoint;
    if (run.nodeCommand) await emulator.terminalCommand(run.nodeCommand);
    const ready = await emulator.waitForServer?.(10000,50);
    if (ready === false) throw new Error('Node deployment did not create a listening server.');
  } else {
    endpoint = new StaticEndpoint({domain:targetUrl.origin, path:targetUrl.pathname === '/' ? '/' : targetUrl.pathname.replace(/\/$/,''), rootfolder, runfile, source:fs});
    await endpoint.loading;
  }
  if (usePeerServer) {
    const layer = String(d.peerLayer || meta.peerLayer || 'peer').trim() || 'peer';
    const server = await ensurePeerServer(targetUrl.origin, async()=>endpoint, {peerLayer:layer});
    window.__deploymentPeerServer = server;
  }
  browserNetwork.prependEndpoint(endpoint);
  appSettings.defaultTab = targetUrl.href;
}

const startupTab = getStartupUrl();
if (window.__deploymentConfig) {
  (async()=>{try { await initializeDeployment(); if (!browserStartupDeferred) createNewTab(appSettings.defaultTab || startupTab); } catch(e) { console.error(e); document.title='Deployment Error'; const el=document.createElement('pre'); el.textContent=String(e?.stack||e); el.style.cssText='padding:24px;color:#ddd;background:#111;white-space:pre-wrap;font:13px monospace'; document.body.appendChild(el); }} )();
} else if (!browserStartupDeferred) createNewTab(startupTab);
renderBookmarks();
refreshAllBookmarkIcons();
updateToolbarUI();

function inferMime(name) {
  if (name == "LICENSE") return "text/plain";
  const ext = name.split('.').pop()?.toLowerCase();
  const map = {
    'txt':'text/plain',
    'md':'text/markdown',
    'js':'text/javascript',
    'ts':'text/typescript',
    'json':'application/json',
    'html':'text/html',
    'css':'text/css',
    'png':'image/png',
    'jpg':'image/jpeg',
    'jpeg':'image/jpeg',
    'gif':'image/gif',
    'webp':'image/webp',
    'avif':'image/avif',
    'hdr':'image/vnd.radiance',
    'exr':'image/x-exr',
    'svg':'image/svg+xml',
    'mp3':'audio/mpeg',
    'wav':'audio/wav',
    'ogg':'audio/ogg',
    'mp4':'video/mp4',
    'webm':'video/webm',
    'obj':'model/obj',
    'fbx':'model/x-fbx',
    'glb':'model/gltf-binary',
    'gltf':'model/gltf+json',
    'mtl':'text/plain',
    'frag':'text/x-hlsl',
    'vert':'text/x-hlsl',
    'hlsl':'text/x-hlsl',
    'fx':'text/x-hlsl',
    'wgsl':'text/wgsl',
    'py':'text/x-python',
    'c':'text/x-c',
    'cpp':'text/x-c'
  };
  return map[ext]||'application/octet-stream';
}

(function forceV8ErrorPolyfillForSafari() {
  // Test if the current environment's captureStackTrace supports prepareStackTrace (V8 behavior)
  var supportsV8StackAPI = false;
  if (typeof Error.captureStackTrace === 'function') {
    var testObj = {};
    var originalPrep = Error.prepareStackTrace;
    
    // Set a dummy formatter to see if the engine triggers it
    Error.prepareStackTrace = function() { return ['mock-frame']; };
    try {
      Error.captureStackTrace(testObj);
      if (Array.isArray(testObj.stack) && testObj.stack[0] === 'mock-frame') {
        supportsV8StackAPI = true;
      }
    } catch (e) {}
    
    // Restore original property
    Error.prepareStackTrace = originalPrep;
  }

  // If the engine behaves fully like V8, we do not need to patch it
  if (supportsV8StackAPI) return;

  // --- Force Override/Polyfill for Safari ---
  Error.stackTraceLimit = Error.stackTraceLimit || 10;
  Error.prepareStackTrace = Error.prepareStackTrace || null;

  Error.captureStackTrace = function (targetObject, constructorOpt) {
    // Force a dummy error instantiation to parse the clean raw text stack
    var dummyError = new Error();
    var rawStack = dummyError.stack || '';

    Object.defineProperty(targetObject, 'stack', {
      configurable: true,
      enumerable: true,
      get: function () {
        // If a V8 custom formatter is attached, process into mock CallSites
        if (typeof Error.prepareStackTrace === 'function') {
          var mockCallSites = parseSafariStackToCallSites(rawStack, constructorOpt);
          
          if (mockCallSites.length > Error.stackTraceLimit) {
            mockCallSites = mockCallSites.slice(0, Error.stackTraceLimit);
          }
          return Error.prepareStackTrace(targetObject, mockCallSites);
        }
        // Otherwise, fall back to Safari's default text trace
        return rawStack;
      }
    });
  };

  // Helper: Parses Safari string layout into structured V8-like CallSite frames
  function parseSafariStackToCallSites(stackString, constructorOpt) {
    var lines = stackString.split('\n');
    var frames = [];
    var skipFrames = !!constructorOpt;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      // Extract details from Safari line format: "functionName@URL:line:column"
      var atIndex = line.indexOf('@');
      var functionName = atIndex > -1 ? line.substring(0, atIndex) : '';
      var urlAndCoords = atIndex > -1 ? line.substring(atIndex + 1) : line;

      var lastColon = urlAndCoords.lastIndexOf(':');
      var secondToLastColon = urlAndCoords.lastIndexOf(':', lastColon - 1);
      
      var fileName = urlAndCoords;
      var lineNumber = null;
      var columnNumber = null;

      if (secondToLastColon > -1 && lastColon > -1) {
        fileName = urlAndCoords.substring(0, secondToLastColon);
        lineNumber = parseInt(urlAndCoords.substring(secondToLastColon + 1, lastColon), 10);
        columnNumber = parseInt(urlAndCoords.substring(lastColon + 1), 10);
      }

      // Drop utility/wrapper trace frames if requested by user configuration
      if (constructorOpt && skipFrames) {
        if (functionName === constructorOpt.name) {
          skipFrames = false; 
        }
        continue;
      }

      // Build mock V8 CallSite instance mapping
      frames.push({
        getFileName: (function(f) { return function() { return f; }; })(fileName),
        getLineNumber: (function(l) { return function() { return l; }; })(lineNumber),
        getColumnNumber: (function(c) { return function() { return c; }; })(columnNumber),
        getFunctionName: (function(n) { return function() { return n || null; }; })(functionName),
        getMethodName: (function(n) { return function() { return n || null; }; })(functionName),
        getTypeName: function() { return null; },
        getThis: function() { return undefined; },
        isNative: function() { return false; },
        isConstructor: function() { return false; },
        isEval: function() { return false; }
      });
    }

    // Default cleanup fallback if constructor target trace frame was not matched
    return (constructorOpt || frames.length < 2) ? frames : frames.slice(2);
  }
})();

(function() {
  const root = window.GitHubService = window.GitHubService || {};
  const API = 'https://api.github.com';
  const API_VERSION = '2026-03-10';
  const TOKEN_SESSION_KEY = 'editor.github.token.session';
  const TOKEN_LOCAL_KEY = 'editor.github.token';
  const USER_SESSION_KEY = 'editor.github.user.session';
  const USER_LOCAL_KEY = 'editor.github.user';
  const REMEMBER_KEY = 'editor.github.remember';
  const PENDING_KEY = 'editor.github.oauth.pending';
  const listeners = new Set();
  let user = null;

  function b64url(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function randomString(bytes = 32) {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return b64url(data);
  }
  async function sha256Base64Url(text) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return b64url(new Uint8Array(hash));
  }
  function getConfig() {
    const workerUrl = String(window.WorkerConfig?.github || '').trim();
    return {workerUrl: workerUrl.replace(/\/$/, '')};
  }
  function setConfig() {
    return getConfig();
  }
  function getRemember() {
    try { return localStorage.getItem(REMEMBER_KEY) === '1'; } catch (_) { return false; }
  }
  function setRemember(value) {
    const next = !!value;
    const currentRemember = getRemember();
    try {
      const from = currentRemember ? localStorage : sessionStorage;
      const to = next ? localStorage : sessionStorage;
      const fromTokenKey = currentRemember ? TOKEN_LOCAL_KEY : TOKEN_SESSION_KEY;
      const fromUserKey = currentRemember ? USER_LOCAL_KEY : USER_SESSION_KEY;
      const toTokenKey = next ? TOKEN_LOCAL_KEY : TOKEN_SESSION_KEY;
      const toUserKey = next ? USER_LOCAL_KEY : USER_SESSION_KEY;
      const token = from.getItem(fromTokenKey);
      const profile = from.getItem(fromUserKey);
      localStorage.setItem(REMEMBER_KEY, next ? '1' : '0');
      if (token) to.setItem(toTokenKey, token);
      if (profile) to.setItem(toUserKey, profile);
      if (from !== to) { from.removeItem(fromTokenKey); from.removeItem(fromUserKey); }
      user = profile ? JSON.parse(profile) : user;
    } catch (_) {}
    notify();
  }
  function loadStoredAuth() {
    const remember = getRemember();
    const storage = remember ? localStorage : sessionStorage;
    const token = storage.getItem(remember ? TOKEN_LOCAL_KEY : TOKEN_SESSION_KEY);
    if (!token) return false;
    try { user = JSON.parse(storage.getItem(remember ? USER_LOCAL_KEY : USER_SESSION_KEY) || 'null'); } catch (_) { user = null; }
    return !!token;
  }
  function clearStoredAuth() {
    try { localStorage.removeItem(TOKEN_LOCAL_KEY); localStorage.removeItem(USER_LOCAL_KEY); sessionStorage.removeItem(TOKEN_SESSION_KEY); sessionStorage.removeItem(USER_SESSION_KEY); } catch (_) {}
    user = null;
  }
  function getToken() {
    const remember = getRemember();
    return (remember ? localStorage.getItem(TOKEN_LOCAL_KEY) : sessionStorage.getItem(TOKEN_SESSION_KEY)) || '';
  }
  function storeAuth(token, profile, remember) {
    clearStoredAuth();
    setRemember(remember);
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem(remember ? TOKEN_LOCAL_KEY : TOKEN_SESSION_KEY, token);
    storage.setItem(remember ? USER_LOCAL_KEY : USER_SESSION_KEY, JSON.stringify(profile || null));
    user = profile || null;
    notify();
  }
  function notify() { for (const listener of [...listeners]) { try { listener(user); } catch (_) {} } }
  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function isSignedIn() { return !!getToken(); }
  function getUser() { return user; }
  function workerUrl() { return getConfig().workerUrl; }
  async function startLogin() {
    const worker = workerUrl();
    if (!worker) throw new Error('Set the GitHub authentication Worker URL in Profile first.');
    const verifier = randomString(48);
    const state = randomString(24);
    const challenge = await sha256Base64Url(verifier);
    const pending = {state, verifier, createdAt: Date.now()};
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    const redirect = new URL(location.href);
    redirect.search = '';
    redirect.hash = '';
    const url = new URL(worker + '/login');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirect.href);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    const popup = window.open(url.href, 'github-auth', 'popup,width=520,height=720,resizable=yes,scrollbars=yes');
    if (!popup) location.href = url.href;
  }
  function cleanupCallbackUrl() {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      url.searchParams.delete('error');
      url.searchParams.delete('error_description');
      history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    } catch (_) {}
  }
  async function completeLogin(code, state) {
    const pendingRaw = localStorage.getItem(PENDING_KEY);
    let pending = null;
    try { pending = JSON.parse(pendingRaw || 'null'); } catch (_) {}
    if (!pending || pending.state !== state) throw new Error('GitHub sign-in state did not match. Please try again.');
    if (Date.now() - Number(pending.createdAt || 0) > 10 * 60 * 1000) throw new Error('GitHub sign-in expired. Please try again.');
    const response = await fetch(workerUrl() + '/exchange', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({code, code_verifier: pending.verifier})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error(data.error || data.message || `GitHub token exchange failed (${response.status}).`);
    const profile = await request('/user', {token: data.access_token});
    storeAuth(data.access_token, profile, getRemember());
    localStorage.removeItem(PENDING_KEY);
    cleanupCallbackUrl();
    return profile;
  }
  async function handleOAuthCallback() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');
    if (!code && !error) return false;
    if (window.opener && window.opener !== window) {
      try {
        window.opener.postMessage({type:'github-oauth-callback', code, state, error, errorDescription: params.get('error_description') || ''}, location.origin);
      } catch (_) {}
      setTimeout(() => window.close(), 150);
      return true;
    }
    if (error) {
      cleanupCallbackUrl();
      throw new Error(params.get('error_description') || `GitHub sign-in failed: ${error}`);
    }
    await completeLogin(code, state);
    return true;
  }
  async function init() {
    loadStoredAuth();
    window.removeEventListener('message', root._messageHandler || (() => {}));
    root._messageHandler = async event => {
      if (event.origin !== location.origin || event.data?.type !== 'github-oauth-callback') return;
      try {
        if (event.data.error) throw new Error(event.data.errorDescription || `GitHub sign-in failed: ${event.data.error}`);
        await completeLogin(event.data.code, event.data.state);
      } catch (e) {
        console.error(e);
        window.dispatchEvent(new CustomEvent('github-auth-error', {detail: e}));
      }
    };
    window.addEventListener('message', root._messageHandler);
    try { await handleOAuthCallback(); } catch (e) { console.error(e); window.dispatchEvent(new CustomEvent('github-auth-error', {detail: e})); }
    return user;
  }
  async function request(path, options = {}) {
    const token = options.token || getToken();
    if (!token) throw new Error('Not signed in to GitHub.');
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', API_VERSION);
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(API + path, {...options, headers});
    if (response.status === 401) {
      clearStoredAuth();
      notify();
      throw new Error('GitHub authentication expired. Sign in again from Profile.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data?.message || `GitHub API request failed (${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }
  async function listRepositories() {
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const items = await request(`/user/repos?per_page=100&page=${page}&affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&direction=desc`);
      if (!Array.isArray(items)) break;
      all.push(...items);
      if (items.length < 100) break;
    }
    return all.filter(repo => repo && repo.full_name).map(repo => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner?.login || repo.full_name.split('/')[0],
      private: !!repo.private,
      defaultBranch: repo.default_branch || 'main',
      permissions: repo.permissions || {},
      updatedAt: repo.updated_at || ''
    }));
  }
  async function getRepository(owner, repo) { return request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`); }
  function branchPath(branch) { return String(branch || 'main').split('/').filter(Boolean).map(encodeURIComponent).join('/'); }
  async function listBranches(owner, repo) {
    const branches = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`);
    return Array.isArray(branches) ? branches.map(x => x.name).filter(Boolean) : [];
  }
  async function getBranchCommit(owner, repo, branch) {
    const ref = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${branchPath(branch)}`);
    return ref?.object?.sha || null;
  }
  async function getRemoteState(owner, repo, branch) {
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    try {
      const ref = await request(`${repoPath}/git/ref/heads/${branchPath(branch)}`);
      const commitSha = ref?.object?.sha || null;
      if (!commitSha) return {commitSha:null, treeSha:null, tree:[]};
      const commit = await request(`${repoPath}/git/commits/${encodeURIComponent(commitSha)}`);
      const treeSha = commit?.tree?.sha || null;
      if (!treeSha) return {commitSha, treeSha:null, tree:[]};
      const tree = await request(`${repoPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
      return {commitSha, treeSha, tree:Array.isArray(tree?.tree) ? tree.tree : [], truncated:!!tree?.truncated};
    } catch (e) {
      if (e?.status === 404) return {commitSha:null, treeSha:null, tree:[], empty:true};
      throw e;
    }
  }
  async function listCommits(owner, repo, branch, count = 20) {
    const items = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch || 'main')}&per_page=${Math.min(100, Math.max(1, count))}`);
    return Array.isArray(items) ? items.map(item => ({
      sha: item.sha,
      message: String(item.commit?.message || '').split(/\r?\n/, 1)[0],
      author: item.author?.login || item.commit?.author?.name || 'Unknown',
      date: item.commit?.author?.date || item.commit?.committer?.date || '',
      url: item.html_url || ''
    })) : [];
  }
  async function gitBlobSha(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(header.length + bytes.length);
    all.set(header, 0); all.set(bytes, header.length);
    const hash = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
  }
  function ignoredPath(path) {
    const p = String(path || '').replace(/^\/+/, '');
    return p === '.editor' || p.startsWith('.editor/') || p === '.git' || p.startsWith('.git/') || p === 'node_modules' || p.startsWith('node_modules/');
  }
  async function compareWorkingTree(fs, remoteTree) {
    if (!fs) throw new Error('No workspace filesystem is open.');
    const localPaths = fs.listFilesSync().map(path => String(path).replace(/^\/+/, '')).filter(path => path && !ignoredPath(path));
    const remoteFiles = new Map();
    for (const entry of remoteTree || []) if (entry?.type === 'blob' && entry.path && !ignoredPath(entry.path)) remoteFiles.set(entry.path, entry);
    const changes = [];
    for (const path of localPaths) {
      const data = fs.readFileSync(path, 'binary');
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
      const sha = await gitBlobSha(bytes);
      const remote = remoteFiles.get(path);
      if (!remote) changes.push({path, type:'added', sha, data:bytes});
      else if (remote.sha !== sha) changes.push({path, type:'modified', sha, data:bytes, mode:remote.mode || '100644'});
      remoteFiles.delete(path);
    }
    for (const [path, entry] of remoteFiles) changes.push({path, type:'deleted', sha:null, mode:entry.mode || '100644'});
    const order = {modified:0, added:1, deleted:2};
    changes.sort((a,b) => (order[a.type] - order[b.type]) || a.path.localeCompare(b.path));
    return changes;
  }
  async function createBlob(owner, repo, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    if (bytes.byteLength > 95 * 1024 * 1024) throw new Error(`File is too large for the GitHub API: ${bytes.byteLength.toLocaleString()} bytes.`);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    return request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, {
      method:'POST',
      body:JSON.stringify({content:btoa(binary), encoding:'base64'})
    });
  }
  async function withConcurrency(items, limit, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({length:Math.min(limit, items.length)}, run));
    return out;
  }
  async function commitAndPush({owner, repo, branch, message, fs}) {
    message = String(message || '').trim();
    if (!message) throw new Error('Enter a commit message.');
    const remote = await getRemoteState(owner, repo, branch);
    const changes = await compareWorkingTree(fs, remote.tree);
    if (!changes.length) return {changed:false, changes:[], commitSha:remote.commitSha};
    const blobs = await withConcurrency(changes.filter(x => x.type !== 'deleted'), 4, async change => ({path:change.path, mode:change.mode || '100644', type:'blob', sha:(await createBlob(owner, repo, change.data)).sha}));
    const treeEntries = [...blobs, ...changes.filter(x => x.type === 'deleted').map(change => ({path:change.path, mode:change.mode || '100644', type:'blob', sha:null}))];
    const treeBody = {tree:treeEntries};
    if (remote.treeSha) treeBody.base_tree = remote.treeSha;
    const tree = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, {method:'POST', body:JSON.stringify(treeBody)});
    const commitBody = {message, tree:tree.sha};
    if (remote.commitSha) commitBody.parents = [remote.commitSha];
    const commit = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, {method:'POST', body:JSON.stringify(commitBody)});
    const refPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${branchPath(branch)}`;
    if (remote.commitSha) await request(refPath, {method:'PATCH', body:JSON.stringify({sha:commit.sha, force:false})});
    else await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {method:'POST', body:JSON.stringify({ref:`refs/heads/${branch}`, sha:commit.sha})});
    return {changed:true, changes, commitSha:commit.sha};
  }
  root.init = init;
  root.onChange = onChange;
  root.getConfig = getConfig;
  root.setConfig = setConfig;
  root.getRemember = getRemember;
  root.setRemember = setRemember;
  root.getToken = getToken;
  root.getUser = getUser;
  root.isSignedIn = isSignedIn;
  root.startLogin = startLogin;
  root.signOut = () => { localStorage.removeItem(PENDING_KEY); clearStoredAuth(); notify(); };
  root.request = request;
  root.listRepositories = listRepositories;
  root.getRepository = getRepository;
  root.listBranches = listBranches;
  root.getRemoteState = getRemoteState;
  root.getBranchCommit = getBranchCommit;
  root.listCommits = listCommits;
  root.compareWorkingTree = compareWorkingTree;
  root.commitAndPush = commitAndPush;
  root.gitBlobSha = gitBlobSha;
})();

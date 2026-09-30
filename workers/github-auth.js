const GITHUB_SCOPE = 'repo read:user user:email';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }
});

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function packState(state, redirectUri) {
  return b64urlEncode(JSON.stringify({s: state, r: redirectUri}));
}
function unpackState(value) {
  try {
    const data = JSON.parse(b64urlDecode(value));
    if (!data?.s || !data?.r) return null;
    const redirect = new URL(data.r);
    if (!/^https?:$/.test(redirect.protocol) && !/^file:$/.test(redirect.protocol)) return null;
    return {state: String(data.s), redirectUri: redirect.href};
  } catch (_) { return null; }
}
function getRedirectUri(value) {
  try {
    const redirect = new URL(String(value || ''));
    if (!/^(https?:|file:)$/i.test(redirect.protocol)) return '';
    redirect.hash = redirect.hash || '';
    return redirect.href;
  } catch (_) { return ''; }
}
function redirectToEditor(redirectUri, params) {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') target.searchParams.set(key, value);
  }
  return Response.redirect(target.href, 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const clientId = String(env.GITHUB_CLIENT_ID).trim();
    if (!clientId || clientId === 'YOUR_GITHUB_CLIENT_ID') return new Response('Set GITHUB_CLIENT_ID in wrangler.toml.', {status:500});

    if (path === '/health') return json({ok:true});

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status:204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (path === '/login' && request.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const codeChallenge = url.searchParams.get('code_challenge') || '';
      const method = url.searchParams.get('code_challenge_method') || '';
      const redirectUri = getRedirectUri(url.searchParams.get('redirect_uri'));
      if (!state || !codeChallenge || method !== 'S256' || !redirectUri) return new Response('Missing or invalid OAuth parameters.', {status:400});
      const callback = new URL('/callback', url.origin).href;
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('redirect_uri', callback);
      authorize.searchParams.set('state', packState(state, redirectUri));
      authorize.searchParams.set('code_challenge', codeChallenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      authorize.searchParams.set('scope', GITHUB_SCOPE);
      return Response.redirect(authorize.href, 302);
    }

    if (path === '/callback' && request.method === 'GET') {
      const packedState = url.searchParams.get('state') || '';
      const packed = unpackState(packedState);
      if (!packed) return new Response('Invalid or missing OAuth state.', {status:400});
      const error = url.searchParams.get('error');
      if (error) return redirectToEditor(packed.redirectUri, {error, error_description:url.searchParams.get('error_description') || '', state:packed.state});
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing GitHub callback code.', {status:400});
      return redirectToEditor(packed.redirectUri, {code, state:packed.state});
    }

    if (path === '/exchange' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({error:'Invalid JSON.'}, 400); }
      const code = String(body?.code || '');
      const verifier = String(body?.code_verifier || '');
      if (!code || !verifier) return json({error:'Missing code or PKCE verifier.'}, 400);
      const callback = new URL('/callback', url.origin).href;
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method:'POST',
        headers:{'Accept':'application/json','Content-Type':'application/json'},
        body:JSON.stringify({client_id:clientId, client_secret:env.GITHUB_CLIENT_SECRET, code, redirect_uri:callback, code_verifier:verifier})
      });
      const data = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || data.error || !data.access_token) return json({error:data.error_description || data.error || `GitHub token exchange failed (${tokenResponse.status}).`}, 502);
      return json({access_token:data.access_token, token_type:data.token_type, scope:data.scope, expires_in:data.expires_in, refresh_token:data.refresh_token, refresh_token_expires_in:data.refresh_token_expires_in});
    }

    return new Response('Not found.', {status:404});
  }
};
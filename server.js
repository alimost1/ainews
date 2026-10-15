#!/usr/bin/env node
// /root/ianews/server.js — Facebook OAuth + Auto-Post Backend
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Generation dashboard API (job queue) — compiled from src/pipeline.
let dashboardApi;
try {
  dashboardApi = require('./dist/pipeline/dashboard.js').handleDashboardApi;
  require('./dist/pipeline/dashboard.js').initDashboard();
  console.log('✅ Generation dashboard mounted at /dashboard');
} catch (e) {
  console.warn('⚠️ Dashboard not built (run: npx tsc -p tsconfig.dashboard.json):', e.message.split('\n')[0]);
  dashboardApi = null;
}

// Property avatar presentation API — compiled from src/pipeline.
let propertyApi;
try {
  propertyApi = require('./dist/pipeline/property-api.js').handlePropertyApi;
  const pInit = require('./dist/pipeline/property-api.js').initPropertyApi();
  console.log('✅ Property presentation mounted at /property (resumed: ' + pInit.resumed + ')');
} catch (e) {
  console.warn('⚠️ Property API not built (run: npx tsc -p tsconfig.dashboard.json):', e.message.split('\n')[0]);
  propertyApi = null;
}

const PORT = 8090;
const PROJECT = process.env.IANEWS_PROJECT_ROOT || __dirname;

// ─── Config ──────────────────────────────────────────────────────────
// Load secrets from .env file (never hardcode in source)
const _envPath = path.join(PROJECT, '.env');
const _env = {};
if (fs.existsSync(_envPath)) {
  const _lines = fs.readFileSync(_envPath, 'utf-8').split(/\r?\n/);
  for (const _l of _lines) {
    const _line = _l.trim();
    if (_line && !_line.startsWith('#') && _line.includes('=')) {
      const [_k, ..._v] = _line.split('=');
      _env[_k.trim()] = _v.join('=').trim();
      // Expose pipeline-relevant variables to process.env so compiled modules
      // (ElevenLabs/Higgsfield checks) see them without a separate env loader.
      if (_k.trim() && !process.env[_k.trim()]) process.env[_k.trim()] = _v.join('=').trim();
    }
  }
}
const FB_APP_ID = _env.FB_APP_ID || process.env.FB_APP_ID || '';
const FB_APP_SECRET = _env.FB_APP_SECRET || process.env.FB_APP_SECRET || '';
// Public base URL of this server. Configure PUBLIC_BASE_URL for production
// deployments; OAuth callbacks must be registered with the provider anyway.
const PUBLIC_BASE_URL = (_env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:8090').replace(/\/$/, '');
function _httpsRedirect(path) { return (PUBLIC_BASE_URL.startsWith('https://') ? PUBLIC_BASE_URL + '/' + path : PUBLIC_BASE_URL + '/' + path); }
const FB_REDIRECT_URI = (_env.FB_REDIRECT_URI || process.env.FB_REDIRECT_URI || _httpsRedirect('auth/facebook/callback'));
const SCOPES = 'pages_manage_posts,pages_read_engagement,publish_video,instagram_basic,instagram_content_publish';

const TOKEN_FILE = path.join(PROJECT, 'data', 'fb_tokens.json');
let tokens = { pageToken: null, pageId: null, userToken: null, pageName: null, allPages: [] };

try {
  if (fs.existsSync(TOKEN_FILE)) {
    tokens = { ...tokens, ...JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) };
    console.log('✅ Loaded saved FB tokens');
  }
} catch (e) {}

function saveTokens() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('💾 Tokens saved');
}

// ─── HTTP helpers ────────────────────────────────────────────────────
function httpsGet(getUrl) {
  return new Promise((resolve, reject) => {
    https.get(getUrl, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    }).on('error', reject);
  });
}

function httpsPost(postUrl, data, binaryFile) {
  return new Promise((resolve, reject) => {
    const u = new URL(postUrl);
    let body, contentType, contentLen;
    
    if (binaryFile) {
      body = binaryFile;
      contentType = 'application/octet-stream';
      contentLen = Buffer.byteLength(binaryFile);
    } else if (Buffer.isBuffer(data)) {
      body = data;
      contentType = 'application/octet-stream';
      contentLen = data.length;
    } else {
      body = new URLSearchParams(data).toString();
      contentType = 'application/x-www-form-urlencoded';
      contentLen = Buffer.byteLength(body);
    }

    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': contentLen },
    }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Facebook API helpers ───────────────────────────────────────────
// Safe GET via https module with URL-encoded params — never shell interpolation.
function graphRequest(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Facebook API: invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Facebook API: request timeout')); });
  });
}
async function exchangeCodeForToken(code) {
  console.log('🔄 Exchanging code for token...');
  const params = new URLSearchParams({
    client_id: FB_APP_ID, client_secret: FB_APP_SECRET,
    redirect_uri: FB_REDIRECT_URI, code,
  });
  return graphRequest(`https://graph.facebook.com/v21.0/oauth/access_token?${params}`);
}

async function exchangeForLongLivedToken(shortLivedToken) {
  console.log('🔄 Exchanging for long-lived token...');
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: FB_APP_ID,
    client_secret: FB_APP_SECRET, fb_exchange_token: shortLivedToken,
  });
  return graphRequest(`https://graph.facebook.com/v21.0/oauth/access_token?${params}`);
}

async function getUserPages(userToken) {
  console.log('📄 Fetching user pages...');
  return graphRequest('https://graph.facebook.com/v21.0/me/accounts' +
    '?fields=name,access_token,instagram_business_account&access_token=' + encodeURIComponent(userToken));
}

async function switchToPage(userToken, pageId) {
  const pages = await getUserPages(userToken);
  if (pages.data) {
    const page = pages.data.find(p => p.id === pageId);
    if (page) {
      tokens.pageToken = page.access_token;
      tokens.pageId = page.id;
      tokens.pageName = page.name;
      saveTokens();
      console.log(`✅ Switched to: ${page.name} (${page.id})`);
      return page;
    }
  }
  return null;
}

async function uploadVideoToPage(pageId, pageToken, videoPath, description) {
  const uploadUrl = `https://graph-video.facebook.com/v21.0/${pageId}/videos`;
  console.log('📤 Uploading video to Facebook...');

  return new Promise((resolve, reject) => {
    const boundary = '----iAnews' + Date.now();
    const fileData = fs.readFileSync(videoPath);

    // Build multipart form data manually
    const parts = [];
    // access_token
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${pageToken}\r\n`);
    // description
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n${description}\r\n`);
    // published
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="published"\r\n\r\ntrue\r\n`);
    // source (file)
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);

    const header = Buffer.from(parts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const u = new URL(uploadUrl);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        console.log('Upload response:', d.substring(0, 300));
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  console.log(`${req.method} ${pathname}`);

  if (pathname === '/auth/facebook') {
    // CSRF protection: random state cookie, verified on callback
    const crypto = require('crypto');
    const fbState = crypto.randomBytes(16).toString('hex');
    res.writeHead(302, {
      'Set-Cookie': `ianews_fb_state=${fbState}; Path=/auth/facebook; HttpOnly; Max-Age=600; SameSite=Lax`,
      Location: `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(FB_APP_ID)}&redirect_uri=${encodeURIComponent(FB_REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&state=${fbState}&auth_type=rerequest`,
    });
    res.end();
    return;
  }

  if (pathname === '/auth/facebook/callback') {
    const code = parsed.query.code;
    const fbState = parsed.query.state;
    const cookieHeader = String(req.headers.cookie || '');
    const stateMatch = cookieHeader.match(/ianews_fb_state=([a-f0-9]{32})/);
    if (!fbState || !stateMatch || stateMatch[1] !== fbState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Invalid OAuth state — restart the connection flow.</h1>');
      return;
    }
    const error = parsed.query.error;
    const errorReason = parsed.query.error_reason;
    const errorDesc = parsed.query.error_description;
    
    if (error) { 
      console.log('FB OAuth error:', error, errorReason, errorDesc);
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); 
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth Error</title><style>body{font-family:Arial;background:#0f0c29;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:rgba(255,255,255,0.1);padding:40px;border-radius:16px;text-align:center;max-width:500px}h1{color:#ef4444}p{color:#aaa}</style></head><body><div class="card"><h1>❌ Facebook Error</h1><p>${errorDesc || errorReason || error}</p><p style="margin-top:20px;font-size:0.9em">This often happens if the auth link expired. Please try again.</p><a href="${PUBLIC_BASE_URL}" style="display:inline-block;margin-top:20px;padding:12px 30px;background:linear-gradient(135deg,#1877f2,#42a5f5);color:#fff;text-decoration:none;border-radius:25px">← Try Again</a></div></body></html>`); 
      return; 
    }
    if (!code) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end('<h1>❌ No code</h1>'); return; }

    // Log the full query for debugging
    console.log('Callback query:', JSON.stringify(parsed.query));
    
    // Unescape the code if needed (Facebook sometimes URL-encodes it)
    const cleanCode = decodeURIComponent(code);

    try {
      console.log('Exchanging code (first 20 chars):', code.substring(0, 20) + '...');
      const tokenRes = await exchangeCodeForToken(code);
      console.log('Token response:', JSON.stringify(tokenRes).substring(0, 500));
      if (tokenRes.error) {
        console.error('Token exchange error:', JSON.stringify(tokenRes.error));
        throw new Error(tokenRes.error.message || JSON.stringify(tokenRes.error));
      }

      const longLived = await exchangeForLongLivedToken(tokenRes.access_token);
      console.log('Long-lived:', JSON.stringify(longLived).substring(0, 300));
      tokens.userToken = longLived.access_token || tokenRes.access_token;

      const pagesRes = await getUserPages(tokens.userToken);
      console.log('Pages:', JSON.stringify(pagesRes).substring(0, 500));

      if (pagesRes.data && pagesRes.data.length > 0) {
        tokens.allPages = pagesRes.data;
        tokens.pageToken = pagesRes.data[0].access_token;
        tokens.pageId = pagesRes.data[0].id;
        tokens.pageName = pagesRes.data[0].name;
        saveTokens();
        console.log(`✅ Connected: ${tokens.pageName} (${tokens.pageId})`);
      }

      // Build page selector HTML
      const pageOptions = (pagesRes.data || []).map(p =>
        `<option value="${p.id}" ${p.id === tokens.pageId ? 'selected' : ''}>${p.name} (${p.id})</option>`
      ).join('');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>✅ Connected</title><style>body{font-family:Arial;background:#0f0c29;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:rgba(255,255,255,0.1);padding:40px;border-radius:16px;text-align:center;max-width:500px}h1{color:#4ade80}select{background:#1a1a2e;color:#fff;border:1px solid #333;padding:10px 15px;border-radius:8px;font-size:1em;width:100%;margin:15px 0}.btn{display:inline-block;margin-top:20px;padding:12px 30px;background:linear-gradient(135deg,#1877f2,#42a5f5);color:#fff;text-decoration:none;border-radius:25px;border:none;cursor:pointer;font-size:1em}</style></head><body><div class="card"><h1>✅ تم الربط بنجاح!</h1><p>Select the page to post to:</p><form action="/auth/facebook/switch" method="POST" id="switchForm"><select name="pageId">${pageOptions}</select><br><button type="submit" class="btn">✅ Confirm Page</button></form><br><a href="${PUBLIC_BASE_URL}" class="btn" style="background:#444">← Back</a></div><script>document.getElementById('switchForm').addEventListener('submit',function(e){e.preventDefault();const fd=new FormData(this);fetch('/auth/facebook/switch',{method:'POST',body:fd}).then(r=>r.json()).then(d=>{if(d.success){window.location.href='dashboard';}else{alert('Error: '+(d.error||'Unknown'))}})});</script></body></html>`);
    } catch (err) {
      console.error('❌', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>❌ Error</h1><p>${err.message}</p>`);
    }
    return;
  }

  // Google OAuth - generate auth URL
  if (pathname === '/auth/google') {
    const GCLIENT_ID = _env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
    const GREDIRECT = _httpsRedirect('auth/google/callback');
    const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
    const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${GCLIENT_ID}&redirect_uri=${encodeURIComponent(GREDIRECT)}&response_type=code&scope=${encodeURIComponent(SCOPE)}&access_type=offline&prompt=consent&include_granted_scopes=true`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // Google OAuth callback for YouTube
  if (pathname === '/auth/google/callback') {
    const code = parsed.query.code;
    const error = parsed.query.error;
    if (error) {
      console.log('Google OAuth error:', error);
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Error: ${error}</h1>`);
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>No code</h1>');
      return;
    }

    try {
      console.log('Google OAuth code received, exchanging...');
      const GCLIENT_ID = _env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
      const GCLIENT_SECRET = _env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
      const GREDIRECT = _httpsRedirect('auth/google/callback');
      const tokenData = await new Promise((resolve, reject) => {
        const body = new URLSearchParams({
          code: String(code || ''), client_id: GCLIENT_ID, client_secret: GCLIENT_SECRET,
          redirect_uri: GREDIRECT, grant_type: 'authorization_code',
        }).toString();
        const u = new URL('https://oauth2.googleapis.com/token');
        const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
          timeout: 30000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Google OAuth: invalid JSON')); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Google OAuth: timeout')); });
        req.write(body); req.end();
      });

      if (tokenData.error) {
        console.log('Token error:', tokenData.error);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Token error: ${tokenData.error}</h1>`);
        return;
      }

      const fs = require('fs');
      const path = require('path');
      const tokenPath = path.join('/root/.config/google', 'youtube_token.json');
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      // Add client_id and client_secret for token refresh
      tokenData.client_id = GCLIENT_ID;
      tokenData.client_secret = GCLIENT_SECRET;
      fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
      console.log('YouTube token saved!');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Done</title><style>body{font-family:Arial;background:#0f0c29;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:rgba(255,255,255,0.1);padding:40px;border-radius:16px;text-align:center}h1{color:#4ade80}p{color:#aaa}</style></head><body><div class="card"><h1>✅ YouTube Connected!</h1><p>You can close this window. Videos will now auto-upload to YouTube.</p></div></body></html>');
    } catch (err) {
      console.error('Google token exchange error:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Error</h1><p>${err.message}</p>`);
    }
    return;
  }

  // Switch page
  if (pathname === '/auth/facebook/switch' && req.method === 'POST') {
    if (!tokens.userToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated — reconnect first' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const params = new URLSearchParams(body);
        const pageId = params.get('pageId');
        if (!pageId) throw new Error('No pageId');
        const page = await switchToPage(tokens.userToken, pageId);
        if (!page) throw new Error('Page not found or no access');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pageName: page.name, pageId: page.id }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Disconnect
  if (pathname === '/api/disconnect') {
    tokens = { pageToken: null, pageId: null, userToken: tokens.userToken, pageName: null, allPages: [] };
    saveTokens();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // List pages
  if (pathname === '/api/pages') {
    if (!tokens.userToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }
    try {
      const pagesRes = await getUserPages(tokens.userToken);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pages: pagesRes.data || [], current: tokens.pageId }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/post-video' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const videoPath = data.videoPath || path.join(PROJECT, 'output', 'video_final.mp4');
        const description = data.description || '';
        // Allow overriding target page (e.g. for health videos → Mawtini)
        const postPageToken = data.pageToken || tokens.pageToken;
        const postPageId = data.pageId || tokens.pageId;

        if (!postPageToken || !postPageId) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not authenticated' }));
          return;
        }
        if (!fs.existsSync(videoPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Video file not found' }));
          return;
        }

        const targetName = data.pageId ? `custom page (${postPageId})` : `${tokens.pageName} (${tokens.pageId})`;
        console.log(`📤 Posting to ${targetName}...`);
        const result = await uploadVideoToPage(postPageId, postPageToken, videoPath, description);
        console.log('Result:', JSON.stringify(result).substring(0, 300));

        if (result.error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, video_id: result.video_id }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    let igAccount = null;
    if (tokens.pageId && tokens.pageToken) {
      try {
        const d = await graphRequest('https://graph.facebook.com/v21.0/' + encodeURIComponent(tokens.pageId) +
          '?fields=instagram_business_account&access_token=' + encodeURIComponent(tokens.pageToken));
        if (d.instagram_business_account) igAccount = d.instagram_business_account.id;
      } catch (e) {}
    }
    res.end(JSON.stringify({
      connected: !!(tokens.pageToken && tokens.pageId),
      pageId: tokens.pageId,
      pageName: tokens.pageName,
      instagramAccount: igAccount,
    }));
    return;
  }

  // YouTube status
  if (pathname === '/api/yt-status') {
    const fs = require('fs');
    const tokenPath = '/root/.config/google/youtube_token.json';
    let connected = false;
    if (fs.existsSync(tokenPath)) {
      try {
        const td = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        connected = !!td.refresh_token;
      } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connected }));
    return;
  }


  // ─── Generation dashboard ──────────────────────────────────────────
  if (pathname === '/dashboard' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(PROJECT, 'public', 'dashboard.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if ((pathname.startsWith('/api/jobs') || pathname === '/api/config' || pathname === '/api/queue')) {
    if (!dashboardApi) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Dashboard not built. Run: npm run build:dashboard' }));
      return;
    }
    try {
      const handled = await dashboardApi(req, res);
      if (handled) return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Dashboard error' }));
      return;
    }
  }

  // ─── Property avatar presentation ─────────────────────────────────
  if (pathname === '/property' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(PROJECT, 'public', 'property.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (pathname.startsWith('/api/property/')) {
    if (!propertyApi) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Property API not built. Run: npm run build:dashboard' }));
      return;
    }
    try {
      const handled = await propertyApi(req, res);
      if (handled) return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Property API error' }));
      return;
    }
  }
  // Per-job media for Higgsfield fetches (avatar portraits + narration audio):
  // /media/prop/<jobId>/<sub...> restricted to data/prop-jobs/<jobId>/...
  const propMediaMatch = pathname.match(/^\/media\/prop\/([a-zA-Z0-9-]+)\/(avatar|audio|photos|scenes)\/([a-zA-Z0-9_.-]+\.(mp3|mp4|png|jpg))$/);
  if (propMediaMatch && req.method === 'GET') {
    const jobId = propMediaMatch[1];
    const sub = propMediaMatch[2];
    const file = propMediaMatch[3];
    if (file.includes('..')) { res.writeHead(403); res.end(); return; }
    const baseDir = path.join(PROJECT, 'data', 'prop-jobs', jobId, 'render', 'public', sub);
    const filePath = path.join(baseDir, file);
    if (!path.resolve(filePath).startsWith(path.resolve(baseDir) + path.sep) || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const mime = { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fs.statSync(filePath).size, 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  // Presenter portraits: /media/prop/<jobId>/presenter.png
  const presenterMatch = pathname.match(/^\/media\/prop\/([a-zA-Z0-9-]+)\/presenter\.png$/);
  if (presenterMatch && req.method === 'GET') {
    const filePath = path.join(PROJECT, 'data', 'prop-jobs', presenterMatch[1], 'presenter.png');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': fs.statSync(filePath).size, 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    res.writeHead(404); res.end(); return;
  }

  // ─── Static media serving (for Higgsfield audio_url/image_url inputs) ─
  // /media/<file> serves /root/ainews/public/media/<file>
  if (pathname.startsWith('/media/')) {
    const MEDIA_DIR = path.join(PROJECT, 'public', 'media');
    const rel = decodeURIComponent(pathname.slice('/media/'.length)).replace(/(\.\.|\/)/g, '');
    const f = path.join(MEDIA_DIR, rel);
    if (rel && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f).toLowerCase();
      const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4' }[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': fs.statSync(f).size,
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(f).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  res.writeHead(302, { Location: PUBLIC_BASE_URL + '/dashboard' });
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 iAnews Facebook Backend on port ${PORT}\n`);
});

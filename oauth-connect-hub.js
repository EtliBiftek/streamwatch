'use strict';

const http = require('http');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, net, safeStorage, shell } = require('electron');
const Store = require('electron-store');
const { spawn } = require('child_process');
const BrowserManager = require('./src/browser-manager');

const store = new Store();
const HUB_PORTS = [37650, 37652, 37653, 37654];
const KICK_CALLBACK_PORT = 37651;
const YOUTUBE_SCOPES = 'openid profile https://www.googleapis.com/auth/youtube.readonly';
const TWITCH_SCOPES = 'user:read:follows';
const KICK_SCOPES = 'user:read channel:read';
const PLATFORM_NAMES = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };

let hubServer = null;
let hubPort = null;
let kickCallbackServer = null;
const hubSessions = new Map();
const activeFlows = new Set();

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat|hesabını bağla/i.test(win.getTitle())) || null;
}

function emitState(payload = null) {
  const win = mainWindow();
  if (!win || win.webContents.isDestroyed()) return;
  win.webContents.send('oauth-accounts-state', payload);
}

function selectedProfileId(browserKey) {
  const prefs = store.get('selectedBrowserProfiles');
  if (!prefs || typeof prefs !== 'object') return null;
  const value = prefs[browserKey];
  return typeof value === 'object' ? value?.id || null : value || null;
}

function selectedBrowserExecutable(browserKey) {
  if (!browserKey) return null;
  try {
    return new BrowserManager().getAvailableBrowsers().find((item) => item.key === browserKey)?.path || null;
  } catch {
    return null;
  }
}

async function openInSelectedBrowser(url) {
  const browserKey = store.get('selectedBrowser');
  const executable = selectedBrowserExecutable(browserKey);
  const profileId = selectedProfileId(browserKey);
  if (!executable) {
    await shell.openExternal(url);
    return;
  }

  const args = [];
  if (profileId && profileId !== '.' && browserKey !== 'firefox' && browserKey !== 'opera') {
    args.push(`--profile-directory=${profileId}`);
  }
  args.push(url);
  try {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch {
    await shell.openExternal(url);
  }
}

function rawConfig() {
  const value = store.get('oauthAccountsConfig');
  return value && typeof value === 'object' ? value : {};
}

function decrypt(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('safe:')) return '';
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'));
  } catch {
    return '';
  }
}

function encrypt(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows güvenli depolama kullanılamıyor.');
  return `safe:${safeStorage.encryptString(String(value)).toString('base64')}`;
}

function readToken(platform) {
  const raw = decrypt(store.get(`oauthAccountToken.${platform}`));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function writeToken(platform, token) {
  store.set(`oauthAccountToken.${platform}`, encrypt(JSON.stringify(token)));
}

function configured(platform) {
  const cfg = rawConfig();
  if (platform === 'youtube') return Boolean(cfg.youtubeClientId);
  if (platform === 'twitch') return Boolean(cfg.twitchClientId);
  if (platform === 'kick') return Boolean(cfg.kickClientId && decrypt(cfg.kickClientSecret));
  return false;
}

function profileSummary(profile) {
  if (!profile) return null;
  return {
    id: profile.id || null,
    username: profile.username || profile.name || null,
    displayName: profile.displayName || profile.username || profile.name || null,
    avatarUrl: profile.avatarUrl || null,
  };
}

function status() {
  const accounts = {};
  for (const platform of Object.keys(PLATFORM_NAMES)) {
    const token = readToken(platform);
    accounts[platform] = {
      configured: configured(platform),
      connected: Boolean(token?.accessToken),
      profile: profileSummary(token?.profile),
      busy: activeFlows.has(platform),
    };
  }
  return { accounts };
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makePkce() {
  const verifier = base64url(crypto.randomBytes(64)).slice(0, 96);
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function randomState() {
  return base64url(crypto.randomBytes(32));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseJson(response) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    const message = data.error_description || data.message || data.error || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return data;
}

async function postForm(url, values) {
  const body = new URLSearchParams();
  Object.entries(values || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
  });
  return responseJson(await net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }));
}

async function getJson(url, headers = {}) {
  return responseJson(await net.fetch(url, { headers }));
}

function tokenExpiry(data) {
  const seconds = Number(data.expires_in || 0);
  return seconds > 0 ? Date.now() + seconds * 1000 : null;
}

async function fetchYouTubeProfile(accessToken) {
  let user = null;
  let channel = null;
  try {
    user = await getJson('https://openidconnect.googleapis.com/v1/userinfo', { Authorization: `Bearer ${accessToken}` });
  } catch { }
  try {
    const result = await getJson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { Authorization: `Bearer ${accessToken}` });
    channel = Array.isArray(result.items) ? result.items[0] : null;
  } catch { }
  const snippet = channel?.snippet || {};
  return {
    id: channel?.id || user?.sub || null,
    username: snippet.customUrl || snippet.title || user?.name || 'YouTube hesabı',
    displayName: snippet.title || user?.name || 'YouTube hesabı',
    avatarUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || user?.picture || null,
  };
}

async function fetchTwitchProfile(accessToken, clientId) {
  const result = await getJson('https://api.twitch.tv/helix/users', {
    Authorization: `Bearer ${accessToken}`,
    'Client-Id': clientId,
  });
  const user = Array.isArray(result.data) ? result.data[0] : null;
  if (!user) throw new Error('Twitch kullanıcı bilgisi alınamadı.');
  return {
    id: user.id || null,
    username: user.login || user.display_name || 'Twitch hesabı',
    displayName: user.display_name || user.login || 'Twitch hesabı',
    avatarUrl: user.profile_image_url || null,
  };
}

async function fetchKickProfile(accessToken) {
  const result = await getJson('https://api.kick.com/public/v1/users', {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  });
  const list = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
  const user = list[0] || result.user || null;
  if (!user) throw new Error('Kick kullanıcı bilgisi alınamadı.');
  return {
    id: String(user.user_id || user.id || ''),
    username: user.username || user.slug || user.name || 'Kick hesabı',
    displayName: user.username || user.name || user.slug || 'Kick hesabı',
    avatarUrl: user.profile_picture || user.profile_pic || user.profile_picture_url || user.avatar || null,
  };
}

function htmlEscape(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function sendHtml(res, code, html, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(html);
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function redirect(res, url) {
  res.writeHead(302, {
    Location: url,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end();
}

function completionHtml(platform, ok, detail) {
  const name = PLATFORM_NAMES[platform] || platform;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamWatch Connect</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090d;color:#f7f7fa;font-family:Inter,system-ui,sans-serif}.box{width:min(540px,calc(100% - 32px));padding:30px;border:1px solid ${ok ? '#2f6d52' : '#70343d'};border-radius:22px;background:#121218;box-shadow:0 30px 90px #0009}.k{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#8d8d99}.t{font-size:24px;font-weight:800;margin:8px 0}.d{color:#aaaab5;line-height:1.6}.ok{color:#8ce6b7}.bad{color:#ffb2bc}</style></head><body><main class="box"><div class="k">StreamWatch Connect</div><div class="t ${ok ? 'ok' : 'bad'}">${htmlEscape(name)} ${ok ? 'bağlandı' : 'bağlanamadı'}</div><div class="d">${htmlEscape(detail)}<br><br>Bu sekmeyi kapatıp StreamWatch’a dönebilirsin.</div></main></body></html>`;
}

function hubHtml(sessionToken) {
  const state = status();
  const cards = Object.entries(PLATFORM_NAMES).map(([platform, name]) => {
    const info = state.accounts[platform] || {};
    const profile = info.profile?.displayName || info.profile?.username || '';
    const connected = info.connected;
    const ready = info.configured;
    const subtitle = connected ? `${profile || 'Hesap'} bağlı` : ready ? 'Resmî izin sayfasına yönlendir' : 'OAuth uygulama bilgisi gerekli';
    const label = connected ? 'Yeniden bağla' : 'Hesabı bağla';
    return `<article class="card" data-platform="${platform}"><div class="brand ${platform}">${name === 'YouTube' ? 'YT' : name === 'Twitch' ? 'TW' : 'K'}</div><div class="meta"><strong>${name}</strong><span data-state>${htmlEscape(subtitle)}</span></div><a class="connect ${!ready ? 'disabled' : ''}" ${ready ? `href="/start/${platform}?t=${encodeURIComponent(sessionToken)}"` : 'aria-disabled="true"'}>${label}</a></article>`;
  }).join('');

  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamWatch Connect</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 10%,#31214955,transparent 35%),radial-gradient(circle at 85% 85%,#183b3a44,transparent 35%),#08080c;color:#f7f7fa;font-family:Inter,ui-sans-serif,system-ui,sans-serif}.wrap{width:min(820px,calc(100% - 32px));margin:0 auto;padding:70px 0}.eyebrow{color:#9b8cad;font-size:12px;text-transform:uppercase;letter-spacing:.14em;font-weight:800}.title{font-size:clamp(32px,6vw,58px);line-height:1.02;margin:12px 0 14px;letter-spacing:-.04em}.lead{color:#a8a8b4;max-width:680px;line-height:1.65;font-size:15px}.panel{margin-top:32px;padding:12px;border:1px solid #292932;border-radius:24px;background:#111117cc;box-shadow:0 30px 100px #0008;backdrop-filter:blur(16px)}.card{display:grid;grid-template-columns:54px 1fr auto;align-items:center;gap:16px;padding:16px;border-radius:17px}.card+.card{border-top:1px solid #24242c}.brand{width:54px;height:54px;border-radius:15px;display:grid;place-items:center;font-weight:900;letter-spacing:-.04em;background:#202028}.brand.youtube{background:#2a1517}.brand.twitch{background:#201832}.brand.kick{background:#172817}.meta{display:flex;flex-direction:column;gap:4px}.meta strong{font-size:16px}.meta span{color:#8f8f9b;font-size:13px}.connect{display:inline-flex;align-items:center;justify-content:center;min-width:142px;height:42px;padding:0 16px;border-radius:12px;background:#f2f2f5;color:#101014;text-decoration:none;font-weight:800;font-size:13px;transition:.15s}.connect:hover{transform:translateY(-1px);background:#fff}.connect.disabled{opacity:.35;pointer-events:none}.note{margin-top:18px;color:#777784;font-size:12px;line-height:1.6}.secure{display:inline-flex;gap:7px;align-items:center;margin-top:18px;color:#92929d;font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:#63d39a}@media(max-width:620px){.wrap{padding:38px 0}.card{grid-template-columns:50px 1fr}.brand{width:50px;height:50px}.connect{grid-column:1/-1;width:100%}}</style></head><body><main class="wrap"><div class="eyebrow">StreamWatch Connect</div><h1 class="title">Hesaplarını tek yerden bağla.</h1><div class="lead">Platformu seç. StreamWatch seni doğrudan YouTube, Twitch veya Kick’in resmî izin sayfasına yönlendirsin. Tarayıcı hesabın açıksa yalnızca <strong>İzin Ver / Authorize</strong> demen yeterli.</div><section class="panel">${cards}</section><div class="secure"><span class="dot"></span>Tarayıcı eklentisi yok • çerez okunmaz • parola StreamWatch’a gelmez</div><div class="note">Bir platform “OAuth uygulama bilgisi gerekli” diyorsa StreamWatch geliştirici OAuth ayarlarının henüz girilmediği anlamına gelir. Son kullanıcı bu bilgileri girmez; uygulama sahibi bir kez yapılandırır.</div></main><script>const token=${JSON.stringify(sessionToken)};async function refresh(){try{const r=await fetch('/api/status?t='+encodeURIComponent(token),{cache:'no-store'});if(!r.ok)return;const s=await r.json();for(const [p,i] of Object.entries(s.accounts||{})){const card=document.querySelector('[data-platform="'+p+'"]');if(!card)continue;const text=card.querySelector('[data-state]');if(i.connected){text.textContent=(i.profile?.displayName||i.profile?.username||'Hesap')+' bağlı';}else if(i.busy){text.textContent='İzin bekleniyor…';}else{text.textContent=i.configured?'Bağlanmaya hazır':'OAuth uygulama bilgisi gerekli';}}}catch{}}setInterval(refresh,1800);refresh();</script></body></html>`;
}

function validSession(token) {
  const entry = hubSessions.get(String(token || ''));
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    hubSessions.delete(String(token || ''));
    return false;
  }
  return true;
}

function createCallbackServer({ port = 0, path, host = '127.0.0.1', timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let finish;
    let fail;
    const resultPromise = new Promise((r, j) => { finish = r; fail = j; });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname !== path) {
        sendHtml(res, 404, '<h1>Not found</h1>');
        return;
      }
      if (settled) {
        sendHtml(res, 409, '<h1>OAuth isteği zaten işlendi.</h1>');
        return;
      }
      settled = true;
      const params = Object.fromEntries(url.searchParams.entries());
      const ok = !params.error && Boolean(params.code);
      sendHtml(res, 200, completionHtml(path.includes('kick') ? 'kick' : 'youtube', ok, ok ? 'Yetkilendirme StreamWatch tarafından alındı ve hesap tamamlanıyor.' : (params.error_description || params.error || 'Yetkilendirme reddedildi.')));
      finish(params);
      setTimeout(() => { try { server.close(); } catch { } }, 250);
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const redirectUri = `http://${host}:${actualPort}${path}`;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { server.close(); } catch { }
        fail(new Error('OAuth izin süresi doldu.'));
      }, timeoutMs);
      resultPromise.finally(() => clearTimeout(timer)).catch(() => {});
      resolve({ redirectUri, resultPromise, close: () => { try { server.close(); } catch { } } });
    });
  });
}

async function startYouTube(res) {
  const cfg = rawConfig();
  if (!cfg.youtubeClientId) throw new Error('YouTube OAuth Client ID yapılandırılmamış.');
  if (activeFlows.has('youtube')) throw new Error('YouTube bağlantısı zaten devam ediyor.');
  activeFlows.add('youtube');

  const callback = await createCallbackServer({ path: '/oauth/youtube/callback', host: '127.0.0.1' });
  const { verifier, challenge } = makePkce();
  const state = randomState();
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', cfg.youtubeClientId);
  auth.searchParams.set('redirect_uri', callback.redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', YOUTUBE_SCOPES);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('include_granted_scopes', 'true');
  redirect(res, auth.toString());

  (async () => {
    try {
      const params = await callback.resultPromise;
      if (params.error) throw new Error(params.error_description || params.error);
      if (params.state !== state) throw new Error('Google OAuth state doğrulaması başarısız.');
      const tokenData = await postForm('https://oauth2.googleapis.com/token', {
        client_id: cfg.youtubeClientId,
        client_secret: decrypt(cfg.youtubeClientSecret) || undefined,
        code: params.code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: callback.redirectUri,
      });
      const profile = await fetchYouTubeProfile(tokenData.access_token);
      writeToken('youtube', {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresAt: tokenExpiry(tokenData),
        scope: tokenData.scope || YOUTUBE_SCOPES,
        profile,
        connectedAt: Date.now(),
        lastValidatedAt: Date.now(),
      });
      emitState({ type: 'connected', platform: 'youtube', profile: profileSummary(profile) });
    } catch (error) {
      emitState({ type: 'error', platform: 'youtube', message: error?.message || 'YouTube bağlantısı başarısız.' });
    } finally {
      callback.close();
      activeFlows.delete('youtube');
    }
  })();
}

async function startTwitch(res) {
  const clientId = rawConfig().twitchClientId;
  if (!clientId) throw new Error('Twitch Client ID yapılandırılmamış.');
  if (activeFlows.has('twitch')) throw new Error('Twitch bağlantısı zaten devam ediyor.');
  activeFlows.add('twitch');

  try {
    const device = await postForm('https://id.twitch.tv/oauth2/device', {
      client_id: clientId,
      scopes: TWITCH_SCOPES,
    });
    if (!device.device_code || !device.verification_uri) throw new Error('Twitch Device Flow başlatılamadı.');
    redirect(res, device.verification_uri);
    emitState({ type: 'device-code', platform: 'twitch', userCode: device.user_code || null, verificationUri: device.verification_uri });

    (async () => {
      try {
        const expiresAt = Date.now() + Number(device.expires_in || 1800) * 1000;
        let intervalMs = Math.max(3, Number(device.interval || 5)) * 1000;
        let tokenData = null;
        while (Date.now() < expiresAt) {
          await wait(intervalMs);
          const body = new URLSearchParams({
            client_id: clientId,
            scopes: TWITCH_SCOPES,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          });
          const response = await net.fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          const text = await response.text();
          let data = {};
          try { data = text ? JSON.parse(text) : {}; } catch { }
          if (response.ok && data.access_token) { tokenData = data; break; }
          const message = String(data.message || data.error || '').toLowerCase();
          if (message.includes('authorization_pending')) continue;
          if (message.includes('slow_down')) { intervalMs += 2000; continue; }
          if (message.includes('expired') || message.includes('invalid device')) break;
          if (response.status >= 500) continue;
          throw new Error(data.message || data.error || `Twitch HTTP ${response.status}`);
        }
        if (!tokenData) throw new Error('Twitch izin süresi doldu.');
        const profile = await fetchTwitchProfile(tokenData.access_token, clientId);
        writeToken('twitch', {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          expiresAt: tokenExpiry(tokenData),
          scope: tokenData.scope || [TWITCH_SCOPES],
          profile,
          connectedAt: Date.now(),
          lastValidatedAt: Date.now(),
        });
        emitState({ type: 'connected', platform: 'twitch', profile: profileSummary(profile) });
      } catch (error) {
        emitState({ type: 'error', platform: 'twitch', message: error?.message || 'Twitch bağlantısı başarısız.' });
      } finally {
        activeFlows.delete('twitch');
      }
    })();
  } catch (error) {
    activeFlows.delete('twitch');
    throw error;
  }
}

async function startKick(res) {
  const cfg = rawConfig();
  const clientSecret = decrypt(cfg.kickClientSecret);
  if (!cfg.kickClientId || !clientSecret) throw new Error('Kick Client ID ve Client Secret yapılandırılmamış.');
  if (activeFlows.has('kick')) throw new Error('Kick bağlantısı zaten devam ediyor.');
  if (kickCallbackServer) throw new Error('Kick callback portu şu anda kullanımda.');
  activeFlows.add('kick');

  let callback;
  try {
    callback = await createCallbackServer({ port: KICK_CALLBACK_PORT, path: '/oauth/kick/callback', host: 'localhost' });
    kickCallbackServer = callback;
    const { verifier, challenge } = makePkce();
    const state = randomState();
    const redirectUri = `http://localhost:${KICK_CALLBACK_PORT}/oauth/kick/callback`;
    const auth = new URL('https://id.kick.com/oauth/authorize');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', cfg.kickClientId);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('scope', KICK_SCOPES);
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
    auth.searchParams.set('state', state);
    redirect(res, auth.toString());

    (async () => {
      try {
        const params = await callback.resultPromise;
        if (params.error) throw new Error(params.error_description || params.error);
        if (params.state !== state) throw new Error('Kick OAuth state doğrulaması başarısız.');
        const tokenData = await postForm('https://id.kick.com/oauth/token', {
          grant_type: 'authorization_code',
          client_id: cfg.kickClientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          code: params.code,
        });
        const profile = await fetchKickProfile(tokenData.access_token);
        writeToken('kick', {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          expiresAt: tokenExpiry(tokenData),
          scope: tokenData.scope || KICK_SCOPES,
          profile,
          connectedAt: Date.now(),
          lastValidatedAt: Date.now(),
        });
        emitState({ type: 'connected', platform: 'kick', profile: profileSummary(profile) });
      } catch (error) {
        emitState({ type: 'error', platform: 'kick', message: error?.message || 'Kick bağlantısı başarısız.' });
      } finally {
        callback.close();
        kickCallbackServer = null;
        activeFlows.delete('kick');
      }
    })();
  } catch (error) {
    callback?.close?.();
    kickCallbackServer = null;
    activeFlows.delete('kick');
    throw error;
  }
}

async function handleHubRequest(req, res) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${hubPort || 0}`);
  const token = url.searchParams.get('t') || '';

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!validSession(token)) {
    sendHtml(res, 403, completionHtml('StreamWatch', false, 'Bağlantı oturumu geçersiz veya süresi dolmuş. StreamWatch’tan yeniden “Hesapları Bağla” butonuna bas.'));
    return;
  }

  if (url.pathname === '/connect') {
    sendHtml(res, 200, hubHtml(token), {
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    });
    return;
  }

  if (url.pathname === '/api/status') {
    sendJson(res, 200, status());
    return;
  }

  const match = url.pathname.match(/^\/start\/(youtube|twitch|kick)$/);
  if (!match) {
    sendHtml(res, 404, completionHtml('StreamWatch', false, 'Sayfa bulunamadı.'));
    return;
  }

  const platform = match[1];
  try {
    if (platform === 'youtube') await startYouTube(res);
    else if (platform === 'twitch') await startTwitch(res);
    else await startKick(res);
  } catch (error) {
    if (!res.headersSent) sendHtml(res, 500, completionHtml(platform, false, error?.message || 'OAuth başlatılamadı.'));
  }
}

async function ensureHubServer() {
  if (hubServer && hubPort) return hubPort;
  for (const candidate of HUB_PORTS) {
    try {
      const server = await new Promise((resolve, reject) => {
        const instance = http.createServer((req, res) => {
          handleHubRequest(req, res).catch((error) => {
            if (!res.headersSent) sendHtml(res, 500, completionHtml('StreamWatch', false, error?.message || 'Bağlantı merkezi hatası.'));
          });
        });
        instance.once('error', reject);
        instance.listen(candidate, '127.0.0.1', () => resolve(instance));
      });
      hubServer = server;
      hubPort = candidate;
      hubServer.unref?.();
      return hubPort;
    } catch {
      // Try next reserved localhost port.
    }
  }
  throw new Error('StreamWatch Connect için localhost portu açılamadı.');
}

async function openHub() {
  const port = await ensureHubServer();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  for (const [key, value] of hubSessions) {
    if (value.expiresAt < now) hubSessions.delete(key);
  }
  hubSessions.set(token, { createdAt: now, expiresAt: now + 20 * 60 * 1000 });
  const url = `http://127.0.0.1:${port}/connect?t=${encodeURIComponent(token)}`;
  await openInSelectedBrowser(url);
  return { success: true, url, port };
}

ipcMain.handle('oauth-connect-hub-open', () => openHub());

app.on('before-quit', () => {
  hubSessions.clear();
  activeFlows.clear();
  try { hubServer?.close(); } catch { }
  try { kickCallbackServer?.close?.(); } catch { }
  hubServer = null;
  hubPort = null;
  kickCallbackServer = null;
});

'use strict';

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, net, safeStorage, shell } = require('electron');
const Store = require('electron-store');
const BrowserManager = require('./src/browser-manager');

const store = new Store();
const KICK_REDIRECT = 'http://localhost:37651/oauth/kick/callback';
const YOUTUBE_SCOPES = 'openid profile https://www.googleapis.com/auth/youtube.readonly';
const TWITCH_SCOPES = 'user:read:follows';
const KICK_SCOPES = 'user:read channel:read';
const activeFlows = new Map();
let validationTimer = null;

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
  if (prefs && typeof prefs === 'object' && prefs[browserKey]) {
    const value = prefs[browserKey];
    return typeof value === 'object' ? value.id || null : value;
  }
  return null;
}

function selectedBrowserExecutable(browserKey) {
  if (!browserKey) return null;
  try {
    return new BrowserManager().getAvailableBrowsers().find((item) => item.key === browserKey)?.path || null;
  } catch {
    return null;
  }
}

async function openAuthorizationUrl(url) {
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

function encrypted(value) {
  if (!value) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows güvenli depolama şu anda kullanılamıyor. Secret/token kaydedilmedi.');
  }
  return `safe:${safeStorage.encryptString(String(value)).toString('base64')}`;
}

function decrypted(value) {
  if (!value || typeof value !== 'string') return '';
  if (!value.startsWith('safe:')) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'));
  } catch {
    return '';
  }
}

function rawConfig() {
  const value = store.get('oauthAccountsConfig');
  return value && typeof value === 'object' ? value : {};
}

function publicConfig() {
  const cfg = rawConfig();
  return {
    youtubeClientId: cfg.youtubeClientId || '',
    youtubeHasSecret: Boolean(cfg.youtubeClientSecret),
    twitchClientId: cfg.twitchClientId || '',
    kickClientId: cfg.kickClientId || '',
    kickHasSecret: Boolean(cfg.kickClientSecret),
    kickRedirectUri: KICK_REDIRECT,
  };
}

function secretFor(key) {
  return decrypted(rawConfig()[key]);
}

function cleanId(value, max = 512) {
  return String(value || '').trim().slice(0, max);
}

function saveConfig(input = {}) {
  const current = rawConfig();
  const next = {
    ...current,
    youtubeClientId: cleanId(input.youtubeClientId),
    twitchClientId: cleanId(input.twitchClientId),
    kickClientId: cleanId(input.kickClientId),
  };

  const youtubeSecret = String(input.youtubeClientSecret || '').trim();
  const kickSecret = String(input.kickClientSecret || '').trim();
  if (youtubeSecret) next.youtubeClientSecret = encrypted(youtubeSecret);
  if (kickSecret) next.kickClientSecret = encrypted(kickSecret);
  if (input.clearYoutubeSecret) delete next.youtubeClientSecret;
  if (input.clearKickSecret) delete next.kickClientSecret;

  store.set('oauthAccountsConfig', next);
  emitState({ type: 'config' });
  return publicConfig();
}

function tokenKey(platform) {
  return `oauthAccountToken.${platform}`;
}

function readToken(platform) {
  const text = decrypted(store.get(tokenKey(platform)));
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function writeToken(platform, token) {
  store.set(tokenKey(platform), encrypted(JSON.stringify(token)));
}

function clearToken(platform) {
  store.delete(tokenKey(platform));
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
    const error = new Error(String(message));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function postForm(url, values, headers = {}) {
  const body = new URLSearchParams();
  Object.entries(values || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
  });
  const response = await net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: body.toString(),
  });
  return responseJson(response);
}

async function getJson(url, headers = {}) {
  return responseJson(await net.fetch(url, { headers }));
}

function callbackHtml(title, ok, detail) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08080b;color:#f5f5f7;font-family:Inter,system-ui,sans-serif}.box{width:min(540px,calc(100% - 32px));padding:28px;border-radius:18px;border:1px solid ${ok ? '#245c46' : '#65333b'};background:#111116}.status{font-size:20px;font-weight:750;margin-bottom:9px}.detail{color:#a4a4af;line-height:1.55}</style></head><body><div class="box"><div class="status">${ok ? 'Bağlantı tamamlandı' : 'Bağlantı tamamlanamadı'}</div><div class="detail">${detail}<br><br>Bu sekmeyi kapatıp StreamWatch’a dönebilirsin.</div></div></body></html>`;
}

async function createCallbackServer({ port = 0, path, redirectHost = '127.0.0.1', timeoutMs = 180000 }) {
  let settled = false;
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${redirectHost}`);
    if (url.pathname !== path) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    if (settled) {
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OAuth isteği zaten işlendi.');
      return;
    }
    settled = true;
    const params = Object.fromEntries(url.searchParams.entries());
    const ok = !params.error && Boolean(params.code);
    const body = callbackHtml('StreamWatch OAuth', ok, ok ? 'Yetkilendirme kodu StreamWatch tarafından alındı.' : (params.error_description || params.error || 'Yetkilendirme reddedildi.'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    resolveResult(params);
    setTimeout(() => { try { server.close(); } catch { } }, 250);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const redirectUri = `http://${redirectHost}:${actualPort}${path}`;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { server.close(); } catch { }
    rejectResult(new Error('OAuth izin süresi doldu. Tekrar dene.'));
  }, timeoutMs);

  resultPromise.finally(() => clearTimeout(timer)).catch(() => {});
  return { redirectUri, resultPromise, close: () => { try { server.close(); } catch { } } };
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

function tokenExpiry(data) {
  const seconds = Number(data.expires_in || 0);
  return seconds > 0 ? Date.now() + seconds * 1000 : null;
}

async function connectYouTube() {
  const cfg = rawConfig();
  const clientId = cfg.youtubeClientId;
  if (!clientId) throw new Error('Önce YouTube/Google OAuth Client ID gir.');
  if (activeFlows.has('youtube')) throw new Error('YouTube bağlantısı zaten devam ediyor.');
  activeFlows.set('youtube', true);

  const callback = await createCallbackServer({ path: '/oauth/youtube/callback', redirectHost: '127.0.0.1' });
  try {
    const { verifier, challenge } = makePkce();
    const state = randomState();
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.searchParams.set('client_id', clientId);
    auth.searchParams.set('redirect_uri', callback.redirectUri);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', YOUTUBE_SCOPES);
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
    auth.searchParams.set('state', state);
    auth.searchParams.set('access_type', 'offline');
    await openAuthorizationUrl(auth.toString());

    const params = await callback.resultPromise;
    if (params.error) throw new Error(params.error_description || params.error);
    if (params.state !== state) throw new Error('Google OAuth state doğrulaması başarısız.');
    if (!params.code) throw new Error('Google yetkilendirme kodu gelmedi.');

    const tokenData = await postForm('https://oauth2.googleapis.com/token', {
      client_id: clientId,
      client_secret: secretFor('youtubeClientSecret') || undefined,
      code: params.code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: callback.redirectUri,
    });
    const profile = await fetchYouTubeProfile(tokenData.access_token);
    const token = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: tokenExpiry(tokenData),
      scope: tokenData.scope || YOUTUBE_SCOPES,
      profile,
      connectedAt: Date.now(),
      lastValidatedAt: Date.now(),
    };
    writeToken('youtube', token);
    emitState({ type: 'connected', platform: 'youtube', profile: profileSummary(profile) });
    return status();
  } finally {
    callback.close();
    activeFlows.delete('youtube');
  }
}

async function twitchTokenRequest(values) {
  const body = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => body.set(key, String(value)));
  const response = await net.fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  return { ok: response.ok, status: response.status, data };
}

async function connectTwitch() {
  const clientId = rawConfig().twitchClientId;
  if (!clientId) throw new Error('Önce Twitch Client ID gir.');
  if (activeFlows.has('twitch')) throw new Error('Twitch bağlantısı zaten devam ediyor.');
  activeFlows.set('twitch', true);

  try {
    const device = await postForm('https://id.twitch.tv/oauth2/device', {
      client_id: clientId,
      scopes: TWITCH_SCOPES,
    });
    if (!device.device_code || !device.verification_uri) throw new Error('Twitch Device Code başlatılamadı.');
    await openAuthorizationUrl(device.verification_uri);
    emitState({ type: 'device-code', platform: 'twitch', userCode: device.user_code || null, verificationUri: device.verification_uri });

    const expiresAt = Date.now() + Number(device.expires_in || 1800) * 1000;
    let intervalMs = Math.max(3, Number(device.interval || 5)) * 1000;
    let tokenData = null;

    while (Date.now() < expiresAt) {
      await wait(intervalMs);
      const response = await twitchTokenRequest({
        client_id: clientId,
        scopes: TWITCH_SCOPES,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (response.ok && response.data.access_token) {
        tokenData = response.data;
        break;
      }
      const message = String(response.data.message || response.data.error || '').toLowerCase();
      if (message.includes('authorization_pending')) continue;
      if (message.includes('slow_down')) {
        intervalMs += 2000;
        continue;
      }
      if (message.includes('expired') || message.includes('invalid device')) break;
      if (response.status >= 500) continue;
      throw new Error(response.data.message || response.data.error || `Twitch HTTP ${response.status}`);
    }

    if (!tokenData) throw new Error('Twitch izin süresi doldu veya yetkilendirme tamamlanmadı.');
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
    return status();
  } finally {
    activeFlows.delete('twitch');
  }
}

async function connectKick() {
  const cfg = rawConfig();
  const clientId = cfg.kickClientId;
  const clientSecret = secretFor('kickClientSecret');
  if (!clientId || !clientSecret) throw new Error('Önce Kick Client ID ve Client Secret gir.');
  if (activeFlows.has('kick')) throw new Error('Kick bağlantısı zaten devam ediyor.');
  activeFlows.set('kick', true);

  const callback = await createCallbackServer({ port: 37651, path: '/oauth/kick/callback', redirectHost: 'localhost' });
  try {
    const { verifier, challenge } = makePkce();
    const state = randomState();
    const auth = new URL('https://id.kick.com/oauth/authorize');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', clientId);
    auth.searchParams.set('redirect_uri', KICK_REDIRECT);
    auth.searchParams.set('scope', KICK_SCOPES);
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
    auth.searchParams.set('state', state);
    await openAuthorizationUrl(auth.toString());

    const params = await callback.resultPromise;
    if (params.error) throw new Error(params.error_description || params.error);
    if (params.state !== state) throw new Error('Kick OAuth state doğrulaması başarısız.');
    if (!params.code) throw new Error('Kick yetkilendirme kodu gelmedi.');

    const tokenData = await postForm('https://id.kick.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: KICK_REDIRECT,
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
    return status();
  } finally {
    callback.close();
    activeFlows.delete('kick');
  }
}

async function refreshYouTube(token) {
  if (!token?.refreshToken) throw new Error('YouTube refresh token yok. Yeniden bağlan.');
  const cfg = rawConfig();
  const data = await postForm('https://oauth2.googleapis.com/token', {
    client_id: cfg.youtubeClientId,
    client_secret: secretFor('youtubeClientSecret') || undefined,
    refresh_token: token.refreshToken,
    grant_type: 'refresh_token',
  });
  const next = {
    ...token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || token.refreshToken,
    expiresAt: tokenExpiry(data),
    lastValidatedAt: Date.now(),
  };
  writeToken('youtube', next);
  return next;
}

async function refreshTwitch(token) {
  if (!token?.refreshToken) throw new Error('Twitch refresh token yok. Yeniden bağlan.');
  const clientId = rawConfig().twitchClientId;
  const response = await twitchTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: clientId,
  });
  if (!response.ok || !response.data.access_token) throw new Error(response.data.message || response.data.error || 'Twitch token yenilenemedi.');
  const next = {
    ...token,
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token || token.refreshToken,
    expiresAt: tokenExpiry(response.data),
    lastValidatedAt: Date.now(),
  };
  writeToken('twitch', next);
  return next;
}

async function refreshKick(token) {
  if (!token?.refreshToken) throw new Error('Kick refresh token yok. Yeniden bağlan.');
  const cfg = rawConfig();
  const data = await postForm('https://id.kick.com/oauth/token', {
    grant_type: 'refresh_token',
    client_id: cfg.kickClientId,
    client_secret: secretFor('kickClientSecret'),
    refresh_token: token.refreshToken,
  });
  const next = {
    ...token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || token.refreshToken,
    expiresAt: tokenExpiry(data),
    lastValidatedAt: Date.now(),
  };
  writeToken('kick', next);
  return next;
}

async function validateYouTube() {
  let token = readToken('youtube');
  if (!token) return false;
  try {
    if (token.expiresAt && token.expiresAt < Date.now() + 60000) token = await refreshYouTube(token);
    token.profile = await fetchYouTubeProfile(token.accessToken);
    token.lastValidatedAt = Date.now();
    writeToken('youtube', token);
    return true;
  } catch {
    try {
      token = await refreshYouTube(token);
      token.profile = await fetchYouTubeProfile(token.accessToken);
      writeToken('youtube', token);
      return true;
    } catch {
      return false;
    }
  }
}

async function validateTwitch() {
  let token = readToken('twitch');
  if (!token) return false;
  const clientId = rawConfig().twitchClientId;
  try {
    const response = await net.fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token.accessToken}` } });
    if (!response.ok) throw new Error('invalid');
    token.profile = await fetchTwitchProfile(token.accessToken, clientId);
    token.lastValidatedAt = Date.now();
    writeToken('twitch', token);
    return true;
  } catch {
    try {
      token = await refreshTwitch(token);
      token.profile = await fetchTwitchProfile(token.accessToken, clientId);
      writeToken('twitch', token);
      return true;
    } catch {
      return false;
    }
  }
}

async function validateKick() {
  let token = readToken('kick');
  if (!token) return false;
  try {
    const result = await responseJson(await net.fetch('https://id.kick.com/oauth/token/introspect', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}` },
    }));
    if (result?.data?.active === false) throw new Error('inactive');
    token.profile = await fetchKickProfile(token.accessToken);
    token.lastValidatedAt = Date.now();
    writeToken('kick', token);
    return true;
  } catch {
    try {
      token = await refreshKick(token);
      token.profile = await fetchKickProfile(token.accessToken);
      writeToken('kick', token);
      return true;
    } catch {
      return false;
    }
  }
}

function configured(platform) {
  const cfg = rawConfig();
  if (platform === 'youtube') return Boolean(cfg.youtubeClientId);
  if (platform === 'twitch') return Boolean(cfg.twitchClientId);
  if (platform === 'kick') return Boolean(cfg.kickClientId && secretFor('kickClientSecret'));
  return false;
}

function status() {
  const accounts = {};
  for (const platform of ['youtube', 'twitch', 'kick']) {
    const token = readToken(platform);
    accounts[platform] = {
      configured: configured(platform),
      connected: Boolean(token?.accessToken),
      profile: profileSummary(token?.profile),
      expiresAt: token?.expiresAt || null,
      connectedAt: token?.connectedAt || null,
      lastValidatedAt: token?.lastValidatedAt || null,
      busy: activeFlows.has(platform),
    };
  }
  return { config: publicConfig(), accounts };
}

async function validateAll() {
  const checks = await Promise.allSettled([
    validateYouTube(),
    validateTwitch(),
    validateKick(),
  ]);
  const platforms = ['youtube', 'twitch', 'kick'];
  checks.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value === false && readToken(platforms[index])) {
      clearToken(platforms[index]);
    }
  });
  const next = status();
  emitState({ type: 'validated', status: next });
  return next;
}

async function connect(platform) {
  if (platform === 'youtube') return connectYouTube();
  if (platform === 'twitch') return connectTwitch();
  if (platform === 'kick') return connectKick();
  throw new Error('Desteklenmeyen platform.');
}

async function disconnect(platform) {
  const token = readToken(platform);
  try {
    if (platform === 'youtube' && token?.accessToken) {
      await postForm('https://oauth2.googleapis.com/revoke', { token: token.refreshToken || token.accessToken });
    }
    if (platform === 'twitch' && token?.accessToken) {
      await postForm('https://id.twitch.tv/oauth2/revoke', { client_id: rawConfig().twitchClientId, token: token.accessToken });
    }
    if (platform === 'kick' && token?.accessToken) {
      const url = new URL('https://id.kick.com/oauth/revoke');
      url.searchParams.set('token', token.refreshToken || token.accessToken);
      url.searchParams.set('token_hint_type', token.refreshToken ? 'refresh_token' : 'access_token');
      await responseJson(await net.fetch(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    }
  } catch {
    // Local disconnect must still succeed even when provider-side revocation is temporarily unavailable.
  }
  clearToken(platform);
  emitState({ type: 'disconnected', platform });
  return status();
}

ipcMain.handle('oauth-accounts-config', () => publicConfig());
ipcMain.handle('oauth-accounts-save-config', (_, input) => saveConfig(input));
ipcMain.handle('oauth-accounts-status', () => status());
ipcMain.handle('oauth-accounts-validate', () => validateAll());
ipcMain.handle('oauth-accounts-connect', (_, platform) => connect(String(platform || '').toLowerCase()));
ipcMain.handle('oauth-accounts-disconnect', (_, platform) => disconnect(String(platform || '').toLowerCase()));

app.whenReady().then(() => {
  validationTimer = setInterval(() => {
    validateAll().catch(() => {});
  }, 60 * 60 * 1000);
  setTimeout(() => validateAll().catch(() => {}), 12000);
});

app.on('before-quit', () => {
  if (validationTimer) clearInterval(validationTimer);
  validationTimer = null;
  activeFlows.clear();
});

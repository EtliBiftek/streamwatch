'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const Store = require('electron-store');
const { spawn } = require('child_process');
const BrowserManager = require('./src/browser-manager');

const store = new Store();
const PLATFORM_NAMES = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };
const LOGIN_URLS = {
  youtube: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F',
  twitch: 'https://www.twitch.tv/login',
  kick: 'https://kick.com/login',
};
const PLATFORM_DOMAINS = {
  youtube: ['youtube.com', 'google.com', 'googleusercontent.com'],
  twitch: ['twitch.tv'],
  kick: ['kick.com'],
};
const CLEAR_ORIGINS = {
  youtube: ['https://www.youtube.com', 'https://accounts.google.com'],
  twitch: ['https://www.twitch.tv'],
  kick: ['https://kick.com'],
};

let portalServer = null;
let portalPort = null;
let portalToken = null;
let internalLoginWindow = null;
let refreshBusy = false;

function blockedPlatforms() {
  const value = store.get('accountDisconnectedPlatforms');
  return value && typeof value === 'object' ? value : {};
}

function isBlocked(platform) {
  return Boolean(blockedPlatforms()[platform]);
}

function setBlocked(platform, blocked) {
  const current = blockedPlatforms();
  if (blocked) current[platform] = true;
  else delete current[platform];
  store.set('accountDisconnectedPlatforms', current);
}

function normalizedDomain(domain) {
  return String(domain || '').replace(/^\./, '').toLowerCase();
}

function belongsToPlatform(domain, platform) {
  const value = normalizedDomain(domain);
  return (PLATFORM_DOMAINS[platform] || []).some((candidate) => value === candidate || value.endsWith(`.${candidate}`));
}

function platformForDomain(domain) {
  return Object.keys(PLATFORM_DOMAINS).find((platform) => belongsToPlatform(domain, platform)) || null;
}

function authState(platform, cookies) {
  const names = new Set(cookies.map((cookie) => String(cookie.name || '').toLowerCase()));
  if (platform === 'youtube') {
    const youtubeAuth = ['sapisid', 'apisid', 'sid', 'login_info', '__secure-1papisid', '__secure-3papisid', '__secure-1psid', '__secure-3psid'];
    if (youtubeAuth.some((name) => names.has(name))) return 'connected';
  }
  if (platform === 'twitch' && names.has('auth-token')) return 'connected';
  if (platform === 'kick' && (names.has('session_token') || names.has('kick_session'))) return 'connected';
  return cookies.length ? 'cookies' : 'none';
}

function platformDetail(platform, state, cookieCount, importState, blocked) {
  const name = PLATFORM_NAMES[platform] || platform;
  if (blocked) return 'Bağlantı kullanıcı tarafından kesildi. Tekrar bağlanmak için giriş başlat.';
  if (state === 'connected') return `Giriş oturumu doğrulandı${cookieCount ? ` • ${cookieCount} çerez` : ''}.`;
  if (state === 'cookies') {
    if (platform === 'twitch') return 'Twitch çerezleri bulundu fakat giriş için gerekli auth-token bulunamadı.';
    if (platform === 'kick') return 'Kick çerezleri bulundu fakat gerçek giriş session_token çerezi bulunamadı.';
    return 'YouTube/Google çerezleri bulundu fakat giriş oturumu doğrulanamadı.';
  }
  if (importState?.status === 'protected') {
    return `${name} için tarayıcı çerezleri korumalı olabilir. “StreamWatch İçinde Giriş” seçeneğini kullan.`;
  }
  return 'Bağlı bir oturum bulunamadı.';
}

async function purgePlatformSession(platform) {
  if (!PLATFORM_NAMES[platform]) return;
  const ses = session.fromPartition('persist:stream');
  const cookies = await ses.cookies.get({});
  for (const cookie of cookies) {
    if (!belongsToPlatform(cookie.domain, platform)) continue;
    const host = normalizedDomain(cookie.domain);
    const scheme = cookie.secure ? 'https' : 'http';
    try { await ses.cookies.remove(`${scheme}://${host}${cookie.path || '/'}`, cookie.name); } catch { }
  }
  for (const origin of CLEAR_ORIGINS[platform] || []) {
    try {
      await ses.clearStorageData({
        origin,
        storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
      });
    } catch { }
  }
  try { await ses.flushStorageData(); } catch { }
}

async function disconnectPlatform(platform) {
  if (!PLATFORM_NAMES[platform]) return { error: 'Desteklenmeyen platform.' };
  setBlocked(platform, true);
  await purgePlatformSession(platform);
  const state = await getStatus();
  emitState(state);
  return state;
}

async function allowPlatform(platform) {
  if (!PLATFORM_NAMES[platform]) return false;
  setBlocked(platform, false);
  emitState(await getStatus());
  return true;
}

async function getStatus() {
  const ses = session.fromPartition('persist:stream');
  const allCookies = await ses.cookies.get({});
  const importState = store.get('accountCookieImportState') || null;
  const platforms = {};

  for (const platform of Object.keys(PLATFORM_NAMES)) {
    const blocked = isBlocked(platform);
    const cookies = blocked ? [] : allCookies.filter((cookie) => belongsToPlatform(cookie.domain, platform));
    const state = blocked ? 'none' : authState(platform, cookies);
    platforms[platform] = {
      state,
      cookieCount: cookies.length,
      blocked,
      detail: platformDetail(platform, state, cookies.length, importState, blocked),
    };
  }

  const selectedBrowser = store.get('selectedBrowser') || null;
  const prefs = store.get('selectedBrowserProfiles');
  const selectedProfile = selectedBrowser && prefs && typeof prefs === 'object' ? prefs[selectedBrowser] || null : null;
  return { selectedBrowser, selectedProfile, cookieImport: importState, platforms };
}

function emitState(state) {
  const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && !/PiP|Chat|hesabını bağla/i.test(item.getTitle()));
  if (win && !win.webContents.isDestroyed()) win.webContents.send('account-bridge-state', state);
}

const previousLoadCookies = BrowserManager.prototype._loadCookies;
BrowserManager.prototype._loadCookies = async function streamwatchDisconnectedAccountGuard(...args) {
  const result = await previousLoadCookies.apply(this, args);
  const blocked = blockedPlatforms();
  for (const platform of Object.keys(PLATFORM_NAMES)) {
    if (blocked[platform]) await purgePlatformSession(platform);
  }
  return result;
};

ipcMain.removeHandler('account-bridge-status');
ipcMain.handle('account-bridge-status', () => getStatus());
ipcMain.handle('account-bridge-disconnect', (_, platform) => disconnectPlatform(platform));
ipcMain.handle('account-bridge-allow-platform', (_, platform) => allowPlatform(platform));

function selectedProfileId(browserKey) {
  const prefs = store.get('selectedBrowserProfiles');
  if (prefs && typeof prefs === 'object' && prefs[browserKey]) return prefs[browserKey];
  try {
    const manager = new BrowserManager();
    const root = manager.browserProfiles?.[browserKey];
    const localState = root ? JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')) : null;
    return localState?.profile?.last_used || 'Default';
  } catch {
    return null;
  }
}

function browserExecutable(browserKey) {
  if (!browserKey) return null;
  try { return new BrowserManager().getAvailableBrowsers().find((item) => item.key === browserKey)?.path || null; }
  catch { return null; }
}

async function openInSelectedBrowser(url) {
  const browserKey = store.get('selectedBrowser');
  const executable = browserExecutable(browserKey);
  const profileId = selectedProfileId(browserKey);
  if (!executable) {
    await shell.openExternal(url);
    return;
  }
  const args = [];
  if (profileId && profileId !== '.' && browserKey !== 'firefox' && browserKey !== 'opera') args.push(`--profile-directory=${profileId}`);
  args.push(url);
  try {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch {
    await shell.openExternal(url);
  }
}

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat|hesabını bağla/i.test(win.getTitle())) || null;
}

function openInternalLogin(platform) {
  const url = LOGIN_URLS[platform];
  if (!url) return { error: 'Desteklenmeyen platform.' };
  setBlocked(platform, false);
  if (internalLoginWindow && !internalLoginWindow.isDestroyed()) internalLoginWindow.close();
  internalLoginWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    parent: mainWindow() || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    title: `${PLATFORM_NAMES[platform]} hesabını bağla`,
    webPreferences: {
      session: session.fromPartition('persist:stream'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  internalLoginWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  internalLoginWindow.loadURL(url);
  internalLoginWindow.on('closed', async () => {
    internalLoginWindow = null;
    emitState(await getStatus());
  });
  return { success: true };
}

async function refreshCookies() {
  if (refreshBusy) return getStatus();
  const browserKey = store.get('selectedBrowser');
  if (!browserKey) return { error: 'Önce StreamWatch ayarlarından bir tarayıcı seç.' };
  refreshBusy = true;
  try {
    const manager = new BrowserManager();
    manager.streamSession = session.fromPartition('persist:stream');
    await manager._loadCookies(browserKey);
    return getStatus();
  } finally {
    refreshBusy = false;
  }
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

function portalHtml(token, focusPlatform) {
  const focus = PLATFORM_NAMES[focusPlatform] ? focusPlatform : '';
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>StreamWatch Hesap Bağlantısı</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#070709;color:#f5f5f6}*{box-sizing:border-box}body{margin:0;background:#070709}.wrap{width:min(980px,calc(100% - 32px));margin:auto;padding:42px 0}.top{display:flex;justify-content:space-between;gap:16px;margin-bottom:20px}.panel{border:1px solid #24242a;border-radius:18px;background:#0f0f12;padding:18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{padding:16px;border:1px solid #292930;border-radius:15px;background:#0b0b0e}.card.focus{border-color:#7047b7}.row{display:flex;justify-content:space-between;gap:8px}.badge{font-size:10px;border:1px solid #34343c;border-radius:999px;padding:5px 8px;color:#999}.badge.ok{color:#59d99a;border-color:#245c46}.badge.partial{color:#f4ba54;border-color:#5d4923}.detail{min-height:54px;padding:10px 0;color:#92929e;font-size:11px;line-height:1.45}.buttons{display:grid;gap:7px}.btn{border-radius:10px;padding:10px;border:1px solid #303038;background:#15151a;color:#ddd;cursor:pointer;font-weight:650}.primary{border-color:#7047b7;background:#241635;color:#eadfff}.danger{border-color:#5b3037;color:#ffb3bd}.message{margin-top:14px;padding:11px 13px;min-height:42px;border:1px solid #292930;border-radius:11px;color:#aaa;font-size:12px}.good{color:#8ee6b9;border-color:#245c46}.warn{color:#edbd68;border-color:#5d4923}.muted{color:#92929e;font-size:13px}.meta{color:#aaa;font-size:12px}@media(max-width:760px){.grid{grid-template-columns:1fr}.top{flex-direction:column}}
</style></head><body><div class="wrap"><div class="top"><div><h2>StreamWatch Bağlantı Merkezi</h2><div class="muted">Hesap durumları artık gerçek giriş çerezleriyle doğrulanır.</div></div><div class="meta" id="meta">Kontrol ediliyor…</div></div><div class="panel"><div class="grid">${Object.entries(PLATFORM_NAMES).map(([key,name])=>`<section class="card ${focus===key?'focus':''}" data-platform="${key}"><div class="row"><strong>${name}</strong><span class="badge" data-badge>Bağlı değil</span></div><div class="detail" data-detail>Kontrol ediliyor…</div><div class="buttons"><button class="btn primary" data-open>Giriş Sayfasını Aç</button><button class="btn" data-internal>StreamWatch İçinde Giriş</button><button class="btn danger" data-disconnect>Bağlantıyı Kopar</button></div></section>`).join('')}</div><div class="message" id="message">Hazır.</div></div></div><script>
const TOKEN=${JSON.stringify(token)};const NAMES=${JSON.stringify(PLATFORM_NAMES)};const msg=document.getElementById('message');let pending=null;let until=0;
function say(text,type=''){msg.textContent=text;msg.className='message '+type}
async function api(p,o={}){const j=p.includes('?')?'&':'?';const r=await fetch(p+j+'token='+encodeURIComponent(TOKEN),{cache:'no-store',...o});const d=await r.json();if(!r.ok||d.error)throw new Error(d.error||'İşlem başarısız');return d}
function paint(s){document.getElementById('meta').textContent=(s.selectedBrowser||'Sistem tarayıcısı')+' • '+(s.selectedProfile||'otomatik profil');for(const card of document.querySelectorAll('[data-platform]')){const p=card.dataset.platform;const i=s.platforms?.[p]||{state:'none'};const b=card.querySelector('[data-badge]');b.className='badge '+(i.state==='connected'?'ok':i.state==='cookies'?'partial':'');b.textContent=i.blocked?'Bağlantı kesildi':i.state==='connected'?'Bağlı':i.state==='cookies'?'Doğrulanamadı':'Bağlı değil';card.querySelector('[data-detail]').textContent=i.detail||'Durum okunamadı.';card.querySelector('[data-disconnect]').disabled=Boolean(i.blocked);if(pending===p&&i.state==='connected'){pending=null;until=0;say(NAMES[p]+' hesabı doğrulandı.','good')}}}
async function status(){try{paint(await api('/api/status'))}catch(e){say(e.message,'warn')}}
for(const card of document.querySelectorAll('[data-platform]')){const p=card.dataset.platform;card.querySelector('[data-open]').onclick=async()=>{try{await api('/api/open?platform='+p,{method:'POST'});pending=p;until=Date.now()+120000;say(NAMES[p]+' giriş sayfası açıldı. Girişten sonra otomatik kontrol edilecek.')}catch(e){say(e.message,'warn')}};card.querySelector('[data-internal]').onclick=async()=>{try{await api('/api/internal?platform='+p,{method:'POST'});pending=p;until=Date.now()+120000;say(NAMES[p]+' için StreamWatch giriş penceresi açıldı.')}catch(e){say(e.message,'warn')}};card.querySelector('[data-disconnect]').onclick=async()=>{try{const s=await api('/api/disconnect?platform='+p,{method:'POST'});paint(s);say(NAMES[p]+' bağlantısı StreamWatch’tan kaldırıldı.','good')}catch(e){say(e.message,'warn')}}}
setInterval(async()=>{await status();if(pending&&until>Date.now()){try{const s=await api('/api/refresh',{method:'POST'});paint(s);const i=s.platforms?.[pending];if(i&&i.state!=='connected')say(NAMES[pending]+': '+(i.detail||'Giriş henüz doğrulanmadı.'),'warn')}catch{}}},4000);status();
</script></body></html>`;
}

function authorized(url) {
  return url.searchParams.get('token') === portalToken;
}

async function handlePortalRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!authorized(url)) return sendJson(res, 403, { error: 'Yetkisiz yerel istek.' });
  try {
    if (url.pathname === '/') {
      const body = portalHtml(portalToken, url.searchParams.get('platform'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      return res.end(body);
    }
    if (url.pathname === '/api/status') return sendJson(res, 200, await getStatus());
    if (url.pathname === '/api/refresh' && req.method === 'POST') return sendJson(res, 200, await refreshCookies());
    if (url.pathname === '/api/disconnect' && req.method === 'POST') return sendJson(res, 200, await disconnectPlatform(url.searchParams.get('platform')));
    if (url.pathname === '/api/open' && req.method === 'POST') {
      const platform = url.searchParams.get('platform');
      if (!LOGIN_URLS[platform]) return sendJson(res, 400, { error: 'Desteklenmeyen platform.' });
      setBlocked(platform, false);
      await openInSelectedBrowser(LOGIN_URLS[platform]);
      return sendJson(res, 200, { success: true });
    }
    if (url.pathname === '/api/internal' && req.method === 'POST') return sendJson(res, 200, openInternalLogin(url.searchParams.get('platform')));
    return sendJson(res, 404, { error: 'Endpoint bulunamadı.' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Yerel bağlantı hatası.' });
  }
}

function ensurePortal() {
  if (portalServer && portalPort && portalToken) return Promise.resolve(portalPort);
  portalToken = crypto.randomBytes(24).toString('hex');
  portalServer = http.createServer((req, res) => handlePortalRequest(req, res));
  return new Promise((resolve, reject) => {
    portalServer.once('error', reject);
    portalServer.listen(0, '127.0.0.1', () => {
      portalPort = portalServer.address().port;
      portalServer.unref?.();
      resolve(portalPort);
    });
  });
}

async function openPortal(platform) {
  const port = await ensurePortal();
  const focus = PLATFORM_NAMES[platform] ? `&platform=${encodeURIComponent(platform)}` : '';
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(portalToken)}${focus}`;
  await openInSelectedBrowser(url);
  return { success: true, url: `http://127.0.0.1:${port}/` };
}

ipcMain.removeHandler('account-bridge-open-portal');
ipcMain.handle('account-bridge-open-portal', (_, platform) => openPortal(platform));

app.on('before-quit', () => {
  if (internalLoginWindow && !internalLoginWindow.isDestroyed()) internalLoginWindow.destroy();
  if (portalServer) {
    try { portalServer.close(); } catch { }
  }
  internalLoginWindow = null;
  portalServer = null;
  portalPort = null;
  portalToken = null;
});

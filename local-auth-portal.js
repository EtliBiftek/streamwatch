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
const PLATFORM_DOMAINS = ['youtube.com', 'google.com', 'googleusercontent.com', 'twitch.tv', 'kick.com'];

let portalServer = null;
let portalPort = null;
let portalToken = null;
let internalLoginWindow = null;
let refreshBusy = false;

function selectedProfileId(browserKey) {
  const prefs = store.get('selectedBrowserProfiles');
  if (prefs && typeof prefs === 'object' && prefs[browserKey]) return prefs[browserKey];

  try {
    const manager = new BrowserManager();
    const root = manager.browserProfiles?.[browserKey];
    if (!root) return null;
    const localState = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
    return localState.profile?.last_used || 'Default';
  } catch {
    return null;
  }
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
    return { browser: browserKey || 'system', profile: profileId };
  }

  const args = [];
  if (profileId && profileId !== '.' && browserKey !== 'firefox' && browserKey !== 'opera') {
    args.push(`--profile-directory=${profileId}`);
  }
  args.push(url);

  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
  } catch {
    await shell.openExternal(url);
  }

  return { browser: browserKey, profile: profileId };
}

function relevantDomain(domain) {
  const value = String(domain || '').replace(/^\./, '').toLowerCase();
  return PLATFORM_DOMAINS.some((candidate) => value === candidate || value.endsWith(`.${candidate}`));
}

function platformForDomain(domain) {
  const value = String(domain || '').toLowerCase();
  if (value.includes('youtube.com') || value.includes('google.com') || value.includes('googleusercontent.com')) return 'youtube';
  if (value.includes('twitch.tv')) return 'twitch';
  if (value.includes('kick.com')) return 'kick';
  return null;
}

function authState(platform, cookies) {
  const names = cookies.map((cookie) => String(cookie.name || ''));
  if (platform === 'youtube' && names.some((name) => /^(SAPISID|APISID|SID|LOGIN_INFO|__Secure-\d?P?APISID|__Secure-\d?P?SID)$/i.test(name))) return 'connected';
  if (platform === 'twitch' && names.some((name) => /^(auth-token|persistent)$/i.test(name))) return 'connected';
  if (platform === 'kick' && names.some((name) => /(auth|session|token)/i.test(name))) return 'connected';
  return cookies.length ? 'cookies' : 'none';
}

async function status() {
  const ses = session.fromPartition('persist:stream');
  const cookies = (await ses.cookies.get({})).filter((cookie) => relevantDomain(cookie.domain));
  const selectedBrowser = store.get('selectedBrowser') || null;
  const selectedProfile = selectedProfileId(selectedBrowser);
  const platforms = {};

  for (const platform of Object.keys(PLATFORM_NAMES)) {
    const platformCookies = cookies.filter((cookie) => platformForDomain(cookie.domain) === platform);
    platforms[platform] = {
      state: authState(platform, platformCookies),
      cookieCount: platformCookies.length,
    };
  }

  return {
    selectedBrowser,
    selectedProfile,
    cookieImport: store.get('accountCookieImportState') || null,
    platforms,
  };
}

async function refreshCookies() {
  if (refreshBusy) return status();
  const browserKey = store.get('selectedBrowser');
  if (!browserKey) return { error: 'Önce StreamWatch ayarlarından bir tarayıcı seç.' };
  refreshBusy = true;
  try {
    const manager = new BrowserManager();
    manager.streamSession = session.fromPartition('persist:stream');
    await manager._loadCookies(browserKey);
    try { await manager.streamSession.flushStorageData(); } catch { }
    return status();
  } finally {
    refreshBusy = false;
  }
}

async function openPlatformLogin(platform) {
  const url = LOGIN_URLS[platform];
  if (!url) return { error: 'Desteklenmeyen platform.' };
  return { success: true, ...(await openInSelectedBrowser(url)) };
}

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat|hesabını bağla/i.test(win.getTitle())) || null;
}

function openInternalLogin(platform) {
  const url = LOGIN_URLS[platform];
  if (!url) return { error: 'Desteklenmeyen platform.' };

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
  internalLoginWindow.on('closed', () => { internalLoginWindow = null; });
  return { success: true };
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function portalHtml(token, focusPlatform) {
  const focus = Object.prototype.hasOwnProperty.call(PLATFORM_NAMES, focusPlatform) ? focusPlatform : '';
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>StreamWatch Hesap Bağlantısı</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#070709;color:#f5f5f6}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0,rgba(124,58,237,.16),transparent 35%),#070709}.wrap{width:min(980px,calc(100% - 32px));margin:0 auto;padding:42px 0 54px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px}.brand{display:flex;align-items:center;gap:13px}.logo{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(145deg,#8b5cf6,#4c1d95);font-weight:800;box-shadow:0 12px 35px rgba(124,58,237,.24)}h1{font-size:22px;margin:0 0 5px}.muted{color:#9898a4;font-size:13px;line-height:1.55}.meta{padding:11px 13px;border:1px solid #24242a;border-radius:12px;background:#111115;font-size:12px;color:#b7b7c1;white-space:nowrap}.panel{border:1px solid #24242a;border-radius:18px;background:rgba(15,15,18,.92);padding:18px;box-shadow:0 22px 65px rgba(0,0,0,.3)}.info{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:13px 14px;border:1px solid #292931;border-radius:13px;background:#0b0b0e;margin-bottom:14px}.info strong{font-size:13px}.refresh{appearance:none;border:1px solid #3a3157;background:#181322;color:#d7c8ff;border-radius:10px;padding:9px 12px;font-weight:650;cursor:pointer}.refresh:hover{background:#21182f}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.card{padding:16px;border:1px solid #25252c;border-radius:15px;background:#0c0c10;transition:.15s border-color,.15s transform}.card.focus{border-color:#7047b7;box-shadow:0 0 0 1px rgba(139,92,246,.15)}.card:hover{border-color:#353541}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.name{font-size:15px;font-weight:750}.badge{font-size:10px;border-radius:999px;padding:5px 8px;border:1px solid #34343c;color:#8f8f9b}.badge.ok{color:#59d99a;border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.08)}.badge.partial{color:#f4ba54;border-color:rgba(245,158,11,.28);background:rgba(245,158,11,.07)}.detail{height:34px;padding-top:9px;color:#858590;font-size:11px}.buttons{display:grid;gap:8px}.btn{appearance:none;width:100%;border-radius:10px;padding:10px 11px;font:inherit;font-size:12px;font-weight:650;cursor:pointer}.primary{border:1px solid #7245ba;background:#241635;color:#e5d7ff}.primary:hover{background:#2d1a43}.secondary{border:1px solid #2b2b33;background:#141419;color:#c7c7ce}.secondary:hover{border-color:#43434e}.message{margin-top:14px;min-height:42px;padding:11px 13px;border-radius:11px;border:1px solid #24242a;background:#0a0a0d;color:#9999a5;font-size:12px;line-height:1.5}.message.good{border-color:rgba(52,211,153,.28);color:#8ee6b9}.message.warn{border-color:rgba(245,158,11,.28);color:#edbd68}.footer{margin-top:16px;color:#777783;font-size:11px;line-height:1.6}@media(max-width:760px){.grid{grid-template-columns:1fr}.top{flex-direction:column}.meta{white-space:normal}.info{align-items:flex-start;flex-direction:column}.refresh{width:100%}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="brand"><div class="logo">SW</div><div><h1>StreamWatch Bağlantı Merkezi</h1><div class="muted">Hesaplarını yerel sayfadan bağla. Bu sayfa sadece bilgisayarındaki 127.0.0.1 adresinde çalışır.</div></div></div>
    <div class="meta" id="browserMeta">Tarayıcı bilgisi okunuyor…</div>
  </div>
  <div class="panel">
    <div class="info"><div><strong>Nasıl çalışır?</strong><div class="muted">Önce giriş sayfasını aç. Giriş tamamlandıktan sonra StreamWatch seçili tarayıcı profilindeki oturumu içe aktarmayı dener.</div></div><button class="refresh" id="refreshAll">Oturumu Yenile</button></div>
    <div class="grid">
      ${Object.entries(PLATFORM_NAMES).map(([key,name])=>`<section class="card ${focus===key?'focus':''}" data-platform="${key}"><div class="row"><div class="name">${name}</div><span class="badge" data-badge>Bağlı değil</span></div><div class="detail" data-detail>Oturum verisi kontrol ediliyor…</div><div class="buttons"><button class="btn primary" data-open>Giriş Sayfasını Aç</button><button class="btn secondary" data-internal>StreamWatch İçinde Giriş</button></div></section>`).join('')}
    </div>
    <div class="message" id="message">Hazır.</div>
    <div class="footer">Brave/Chrome/Edge yeni çerez şifreleme korumaları nedeniyle harici oturum aktarımını engelleyebilir. Böyle bir durumda “StreamWatch İçinde Giriş” aynı kalıcı StreamWatch oturumunda giriş yapar ve en güvenilir fallback olarak kalır.</div>
  </div>
</div>
<script>
const TOKEN=${JSON.stringify(token)};
let pendingUntil=0;
let pendingPlatform=null;
const message=document.getElementById('message');
function setMessage(text,type=''){message.textContent=text;message.className='message '+type}
async function api(path,options={}){const join=path.includes('?')?'&':'?';const res=await fetch(path+join+'token='+encodeURIComponent(TOKEN),{cache:'no-store',...options});const data=await res.json();if(!res.ok||data.error)throw new Error(data.error||'İşlem başarısız');return data}
function paint(state){
  const browser=state.selectedBrowser||'Sistem tarayıcısı';
  const profile=state.selectedProfile||'otomatik profil';
  document.getElementById('browserMeta').textContent=browser+' • '+profile;
  for(const card of document.querySelectorAll('[data-platform]')){
    const platform=card.dataset.platform;const info=state.platforms?.[platform]||{state:'none',cookieCount:0};const badge=card.querySelector('[data-badge]');
    badge.className='badge '+(info.state==='connected'?'ok':info.state==='cookies'?'partial':'');
    badge.textContent=info.state==='connected'?'Bağlı':info.state==='cookies'?'Oturum bulundu':'Bağlı değil';
    card.querySelector('[data-detail]').textContent=info.cookieCount?info.cookieCount+' oturum çerezi mevcut':'Oturum verisi yok';
    if(pendingPlatform===platform&&info.state==='connected'){pendingPlatform=null;pendingUntil=0;setMessage(card.querySelector('.name').textContent+' hesabı StreamWatch oturumunda algılandı.','good')}
  }
  const imported=state.cookieImport;
  if(imported?.status==='protected'&&pendingPlatform){setMessage('Tarayıcı oturumu bulundu fakat korumalı çerezler okunamadı. StreamWatch İçinde Giriş seçeneğini kullanabilirsin.','warn')}
}
async function getStatus(){try{paint(await api('/api/status'))}catch(e){setMessage(e.message,'warn')}}
async function refresh(){try{setMessage('Tarayıcı oturumu yeniden okunuyor…');const state=await api('/api/refresh',{method:'POST'});paint(state);if(!state.error)setMessage('Oturum kontrolü tamamlandı.','good')}catch(e){setMessage(e.message,'warn')}}
document.getElementById('refreshAll').addEventListener('click',refresh);
for(const card of document.querySelectorAll('[data-platform]')){
  const platform=card.dataset.platform;
  card.querySelector('[data-open]').addEventListener('click',async()=>{try{await api('/api/open?platform='+encodeURIComponent(platform),{method:'POST'});pendingPlatform=platform;pendingUntil=Date.now()+120000;setMessage(card.querySelector('.name').textContent+' giriş sayfası açıldı. Girişi tamamla; StreamWatch otomatik kontrol edecek.')}catch(e){setMessage(e.message,'warn')}});
  card.querySelector('[data-internal]').addEventListener('click',async()=>{try{await api('/api/internal?platform='+encodeURIComponent(platform),{method:'POST'});pendingPlatform=platform;pendingUntil=Date.now()+120000;setMessage('StreamWatch giriş penceresi açıldı. Giriş tamamlanınca bu sayfa durumu algılayacak.')}catch(e){setMessage(e.message,'warn')}});
}
setInterval(async()=>{await getStatus();if(pendingUntil>Date.now()){try{paint(await api('/api/refresh',{method:'POST'}))}catch{}}},4000);
getStatus();
</script>
</body>
</html>`;
}

function authorized(url) {
  return url.searchParams.get('token') === portalToken;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!authorized(url)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Yetkisiz yerel istek.');
    return;
  }

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
      res.end(body);
      return;
    }

    if (url.pathname === '/api/status') return sendJson(res, 200, await status());
    if (url.pathname === '/api/refresh' && req.method === 'POST') return sendJson(res, 200, await refreshCookies());
    if (url.pathname === '/api/open' && req.method === 'POST') return sendJson(res, 200, await openPlatformLogin(url.searchParams.get('platform')));
    if (url.pathname === '/api/internal' && req.method === 'POST') return sendJson(res, 200, openInternalLogin(url.searchParams.get('platform')));

    sendJson(res, 404, { error: 'Yerel bağlantı endpointi bulunamadı.' });
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Yerel bağlantı hatası.' });
  }
}

function ensurePortalServer() {
  if (portalServer && portalPort && portalToken) return Promise.resolve(portalPort);
  portalToken = crypto.randomBytes(24).toString('hex');
  portalServer = http.createServer((req, res) => { handleRequest(req, res); });
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
  const port = await ensurePortalServer();
  const focus = Object.prototype.hasOwnProperty.call(PLATFORM_NAMES, platform) ? `&platform=${encodeURIComponent(platform)}` : '';
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(portalToken)}${focus}`;
  await openInSelectedBrowser(url);
  return { success: true, url: `http://127.0.0.1:${port}/` };
}

ipcMain.handle('account-bridge-open-portal', (_, platform) => openPortal(platform));

app.on('before-quit', () => {
  if (internalLoginWindow && !internalLoginWindow.isDestroyed()) internalLoginWindow.destroy();
  internalLoginWindow = null;
  if (portalServer) {
    try { portalServer.close(); } catch { }
  }
  portalServer = null;
  portalPort = null;
  portalToken = null;
});

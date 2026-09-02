'use strict';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { app, BrowserWindow, ipcMain, session, shell, clipboard } = require('electron');
const Store = require('electron-store');
const { spawn } = require('child_process');
const BrowserManager = require('./src/browser-manager');

const store = new Store();
const PORTS = [37641, 37642, 37643, 37644];
const PLATFORM_NAMES = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };
const PLATFORM_URLS = {
  youtube: 'https://www.youtube.com/',
  twitch: 'https://www.twitch.tv/',
  kick: 'https://kick.com/',
};
const PLATFORM_DOMAINS = {
  youtube: ['youtube.com', 'google.com', 'googleusercontent.com'],
  twitch: ['twitch.tv'],
  kick: ['kick.com'],
};

let server = null;
let port = null;
const pending = new Map();

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat|hesabını bağla/i.test(win.getTitle())) || null;
}

function extensionDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(__dirname, 'browser-extension');
}

function selectedProfileId(browserKey) {
  const prefs = store.get('selectedBrowserProfiles');
  if (prefs && typeof prefs === 'object' && prefs[browserKey]) return prefs[browserKey];
  return null;
}

function browserExecutable(browserKey) {
  if (!browserKey) return null;
  try {
    return new BrowserManager().getAvailableBrowsers().find((item) => item.key === browserKey)?.path || null;
  } catch {
    return null;
  }
}

async function openInSelectedBrowser(url) {
  const browserKey = store.get('selectedBrowser');
  const executable = browserExecutable(browserKey);
  const profileId = selectedProfileId(browserKey);
  if (!executable) {
    await shell.openExternal(url);
    return { browser: browserKey || 'system', profile: profileId || null };
  }

  const args = [];
  if (profileId && profileId !== '.' && browserKey !== 'firefox' && browserKey !== 'opera') {
    args.push(`--profile-directory=${profileId}`);
  }
  args.push(url);
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { browser: browserKey, profile: profileId || null };
}

function belongsToPlatform(domain, platform) {
  const value = String(domain || '').replace(/^\./, '').toLowerCase();
  return (PLATFORM_DOMAINS[platform] || []).some((candidate) => value === candidate || value.endsWith(`.${candidate}`));
}

function sameSite(value) {
  return ['unspecified', 'no_restriction', 'lax', 'strict'].includes(value) ? value : 'unspecified';
}

async function importCookies(platform, cookies) {
  const ses = session.fromPartition('persist:stream');
  let imported = 0;
  const now = Date.now() / 1000;

  for (const raw of Array.isArray(cookies) ? cookies.slice(0, 5000) : []) {
    try {
      if (!raw || typeof raw.name !== 'string' || typeof raw.value !== 'string') continue;
      if (!belongsToPlatform(raw.domain, platform)) continue;
      if (raw.name.length > 512 || raw.value.length > 16384) continue;
      if (raw.expirationDate && Number(raw.expirationDate) <= now) continue;

      const host = String(raw.domain || '').replace(/^\./, '').toLowerCase();
      if (!host) continue;
      const details = {
        url: `${raw.secure ? 'https' : 'http'}://${host}${raw.path || '/'}`,
        name: raw.name,
        value: raw.value,
        path: raw.path || '/',
        secure: Boolean(raw.secure),
        httpOnly: Boolean(raw.httpOnly),
        sameSite: sameSite(raw.sameSite),
      };
      if (!raw.hostOnly && !raw.name.startsWith('__Host-')) details.domain = String(raw.domain || host);
      if (!raw.session && Number.isFinite(Number(raw.expirationDate))) details.expirationDate = Number(raw.expirationDate);

      await ses.cookies.set(details);
      imported += 1;
    } catch {
      // One malformed/unsupported cookie must not abort the whole platform session.
    }
  }

  try { await ses.flushStorageData(); } catch { }
  return imported;
}

async function platformState(platform) {
  const ses = session.fromPartition('persist:stream');
  const cookies = (await ses.cookies.get({})).filter((cookie) => belongsToPlatform(cookie.domain, platform));
  const names = new Set(cookies.map((cookie) => String(cookie.name || '').toLowerCase()));

  let connected = false;
  if (platform === 'youtube') {
    connected = ['sapisid', 'apisid', 'sid', 'login_info', '__secure-1papisid', '__secure-3papisid', '__secure-1psid', '__secure-3psid']
      .some((name) => names.has(name));
  } else if (platform === 'twitch') {
    connected = names.has('auth-token');
  } else if (platform === 'kick') {
    connected = names.has('session_token') || names.has('kick_session');
  }

  return { connected, cookieCount: cookies.length };
}

function unblock(platform) {
  const current = store.get('accountDisconnectedPlatforms');
  if (!current || typeof current !== 'object') return;
  if (!current[platform]) return;
  delete current[platform];
  store.set('accountDisconnectedPlatforms', current);
}

function emit(result) {
  const win = mainWindow();
  if (!win || win.webContents.isDestroyed()) return;
  win.webContents.send('browser-bridge-state', result);
  win.webContents.send('account-bridge-state', null);
}

function html(platform) {
  const name = PLATFORM_NAMES[platform] || platform;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamWatch Browser Bridge</title><style>body{margin:0;background:#08080b;color:#f5f5f7;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}.card{width:min(560px,calc(100% - 32px));padding:26px;border:1px solid #292932;border-radius:18px;background:#111116;box-shadow:0 24px 70px #0008}h1{font-size:21px;margin:0 0 10px}.muted{color:#9a9aa6;line-height:1.6;font-size:13px}.status{margin-top:18px;padding:13px 14px;border:1px solid #33333d;border-radius:12px;color:#c8c8d0}.ok{border-color:#245c46;color:#84e3b3}.bad{border-color:#65333b;color:#ffb3be}code{background:#1a1a20;padding:2px 5px;border-radius:5px}</style></head><body><main class="card"><h1>${name} → StreamWatch</h1><div class="muted">StreamWatch Browser Bridge, bu tarayıcı profilindeki yalnızca ${name} oturumunu yerel StreamWatch uygulamasına aktaracak. Veri dışarıya gönderilmez.</div><div id="status" class="status">Browser Bridge eklentisi bekleniyor…</div><div class="muted" style="margin-top:14px">Bu ekran 8 saniyeden uzun süre burada kalırsa eklenti kurulu değildir. StreamWatch → Ayarlar → Hesaplar bölümündeki <code>Browser Bridge'i Kur</code> düğmesini kullan.</div></main><script>const s=document.getElementById('status');let done=false;window.addEventListener('message',e=>{if(e.origin!==location.origin||e.data?.source!=='streamwatch-browser-bridge')return;done=true;const r=e.data.result||{};if(r.ok){s.className='status ok';s.textContent=r.connected?'Oturum başarıyla aktarıldı. StreamWatch hesabı bağlı.':('Oturum verileri aktarıldı ('+(r.imported||0)+' çerez). StreamWatch bağlantıyı yeniden kontrol edecek.');}else{s.className='status bad';s.textContent='Aktarım başarısız: '+(r.error||'Bilinmeyen hata');}});setTimeout(()=>{if(done)return;s.className='status bad';s.textContent='Browser Bridge eklentisi yanıt vermedi. Eklentiyi bir kez kurup tekrar dene.';},8000);</script></body></html>`;
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${port || 0}`);
  if (req.method === 'GET' && url.pathname === '/streamwatch-session-bridge') {
    const nonce = url.searchParams.get('nonce') || '';
    const request = pending.get(nonce);
    if (!request || request.expiresAt < Date.now()) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('StreamWatch bağlantı isteği süresi doldu.');
      return;
    }
    const body = html(request.platform);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(body);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/import') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(raw || '{}');
        const nonce = String(data.nonce || '');
        const request = pending.get(nonce);
        if (!request || request.expiresAt < Date.now()) return sendJson(res, 410, { error: 'Bağlantı isteği süresi doldu.' });
        if (request.platform !== data.platform) return sendJson(res, 400, { error: 'Platform eşleşmedi.' });
        pending.delete(nonce);

        const imported = await importCookies(request.platform, data.cookies);
        unblock(request.platform);
        const state = await platformState(request.platform);
        const result = {
          success: true,
          platform: request.platform,
          imported,
          connected: state.connected,
          cookieCount: state.cookieCount,
          at: Date.now(),
        };
        store.set(`browserBridgeLastSync.${request.platform}`, result);
        emit(result);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { error: error?.message || 'Oturum verisi işlenemedi.' });
      }
    });
    return;
  }

  sendJson(res, 404, { error: 'Browser Bridge endpointi bulunamadı.' });
}

async function ensureServer() {
  if (server && port) return port;
  for (const candidate of PORTS) {
    try {
      const chosen = await new Promise((resolve, reject) => {
        const instance = http.createServer((req, res) => handleRequest(req, res));
        instance.once('error', reject);
        instance.listen(candidate, '127.0.0.1', () => resolve(instance));
      });
      server = chosen;
      port = candidate;
      server.unref?.();
      return port;
    } catch {
      // Try the next local-only port.
    }
  }
  throw new Error('Browser Bridge için yerel port açılamadı.');
}

async function startImport(platform) {
  if (!PLATFORM_NAMES[platform]) return { error: 'Desteklenmeyen platform.' };
  const browserKey = store.get('selectedBrowser');
  if (browserKey === 'firefox') return { error: 'Browser Bridge şu an Chromium tabanlı Chrome/Brave/Edge/Opera tarayıcılarında destekleniyor.' };

  const chosenPort = await ensureServer();
  const nonce = crypto.randomBytes(32).toString('hex');
  pending.set(nonce, { platform, expiresAt: Date.now() + 120000 });
  for (const [key, value] of pending) if (value.expiresAt < Date.now()) pending.delete(key);

  const url = `http://127.0.0.1:${chosenPort}/streamwatch-session-bridge?platform=${encodeURIComponent(platform)}&nonce=${encodeURIComponent(nonce)}`;
  const browser = await openInSelectedBrowser(url);
  return { success: true, platform, port: chosenPort, ...browser };
}

async function setupExtension() {
  const dir = extensionDir();
  clipboard.writeText(dir);
  try { shell.showItemInFolder(path.join(dir, 'manifest.json')); } catch { }

  const browserKey = store.get('selectedBrowser');
  const executable = browserExecutable(browserKey);
  if (executable && browserKey !== 'firefox') {
    const args = [];
    const profileId = selectedProfileId(browserKey);
    if (profileId && profileId !== '.' && browserKey !== 'opera') args.push(`--profile-directory=${profileId}`);
    args.push('chrome://extensions');
    try {
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    } catch { }
  }
  return { success: true, path: dir, copied: true };
}

ipcMain.handle('browser-bridge-start', (_, platform) => startImport(platform));
ipcMain.handle('browser-bridge-setup', () => setupExtension());
ipcMain.handle('browser-bridge-info', () => ({
  supported: store.get('selectedBrowser') !== 'firefox',
  path: extensionDir(),
  lastSync: {
    youtube: store.get('browserBridgeLastSync.youtube') || null,
    twitch: store.get('browserBridgeLastSync.twitch') || null,
    kick: store.get('browserBridgeLastSync.kick') || null,
  },
}));

app.on('before-quit', () => {
  pending.clear();
  if (server) {
    try { server.close(); } catch { }
  }
  server = null;
  port = null;
});

'use strict';

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const Store = require('electron-store');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const BrowserManager = require('./src/browser-manager');

const store = new Store();
const PLATFORM_DOMAINS = ['youtube.com', 'google.com', 'googleusercontent.com', 'twitch.tv', 'kick.com'];
const LOGIN_URLS = {
  youtube: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F',
  twitch: 'https://www.twitch.tv/login',
  kick: 'https://kick.com/login',
};
const PLATFORM_NAMES = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };

let activeManager = null;
let externalRefreshTimer = null;
let loginWindow = null;

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat|hesabını bağla/i.test(win.getTitle())) || null;
}

function profilePrefs() {
  const value = store.get('selectedBrowserProfiles');
  return value && typeof value === 'object' ? value : {};
}

function selectedProfileId(browserKey) {
  return profilePrefs()[browserKey] || null;
}

function setSelectedProfileId(browserKey, profileId) {
  const prefs = profilePrefs();
  if (profileId) prefs[browserKey] = profileId;
  else delete prefs[browserKey];
  store.set('selectedBrowserProfiles', prefs);
}

function browserRoot(manager, browserKey) {
  return manager?.browserProfiles?.[browserKey] || null;
}

function readLocalState(root) {
  try {
    const file = path.join(root, 'Local State');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function cookiePathFor(profilePath) {
  const network = path.join(profilePath, 'Network', 'Cookies');
  if (fs.existsSync(network)) return network;
  const legacy = path.join(profilePath, 'Cookies');
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

function discoverProfiles(manager, browserKey) {
  const root = browserRoot(manager, browserKey);
  if (!root || !fs.existsSync(root)) return [];

  if (browserKey === 'opera') {
    const cookiesPath = cookiePathFor(root);
    return cookiesPath ? [{ id: '.', name: 'Opera Profili', path: root, cookiesPath, lastUsed: true }] : [];
  }

  const localState = readLocalState(root) || {};
  const infoCache = localState.profile?.info_cache || {};
  const lastUsed = localState.profile?.last_used || 'Default';
  const ids = new Set(Object.keys(infoCache));

  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'Default' || /^Profile \d+$/i.test(entry.name)) ids.add(entry.name);
    }
  } catch { }

  return [...ids]
    .map((id) => {
      const profilePath = path.join(root, id);
      const cookiesPath = cookiePathFor(profilePath);
      if (!cookiesPath) return null;
      let modifiedAt = 0;
      try { modifiedAt = fs.statSync(cookiesPath).mtimeMs; } catch { }
      const cache = infoCache[id] || {};
      return {
        id,
        name: String(cache.name || (id === 'Default' ? 'Varsayılan' : id)),
        path: profilePath,
        cookiesPath,
        lastUsed: id === lastUsed,
        modifiedAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed) || b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name, 'tr'));
}

function chooseProfile(manager, browserKey) {
  const profiles = discoverProfiles(manager, browserKey);
  const wanted = selectedProfileId(browserKey);
  return profiles.find((profile) => profile.id === wanted) || profiles.find((profile) => profile.lastUsed) || profiles[0] || null;
}

function isRelevantDomain(domain) {
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

async function clearPlatformCookies() {
  const ses = session.fromPartition('persist:stream');
  const cookies = await ses.cookies.get({});
  for (const cookie of cookies) {
    if (!isRelevantDomain(cookie.domain)) continue;
    const host = String(cookie.domain || '').replace(/^\./, '');
    const scheme = cookie.secure ? 'https' : 'http';
    const cookiePath = cookie.path || '/';
    try { await ses.cookies.remove(`${scheme}://${host}${cookiePath}`, cookie.name); } catch { }
  }
}

function emitState() {
  getAccountStatus().then((state) => {
    const win = mainWindow();
    if (win && !win.webContents.isDestroyed()) win.webContents.send('account-bridge-state', state);
  }).catch(() => {});
}

function authState(platform, cookies) {
  const names = cookies.map((cookie) => String(cookie.name || ''));
  if (platform === 'youtube') {
    if (names.some((name) => /^(SAPISID|APISID|SID|LOGIN_INFO|__Secure-\d?P?APISID|__Secure-\d?P?SID)$/i.test(name))) return 'connected';
  } else if (platform === 'twitch') {
    if (names.some((name) => /^(auth-token|persistent)$/i.test(name))) return 'connected';
  } else if (platform === 'kick') {
    if (names.some((name) => /(auth|session|token)/i.test(name))) return 'connected';
  }
  return cookies.length ? 'cookies' : 'none';
}

async function getAccountStatus() {
  const selectedBrowser = store.get('selectedBrowser') || null;
  const manager = activeManager || new BrowserManager();
  const profile = selectedBrowser ? chooseProfile(manager, selectedBrowser) : null;
  const ses = session.fromPartition('persist:stream');
  const all = (await ses.cookies.get({})).filter((cookie) => isRelevantDomain(cookie.domain));
  const platforms = {};

  for (const platform of Object.keys(PLATFORM_NAMES)) {
    const cookies = all.filter((cookie) => platformForDomain(cookie.domain) === platform);
    platforms[platform] = {
      state: authState(platform, cookies),
      cookieCount: cookies.length,
    };
  }

  return {
    selectedBrowser,
    selectedProfile: profile ? { id: profile.id, name: profile.name, lastUsed: profile.lastUsed } : null,
    cookieImport: store.get('accountCookieImportState') || null,
    platforms,
  };
}

const originalInitialize = BrowserManager.prototype.initialize;
const originalLoadCookies = BrowserManager.prototype._loadCookies;

BrowserManager.prototype.initialize = async function streamwatchInitialize(browserKey, options = {}) {
  activeManager = this;
  const force = options === true || options?.force === true;
  const profile = chooseProfile(this, browserKey);
  const profileId = profile?.id || null;
  const changed = this.__swBrowserKey !== browserKey || this.__swProfileId !== profileId;

  if (force || changed) {
    this.initialized = false;
    this.cookiesLoaded = false;
    this.cookieStatus = 'unknown';
    this.extensionsLoaded = false;
  }
  this.__swBrowserKey = browserKey;
  this.__swProfileId = profileId;
  const result = await originalInitialize.call(this, browserKey);
  emitState();
  return result;
};

BrowserManager.prototype._loadCookies = async function streamwatchLoadCookies(browserKey) {
  activeManager = this;
  const root = browserRoot(this, browserKey);
  const profile = chooseProfile(this, browserKey);
  if (!root || !profile) {
    this.cookieStatus = browserKey === 'firefox' ? 'unsupported' : 'empty';
    this.cookiesLoaded = false;
    store.set('accountCookieImportState', {
      browser: browserKey,
      profile: null,
      imported: 0,
      status: this.cookieStatus,
      at: Date.now(),
    });
    return;
  }

  this.__swBrowserKey = browserKey;
  this.__swProfileId = profile.id;
  this.streamSession ||= session.fromPartition('persist:stream');
  const localStatePath = path.join(root, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    return originalLoadCookies.call(this, browserKey);
  }

  let sourceSize = 0;
  try { sourceSize = fs.statSync(profile.cookiesPath).size; } catch { }

  try {
    const masterKey = await this._getMasterKey(localStatePath);
    if (!masterKey) throw new Error('Tarayıcı şifreleme anahtarı okunamadı.');
    const cookies = await this._readCookies(profile.cookiesPath, masterKey);
    const relevant = cookies.filter((cookie) => isRelevantDomain(cookie.domain));
    let imported = 0;
    const counts = { youtube: 0, twitch: 0, kick: 0 };

    for (const cookie of relevant) {
      try {
        await this.streamSession.cookies.set(cookie);
        imported += 1;
        const platform = platformForDomain(cookie.domain);
        if (platform) counts[platform] += 1;
      } catch { }
    }

    try { await this.streamSession.flushStorageData(); } catch { }
    this.cookiesLoaded = imported > 0;
    this.cookieStatus = imported > 0 ? 'success' : (sourceSize > 4096 ? 'protected' : 'empty');
    store.set('accountCookieImportState', {
      browser: browserKey,
      profile: profile.id,
      profileName: profile.name,
      imported,
      counts,
      status: this.cookieStatus,
      at: Date.now(),
    });
    console.log(`[AccountBridge] ${browserKey}/${profile.id}: ${imported} platform cookie imported.`);
  } catch (error) {
    this.cookiesLoaded = false;
    this.cookieStatus = sourceSize > 4096 ? 'protected' : 'error';
    store.set('accountCookieImportState', {
      browser: browserKey,
      profile: profile.id,
      profileName: profile.name,
      imported: 0,
      status: this.cookieStatus,
      error: error.message,
      at: Date.now(),
    });
    console.warn('[AccountBridge] Cookie import failed:', error.message);
  }
  emitState();
};

async function refreshCookies({ clear = false } = {}) {
  const browserKey = store.get('selectedBrowser');
  if (!browserKey) return { error: 'Önce bir tarayıcı seçmelisiniz.' };
  const manager = activeManager || new BrowserManager();
  activeManager = manager;
  if (clear) await clearPlatformCookies();
  manager.streamSession ||= session.fromPartition('persist:stream');
  await manager._loadCookies(browserKey);
  return getAccountStatus();
}

function browserExecutable(browserKey) {
  const manager = activeManager || new BrowserManager();
  return manager.getAvailableBrowsers().find((browser) => browser.key === browserKey)?.path || null;
}

async function openExternalLogin(platform) {
  const url = LOGIN_URLS[platform];
  if (!url) return { error: 'Desteklenmeyen platform.' };
  const browserKey = store.get('selectedBrowser');
  const manager = activeManager || new BrowserManager();
  const profile = browserKey ? chooseProfile(manager, browserKey) : null;
  const executable = browserKey ? browserExecutable(browserKey) : null;

  try {
    if (executable) {
      const args = [];
      if (profile && profile.id !== '.' && browserKey !== 'firefox' && browserKey !== 'opera') {
        args.push(`--profile-directory=${profile.id}`);
      }
      args.push(url);
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    } else {
      await shell.openExternal(url);
    }
  } catch (error) {
    await shell.openExternal(url);
  }

  clearInterval(externalRefreshTimer);
  let attempts = 0;
  externalRefreshTimer = setInterval(async () => {
    attempts += 1;
    try { await refreshCookies(); } catch { }
    if (attempts >= 16) {
      clearInterval(externalRefreshTimer);
      externalRefreshTimer = null;
    }
  }, 6000);

  return { success: true, platform, browser: browserKey, profile: profile?.id || null };
}

function openInternalLogin(platform) {
  const url = LOGIN_URLS[platform];
  if (!url) return { error: 'Desteklenmeyen platform.' };
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();

  loginWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    parent: mainWindow() || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0b',
    title: `${PLATFORM_NAMES[platform]} hesabını bağla`,
    webPreferences: {
      session: session.fromPartition('persist:stream'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  loginWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  loginWindow.loadURL(url);
  loginWindow.on('closed', () => {
    loginWindow = null;
    emitState();
  });
  return { success: true };
}

ipcMain.handle('account-bridge-profiles', (_, browserKey) => {
  const manager = activeManager || new BrowserManager();
  return discoverProfiles(manager, browserKey).map(({ id, name, lastUsed }) => ({ id, name, lastUsed }));
});
ipcMain.handle('account-bridge-select-profile', async (_, browserKey, profileId) => {
  setSelectedProfileId(browserKey, profileId);
  await clearPlatformCookies();
  return refreshCookies();
});
ipcMain.handle('account-bridge-refresh', (_, options) => refreshCookies(options || {}));
ipcMain.handle('account-bridge-status', () => getAccountStatus());
ipcMain.handle('account-bridge-open-external', (_, platform) => openExternalLogin(platform));
ipcMain.handle('account-bridge-open-internal', (_, platform) => openInternalLogin(platform));

app.on('before-quit', () => {
  clearInterval(externalRefreshTimer);
  externalRefreshTimer = null;
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.destroy();
});

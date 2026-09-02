'use strict';

const { BrowserWindow, ipcMain, session, shell } = require('electron');
const Store = require('electron-store');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const BrowserManager = require('./src/browser-manager');

const store = new Store();
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

function blockedPlatforms() {
  const value = store.get('accountDisconnectedPlatforms');
  return value && typeof value === 'object' ? value : {};
}

function setBlocked(platform, blocked) {
  const value = blockedPlatforms();
  if (blocked) value[platform] = true;
  else delete value[platform];
  store.set('accountDisconnectedPlatforms', value);
}

function belongsToPlatform(domain, platform) {
  const value = String(domain || '').replace(/^\./, '').toLowerCase();
  return (PLATFORM_DOMAINS[platform] || []).some((candidate) => value === candidate || value.endsWith(`.${candidate}`));
}

function authState(platform, cookies) {
  const names = new Set(cookies.map((cookie) => String(cookie.name || '').toLowerCase()));
  if (platform === 'youtube') {
    const auth = ['sapisid', 'apisid', 'sid', 'login_info', '__secure-1papisid', '__secure-3papisid', '__secure-1psid', '__secure-3psid'];
    if (auth.some((name) => names.has(name))) return 'connected';
  }
  if (platform === 'twitch' && names.has('auth-token')) return 'connected';
  if (platform === 'kick' && (names.has('session_token') || names.has('kick_session'))) return 'connected';
  return cookies.length ? 'cookies' : 'none';
}

function detailFor(platform, state, blocked) {
  if (blocked) return 'Bağlantı kullanıcı tarafından kesildi.';
  if (state === 'connected') return 'StreamWatch oturumu bağlı ve doğrulandı.';
  if (state === 'cookies') return 'StreamWatch oturumunda bazı veriler var fakat giriş doğrulanamadı.';
  const external = store.get(`accountExternalOpen.${platform}`);
  if (external && Date.now() - Number(external) < 10 * 60 * 1000) {
    return 'Hesap seçili tarayıcıda açıldı. StreamWatch oturumu henüz bağlı değil.';
  }
  return 'StreamWatch oturumu bağlı değil.';
}

async function getStatus() {
  const ses = session.fromPartition('persist:stream');
  const allCookies = await ses.cookies.get({});
  const blocked = blockedPlatforms();
  const platforms = {};

  for (const platform of Object.keys(PLATFORM_NAMES)) {
    const isBlocked = Boolean(blocked[platform]);
    const cookies = isBlocked ? [] : allCookies.filter((cookie) => belongsToPlatform(cookie.domain, platform));
    const state = isBlocked ? 'none' : authState(platform, cookies);
    platforms[platform] = {
      state,
      blocked: isBlocked,
      cookieCount: cookies.length,
      detail: detailFor(platform, state, isBlocked),
    };
  }

  const selectedBrowser = store.get('selectedBrowser') || null;
  const prefs = store.get('selectedBrowserProfiles');
  const selectedProfile = selectedBrowser && prefs && typeof prefs === 'object' ? prefs[selectedBrowser] || null : null;
  return { selectedBrowser, selectedProfile, cookieImport: null, platforms };
}

function emitState(state) {
  const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && !/PiP|Chat|hesabını bağla/i.test(item.getTitle()));
  if (win && !win.webContents.isDestroyed()) win.webContents.send('account-bridge-state', state);
}

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
  try {
    return new BrowserManager().getAvailableBrowsers().find((item) => item.key === browserKey)?.path || null;
  } catch {
    return null;
  }
}

async function openExternalNoCookieImport(platform) {
  const url = PLATFORM_URLS[platform];
  if (!url) return { error: 'Desteklenmeyen platform.' };

  setBlocked(platform, false);
  store.set(`accountExternalOpen.${platform}`, Date.now());

  const browserKey = store.get('selectedBrowser') || null;
  const profileId = selectedProfileId(browserKey);
  const executable = browserExecutable(browserKey);

  if (!executable) {
    await shell.openExternal(url);
  } else {
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

  const state = await getStatus();
  emitState(state);
  return {
    success: true,
    platform,
    browser: browserKey,
    profile: profileId,
    cookieImportAttempted: false,
    state,
  };
}

ipcMain.removeHandler('account-bridge-status');
ipcMain.handle('account-bridge-status', () => getStatus());

ipcMain.removeHandler('account-bridge-open-external');
ipcMain.handle('account-bridge-open-external', (_, platform) => openExternalNoCookieImport(platform));

// Eski UI/yerel portal bu kanalı çağırsa bile çerez içe aktarma yapılmasın.
ipcMain.removeHandler('account-bridge-open-portal');
ipcMain.handle('account-bridge-open-portal', (_, platform) => openExternalNoCookieImport(platform));

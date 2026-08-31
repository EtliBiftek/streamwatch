'use strict';

const { app, BrowserWindow, ipcMain, net, session, Notification } = require('electron');
const Store = require('electron-store');
const StreamChecker = require('./src/stream-checker');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const store = new Store();
const checker = new StreamChecker();
checker.cacheTTL = 3000;

const CHECK_DELAY_LIVE = 7000;
const CHECK_DELAY_IDLE = 12000;
const META_TTL = 10000;
const metadataCache = new Map();
let monitorTimer = null;
let monitorBusy = false;
let stopping = false;
let chatWindow = null;
let legacyMinuteTimerSuppressed = false;

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat/i.test(win.getTitle())) || null;
}

function send(channel, payload) {
  const win = mainWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function commandOnPath(command) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(lookup, [command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1800,
    });
    if (result.status !== 0) return null;
    const found = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return found && fs.existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

function pythonScriptCandidates(filename) {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Python'),
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        found.push(path.join(root, entry.name, 'Scripts', filename));
      }
    } catch { }
  }
  return found;
}

function resolveStreamlink() {
  return commandOnPath(process.platform === 'win32' ? 'streamlink.exe' : 'streamlink')
    || pythonScriptCandidates(process.platform === 'win32' ? 'streamlink.exe' : 'streamlink').find((candidate) => fs.existsSync(candidate))
    || null;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const clean = {
    id: meta.id ? String(meta.id).slice(0, 160) : null,
    author: meta.author ? String(meta.author).slice(0, 160) : null,
    title: meta.title ? String(meta.title).slice(0, 300) : null,
    game: (meta.category || meta.game) ? String(meta.category || meta.game).slice(0, 160) : null,
    viewers: Number.isFinite(Number(meta.viewers)) ? Number(meta.viewers) : null,
    updatedAt: Date.now(),
  };
  return clean.id || clean.author || clean.title || clean.game || clean.viewers !== null ? clean : null;
}

function streamlinkMetadata(url) {
  const cached = metadataCache.get(url);
  if (cached && Date.now() - cached.at < META_TTL) return Promise.resolve(cached.value);
  const executable = resolveStreamlink();
  if (!executable) return Promise.resolve(null);

  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const clean = sanitizeMeta(value);
      metadataCache.set(url, { at: Date.now(), value: clean });
      resolve(clean);
    };

    try {
      child = spawn(executable, ['--no-config', '--json', url], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(null);
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
    });
    child.once('error', () => finish(null));
    child.once('close', () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        finish(parsed?.metadata || null);
      } catch {
        finish(null);
      }
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { }
      finish(null);
    }, 6500);
  });
}

async function fetchText(url) {
  const response = await net.fetch(url, {
    session: session.fromPartition('persist:stream'),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function decodeHtml(value) {
  return String(value || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

async function fallbackMetadata(platform, url) {
  try {
    if (platform === 'kick') {
      const username = checker._extractKickUsername(url);
      if (!username) return null;
      const raw = await fetchText(`https://kick.com/api/v2/channels/${encodeURIComponent(username)}`);
      const data = JSON.parse(raw);
      const live = data?.livestream;
      if (!live) return null;
      return sanitizeMeta({
        id: live.id,
        author: data?.user?.username || username,
        title: live.session_title || data?.livestream?.session_title,
        category: live.categories?.[0]?.name || data?.recent_categories?.[0]?.name || data?.category?.name,
        viewers: live.viewer_count,
      });
    }

    if (platform === 'youtube') {
      const html = await fetchText(`${String(url).replace(/\/$/, '')}/live`);
      const title = html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
      return sanitizeMeta({ title: decodeHtml(title) });
    }

    if (platform === 'twitch') {
      const html = await fetchText(url);
      const title = html.match(/"broadcastSettings"\s*:\s*\{[^{}]{0,1200}?"title"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1];
      const game = html.match(/"game"\s*:\s*\{[^{}]{0,500}?"name"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1];
      const parseJsonString = (value) => {
        if (!value) return null;
        try { return JSON.parse(`"${value}"`); } catch { return value; }
      };
      return sanitizeMeta({ title: parseJsonString(title), category: parseJsonString(game) });
    }
  } catch { }
  return null;
}

async function getMetadata(platform, url) {
  const viaStreamlink = await streamlinkMetadata(url);
  if (viaStreamlink) return viaStreamlink;
  return fallbackMetadata(platform, url);
}

async function checkPlatform(channel, platform) {
  const url = channel?.[platform];
  if (!url) return { live: false, meta: null };
  try {
    let live = false;
    if (platform === 'youtube') live = await checker._checkYouTube(url);
    else if (platform === 'twitch') live = await checker._checkTwitch(url);
    else if (platform === 'kick') live = await checker._checkKick(url);
    const meta = live ? await getMetadata(platform, url) : null;
    return { live: Boolean(live), meta };
  } catch {
    return { live: Boolean(channel?.isLive?.[platform]), meta: channel?.streamMeta?.[platform] || null };
  }
}

function showLiveNotification(channel, platform) {
  if (channel.notificationsEnabled === false || !Notification.isSupported()) return;
  const platformName = platform === 'youtube' ? 'YouTube' : platform === 'twitch' ? 'Twitch' : 'Kick';
  const meta = channel.streamMeta?.[platform];
  const notification = new Notification({
    title: `${channel.name} Canlı Yayında!`,
    body: meta?.title || `${channel.name} ${platformName} üzerinde yayın başlattı.`,
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  notification.on('click', () => {
    const win = mainWindow();
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
    win.webContents.send('open-stream-from-notification', {
      channelId: channel.id,
      platform,
      url: channel[platform],
    });
  });
  notification.show();
}

async function runMonitorPass(forceEmit = false) {
  if (monitorBusy || stopping) return store.get('channels') || [];
  monitorBusy = true;
  try {
    const channels = store.get('channels') || [];
    if (!channels.length) return channels;

    let changed = false;
    let anyLive = false;
    const nextChannels = await Promise.all(channels.map(async (channel) => {
      const before = JSON.stringify({ isLive: channel.isLive || {}, streamMeta: channel.streamMeta || {} });
      const results = await Promise.all(['youtube', 'twitch', 'kick'].map(async (platform) => [platform, await checkPlatform(channel, platform)]));
      const updated = { ...channel, isLive: { ...(channel.isLive || {}) }, streamMeta: { ...(channel.streamMeta || {}) } };

      for (const [platform, result] of results) {
        const wasLive = Boolean(channel?.isLive?.[platform]);
        updated.isLive[platform] = result.live;
        if (result.live) {
          anyLive = true;
          if (result.meta) updated.streamMeta[platform] = result.meta;
          if (!wasLive) showLiveNotification(updated, platform);
        } else {
          delete updated.streamMeta[platform];
        }
      }

      const livePlatform = ['youtube', 'twitch', 'kick'].find((platform) => updated.isLive?.[platform] && updated[platform]);
      updated.liveTitle = livePlatform ? updated.streamMeta?.[livePlatform]?.title || null : null;
      updated.liveGame = livePlatform ? updated.streamMeta?.[livePlatform]?.game || null : null;

      const after = JSON.stringify({ isLive: updated.isLive, streamMeta: updated.streamMeta });
      if (before !== after) changed = true;
      return updated;
    }));

    store.set('channels', nextChannels);
    if (changed || forceEmit) send('channels-updated', nextChannels);
    return { channels: nextChannels, anyLive };
  } finally {
    monitorBusy = false;
  }
}

async function monitorLoop() {
  if (stopping) return;
  let delay = CHECK_DELAY_IDLE;
  try {
    const result = await runMonitorPass(false);
    if (result?.anyLive) delay = CHECK_DELAY_LIVE;
  } catch (error) {
    console.warn('[LiveTools] Monitor error:', error.message);
  }
  clearTimeout(monitorTimer);
  monitorTimer = setTimeout(monitorLoop, delay);
}

function extractUsername(url, platform) {
  const patterns = {
    twitch: /twitch\.tv\/([^/?#]+)/i,
    kick: /kick\.com\/([^/?#]+)/i,
  };
  return String(url || '').match(patterns[platform])?.[1] || null;
}

async function resolveYoutubeVideoId(url) {
  try {
    const direct = new URL(url);
    const id = direct.searchParams.get('v');
    if (id) return id;
  } catch { }
  try {
    const html = await fetchText(`${String(url).replace(/\/$/, '')}/live`);
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1];
    if (canonical) return new URL(canonical).searchParams.get('v');
  } catch { }
  return null;
}

async function chatUrlFor(entry) {
  const platform = entry?.platform || (String(entry?.url || '').includes('twitch.tv') ? 'twitch' : String(entry?.url || '').includes('kick.com') ? 'kick' : 'youtube');
  if (platform === 'twitch') {
    const username = extractUsername(entry.url, 'twitch');
    return username ? `https://www.twitch.tv/popout/${encodeURIComponent(username)}/chat?popout=` : null;
  }
  if (platform === 'kick') {
    const username = extractUsername(entry.url, 'kick');
    return username ? `https://kick.com/popout/${encodeURIComponent(username)}/chat` : null;
  }
  if (platform === 'youtube') {
    const videoId = await resolveYoutubeVideoId(entry.url);
    return videoId ? `https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}&is_popout=1` : null;
  }
  return null;
}

function emitChatState() {
  send('live-tools-chat-state', { active: Boolean(chatWindow && !chatWindow.isDestroyed()) });
}

async function openChat(entry) {
  if (!entry?.url) return { error: 'Önce bir yayın açmalısınız.' };
  const url = await chatUrlFor(entry);
  if (!url) return { error: 'Bu yayın için sohbet bağlantısı bulunamadı.' };

  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
  chatWindow = new BrowserWindow({
    width: 420,
    height: 720,
    minWidth: 320,
    minHeight: 420,
    title: 'StreamWatch Chat',
    backgroundColor: '#0a0a0b',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      partition: 'persist:stream',
      contextIsolation: true,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  chatWindow.setMenuBarVisibility(false);
  chatWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chatWindow.on('closed', () => {
    chatWindow = null;
    emitChatState();
  });
  await chatWindow.loadURL(url);
  emitChatState();
  return { success: true, url };
}

ipcMain.handle('live-tools-check-now', () => runMonitorPass(true));
ipcMain.handle('live-tools-chat-open', (_, entry) => openChat(entry));
ipcMain.handle('live-tools-chat-close', () => {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
  return true;
});
ipcMain.handle('live-tools-chat-state', () => ({ active: Boolean(chatWindow && !chatWindow.isDestroyed()) }));

// main.js'nin eski 60 saniyelik kontrolünü yalnızca ilk kayıt sırasında bastırıyoruz.
// Yerine yukarıdaki adaptif, metadata destekli canlı monitör çalışıyor.
const nativeSetInterval = global.setInterval;
global.setInterval = function streamwatchInterval(callback, delay, ...args) {
  if (!legacyMinuteTimerSuppressed && Number(delay) === 60000) {
    legacyMinuteTimerSuppressed = true;
    console.log('[LiveTools] Legacy 60s stream polling disabled.');
    return { __streamwatchSuppressed: true, ref() { return this; }, unref() { return this; } };
  }
  return nativeSetInterval(callback, delay, ...args);
};

app.whenReady().then(() => {
  // main.js ready callback'inin 60s timer'ını kaydetmesine zaman ver, sonra native davranışı geri getir.
  setTimeout(() => {
    if (global.setInterval !== nativeSetInterval) global.setInterval = nativeSetInterval;
  }, 2500);
  setTimeout(() => runMonitorPass(true).finally(() => monitorLoop()), 3000);
});

app.on('before-quit', () => {
  stopping = true;
  clearTimeout(monitorTimer);
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.destroy();
});

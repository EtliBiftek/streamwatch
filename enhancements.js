const electron = require('electron');
const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  Tray,
  ipcMain,
  net,
  session,
  webContents,
} = electron;
const Store = require('electron-store');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodeNet = require('net');

const DISCORD_CLIENT_ID = '1543965790280359946';
const store = new Store();
store.set('discordClientId', DISCORD_CLIENT_ID);
if (store.get('lightweightMode') === undefined) store.set('lightweightMode', false);
if (!Array.isArray(store.get('broadcastLog'))) store.set('broadcastLog', []);

let presenceEntry = null;
let discordSocket = null;
let capturedTray = null;
let multiBindings = new Map();
let trayRefreshTimer = null;
let broadcastTimer = null;
let liveSnapshot = null;

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !win.getTitle().includes('PiP')) || null;
}

function channelForUrl(url) {
  const channels = store.get('channels') || [];
  return channels.find((channel) => ['youtube', 'twitch', 'kick'].some((platform) => channel[platform] === url)) || null;
}

function platformForUrl(channel, url) {
  if (!channel) return 'web';
  return ['youtube', 'twitch', 'kick'].find((platform) => channel[platform] === url) || 'web';
}

function presenceFromUrl(url, meta = {}) {
  const channel = channelForUrl(url);
  return {
    url,
    channelId: meta.channelId || channel?.id || null,
    channelName: meta.channelName || channel?.name || 'StreamWatch',
    platform: meta.platform || platformForUrl(channel, url),
    avatarUrl: meta.avatarUrl || channel?.avatarUrl || null,
  };
}

function patchDiscordSocket() {
  const originalCreateConnection = nodeNet.createConnection.bind(nodeNet);
  nodeNet.createConnection = (...args) => {
    const socket = originalCreateConnection(...args);
    const target = String(typeof args[0] === 'string' ? args[0] : args[0]?.path || '');
    if (!target.includes('discord-ipc-')) return socket;

    discordSocket = socket;
    const originalWrite = socket.write.bind(socket);
    socket.write = (chunk, ...rest) => {
      try {
        if (Buffer.isBuffer(chunk) && chunk.length >= 8 && chunk.readInt32LE(0) === 1) {
          const length = chunk.readInt32LE(4);
          if (chunk.length >= 8 + length) {
            const payload = JSON.parse(chunk.subarray(8, 8 + length).toString('utf8'));
            const activity = payload?.args?.activity;
            const avatar = presenceEntry?.avatarUrl;
            if (activity && avatar && /^https?:\/\//i.test(avatar) && avatar.length <= 300) {
              activity.assets = {
                ...(activity.assets || {}),
                large_image: avatar,
                large_text: String(presenceEntry.channelName || 'StreamWatch').slice(0, 128),
              };
              const body = Buffer.from(JSON.stringify(payload), 'utf8');
              const header = Buffer.alloc(8);
              header.writeInt32LE(1, 0);
              header.writeInt32LE(body.length, 4);
              chunk = Buffer.concat([header, body]);
            }
          }
        }
      } catch (error) {
        console.warn('[Enhancements] Discord asset injection failed:', error.message);
      }
      return originalWrite(chunk, ...rest);
    };
    socket.once('close', () => {
      if (discordSocket === socket) discordSocket = null;
    });
    return socket;
  };
}

function sendDiscordActivity(activity) {
  if (!store.get('discordEnabled') || !discordSocket || discordSocket.destroyed) return;
  try {
    const payload = {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: crypto.randomUUID(),
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(1, 0);
    header.writeInt32LE(body.length, 4);
    discordSocket.write(Buffer.concat([header, body]));
  } catch (error) {
    console.warn('[Enhancements] Discord activity update failed:', error.message);
  }
}

function patchFeatureHandlers() {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel === 'feature-get-setting') {
      return originalHandle(channel, (event, key, ...args) => {
        if (key === 'discordClientId') return DISCORD_CLIENT_ID;
        return listener(event, key, ...args);
      });
    }
    if (channel === 'feature-set-setting') {
      return originalHandle(channel, (event, key, value, ...args) => {
        if (key === 'discordClientId') {
          store.set('discordClientId', DISCORD_CLIENT_ID);
          return true;
        }
        return listener(event, key, value, ...args);
      });
    }
    if (channel === 'feature-watch-start') {
      return originalHandle(channel, (event, url, meta, ...args) => {
        presenceEntry = presenceFromUrl(url, meta);
        return listener(event, url, meta, ...args);
      });
    }
    if (channel === 'feature-watch-stop') {
      return originalHandle(channel, async (event, ...args) => {
        const result = await listener(event, ...args);
        presenceEntry = null;
        return result;
      });
    }
    if (channel === 'feature-open-multiview') {
      return originalHandle(channel, async (event, entries, ...args) => {
        const before = new Set(webContents.getAllWebContents().map((contents) => contents.id));
        presenceEntry = entries?.[0] ? presenceFromUrl(entries[0].url, entries[0]) : null;
        const result = await listener(event, entries, ...args);
        setTimeout(() => {
          const created = webContents.getAllWebContents().filter((contents) => !before.has(contents.id) && !contents.isDestroyed());
          multiBindings = new Map();
          (entries || []).forEach((entry, index) => {
            if (created[index]) multiBindings.set(entry.url, created[index].id);
          });
        }, 250);
        return result;
      });
    }
    if (channel === 'feature-close-multiview') {
      return originalHandle(channel, async (event, ...args) => {
        const result = await listener(event, ...args);
        multiBindings.clear();
        return result;
      });
    }
    return originalHandle(channel, listener);
  };
}

patchDiscordSocket();
patchFeatureHandlers();

const originalSetContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function patchedSetContextMenu(menu) {
  capturedTray = this;
  return originalSetContextMenu.call(this, menu);
};

function openChannelFromTray(channel, platform) {
  const win = mainWindow();
  if (!win) return;
  win.show();
  win.focus();
  win.webContents.send('open-stream-from-notification', {
    channelId: channel.id,
    platform,
    url: channel[platform],
  });
}

function refreshTrayMenu() {
  if (!capturedTray || capturedTray.isDestroyed()) return;
  const channels = store.get('channels') || [];
  const live = channels
    .filter((channel) => channel.isLive && Object.values(channel.isLive).some(Boolean))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || String(a.name).localeCompare(String(b.name), 'tr'));

  const liveItems = live.slice(0, 10).map((channel) => {
    const platforms = ['youtube', 'twitch', 'kick'].filter((platform) => channel.isLive?.[platform] && channel[platform]);
    const label = `${channel.favorite ? '★ ' : ''}${channel.name}`;
    if (platforms.length <= 1) {
      const platform = platforms[0];
      return { label, click: () => platform && openChannelFromTray(channel, platform) };
    }
    return {
      label,
      submenu: platforms.map((platform) => ({
        label: platform.charAt(0).toUpperCase() + platform.slice(1),
        click: () => openChannelFromTray(channel, platform),
      })),
    };
  });

  const win = mainWindow();
  const template = [
    { label: live.length ? `Canlı Yayınlar (${live.length})` : 'Canlı yayın yok', enabled: false },
    ...liveItems,
    { type: 'separator' },
    { label: 'Göster', click: () => { win?.show(); win?.focus(); } },
    { label: 'Gizle', click: () => win?.hide() },
    { type: 'separator' },
    { label: 'Çıkış', click: () => app.quit() },
  ];
  originalSetContextMenu.call(capturedTray, Menu.buildFromTemplate(template));
}

function pollBroadcastLog() {
  const channels = store.get('channels') || [];
  const next = new Map();
  for (const channel of channels) {
    for (const platform of ['youtube', 'twitch', 'kick']) {
      const key = `${channel.id}:${platform}`;
      const current = Boolean(channel?.isLive?.[platform]);
      next.set(key, current);
      if (liveSnapshot && liveSnapshot.has(key) && liveSnapshot.get(key) !== current) {
        const log = store.get('broadcastLog') || [];
        log.unshift({
          type: current ? 'start' : 'end',
          at: Date.now(),
          channelId: channel.id,
          channelName: channel.name,
          platform,
          url: channel[platform] || null,
          avatarUrl: channel.avatarUrl || null,
        });
        store.set('broadcastLog', log.slice(0, 1000));
      }
    }
  }
  liveSnapshot = next;
}

function injectCompactPlayer(contents, url) {
  let css = 'html,body{background:#000!important;}body{overflow:hidden!important;}';
  if (/youtube\.com|youtu\.be/i.test(url)) {
    css += 'ytd-masthead,#secondary,#below,#comments,ytd-watch-metadata,#related,ytd-guide-renderer,ytd-mini-guide-renderer{display:none!important;}';
  } else if (/twitch\.tv/i.test(url)) {
    css += '.side-nav,[data-a-target="top-nav-container"],[data-test-selector="chat-room-component-layout"],.channel-root__right-column{display:none!important;}';
  } else if (/kick\.com/i.test(url)) {
    css += 'nav,aside,[data-testid*="chat"],[class*="chatroom"],[class*="sidebar"]{display:none!important;}';
  }
  contents.insertCSS(css).catch(() => {});
}

function mediaVolumeKey(url) {
  return `streamVolume:${url}`;
}

function savedVolume(url, fallback = 0) {
  const value = store.get(mediaVolumeKey(url));
  return value === undefined ? fallback : Math.max(0, Math.min(100, Number(value)));
}

function applyVolumeToContents(contents, volume) {
  if (!contents || contents.isDestroyed()) return;
  const normalized = Math.max(0, Math.min(100, Number(volume))) / 100;
  try { contents.setAudioMuted(normalized <= 0); } catch { }
  contents.executeJavaScript(`(() => { for (const media of document.querySelectorAll('video,audio')) { media.muted = ${normalized <= 0}; media.volume = ${normalized}; } })()`).catch(() => {});
}

function contentsForUrl(url) {
  const boundId = multiBindings.get(url);
  if (boundId) {
    const bound = webContents.fromId(boundId);
    if (bound && !bound.isDestroyed()) return [bound];
  }
  const target = String(url || '');
  const host = (() => { try { return new URL(target).host; } catch { return ''; } })();
  return webContents.getAllWebContents().filter((contents) => {
    if (contents.isDestroyed()) return false;
    const current = contents.getURL();
    if (!current || current.startsWith('file:')) return false;
    if (current === target) return true;
    if (!host) return false;
    try { return new URL(current).host === host; } catch { return false; }
  });
}

class PreviewManager {
  constructor() {
    this.view = null;
    this.win = null;
  }

  async open(entry, bounds) {
    if (store.get('lightweightMode')) return { disabled: true };
    const win = mainWindow();
    if (!win || !entry?.url) return { error: 'Önizleme açılamadı.' };
    this.close();
    this.win = win;
    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition('persist:stream'),
        contextIsolation: true,
        sandbox: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.view = view;
    win.contentView.addChildView(view);
    const width = 320;
    const height = 180;
    const [winWidth, winHeight] = win.getContentSize();
    const x = Math.min(Math.max(0, Number(bounds?.x || 288)), Math.max(0, winWidth - width - 8));
    const y = Math.min(Math.max(42, Number(bounds?.y || 48)), Math.max(42, winHeight - height - 8));
    view.setBounds({ x, y, width, height });
    view.webContents.setAudioMuted(true);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('did-finish-load', () => {
      injectCompactPlayer(view.webContents, view.webContents.getURL());
      view.webContents.executeJavaScript("document.querySelectorAll('video,audio').forEach(m=>{m.muted=true;m.play().catch(()=>{});})").catch(() => {});
    });
    await view.webContents.loadURL(entry.url);
    return { success: true };
  }

  close() {
    if (!this.view) return;
    try { this.win?.contentView.removeChildView(this.view); } catch { }
    try { this.view.webContents.close(); } catch { }
    this.view = null;
    this.win = null;
  }
}

class TournamentManager {
  constructor() {
    this.views = [];
    this.win = null;
    this.hidden = false;
    this.startedAt = 0;
    this.resizeHandler = () => this.resize();
  }

  state() {
    return {
      active: this.views.length > 0,
      count: this.views.length,
      entries: this.views.map(({ entry }) => entry),
    };
  }

  emit() {
    const win = mainWindow();
    if (win && !win.webContents.isDestroyed()) win.webContents.send('enhancement-tournament-state', this.state());
  }

  async open(entries) {
    const clean = (entries || []).filter((entry) => entry?.url).slice(0, 6);
    if (!clean.length) return { error: 'En az bir yayın seçmelisiniz.' };
    this.close();
    const win = mainWindow();
    if (!win) return { error: 'Ana pencere bulunamadı.' };
    this.win = win;
    this.startedAt = Date.now();
    presenceEntry = presenceFromUrl(clean[0].url, clean[0]);

    for (let index = 0; index < clean.length; index += 1) {
      const entry = clean[index];
      const view = new WebContentsView({
        webPreferences: {
          session: session.fromPartition('persist:stream'),
          contextIsolation: true,
          sandbox: false,
          autoplayPolicy: 'no-user-gesture-required',
        },
      });
      win.contentView.addChildView(view);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('did-finish-load', () => {
        injectCompactPlayer(view.webContents, view.webContents.getURL());
        applyVolumeToContents(view.webContents, savedVolume(entry.url, index === 0 ? 100 : 0));
      });
      view.webContents.loadURL(entry.url);
      this.views.push({ view, entry });
    }

    this.resize();
    for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(event, this.resizeHandler);
    this.emit();
    setTimeout(() => {
      if (!store.get('discordEnabled')) return;
      sendDiscordActivity({
        details: 'Turnuva modu',
        state: `${clean.length} yayın aynı anda`,
        timestamps: { start: Math.floor(this.startedAt / 1000) },
        assets: presenceEntry?.avatarUrl ? {
          large_image: presenceEntry.avatarUrl,
          large_text: presenceEntry.channelName,
        } : undefined,
        instance: false,
      });
    }, 600);
    return { success: true, ...this.state() };
  }

  resize() {
    if (!this.win || this.win.isDestroyed() || !this.views.length) return;
    const [width, height] = this.win.getContentSize();
    const fullscreen = this.win.isFullScreen();
    const y = fullscreen ? 0 : 40;
    const availableH = Math.max(1, height - y);
    const count = this.views.length;
    const cols = count <= 2 ? count : count === 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    const gap = 3;
    const cellW = Math.floor((width - gap * (cols - 1)) / cols);
    const cellH = Math.floor((availableH - gap * (rows - 1)) / rows);
    this.views.forEach(({ view }, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const lastRowCount = count - row * cols;
      const isLastPartial = row === rows - 1 && lastRowCount < cols;
      const rowWidth = isLastPartial ? lastRowCount * cellW + (lastRowCount - 1) * gap : width;
      const offset = isLastPartial ? Math.floor((width - rowWidth) / 2) : 0;
      view.setBounds({
        x: offset + col * (cellW + gap),
        y: y + row * (cellH + gap),
        width: cellW,
        height: cellH,
      });
      view.setVisible(!this.hidden);
    });
  }

  hide() {
    this.hidden = true;
    this.views.forEach(({ view }) => view.setVisible(false));
  }

  show() {
    this.hidden = false;
    this.views.forEach(({ view }) => view.setVisible(true));
    this.resize();
  }

  close() {
    const hadViews = this.views.length > 0;
    if (this.win && !this.win.isDestroyed()) {
      for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) this.win.removeListener(event, this.resizeHandler);
    }
    if (hadViews && this.startedAt) {
      const endedAt = Date.now();
      const durationSec = Math.max(1, Math.round((endedAt - this.startedAt) / 1000));
      const history = store.get('watchHistory') || [];
      for (const { entry } of this.views) {
        const resolved = presenceFromUrl(entry.url, entry);
        history.unshift({ ...resolved, startedAt: this.startedAt, endedAt, durationSec, mode: 'tournament' });
      }
      store.set('watchHistory', history.slice(0, 2000));
    }
    for (const { view } of this.views) {
      try { this.win?.contentView.removeChildView(view); } catch { }
      try { view.webContents.close(); } catch { }
    }
    this.views = [];
    this.win = null;
    this.hidden = false;
    this.startedAt = 0;
    if (hadViews) sendDiscordActivity(null);
    this.emit();
  }
}

const preview = new PreviewManager();
const tournament = new TournamentManager();

ipcMain.handle('enhancement-preview-open', (_, entry, bounds) => preview.open(entry, bounds));
ipcMain.handle('enhancement-preview-close', () => { preview.close(); return true; });
ipcMain.handle('enhancement-tournament-open', (_, entries) => tournament.open(entries));
ipcMain.handle('enhancement-tournament-close', () => { tournament.close(); return true; });
ipcMain.handle('enhancement-tournament-hide', () => { tournament.hide(); return true; });
ipcMain.handle('enhancement-tournament-show', () => { tournament.show(); return true; });
ipcMain.handle('enhancement-tournament-state', () => tournament.state());
ipcMain.handle('enhancement-set-volume', (_, url, volume) => {
  const normalized = Math.max(0, Math.min(100, Number(volume)));
  store.set(mediaVolumeKey(url), normalized);
  for (const contents of contentsForUrl(url)) applyVolumeToContents(contents, normalized);
  return normalized;
});
ipcMain.handle('enhancement-get-volumes', (_, urls) => Object.fromEntries((urls || []).map((url, index) => [url, savedVolume(url, index === 0 ? 100 : 0)])));
ipcMain.handle('enhancement-release-notes', async () => {
  try {
    const response = await net.fetch('https://api.github.com/repos/EtliBiftek/streamwatch/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'streamwatch-updater' },
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const release = await response.json();
    return {
      version: String(release.tag_name || '').replace(/^v/i, ''),
      title: release.name || release.tag_name || 'Yeni sürüm',
      notes: release.body || 'Bu sürüm için değişiklik notu eklenmemiş.',
      url: release.html_url || null,
      publishedAt: release.published_at || null,
    };
  } catch (error) {
    return { error: error.message };
  }
});
ipcMain.handle('enhancement-discord-client-id', () => DISCORD_CLIENT_ID);

require('./bootstrap.js');

function injectEnhancementRenderer(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const css = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'enhancements.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'enhancements.js'), 'utf8');
    win.webContents.insertCSS(css).catch(() => {});
    win.webContents.executeJavaScript(js).catch((error) => console.error('[Enhancements] Renderer injection failed:', error));
  } catch (error) {
    console.error('[Enhancements] Renderer files could not be injected:', error);
  }
}

app.whenReady().then(() => {
  const attach = () => {
    const win = mainWindow();
    if (!win) return setTimeout(attach, 250);
    setTimeout(() => injectEnhancementRenderer(win), 650);
    win.webContents.on('did-finish-load', () => setTimeout(() => injectEnhancementRenderer(win), 700));
    setTimeout(refreshTrayMenu, 1200);
    trayRefreshTimer = setInterval(refreshTrayMenu, 15000);
    pollBroadcastLog();
    broadcastTimer = setInterval(pollBroadcastLog, 10000);
  };
  setTimeout(attach, 350);
});

app.on('before-quit', () => {
  clearInterval(trayRefreshTimer);
  clearInterval(broadcastTimer);
  preview.close();
  tournament.close();
});

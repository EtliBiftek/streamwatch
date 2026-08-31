const electron = require('electron');
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  net,
  session,
} = electron;
const Store = require('electron-store');
const fs = require('fs');
const path = require('path');
const nodeNet = require('net');
const { spawn } = require('child_process');
const crypto = require('crypto');

const featureStore = new Store();

const FEATURE_DEFAULTS = {
  smartNotificationsEnabled: true,
  quietHoursEnabled: false,
  quietHoursStart: '00:00',
  quietHoursEnd: '08:00',
  discordEnabled: false,
  discordClientId: '',
};

for (const [key, value] of Object.entries(FEATURE_DEFAULTS)) {
  if (featureStore.get(key) === undefined) featureStore.set(key, value);
}

function getMainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null;
}

function sendToRenderer(channel, payload) {
  const win = getMainWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function isQuietTime(start, end) {
  const [startH, startM] = String(start || '00:00').split(':').map(Number);
  const [endH, endM] = String(end || '08:00').split(':').map(Number);
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return current >= startMinutes && current < endMinutes;
  return current >= startMinutes || current < endMinutes;
}

function installSmartNotificationLayer() {
  const Notification = electron.Notification;
  if (!Notification?.prototype?.show || Notification.prototype.__streamwatchSmartPatched) return;

  const nativeShow = Notification.prototype.show;
  const recent = new Map();

  Notification.prototype.show = function streamwatchSmartShow() {
    if (featureStore.get('smartNotificationsEnabled') === false) return;

    const title = String(this.title || 'streamwatch');
    const body = String(this.body || '');
    const dedupeKey = `${title}\n${body}`;
    const now = Date.now();
    const lastShown = recent.get(dedupeKey) || 0;

    if (now - lastShown < 120000) return;
    recent.set(dedupeKey, now);

    for (const [key, time] of recent) {
      if (now - time > 10 * 60 * 1000) recent.delete(key);
    }

    if (featureStore.get('quietHoursEnabled') && isQuietTime(
      featureStore.get('quietHoursStart'),
      featureStore.get('quietHoursEnd')
    )) {
      try { this.silent = true; } catch { }
    }

    const history = featureStore.get('notificationHistory') || [];
    history.unshift({ title, body, at: now });
    featureStore.set('notificationHistory', history.slice(0, 100));

    return nativeShow.call(this);
  };

  Notification.prototype.__streamwatchSmartPatched = true;
}

class DiscordPresence {
  constructor(store) {
    this.store = store;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.retryTimer = null;
    this.currentActivity = null;
  }

  get enabled() {
    return this.store.get('discordEnabled') === true;
  }

  get clientId() {
    return String(this.store.get('discordClientId') || process.env.STREAMWATCH_DISCORD_CLIENT_ID || '').trim();
  }

  getStatus() {
    return {
      enabled: this.enabled,
      configured: Boolean(this.clientId),
      connected: this.connected,
    };
  }

  reconfigure() {
    this.disconnect(false);
    if (this.enabled && this.clientId) this.connect();
    this.emitStatus();
  }

  connect() {
    if (!this.enabled || !this.clientId || this.connected || this.connecting) return;
    this.connecting = true;
    this.tryPipe(0);
  }

  getPipePath(index) {
    if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${index}`;
    const runtime = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';
    return path.join(runtime, `discord-ipc-${index}`);
  }

  tryPipe(index) {
    if (index > 9) {
      this.connecting = false;
      this.connected = false;
      this.emitStatus();
      this.scheduleRetry();
      return;
    }

    const socket = nodeNet.createConnection(this.getPipePath(index));
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      this.tryPipe(index + 1);
    };

    socket.once('error', fail);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.removeListener('error', fail);
      this.socket = socket;
      this.connecting = false;
      this.connected = true;
      this.bindSocket(socket);
      this.sendFrame(0, { v: 1, client_id: this.clientId });
      setTimeout(() => this.flushActivity(), 250);
      this.emitStatus();
    });
  }

  bindSocket(socket) {
    socket.on('error', () => this.handleDisconnect());
    socket.on('close', () => this.handleDisconnect());
  }

  handleDisconnect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch { }
    }
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.emitStatus();
    this.scheduleRetry();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.enabled || !this.clientId) return;
    this.retryTimer = setTimeout(() => this.connect(), 15000);
  }

  disconnect(clearActivity = true) {
    clearTimeout(this.retryTimer);
    if (clearActivity && this.connected) {
      try { this.sendActivity(null); } catch { }
    }
    if (this.socket) {
      try { this.socket.destroy(); } catch { }
    }
    this.socket = null;
    this.connected = false;
    this.connecting = false;
  }

  sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(opcode, 0);
    header.writeInt32LE(body.length, 4);
    this.socket.write(Buffer.concat([header, body]));
  }

  sendActivity(activity) {
    this.sendFrame(1, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: crypto.randomUUID(),
    });
  }

  setActivity(details, state) {
    this.currentActivity = {
      details: String(details || 'streamwatch').slice(0, 128),
      state: String(state || '').slice(0, 128),
      timestamps: { start: Math.floor(Date.now() / 1000) },
      instance: false,
    };
    if (!this.enabled || !this.clientId) return;
    if (!this.connected) this.connect();
    else this.flushActivity();
  }

  clearActivity() {
    this.currentActivity = null;
    if (this.connected) this.sendActivity(null);
  }

  flushActivity() {
    if (!this.connected) return;
    this.sendActivity(this.currentActivity);
  }

  emitStatus() {
    sendToRenderer('feature-discord-status', this.getStatus());
  }
}

class WatchTracker {
  constructor(store, discord) {
    this.store = store;
    this.discord = discord;
    this.single = null;
    this.multi = [];
  }

  resolve(url, meta = {}) {
    const channels = this.store.get('channels') || [];
    const channel = channels.find((item) => ['youtube', 'twitch', 'kick'].some((platform) => item[platform] === url));
    let platform = meta.platform || 'web';
    if (channel) {
      platform = ['youtube', 'twitch', 'kick'].find((key) => channel[key] === url) || platform;
    } else if (/youtube\.com|youtu\.be/i.test(url)) platform = 'youtube';
    else if (/twitch\.tv/i.test(url)) platform = 'twitch';
    else if (/kick\.com/i.test(url)) platform = 'kick';

    return {
      url,
      channelId: meta.channelId || channel?.id || null,
      channelName: meta.channelName || channel?.name || 'Bilinmeyen kanal',
      platform,
    };
  }

  start(url, meta = {}) {
    if (!url) return null;
    const resolved = this.resolve(url, meta);
    if (this.single?.url === url && this.multi.length === 0) return this.single;
    this.stop();
    this.stopMulti();
    this.single = { ...resolved, startedAt: Date.now(), mode: 'single' };
    this.discord.setActivity(`${resolved.channelName} izleniyor`, this.platformName(resolved.platform));
    sendToRenderer('feature-watch-state', this.getCurrent());
    return this.single;
  }

  stop() {
    if (!this.single) return;
    this.finishSession(this.single);
    this.single = null;
    if (this.multi.length === 0) this.discord.clearActivity();
    sendToRenderer('feature-watch-state', this.getCurrent());
  }

  startMulti(entries) {
    this.stop();
    this.stopMulti();
    const startedAt = Date.now();
    this.multi = entries.map((entry) => ({ ...this.resolve(entry.url, entry), startedAt, mode: 'multi' }));
    if (this.multi.length) {
      this.discord.setActivity('Multi-View izleniyor', `${this.multi.length} yayın açık`);
    }
    sendToRenderer('feature-watch-state', this.getCurrent());
  }

  stopMulti() {
    if (!this.multi.length) return;
    for (const session of this.multi) this.finishSession(session);
    this.multi = [];
    if (!this.single) this.discord.clearActivity();
    sendToRenderer('feature-watch-state', this.getCurrent());
  }

  finishSession(session) {
    const endedAt = Date.now();
    const durationSec = Math.max(1, Math.round((endedAt - session.startedAt) / 1000));
    const history = this.store.get('watchHistory') || [];
    history.unshift({ ...session, endedAt, durationSec });
    this.store.set('watchHistory', history.slice(0, 2000));
  }

  platformName(platform) {
    return { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' }[platform] || 'Yayın';
  }

  getCurrent() {
    if (this.multi.length) return { mode: 'multi', entries: this.multi };
    if (this.single) return { mode: 'single', entry: this.single };
    return { mode: 'none' };
  }

  getStats() {
    const history = [...(this.store.get('watchHistory') || [])];
    const now = Date.now();
    const active = [];
    if (this.single) active.push(this.single);
    active.push(...this.multi);

    for (const session of active) {
      history.unshift({
        ...session,
        endedAt: now,
        durationSec: Math.max(1, Math.round((now - session.startedAt) / 1000)),
        active: true,
      });
    }

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = now - 7 * 24 * 60 * 60 * 1000;
    let totalSec = 0;
    let todaySec = 0;
    let weekSec = 0;
    const byChannel = new Map();

    for (const item of history) {
      const duration = Number(item.durationSec || 0);
      totalSec += duration;
      if (item.startedAt >= dayStart.getTime()) todaySec += duration;
      if (item.startedAt >= weekStart) weekSec += duration;
      const key = item.channelName || 'Bilinmeyen kanal';
      byChannel.set(key, (byChannel.get(key) || 0) + duration);
    }

    const topChannels = [...byChannel.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, durationSec]) => ({ name, durationSec }));

    return {
      totalSec,
      todaySec,
      weekSec,
      sessions: history.filter((item) => !item.active).length,
      topChannels,
      recent: history.slice(0, 30),
      current: this.getCurrent(),
    };
  }

  shutdown() {
    this.stop();
    this.stopMulti();
  }
}

function injectPlayerCss(webContents, url) {
  let css = `html,body{background:#000!important;} body{overflow:hidden!important;}`;
  if (/youtube\.com|youtu\.be/i.test(url)) {
    css += `
      ytd-masthead, #secondary, #below, #comments, ytd-watch-metadata, #related, ytd-merch-shelf-renderer { display:none!important; }
      ytd-watch-flexy[theater] #player-theater-container, #player-theater-container, #movie_player { max-height:100vh!important; }
    `;
  } else if (/twitch\.tv/i.test(url)) {
    css += `
      .side-nav, [data-a-target="top-nav-container"], [data-test-selector="chat-room-component-layout"], .channel-root__right-column { display:none!important; }
      .channel-root__player, .persistent-player { inset:0!important; left:0!important; }
    `;
  } else if (/kick\.com/i.test(url)) {
    css += `
      nav, aside, [data-testid*="chat"], [class*="chatroom"], [class*="sidebar"] { display:none!important; }
      video { max-height:100vh!important; }
    `;
  }
  webContents.insertCSS(css).catch(() => {});
}

class MultiViewManager {
  constructor(store, tracker) {
    this.store = store;
    this.tracker = tracker;
    this.views = [];
    this.hidden = false;
    this.audioIndex = 0;
    this.boundWindow = null;
    this.resizeHandler = () => this.resize();
  }

  get active() {
    return this.views.length > 0;
  }

  state() {
    return { active: this.active, count: this.views.length, audioIndex: this.audioIndex };
  }

  async open(entries) {
    const clean = (entries || []).filter((entry) => entry?.url).slice(0, 4);
    if (!clean.length) return { error: 'En az bir yayın seçmelisiniz.' };

    this.close();
    const win = getMainWindow();
    if (!win) return { error: 'Ana pencere bulunamadı.' };

    const streamSession = session.fromPartition('persist:stream');
    this.boundWindow = win;

    for (const entry of clean) {
      const view = new WebContentsView({
        webPreferences: {
          session: streamSession,
          contextIsolation: true,
          sandbox: false,
          autoplayPolicy: 'no-user-gesture-required',
        },
      });
      win.contentView.addChildView(view);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('did-finish-load', () => injectPlayerCss(view.webContents, view.webContents.getURL()));
      view.webContents.on('did-navigate-in-page', (_, url) => injectPlayerCss(view.webContents, url));
      view.webContents.loadURL(entry.url);
      this.views.push({ view, entry });
    }

    this.audioIndex = 0;
    this.applyAudio();
    this.resize();
    this.tracker.startMulti(clean);
    win.on('resize', this.resizeHandler);
    win.on('maximize', this.resizeHandler);
    win.on('unmaximize', this.resizeHandler);
    win.on('enter-full-screen', this.resizeHandler);
    win.on('leave-full-screen', this.resizeHandler);
    this.emitState();
    return { success: true, ...this.state() };
  }

  resize() {
    const win = this.boundWindow || getMainWindow();
    if (!win || win.isDestroyed() || !this.views.length) return;
    const [windowWidth, windowHeight] = win.getContentSize();
    const fullscreen = win.isFullScreen();
    const sidebarWidth = this.store.get('sidebarExpanded', true) ? 280 : 64;
    const x = fullscreen ? 0 : sidebarWidth;
    const y = fullscreen ? 0 : 40;
    const width = Math.max(1, windowWidth - x);
    const height = Math.max(1, windowHeight - y);
    const count = this.views.length;
    const gap = 4;
    const columns = count === 1 ? 1 : 2;
    const rows = count <= 2 ? 1 : 2;
    const cellW = Math.floor((width - gap * (columns - 1)) / columns);
    const cellH = Math.floor((height - gap * (rows - 1)) / rows);

    this.views.forEach(({ view }, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      let w = cellW;
      if (count === 3 && index === 2) w = width;
      const bx = count === 3 && index === 2 ? x : x + col * (cellW + gap);
      const by = y + row * (cellH + gap);
      view.setBounds({ x: bx, y: by, width: Math.max(1, w), height: Math.max(1, cellH) });
      view.setVisible(!this.hidden);
    });
  }

  applyAudio() {
    this.views.forEach(({ view }, index) => {
      try { view.webContents.setAudioMuted(index !== this.audioIndex); } catch { }
    });
  }

  cycleAudio() {
    if (!this.views.length) return this.state();
    this.audioIndex = (this.audioIndex + 1) % this.views.length;
    this.applyAudio();
    this.emitState();
    return this.state();
  }

  reload() {
    for (const { view } of this.views) {
      if (!view.webContents.isDestroyed()) view.webContents.reload();
    }
  }

  hide() {
    this.hidden = true;
    for (const { view } of this.views) view.setVisible(false);
  }

  show() {
    this.hidden = false;
    for (const { view } of this.views) view.setVisible(true);
    this.resize();
  }

  preferredUrl() {
    return this.views[this.audioIndex]?.entry?.url || this.views[0]?.entry?.url || null;
  }

  close() {
    const win = this.boundWindow || getMainWindow();
    if (win && !win.isDestroyed()) {
      win.removeListener('resize', this.resizeHandler);
      win.removeListener('maximize', this.resizeHandler);
      win.removeListener('unmaximize', this.resizeHandler);
      win.removeListener('enter-full-screen', this.resizeHandler);
      win.removeListener('leave-full-screen', this.resizeHandler);
    }

    for (const { view } of this.views) {
      try { win?.contentView.removeChildView(view); } catch { }
      try { view.webContents.close(); } catch { }
    }
    const hadViews = this.views.length > 0;
    this.views = [];
    this.audioIndex = 0;
    this.hidden = false;
    this.boundWindow = null;
    if (hadViews) this.tracker.stopMulti();
    this.emitState();
  }

  emitState() {
    sendToRenderer('feature-multiview-state', this.state());
  }
}

class PipManager {
  constructor(multiview, tracker) {
    this.multiview = multiview;
    this.tracker = tracker;
    this.window = null;
  }

  state() {
    return { active: Boolean(this.window && !this.window.isDestroyed()) };
  }

  open(url) {
    const current = this.tracker.getCurrent();
    const resolvedUrl = url || this.multiview.preferredUrl() || current.entry?.url || current.entries?.[0]?.url;
    if (!resolvedUrl) return { error: 'Önce bir yayın açmalısınız.' };

    this.close();
    this.window = new BrowserWindow({
      width: 480,
      height: 300,
      minWidth: 320,
      minHeight: 200,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      title: 'streamwatch PiP',
      webPreferences: {
        partition: 'persist:stream',
        contextIsolation: true,
        sandbox: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.window.setAspectRatio(16 / 9);
    this.window.setAlwaysOnTop(true, 'floating');
    this.window.webContents.on('did-finish-load', () => injectPlayerCss(this.window.webContents, resolvedUrl));
    this.window.loadURL(resolvedUrl);
    this.window.on('closed', () => {
      this.window = null;
      sendToRenderer('feature-pip-state', this.state());
    });
    sendToRenderer('feature-pip-state', this.state());
    return { success: true };
  }

  close() {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
    sendToRenderer('feature-pip-state', this.state());
  }
}

class UpdateManager {
  constructor() {
    this.state = { available: false, checking: false, downloading: false };
  }

  compareVersions(a, b) {
    const parse = (value) => String(value || '0').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
    const va = parse(a);
    const vb = parse(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
      if ((va[i] || 0) > (vb[i] || 0)) return 1;
      if ((va[i] || 0) < (vb[i] || 0)) return -1;
    }
    return 0;
  }

  async check() {
    if (this.state.checking) return this.state;
    this.state.checking = true;
    try {
      const response = await net.fetch('https://api.github.com/repos/EtliBiftek/streamwatch/releases/latest', {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'streamwatch-updater',
        },
      });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const release = await response.json();
      const version = String(release.tag_name || '').replace(/^v/i, '');
      const asset = (release.assets || []).find((item) => /streamwatch.*\.exe$/i.test(item.name))
        || (release.assets || []).find((item) => /\.exe$/i.test(item.name));
      const available = Boolean(version && asset && this.compareVersions(version, app.getVersion()) > 0);
      this.state = {
        available,
        checking: false,
        downloading: false,
        version,
        assetName: asset?.name || null,
        assetUrl: asset?.browser_download_url || null,
        releaseUrl: release.html_url || null,
      };
      sendToRenderer('feature-update-state', this.state);
      return this.state;
    } catch (error) {
      this.state = { ...this.state, checking: false, error: error.message };
      return this.state;
    }
  }

  async install() {
    if (!this.state.available || !this.state.assetUrl) return { error: 'İndirilebilir bir güncelleme bulunamadı.' };
    if (this.state.downloading) return { error: 'Güncelleme zaten indiriliyor.' };
    this.state.downloading = true;
    sendToRenderer('feature-update-state', this.state);

    try {
      const response = await net.fetch(this.state.assetUrl, {
        headers: { 'User-Agent': 'streamwatch-updater' },
      });
      if (!response.ok) throw new Error(`İndirme başarısız: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1024 * 100) throw new Error('İndirilen kurulum dosyası geçersiz görünüyor.');
      const safeName = String(this.state.assetName || `streamwatch-${this.state.version}.exe`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const target = path.join(app.getPath('temp'), safeName);
      fs.writeFileSync(target, bytes);
      const child = spawn(target, ['/S'], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => app.quit(), 600);
      return { success: true };
    } catch (error) {
      this.state.downloading = false;
      sendToRenderer('feature-update-state', this.state);
      return { error: error.message };
    }
  }
}

installSmartNotificationLayer();

const discord = new DiscordPresence(featureStore);
const tracker = new WatchTracker(featureStore, discord);
const multiview = new MultiViewManager(featureStore, tracker);
const pip = new PipManager(multiview, tracker);
const updates = new UpdateManager();

ipcMain.handle('feature-get-setting', (_, key) => featureStore.get(key));
ipcMain.handle('feature-set-setting', (_, key, value) => {
  const allowed = new Set(Object.keys(FEATURE_DEFAULTS));
  if (!allowed.has(key)) return false;
  featureStore.set(key, value);
  if (key === 'discordEnabled' || key === 'discordClientId') discord.reconfigure();
  return true;
});
ipcMain.handle('feature-watch-start', (_, url, meta) => tracker.start(url, meta));
ipcMain.handle('feature-watch-stop', () => { tracker.stop(); return true; });
ipcMain.handle('feature-watch-stats', () => tracker.getStats());
ipcMain.handle('feature-current-media', () => tracker.getCurrent());
ipcMain.handle('feature-open-multiview', (_, entries) => multiview.open(entries));
ipcMain.handle('feature-close-multiview', () => { multiview.close(); return true; });
ipcMain.handle('feature-reload-multiview', () => { multiview.reload(); return true; });
ipcMain.handle('feature-resize-multiview', () => { multiview.resize(); return true; });
ipcMain.handle('feature-hide-multiview', () => { multiview.hide(); return true; });
ipcMain.handle('feature-show-multiview', () => { multiview.show(); return true; });
ipcMain.handle('feature-multiview-state', () => multiview.state());
ipcMain.handle('feature-multiview-cycle-audio', () => multiview.cycleAudio());
ipcMain.handle('feature-open-pip', (_, url) => pip.open(url));
ipcMain.handle('feature-close-pip', () => { pip.close(); return true; });
ipcMain.handle('feature-pip-state', () => pip.state());
ipcMain.handle('feature-discord-status', () => discord.getStatus());
ipcMain.handle('feature-update-state', () => updates.state);
ipcMain.handle('feature-check-update', () => updates.check());
ipcMain.handle('feature-install-update', () => updates.install());

require('./main.js');

function injectRendererFeatures(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const css = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'features.css'), 'utf8');
    win.webContents.insertCSS(css).catch(() => {});
    const js = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'features.js'), 'utf8');
    win.webContents.executeJavaScript(js).catch((error) => console.error('[Features] Renderer injection failed:', error));
  } catch (error) {
    console.error('[Features] Could not inject renderer features:', error);
  }
}

app.whenReady().then(() => {
  const attach = () => {
    const win = getMainWindow();
    if (!win) {
      setTimeout(attach, 250);
      return;
    }
    injectRendererFeatures(win);
    win.webContents.on('did-finish-load', () => setTimeout(() => injectRendererFeatures(win), 50));
    setTimeout(() => updates.check(), 3500);
    if (discord.enabled && discord.clientId) discord.connect();
  };
  setTimeout(attach, 250);
});

app.on('before-quit', () => {
  tracker.shutdown();
  multiview.close();
  pip.close();
  discord.disconnect(true);
});

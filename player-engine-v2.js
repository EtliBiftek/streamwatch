'use strict';

const electron = require('electron');
const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
const Store = require('electron-store');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const store = new Store();
const VALID_ENGINES = new Set(['embedded', 'mpv', 'vlc']);
if (!VALID_ENGINES.has(store.get('playerEngine'))) store.set('playerEngine', 'embedded');

let externalLaunchId = 0;
let externalProcess = null;
let watchStopHandler = null;
let lastFallback = null;

function firstExisting(paths) {
  for (const candidate of paths.filter(Boolean)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { }
  }
  return null;
}

function commandOnPath(command) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(lookup, [command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2500,
    });
    if (result.status !== 0) return null;
    const found = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
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
        found.push(path.join(root, entry.name, filename));
      }
    } catch { }
  }
  return found;
}

function resolveExecutable(kind) {
  if (kind === 'streamlink') {
    return commandOnPath(process.platform === 'win32' ? 'streamlink.exe' : 'streamlink')
      || firstExisting([
        ...pythonScriptCandidates(process.platform === 'win32' ? 'streamlink.exe' : 'streamlink'),
        process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'scoop', 'apps', 'streamlink', 'current', 'bin', 'streamlink.exe'),
      ]);
  }

  if (kind === 'mpv') {
    return commandOnPath(process.platform === 'win32' ? 'mpv.exe' : 'mpv')
      || firstExisting([
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'mpv', 'mpv.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'mpv', 'mpv.exe'),
        process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
      ]);
  }

  if (kind === 'vlc') {
    return commandOnPath(process.platform === 'win32' ? 'vlc.exe' : 'vlc')
      || firstExisting([
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'VideoLAN', 'VLC', 'vlc.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'VideoLAN', 'VLC', 'vlc.exe'),
      ]);
  }

  return null;
}

function playerStatus() {
  const streamlink = resolveExecutable('streamlink');
  const mpv = resolveExecutable('mpv');
  const vlc = resolveExecutable('vlc');
  return {
    streamlink: { installed: Boolean(streamlink), path: streamlink },
    mpv: { installed: Boolean(mpv), path: mpv },
    vlc: { installed: Boolean(vlc), path: vlc },
    selected: VALID_ENGINES.has(store.get('playerEngine')) ? store.get('playerEngine') : 'embedded',
    lastFallback,
  };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function getStreamlinkOptions() {
  const quality = String(store.get('streamlinkQuality') || 'best').trim() || 'best';
  const transport = ['default', 'http', 'fifo'].includes(store.get('streamlinkTransport'))
    ? store.get('streamlinkTransport')
    : 'default';
  return {
    quality: quality.slice(0, 80),
    lowLatency: store.get('streamlinkLowLatency') === true,
    transport,
    hlsLiveEdge: clampInt(store.get('streamlinkHlsLiveEdge'), 1, 10, 3),
    segmentThreads: clampInt(store.get('streamlinkSegmentThreads'), 1, 10, 1),
    retryOpen: clampInt(store.get('streamlinkRetryOpen'), 1, 20, 3),
    retryStreams: clampInt(store.get('streamlinkRetryStreams'), 0, 60, 2),
    retryMax: clampInt(store.get('streamlinkRetryMax'), 0, 50, 5),
    playerArgs: String(store.get('streamlinkPlayerArgs') || '').trim().slice(0, 500),
  };
}

function buildStreamlinkArgs(url, playerPath) {
  const options = getStreamlinkOptions();
  const args = ['--player', playerPath, '--retry-open', String(options.retryOpen)];

  if (options.retryStreams > 0) {
    args.push('--retry-streams', String(options.retryStreams), '--retry-max', String(options.retryMax));
  }
  if (options.transport === 'http') args.push('--player-http');
  if (options.transport === 'fifo') args.push('--player-fifo');

  const isTwitch = /(?:^|\.)twitch\.tv\//i.test(url);
  const isKick = /(?:^|\.)kick\.com\//i.test(url);
  if (options.lowLatency && isTwitch) args.push('--twitch-low-latency');
  else if (options.lowLatency && isKick) args.push('--kick-low-latency');
  else args.push('--hls-live-edge', String(options.hlsLiveEdge));

  args.push('--stream-segment-threads', String(options.segmentThreads));
  if (options.playerArgs) args.push('--player-args', options.playerArgs);
  args.push(url, options.quality);
  return args;
}

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat/i.test(win.getTitle())) || null;
}

function emitFallback(payload) {
  lastFallback = { ...payload, at: Date.now() };
  const win = mainWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send('player-engine-fallback', lastFallback);
}

async function spawnExternal(url, requestedEngine, event, embeddedListener, listenerArgs) {
  const streamlink = resolveExecutable('streamlink');
  const preferred = resolveExecutable(requestedEngine);
  const alternateEngine = requestedEngine === 'mpv' ? 'vlc' : 'mpv';
  const alternate = resolveExecutable(alternateEngine);

  if (!streamlink) {
    emitFallback({ from: requestedEngine, to: 'embedded', reason: 'Streamlink bulunamadı.' });
    return embeddedListener(event, url, ...listenerArgs);
  }

  let actualEngine = requestedEngine;
  let player = preferred;
  if (!player && alternate) {
    actualEngine = alternateEngine;
    player = alternate;
    emitFallback({ from: requestedEngine, to: alternateEngine, reason: `${requestedEngine.toUpperCase()} bulunamadı.` });
  }

  if (!player) {
    emitFallback({ from: requestedEngine, to: 'embedded', reason: 'MPV ve VLC bulunamadı.' });
    return embeddedListener(event, url, ...listenerArgs);
  }

  if (externalProcess && !externalProcess.killed) {
    try { externalProcess.kill(); } catch { }
  }

  const launchId = ++externalLaunchId;
  const args = buildStreamlinkArgs(url, player);
  let child;
  try {
    child = spawn(streamlink, args, {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    emitFallback({ from: actualEngine, to: 'embedded', reason: error.message });
    return embeddedListener(event, url, ...listenerArgs);
  }

  externalProcess = child;
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => finish({ success: true, external: true, engine: actualEngine, requestedEngine }), 900);
    child.once('error', async (error) => {
      if (launchId !== externalLaunchId) return;
      emitFallback({ from: actualEngine, to: 'embedded', reason: error.message });
      finish(await embeddedListener(event, url, ...listenerArgs));
    });
    child.once('exit', async (code) => {
      if (externalProcess === child) externalProcess = null;
      if (launchId === externalLaunchId && !settled && code && code !== 0) {
        const reason = stderr.trim().split(/\r?\n/).slice(-1)[0] || `Streamlink kod ${code} ile kapandı.`;
        emitFallback({ from: actualEngine, to: 'embedded', reason });
        finish(await embeddedListener(event, url, ...listenerArgs));
        return;
      }
      if (launchId === externalLaunchId && settled && typeof watchStopHandler === 'function') {
        Promise.resolve(watchStopHandler({ sender: null })).catch(() => {});
      }
    });
  });

  return result;
}

function installPlayerEngineIpcLayer() {
  const nativeHandle = ipcMain.handle.bind(ipcMain);
  nativeHandle('player-engine-status', () => playerStatus());
  nativeHandle('player-engine-last-fallback', () => lastFallback);

  ipcMain.handle = (channel, listener) => {
    if (channel === 'open-stream') {
      return nativeHandle(channel, async (event, url, ...args) => {
        const engine = VALID_ENGINES.has(store.get('playerEngine')) ? store.get('playerEngine') : 'embedded';
        if (engine === 'embedded') return listener(event, url, ...args);
        return spawnExternal(url, engine, event, listener, args);
      });
    }

    if (channel === 'feature-watch-stop') watchStopHandler = listener;
    return nativeHandle(channel, listener);
  };
}

function polishPreviewContents(contents) {
  if (!contents || contents.isDestroyed() || contents.__streamwatchPreviewPolished) return;
  contents.__streamwatchPreviewPolished = true;

  const css = `
    html,body{margin:0!important;padding:0!important;width:100vw!important;height:100vh!important;overflow:hidden!important;background:#050506!important}
    video{position:fixed!important;inset:0!important;z-index:2147483647!important;width:100vw!important;height:100vh!important;min-width:100vw!important;min-height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;object-fit:contain!important;background:#050506!important;border-radius:0 0 12px 12px!important}
    video::-webkit-media-controls{display:none!important}
  `;

  const focusVideo = () => {
    if (contents.isDestroyed()) return;
    contents.insertCSS(css).catch(() => {});
    contents.executeJavaScript(`(() => {
      const apply = () => document.querySelectorAll('video').forEach((video) => {
        video.muted = true;
        video.volume = 0;
        video.controls = false;
        video.setAttribute('playsinline', '');
        video.style.setProperty('position', 'fixed', 'important');
        video.style.setProperty('inset', '0', 'important');
        video.style.setProperty('width', '100vw', 'important');
        video.style.setProperty('height', '100vh', 'important');
        video.style.setProperty('object-fit', 'contain', 'important');
        video.style.setProperty('z-index', '2147483647', 'important');
        video.play().catch(() => {});
      });
      apply();
      const observer = new MutationObserver(apply);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 12000);
    })()`).catch(() => {});
  };

  contents.on('did-finish-load', () => {
    focusVideo();
    setTimeout(focusVideo, 250);
    setTimeout(focusVideo, 1000);
  });
  contents.on('did-navigate-in-page', () => setTimeout(focusVideo, 100));
}

function installPreviewPolish() {
  const nativeSetBounds = WebContentsView?.prototype?.setBounds;
  if (!nativeSetBounds || WebContentsView.prototype.__streamwatchPreviewBoundsPatched) return;

  WebContentsView.prototype.setBounds = function streamwatchPreviewSetBounds(bounds) {
    let next = bounds;
    try {
      const currentUrl = this.webContents?.getURL?.() || '';
      const loading = this.webContents?.isLoadingMainFrame?.() === true;
      const looksLikePreview = Number(bounds?.width) === 320
        && Number(bounds?.height) === 180
        && !loading
        && (!currentUrl || currentUrl === 'about:blank');

      if (looksLikePreview) {
        const width = 376;
        const height = 212;
        const headerHeight = 40;
        const win = mainWindow();
        const [winWidth, winHeight] = win?.getContentSize?.() || [1200, 800];
        const x = Math.min(Math.max(8, Number(bounds.x || 0)), Math.max(8, winWidth - width - 8));
        const cardY = Math.min(Math.max(42, Number(bounds.y || 42)), Math.max(42, winHeight - height - headerHeight - 8));
        next = { x, y: cardY + headerHeight, width, height };
        polishPreviewContents(this.webContents);
      }
    } catch (error) {
      console.warn('[PlayerEngineV2] Preview polish failed:', error.message);
    }
    return nativeSetBounds.call(this, next);
  };
  WebContentsView.prototype.__streamwatchPreviewBoundsPatched = true;
}

installPlayerEngineIpcLayer();
installPreviewPolish();

app.on('before-quit', () => {
  externalLaunchId += 1;
  if (externalProcess && !externalProcess.killed) {
    try { externalProcess.kill(); } catch { }
  }
});

'use strict';

const electron = require('electron');
const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
const Store = require('electron-store');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const store = new Store();
if (!['embedded', 'mpv', 'vlc'].includes(store.get('playerEngine'))) {
  store.set('playerEngine', 'embedded');
}

let externalLaunchId = 0;
let externalProcess = null;
let watchStopHandler = null;

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

function launchExternalPlayer(url, engine) {
  const streamlink = resolveExecutable('streamlink');
  const player = resolveExecutable(engine);
  const engineName = engine === 'mpv' ? 'MPV' : 'VLC';

  if (!streamlink || !player) {
    const missing = [!streamlink && 'Streamlink', !player && engineName].filter(Boolean).join(' ve ');
    return {
      error: `${missing} bulunamadı. ${engineName} player motoru için Streamlink ve ${engineName} kurulu olmalı.`,
      code: 'PLAYER_ENGINE_MISSING',
    };
  }

  const launchId = ++externalLaunchId;
  try {
    const child = spawn(streamlink, [
      '--player', player,
      url,
      'best',
    ], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });

    externalProcess = child;
    child.once('error', (error) => {
      console.error(`[PlayerEngine] ${engineName} launch failed:`, error.message);
    });
    child.once('exit', () => {
      if (externalProcess === child) externalProcess = null;
      if (launchId === externalLaunchId && typeof watchStopHandler === 'function') {
        Promise.resolve(watchStopHandler({ sender: null })).catch(() => {});
      }
    });

    return { success: true, external: true, engine };
  } catch (error) {
    return { error: `${engineName} açılamadı: ${error.message}` };
  }
}

function installPlayerEngineIpcLayer() {
  const nativeHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel === 'open-stream') {
      return nativeHandle(channel, async (event, url, ...args) => {
        const engine = store.get('playerEngine') || 'embedded';
        if (engine === 'embedded') return listener(event, url, ...args);
        if (!['mpv', 'vlc'].includes(engine)) {
          store.set('playerEngine', 'embedded');
          return listener(event, url, ...args);
        }
        return launchExternalPlayer(url, engine);
      });
    }

    if (channel === 'feature-watch-stop') {
      watchStopHandler = listener;
    }

    return nativeHandle(channel, listener);
  };
}

function polishPreviewContents(contents) {
  if (!contents || contents.isDestroyed() || contents.__streamwatchPreviewPolished) return;
  contents.__streamwatchPreviewPolished = true;

  const css = `
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      overflow: hidden !important;
      background: #050506 !important;
    }
    video {
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      width: 100vw !important;
      height: 100vh !important;
      min-width: 100vw !important;
      min-height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      object-fit: contain !important;
      background: #050506 !important;
      border-radius: 0 0 12px 12px !important;
    }
    video::-webkit-media-controls { display: none !important; }
  `;

  const focusVideo = () => {
    if (contents.isDestroyed()) return;
    contents.insertCSS(css).catch(() => {});
    contents.executeJavaScript(`(() => {
      const apply = () => {
        const videos = [...document.querySelectorAll('video')];
        for (const video of videos) {
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
          video.style.setProperty('background', '#050506', 'important');
          video.play().catch(() => {});
        }
      };
      apply();
      if (!window.__streamwatchPreviewObserver) {
        window.__streamwatchPreviewObserver = new MutationObserver(apply);
        window.__streamwatchPreviewObserver.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
          window.__streamwatchPreviewObserver?.disconnect();
          window.__streamwatchPreviewObserver = null;
        }, 12000);
      }
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
        const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && !/PiP/i.test(candidate.getTitle()));
        const [winWidth, winHeight] = win?.getContentSize?.() || [1200, 800];
        const x = Math.min(Math.max(8, Number(bounds.x || 0)), Math.max(8, winWidth - width - 8));
        const cardY = Math.min(Math.max(42, Number(bounds.y || 42)), Math.max(42, winHeight - height - headerHeight - 8));
        next = { x, y: cardY + headerHeight, width, height };
        polishPreviewContents(this.webContents);
      }
    } catch (error) {
      console.warn('[PlayerEngine] Preview polish failed:', error.message);
    }
    return nativeSetBounds.call(this, next);
  };
  WebContentsView.prototype.__streamwatchPreviewBoundsPatched = true;
}

function injectRenderer(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const css = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'player-engine.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'player-engine.js'), 'utf8');
    win.webContents.insertCSS(css).catch(() => {});
    win.webContents.executeJavaScript(js).catch((error) => console.error('[PlayerEngine] Renderer injection failed:', error));
  } catch (error) {
    console.error('[PlayerEngine] Renderer files could not be injected:', error);
  }
}

installPlayerEngineIpcLayer();
installPreviewPolish();

app.whenReady().then(() => {
  const attach = () => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && !/PiP/i.test(candidate.getTitle()));
    if (!win) return setTimeout(attach, 250);
    setTimeout(() => injectRenderer(win), 800);
    win.webContents.on('did-finish-load', () => setTimeout(() => injectRenderer(win), 800));
  };
  setTimeout(attach, 450);
});

app.on('before-quit', () => {
  externalLaunchId += 1;
  if (externalProcess && !externalProcess.killed) {
    try { externalProcess.kill(); } catch { }
  }
});

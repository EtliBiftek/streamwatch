'use strict';

const { app, BrowserWindow, ipcMain, net } = require('electron');
const fs = require('fs');
const path = require('path');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (error) {
  console.warn('[UpdaterV2] electron-updater could not be loaded:', error.message);
}

const REPO_OWNER = 'EtliBiftek';
const REPO_NAME = 'streamwatch';
const WEB_LATEST = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const POLL_INTERVAL_MS = 20000;

let originalUpdateCheck = null;
let originalUpdateInstall = null;
let probeBusy = false;
let monitorTimer = null;
let lastHydratedVersion = null;
let lastFallbackCheckAt = 0;
let updaterConfigured = false;
let updaterBusy = false;
let updateState = {
  available: false,
  checking: false,
  downloading: false,
  installing: false,
  stage: 'idle',
  progress: 0,
};

function getMainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat/i.test(win.getTitle())) || null;
}

function compareVersions(a, b) {
  const parse = (value) => String(value || '0')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return 1;
    if ((left[index] || 0) < (right[index] || 0)) return -1;
  }
  return 0;
}

function emitUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  const win = getMainWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send('feature-update-state', updateState);
  return updateState;
}

function versionFromReleaseUrl(url) {
  const match = String(url || '').match(/\/releases\/tag\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]).replace(/^v/i, '') : null;
}

function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function configureAutoUpdater() {
  if (updaterConfigured) return Boolean(autoUpdater);
  if (!autoUpdater || !app.isPackaged) return false;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: REPO_OWNER,
    repo: REPO_NAME,
  });

  autoUpdater.on('checking-for-update', () => {
    emitUpdateState({ checking: true, stage: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    const version = String(info?.version || '').replace(/^v/i, '');
    if (version) lastHydratedVersion = version;
    emitUpdateState({
      available: Boolean(version && compareVersions(version, app.getVersion()) > 0),
      checking: false,
      downloading: false,
      installing: false,
      stage: 'available',
      progress: 0,
      version: version || null,
      releaseDate: info?.releaseDate || null,
      error: null,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    emitUpdateState({
      available: false,
      checking: false,
      downloading: false,
      installing: false,
      stage: 'idle',
      progress: 0,
      version: String(info?.version || app.getVersion()).replace(/^v/i, ''),
      error: null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(99, Math.floor(Number(progress?.percent || 0))));
    emitUpdateState({
      available: true,
      checking: false,
      downloading: true,
      installing: false,
      stage: 'downloading',
      progress: percent,
      downloadedBytes: Number(progress?.transferred || 0),
      totalBytes: Number(progress?.total || 0),
      message: progress?.total
        ? `${humanBytes(progress.transferred)} / ${humanBytes(progress.total)}`
        : humanBytes(progress?.transferred || 0),
      error: null,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = String(info?.version || updateState.version || '').replace(/^v/i, '');
    emitUpdateState({
      available: true,
      checking: false,
      downloading: false,
      installing: true,
      stage: 'installing',
      progress: 100,
      version: version || updateState.version || null,
      message: 'İndirme tamamlandı. Güncelleme kuruluyor ve uygulama yeniden başlatılıyor…',
      error: null,
    });

    setTimeout(() => {
      try {
        // electron-updater's NSIS path adds --updated, /S and --force-run itself.
        // This also keeps the current installation directory instead of starting a second old install.
        autoUpdater.quitAndInstall(true, true);
      } catch (error) {
        console.error('[UpdaterV2] quitAndInstall failed:', error);
        emitUpdateState({
          downloading: false,
          installing: false,
          stage: 'error',
          error: error.message,
          message: `Güncelleme kurulamadı: ${error.message}`,
        });
      }
    }, 450);
  });

  autoUpdater.on('error', (error) => {
    console.error('[UpdaterV2] electron-updater error:', error);
    emitUpdateState({
      checking: false,
      downloading: false,
      installing: false,
      stage: 'error',
      error: error?.message || String(error),
      message: error?.message || 'Güncelleme sırasında bir hata oluştu.',
    });
  });

  updaterConfigured = true;
  return true;
}

async function runLegacyUpdateCheck() {
  if (!originalUpdateCheck) return null;
  try {
    const result = await originalUpdateCheck(null);
    if (result?.version) lastHydratedVersion = String(result.version).replace(/^v/i, '');
    lastFallbackCheckAt = Date.now();
    return result;
  } catch (error) {
    console.warn('[UpdaterV2] Legacy update check failed:', error.message);
    return null;
  }
}

async function runFullUpdateCheck() {
  if (!configureAutoUpdater()) return runLegacyUpdateCheck();
  if (updaterBusy) return updateState;

  updaterBusy = true;
  emitUpdateState({ checking: true, stage: 'checking', error: null });
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = String(result?.updateInfo?.version || '').replace(/^v/i, '');
    if (version) lastHydratedVersion = version;
    lastFallbackCheckAt = Date.now();

    if (version && compareVersions(version, app.getVersion()) > 0) {
      return emitUpdateState({
        available: true,
        checking: false,
        stage: 'available',
        version,
        error: null,
      });
    }

    return emitUpdateState({
      available: false,
      checking: false,
      downloading: false,
      installing: false,
      stage: 'idle',
      progress: 0,
      error: null,
    });
  } catch (error) {
    console.warn('[UpdaterV2] Full update check failed:', error.message);
    return emitUpdateState({
      checking: false,
      downloading: false,
      installing: false,
      stage: 'error',
      error: error.message,
      message: error.message,
    });
  } finally {
    updaterBusy = false;
  }
}

async function probeLatestRelease(force = false) {
  if (probeBusy) return;
  probeBusy = true;
  try {
    const response = await net.fetch(WEB_LATEST, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'streamwatch-updater-v2' },
    });
    const latestVersion = versionFromReleaseUrl(response.url);
    if (latestVersion && compareVersions(latestVersion, app.getVersion()) > 0) {
      if (latestVersion !== lastHydratedVersion || force) await runFullUpdateCheck();
      return;
    }

    if (latestVersion && compareVersions(latestVersion, app.getVersion()) <= 0 && updateState.available) {
      emitUpdateState({ available: false, stage: 'idle', progress: 0 });
    }

    if (!latestVersion && (force || Date.now() - lastFallbackCheckAt > 2 * 60 * 1000)) {
      await runFullUpdateCheck();
    }
  } catch (error) {
    if (force || Date.now() - lastFallbackCheckAt > 2 * 60 * 1000) await runFullUpdateCheck();
  } finally {
    probeBusy = false;
  }
}

async function installUpdateV2() {
  if (!configureAutoUpdater()) {
    if (originalUpdateInstall) return originalUpdateInstall(null);
    return { error: 'Güncelleme sistemi kullanılamıyor.' };
  }

  if (updateState.downloading || updateState.installing) {
    return { error: 'Güncelleme işlemi zaten devam ediyor.' };
  }

  if (!updateState.available) {
    await runFullUpdateCheck();
    if (!updateState.available) return { error: 'Daha yeni bir sürüm bulunamadı.' };
  }

  emitUpdateState({
    downloading: true,
    installing: false,
    stage: 'downloading',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    message: 'İndirme hazırlanıyor…',
    error: null,
  });

  try {
    await autoUpdater.downloadUpdate();
    return { success: true, restarting: true };
  } catch (error) {
    console.error('[UpdaterV2] downloadUpdate failed:', error);
    emitUpdateState({
      downloading: false,
      installing: false,
      stage: 'error',
      progress: 0,
      error: error.message,
      message: error.message,
    });
    return { error: error.message };
  }
}

const nativeHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (channel === 'feature-check-update') {
    originalUpdateCheck = listener;
    return nativeHandle(channel, () => runFullUpdateCheck());
  }
  if (channel === 'feature-install-update') {
    originalUpdateInstall = listener;
    return nativeHandle(channel, () => installUpdateV2());
  }
  return nativeHandle(channel, listener);
};

function injectRenderer(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const css = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'updater-v2.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'updater-v2.js'), 'utf8');
    win.webContents.insertCSS(css).catch(() => {});
    win.webContents.executeJavaScript(js).catch((error) => console.error('[UpdaterV2] Renderer injection failed:', error));
  } catch (error) {
    console.error('[UpdaterV2] Renderer files could not be injected:', error);
  }
}

function startMonitor(win) {
  clearInterval(monitorTimer);
  setTimeout(() => probeLatestRelease(true), 5000);
  monitorTimer = setInterval(() => probeLatestRelease(false), POLL_INTERVAL_MS);
  win.on('focus', () => probeLatestRelease(true));
  win.on('restore', () => probeLatestRelease(true));
}

app.whenReady().then(() => {
  configureAutoUpdater();
  const attach = () => {
    const win = getMainWindow();
    if (!win) return setTimeout(attach, 200);
    setTimeout(() => injectRenderer(win), 500);
    win.webContents.on('did-finish-load', () => setTimeout(() => injectRenderer(win), 500));
    startMonitor(win);
  };
  setTimeout(attach, 300);
});

app.on('before-quit', () => clearInterval(monitorTimer));

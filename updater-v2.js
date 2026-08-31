'use strict';

const { app, BrowserWindow, ipcMain, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'EtliBiftek/streamwatch';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const WEB_LATEST = `https://github.com/${REPO}/releases/latest`;
const POLL_INTERVAL_MS = 20000;

let originalUpdateCheck = null;
let probeBusy = false;
let monitorTimer = null;
let lastHydratedVersion = null;
let lastFallbackCheckAt = 0;

function getMainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP/i.test(win.getTitle())) || null;
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

function emitUpdateState(state) {
  const win = getMainWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send('feature-update-state', state);
}

function versionFromReleaseUrl(url) {
  const match = String(url || '').match(/\/releases\/tag\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]).replace(/^v/i, '') : null;
}

async function runFullUpdateCheck() {
  if (!originalUpdateCheck) return null;
  try {
    const result = await originalUpdateCheck(null);
    if (result?.version) lastHydratedVersion = String(result.version).replace(/^v/i, '');
    lastFallbackCheckAt = Date.now();
    return result;
  } catch (error) {
    console.warn('[UpdaterV2] Full update check failed:', error.message);
    return null;
  }
}

async function probeLatestRelease(force = false) {
  if (probeBusy || !originalUpdateCheck) return;
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

    if (!latestVersion && (force || Date.now() - lastFallbackCheckAt > 2 * 60 * 1000)) {
      await runFullUpdateCheck();
    }
  } catch (error) {
    if (force || Date.now() - lastFallbackCheckAt > 2 * 60 * 1000) await runFullUpdateCheck();
  } finally {
    probeBusy = false;
  }
}

function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function psQuote(value) {
  return `'${String(value || '').replaceAll("'", "''")}'`;
}

async function writeResponseToFile(response, target, metadata) {
  if (!response.body) throw new Error('İndirme akışı başlatılamadı.');
  const total = Number(response.headers.get('content-length') || metadata.assetSize || 0);
  const reader = response.body.getReader();
  const output = fs.createWriteStream(target);
  let downloaded = 0;
  let lastPercent = -1;
  let lastEmitAt = 0;

  const writeChunk = (chunk) => new Promise((resolve, reject) => {
    const ok = output.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve());
    if (!ok) output.once('drain', resolve);
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      await writeChunk(value);
      const percent = total > 0 ? Math.min(99, Math.floor((downloaded / total) * 100)) : 0;
      const now = Date.now();
      if (percent !== lastPercent || now - lastEmitAt > 300) {
        lastPercent = percent;
        lastEmitAt = now;
        emitUpdateState({
          available: true,
          downloading: true,
          installing: false,
          stage: 'downloading',
          progress: percent,
          downloadedBytes: downloaded,
          totalBytes: total,
          version: metadata.version,
          assetName: metadata.assetName,
          releaseUrl: metadata.releaseUrl,
          message: total > 0 ? `${humanBytes(downloaded)} / ${humanBytes(total)}` : humanBytes(downloaded),
        });
      }
    }
  } finally {
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
    reader.releaseLock?.();
  }

  return { downloaded, total };
}

function launchInstallerAndRestart(installerPath) {
  const appExe = process.execPath;
  const fallbackExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'streamwatch', 'streamwatch.exe');
  const scriptPath = path.join(app.getPath('temp'), `streamwatch-update-${Date.now()}.ps1`);
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$parentPid = ${process.pid}`,
    `$installer = ${psQuote(installerPath)}`,
    `$appExe = ${psQuote(appExe)}`,
    `$fallbackExe = ${psQuote(fallbackExe)}`,
    'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }',
    "$p = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait",
    'Start-Sleep -Milliseconds 750',
    'if (Test-Path -LiteralPath $appExe) { Start-Process -FilePath $appExe } elseif (Test-Path -LiteralPath $fallbackExe) { Start-Process -FilePath $fallbackExe }',
    'Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
  ].join('\r\n');
  fs.writeFileSync(scriptPath, script, 'utf8');

  const helper = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  helper.unref();
}

async function installUpdateV2() {
  let metadata = null;
  try {
    const releaseResponse = await net.fetch(API_LATEST, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'streamwatch-updater-v2',
      },
    });
    if (!releaseResponse.ok) throw new Error(`GitHub HTTP ${releaseResponse.status}`);
    const release = await releaseResponse.json();
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (!version || compareVersions(version, app.getVersion()) <= 0) {
      return { error: 'Daha yeni bir sürüm bulunamadı.' };
    }

    const asset = (release.assets || []).find((item) => /streamwatch.*\.exe$/i.test(item.name))
      || (release.assets || []).find((item) => /\.exe$/i.test(item.name));
    if (!asset?.browser_download_url) throw new Error('Release içinde Windows kurulum dosyası bulunamadı.');

    metadata = {
      version,
      assetName: asset.name,
      assetSize: Number(asset.size || 0),
      assetUrl: asset.browser_download_url,
      releaseUrl: release.html_url || null,
    };

    emitUpdateState({
      available: true,
      downloading: true,
      installing: false,
      stage: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: metadata.assetSize,
      version,
      assetName: metadata.assetName,
      releaseUrl: metadata.releaseUrl,
      message: 'İndirme hazırlanıyor…',
    });

    const safeName = String(metadata.assetName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const target = path.join(app.getPath('temp'), `${Date.now()}-${safeName}`);
    const response = await net.fetch(metadata.assetUrl, {
      headers: { 'User-Agent': 'streamwatch-updater-v2' },
    });
    if (!response.ok) throw new Error(`İndirme başarısız: HTTP ${response.status}`);

    const { downloaded } = await writeResponseToFile(response, target, metadata);
    if (downloaded < 1024 * 100) {
      try { fs.unlinkSync(target); } catch { }
      throw new Error('İndirilen kurulum dosyası geçersiz görünüyor.');
    }

    emitUpdateState({
      available: true,
      downloading: false,
      installing: true,
      stage: 'installing',
      progress: 100,
      downloadedBytes: downloaded,
      totalBytes: metadata.assetSize || downloaded,
      version,
      assetName: metadata.assetName,
      releaseUrl: metadata.releaseUrl,
      message: 'İndirme tamamlandı. Kuruluyor ve yeniden başlatılıyor…',
    });

    launchInstallerAndRestart(target);
    setTimeout(() => app.quit(), 900);
    return { success: true, restarting: true };
  } catch (error) {
    emitUpdateState({
      available: true,
      downloading: false,
      installing: false,
      stage: 'error',
      progress: 0,
      version: metadata?.version || null,
      releaseUrl: metadata?.releaseUrl || null,
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
    return nativeHandle(channel, async (...args) => {
      const result = await listener(...args);
      if (result?.version) lastHydratedVersion = String(result.version).replace(/^v/i, '');
      lastFallbackCheckAt = Date.now();
      return result;
    });
  }
  if (channel === 'feature-install-update') {
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

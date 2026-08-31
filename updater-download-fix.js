'use strict';

const { app, BrowserWindow, ipcMain, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RELEASE_API = 'https://api.github.com/repos/EtliBiftek/streamwatch/releases/latest';
let installBusy = false;

function getMainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat/i.test(win.getTitle())) || null;
}

function emitUpdateState(patch) {
  const win = getMainWindow();
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send('feature-update-state', patch);
  }
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

function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function psQuote(value) {
  return `'${String(value || '').replaceAll("'", "''")}'`;
}

async function getLatestInstaller() {
  const response = await net.fetch(RELEASE_API, {
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'streamwatch-updater-direct',
    },
  });
  if (!response.ok) throw new Error(`GitHub sürüm bilgisi alınamadı: HTTP ${response.status}`);

  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (!version || compareVersions(version, app.getVersion()) <= 0) {
    throw new Error('Daha yeni bir sürüm bulunamadı.');
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((asset) => /streamwatch.*setup.*\.exe$/i.test(asset.name) && !/\.blockmap$/i.test(asset.name))
    || assets.find((asset) => /\.exe$/i.test(asset.name) && !/\.blockmap$/i.test(asset.name));

  if (!installer?.browser_download_url) {
    throw new Error('Release içinde Windows kurulum dosyası bulunamadı.');
  }

  return {
    version,
    name: installer.name,
    url: installer.browser_download_url,
    size: Number(installer.size || 0),
    releaseUrl: release.html_url || null,
  };
}

async function downloadInstaller(meta, target) {
  const response = await net.fetch(meta.url, {
    cache: 'no-store',
    redirect: 'follow',
    headers: { 'User-Agent': 'streamwatch-updater-direct' },
  });
  if (!response.ok) {
    throw new Error(`Kurulum dosyası indirilemedi: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('İndirme akışı başlatılamadı.');

  const total = Number(response.headers.get('content-length') || meta.size || 0);
  const reader = response.body.getReader();
  const output = fs.createWriteStream(target);
  let downloaded = 0;
  let lastPercent = -1;
  let lastEmit = 0;

  const write = (chunk) => new Promise((resolve, reject) => {
    output.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve());
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await write(value);
      downloaded += value.byteLength;

      const percent = total > 0 ? Math.min(99, Math.floor((downloaded / total) * 100)) : 0;
      const now = Date.now();
      if (percent !== lastPercent || now - lastEmit >= 300) {
        lastPercent = percent;
        lastEmit = now;
        emitUpdateState({
          available: true,
          checking: false,
          downloading: true,
          installing: false,
          stage: 'downloading',
          progress: percent,
          version: meta.version,
          assetName: meta.name,
          releaseUrl: meta.releaseUrl,
          downloadedBytes: downloaded,
          totalBytes: total,
          message: total > 0
            ? `${humanBytes(downloaded)} / ${humanBytes(total)}`
            : humanBytes(downloaded),
          error: null,
        });
      }
    }
  } finally {
    reader.releaseLock?.();
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  }

  if (downloaded < 1024 * 100) throw new Error('İndirilen kurulum dosyası geçersiz görünüyor.');
  if (meta.size > 0 && downloaded !== meta.size) {
    throw new Error(`İndirme eksik tamamlandı (${humanBytes(downloaded)} / ${humanBytes(meta.size)}).`);
  }

  return downloaded;
}

function launchInstallerAndRestart(installerPath) {
  const currentExe = process.execPath;
  const fallbackExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'streamwatch', 'streamwatch.exe');
  const helperPath = path.join(app.getPath('temp'), `streamwatch-update-${Date.now()}.ps1`);
  const logPath = path.join(app.getPath('temp'), 'streamwatch-update.log');

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$parentPid = ${process.pid}`,
    `$installer = ${psQuote(installerPath)}`,
    `$currentExe = ${psQuote(currentExe)}`,
    `$fallbackExe = ${psQuote(fallbackExe)}`,
    `$logPath = ${psQuote(logPath)}`,
    "Add-Content -LiteralPath $logPath -Value ('Update helper started: ' + (Get-Date))",
    'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }',
    "$process = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait",
    "Add-Content -LiteralPath $logPath -Value ('Installer exit code: ' + $process.ExitCode)",
    'Start-Sleep -Milliseconds 800',
    'if (Test-Path -LiteralPath $currentExe) {',
    "  Start-Process -FilePath $currentExe -ArgumentList '--updated'",
    '} elseif (Test-Path -LiteralPath $fallbackExe) {',
    "  Start-Process -FilePath $fallbackExe -ArgumentList '--updated'",
    '}',
    'Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
  ].join('\r\n');

  fs.writeFileSync(helperPath, script, 'utf8');
  const helper = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', helperPath,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  helper.unref();
}

async function installDirect() {
  if (installBusy) return { error: 'Güncelleme işlemi zaten devam ediyor.' };
  installBusy = true;
  let target = null;
  let meta = null;

  try {
    meta = await getLatestInstaller();
    emitUpdateState({
      available: true,
      checking: false,
      downloading: true,
      installing: false,
      stage: 'downloading',
      progress: 0,
      version: meta.version,
      assetName: meta.name,
      releaseUrl: meta.releaseUrl,
      downloadedBytes: 0,
      totalBytes: meta.size,
      message: 'İndirme hazırlanıyor…',
      error: null,
    });

    const safeName = String(meta.name).replace(/[^a-zA-Z0-9._-]/g, '_');
    target = path.join(app.getPath('temp'), `${Date.now()}-${safeName}`);
    const downloaded = await downloadInstaller(meta, target);

    emitUpdateState({
      available: true,
      checking: false,
      downloading: false,
      installing: true,
      stage: 'installing',
      progress: 100,
      version: meta.version,
      assetName: meta.name,
      releaseUrl: meta.releaseUrl,
      downloadedBytes: downloaded,
      totalBytes: meta.size || downloaded,
      message: 'İndirme tamamlandı. Güncelleme kuruluyor ve StreamWatch yeniden başlatılıyor…',
      error: null,
    });

    launchInstallerAndRestart(target);
    setTimeout(() => app.quit(), 800);
    return { success: true, restarting: true };
  } catch (error) {
    if (target) {
      try { fs.unlinkSync(target); } catch { }
    }
    installBusy = false;
    emitUpdateState({
      available: true,
      checking: false,
      downloading: false,
      installing: false,
      stage: 'error',
      progress: 0,
      version: meta?.version || null,
      releaseUrl: meta?.releaseUrl || null,
      error: error.message,
      message: error.message,
    });
    return { error: error.message };
  }
}

ipcMain.removeHandler('feature-install-update');
ipcMain.handle('feature-install-update', () => installDirect());

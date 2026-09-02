'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP|Chat/i.test(win.getTitle())) || null;
}

function injectFile(win, relativePath, kind) {
  const fullPath = path.join(__dirname, relativePath);
  const source = fs.readFileSync(fullPath, 'utf8');
  if (kind === 'css') return win.webContents.insertCSS(source);
  return win.webContents.executeJavaScript(source);
}

function inject(win) {
  if (!win || win.isDestroyed()) return;
  const jobs = [
    injectFile(win, 'src/renderer/player-engine.css', 'css'),
    injectFile(win, 'src/renderer/live-tools.css', 'css'),
    injectFile(win, 'src/renderer/layout-v2.css', 'css'),
    injectFile(win, 'src/renderer/oauth-accounts.css', 'css'),
    injectFile(win, 'src/renderer/interface-polish.css', 'css'),
    injectFile(win, 'src/renderer/player-engine.js', 'js'),
    injectFile(win, 'src/renderer/live-tools.js', 'js'),
    injectFile(win, 'src/renderer/layout-v2.js', 'js'),
    injectFile(win, 'src/renderer/oauth-accounts.js', 'js'),
    injectFile(win, 'src/renderer/interface-polish.js', 'js'),
  ];
  Promise.allSettled(jobs).then((results) => {
    results.forEach((result) => {
      if (result.status === 'rejected') console.error('[UIIntegrations] Injection failed:', result.reason?.message || result.reason);
    });
  });
}

app.whenReady().then(() => {
  const attach = () => {
    const win = mainWindow();
    if (!win) return setTimeout(attach, 250);
    setTimeout(() => inject(win), 850);
    win.webContents.on('did-finish-load', () => setTimeout(() => inject(win), 850));
  };
  setTimeout(attach, 500);
});
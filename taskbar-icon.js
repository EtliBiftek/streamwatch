'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');

const APP_ID = 'com.streamwatch.app';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

function getMainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP/i.test(win.getTitle())) || null;
}

function applyTaskbarIcon(win) {
  if (!win || win.isDestroyed()) return;

  const icon = nativeImage.createFromPath(ICON_PATH);
  if (!icon.isEmpty()) {
    try {
      win.setIcon(icon);
    } catch (error) {
      console.warn('[TaskbarIcon] Window icon could not be applied:', error.message);
    }
  }

  if (process.platform === 'win32') {
    try {
      win.setAppDetails({
        appId: APP_ID,
        appIconPath: ICON_PATH,
        appIconIndex: 0,
        relaunchCommand: process.execPath,
        relaunchDisplayName: 'streamwatch',
      });
    } catch (error) {
      console.warn('[TaskbarIcon] Windows taskbar details could not be applied:', error.message);
    }
  }
}

app.whenReady().then(() => {
  const attach = () => {
    const win = getMainWindow();
    if (!win) return setTimeout(attach, 200);

    applyTaskbarIcon(win);
    win.once('ready-to-show', () => applyTaskbarIcon(win));
    win.on('show', () => applyTaskbarIcon(win));
  };

  setTimeout(attach, 150);
});

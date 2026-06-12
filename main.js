const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, screen, globalShortcut } = require('electron');

const path = require('path');
const Store = require('electron-store');
const BrowserManager = require('./src/browser-manager');
const StreamChecker = require('./src/stream-checker');
const AutoLaunch = require('auto-launch');

// ── Chromium flags (app.whenReady() öncesi ayarlanmalı) ──
// Autoplay policy: YouTube canlı yayınları otomatik oynatılabilsin
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// DRM (Widevine) desteği
app.commandLine.appendSwitch('enable-features', 'PlatformEncryptedDotMediaKeySystemAccess');
// GPU hızlandırma
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// electron-store schema
const store = new Store({
  defaults: {
    selectedBrowser: null,
    theme: 'dark',
    autoLaunch: false,
    startMinimized: false,
    channels: [],
    sidebarExpanded: true
  }
});

let mainWindow = null;
let tray = null;
let browserManager = null;
let streamChecker = null;
let isQuitting = false;

const autoLauncher = new AutoLaunch({
  name: 'streamwatch',
  path: app.getPath('exe'),
});

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: store.get('theme') === 'dark' ? '#0A0A0B' : '#FAFAFA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    const startMinimized = store.get('startMinimized') && process.argv.includes('--start-minimized');
    if (!startMinimized) {
      mainWindow.show();
    }
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── Resize/move → update stream view bounds ──
  const updateStreamBounds = () => {
    if (browserManager) {
      // Electron'un layout'u bitirmesi için k\u0131sa bekleme
      setTimeout(() => browserManager.resizeStreamView(mainWindow), 50);
    }
  };

  mainWindow.on('resize', updateStreamBounds);
  mainWindow.on('move', updateStreamBounds);

  mainWindow.on('maximize', () => {
    setTimeout(() => {
      updateStreamBounds();
      mainWindow.webContents.send('window-maximized', true);
    }, 100);
  });

  mainWindow.on('unmaximize', () => {
    setTimeout(() => {
      updateStreamBounds();
      mainWindow.webContents.send('window-maximized', false);
    }, 100);
  });


  // ── Fullscreen ──
  mainWindow.on('enter-full-screen', () => {
    setTimeout(() => {
      if (browserManager) browserManager.applyFullscreenBounds(mainWindow);
      mainWindow.webContents.send('fullscreen-changed', true);
    }, 100);
  });

  mainWindow.on('leave-full-screen', () => {
    setTimeout(() => {
      updateStreamBounds();
      mainWindow.webContents.send('fullscreen-changed', false);
    }, 100);
  });
}

function createTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(trayIconPath);
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Göster',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Gizle',
      click: () => {
        if (mainWindow) mainWindow.hide();
      }
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        isQuitting = true;
        if (browserManager) browserManager.destroy(mainWindow);
        app.quit();
      }
    }
  ]);

  tray.setToolTip('streamwatch');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ========================
// IPC Handlers
// ========================

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized());

// Store operations
ipcMain.handle('store-get', (_, key) => store.get(key));
ipcMain.handle('store-set', (_, key, value) => {
  store.set(key, value);
  return true;
});
ipcMain.handle('open-external', async (_, url) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
  return true;
});
ipcMain.handle('get-cookie-status', () => {
  if (browserManager) return browserManager.cookieStatus;
  return 'unknown';
});

// Browser selection and management
ipcMain.handle('get-available-browsers', async () => {
  if (!browserManager) browserManager = new BrowserManager();
  return browserManager.getAvailableBrowsers();
});

ipcMain.handle('select-browser', async (_, browserKey) => {
  store.set('selectedBrowser', browserKey);

  // Initialize session with cookies + extensions for the selected browser
  if (!browserManager) browserManager = new BrowserManager();
  try {
    await browserManager.initialize(browserKey);
  } catch (e) {
    console.error('Browser initialization error:', e);
  }
  return true;
});

ipcMain.handle('open-stream', async (_, url) => {
  if (!browserManager) browserManager = new BrowserManager();
  const selectedBrowser = store.get('selectedBrowser');
  if (!selectedBrowser) return { error: 'Tarayıcı seçilmedi' };

  try {
    // Ensure initialized
    if (!browserManager.initialized) {
      await browserManager.initialize(selectedBrowser);
    }

    const sidebarExpanded = store.get('sidebarExpanded', true);
    await browserManager.openStream(url, mainWindow, sidebarExpanded);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('reload-stream', async () => {
  if (browserManager) browserManager.reloadStream();
  return true;
});

ipcMain.handle('close-embedded-browser', async () => {
  if (browserManager) browserManager.closeStream(mainWindow);
  return true;
});

// Stream view visibility for modals
ipcMain.handle('hide-browser', async () => {
  if (browserManager) browserManager.hideStreamView();
  return true;
});

ipcMain.handle('show-browser', async () => {
  if (browserManager) browserManager.showStreamView();
  return true;
});

ipcMain.handle('update-browser-bounds', async (_, sidebarExpanded) => {
  store.set('sidebarExpanded', sidebarExpanded);
  if (browserManager) {
    browserManager.setSidebarState(sidebarExpanded);
    browserManager.resizeStreamView(mainWindow);
  }
  return true;
});

// Channel management
ipcMain.handle('get-channels', () => store.get('channels'));

ipcMain.handle('add-channel', async (_, channel) => {
  const channels = store.get('channels') || [];
  const { v4: uuidv4 } = require('uuid');
  channel.id = uuidv4();
  channel.isLive = { youtube: false, twitch: false, kick: false };
  
  if (!streamChecker) streamChecker = new StreamChecker();
  try {
    const avatarUrl = await streamChecker.getChannelAvatar(channel);
    if (avatarUrl) channel.avatarUrl = avatarUrl;
  } catch (e) {
    console.error('Avatar fetch failed for new channel:', e.message);
  }

  channels.push(channel);
  store.set('channels', channels);
  return channel;
});

ipcMain.handle('update-channel', async (_, updatedChannel) => {
  const channels = store.get('channels') || [];
  const index = channels.findIndex(c => c.id === updatedChannel.id);
  if (index !== -1) {
    const oldChannel = channels[index];
    const urlsChanged = oldChannel.youtube !== updatedChannel.youtube ||
                        oldChannel.twitch !== updatedChannel.twitch ||
                        oldChannel.kick !== updatedChannel.kick;
    
    if (urlsChanged || !oldChannel.avatarUrl) {
      if (!streamChecker) streamChecker = new StreamChecker();
      try {
        const avatarUrl = await streamChecker.getChannelAvatar(updatedChannel);
        if (avatarUrl) updatedChannel.avatarUrl = avatarUrl;
      } catch (e) {
        console.error('Avatar fetch failed on update:', e.message);
      }
    } else {
      updatedChannel.avatarUrl = oldChannel.avatarUrl;
    }

    channels[index] = { ...channels[index], ...updatedChannel };
    store.set('channels', channels);
    return true;
  }
  return false;
});

ipcMain.handle('delete-channel', (_, channelId) => {
  const channels = (store.get('channels') || []).filter(c => c.id !== channelId);
  store.set('channels', channels);
  return true;
});

// Auto-launch
ipcMain.handle('set-auto-launch', async (_, enabled) => {
  try {
    if (enabled) {
      await autoLauncher.enable();
    } else {
      await autoLauncher.disable();
    }
    store.set('autoLaunch', enabled);
    return true;
  } catch (err) {
    console.error('Auto-launch error:', err);
    return false;
  }
});

ipcMain.handle('set-start-minimized', (_, enabled) => {
  store.set('startMinimized', enabled);
  return true;
});

// Theme
ipcMain.handle('set-theme', (_, theme) => {
  store.set('theme', theme);
  if (mainWindow) {
    mainWindow.setBackgroundColor(theme === 'dark' ? '#0A0A0B' : '#FAFAFA');
  }
  return true;
});

// Stream checking
ipcMain.handle('check-streams', async () => {
  if (!streamChecker) streamChecker = new StreamChecker();
  const channels = store.get('channels') || [];
  const results = await streamChecker.checkAll(channels);

  // Update store and send notifications
  const storedChannels = store.get('channels') || [];
  for (const result of results) {
    const channel = storedChannels.find(c => c.id === result.id);
    if (channel) {
      const oldLive = channel.isLive || {};
      const newLive = result.isLive;

      // Check for new live streams
      if (channel.notificationsEnabled !== false) {
        for (const platform of ['youtube', 'twitch', 'kick']) {
          if (newLive[platform] && !oldLive[platform]) {
            // Send notification
            const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
            const notification = new Notification({
              title: `${channel.name} Canlı Yayında!`,
              body: `${channel.name} ${platformName} üzerinde yayın başlattı.`,
              icon: path.join(__dirname, 'assets', 'icon.png'),
            });

            notification.on('click', () => {
              if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
                const url = channel[platform];
                if (url) {
                  mainWindow.webContents.send('open-stream-from-notification', { channelId: channel.id, platform, url });
                }
              }
            });

            notification.show();
          }
        }
      }

      channel.isLive = newLive;

      // If channel is missing avatar, fetch it!
      if (!channel.avatarUrl) {
        try {
          const avatarUrl = await streamChecker.getChannelAvatar(channel);
          if (avatarUrl) channel.avatarUrl = avatarUrl;
        } catch (e) {
          console.error(`Failed to fetch missing avatar for ${channel.name}:`, e.message);
        }
      }
    }
  }
  store.set('channels', storedChannels);
  return storedChannels;
});

// ========================
// App Lifecycle
// ========================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    createWindow();
    createTray();

    // Auto-initialize browser manager if a browser is already selected
    const selectedBrowser = store.get('selectedBrowser');
    if (selectedBrowser) {
      browserManager = new BrowserManager();
      try {
        await browserManager.initialize(selectedBrowser);
        console.log('[Main] Browser manager initialized');
      } catch (e) {
        console.error('[Main] Browser initialization error:', e);
      }
    }

    // Start periodic stream checking (every 60 seconds)
    setInterval(async () => {
      try {
        const channels = store.get('channels') || [];
        if (channels.length > 0) {
          if (!streamChecker) streamChecker = new StreamChecker();
          const results = await streamChecker.checkAll(channels);

          const storedChannels = store.get('channels') || [];
          for (const result of results) {
            const channel = storedChannels.find(c => c.id === result.id);
            if (channel) {
              const oldLive = channel.isLive || {};
              const newLive = result.isLive;

              if (channel.notificationsEnabled !== false) {
                for (const platform of ['youtube', 'twitch', 'kick']) {
                  if (newLive[platform] && !oldLive[platform]) {
                    const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
                    const notification = new Notification({
                      title: `${channel.name} Canlı Yayında!`,
                      body: `${channel.name} ${platformName} üzerinde yayın başlattı.`,
                      icon: path.join(__dirname, 'assets', 'icon.png'),
                    });
                    notification.on('click', () => {
                      if (mainWindow) {
                        mainWindow.show();
                        mainWindow.focus();
                        mainWindow.webContents.send('open-stream-from-notification', {
                          channelId: channel.id, platform, url: channel[platform]
                        });
                      }
                    });
                    notification.show();
                  }
                }
              }

              channel.isLive = newLive;

              // If channel is missing avatar, fetch it!
              if (!channel.avatarUrl) {
                try {
                  const avatarUrl = await streamChecker.getChannelAvatar(channel);
                  if (avatarUrl) channel.avatarUrl = avatarUrl;
                } catch (e) {
                  console.error(`Failed to fetch missing avatar for ${channel.name}:`, e.message);
                }
              }
            }
          }
          store.set('channels', storedChannels);
          // Notify renderer of updated channels
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('channels-updated', storedChannels);
          }
        }
      } catch (err) {
        console.error('Stream check error:', err);
      }
    }, 60000);

    // F11 → Electron penceresini tam ekran yap/çık
    globalShortcut.register('F11', () => {
      if (!mainWindow) return;
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    });
  });

  app.on('window-all-closed', () => {
    // Don't quit on window close — keep in tray
  });

  app.on('before-quit', () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (browserManager) browserManager.destroy(mainWindow);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

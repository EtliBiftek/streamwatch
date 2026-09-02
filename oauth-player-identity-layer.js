'use strict';

const { app, session, webContents } = require('electron');
const { platformFromUrl, injectOAuthIdentity } = require('./src/oauth-player-identity');

function isStreamSession(contents) {
  try {
    return contents?.session === session.fromPartition('persist:stream');
  } catch {
    return false;
  }
}

function apply(contents, url = null) {
  if (!contents || contents.isDestroyed() || !isStreamSession(contents)) return;
  const currentUrl = String(url || contents.getURL?.() || '');
  if (!platformFromUrl(currentUrl)) return;
  injectOAuthIdentity(contents, currentUrl).catch(() => {});
  setTimeout(() => {
    if (!contents.isDestroyed()) injectOAuthIdentity(contents, contents.getURL?.() || currentUrl).catch(() => {});
  }, 350);
  setTimeout(() => {
    if (!contents.isDestroyed()) injectOAuthIdentity(contents, contents.getURL?.() || currentUrl).catch(() => {});
  }, 1200);
}

function attach(contents) {
  if (!contents || contents.isDestroyed() || contents.__streamwatchOAuthIdentityAttached) return;
  contents.__streamwatchOAuthIdentityAttached = true;

  contents.on('did-finish-load', () => apply(contents));
  contents.on('dom-ready', () => apply(contents));
  contents.on('did-navigate-in-page', (_event, url) => apply(contents, url));
}

app.on('web-contents-created', (_event, contents) => attach(contents));

app.whenReady().then(() => {
  for (const contents of webContents.getAllWebContents()) attach(contents);
});

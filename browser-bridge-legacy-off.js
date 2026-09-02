'use strict';

const { session } = require('electron');
const Store = require('electron-store');
const BrowserManager = require('./src/browser-manager');

const store = new Store();

// Modern Chromium browsers protect their cookie database with App-Bound Encryption.
// StreamWatch no longer tries to decrypt/read that database directly. Browser Bridge
// is the only supported browser-session import path for Chromium-based browsers.
BrowserManager.prototype._loadCookies = async function streamwatchBrowserBridgeOnly(browserKey) {
  this.streamSession ||= session.fromPartition('persist:stream');
  this.cookiesLoaded = false;
  this.cookieStatus = 'browser-bridge';
  store.set('accountCookieImportState', {
    browser: browserKey || null,
    profile: null,
    imported: 0,
    status: 'browser-bridge',
    at: Date.now(),
  });
};

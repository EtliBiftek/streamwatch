'use strict';

const { session } = require('electron');
const Store = require('electron-store');
const BrowserManager = require('./src/browser-manager');

const store = new Store();

BrowserManager.prototype._loadCookies = async function streamwatchOAuthOnlySession(browserKey) {
  this.streamSession ||= session.fromPartition('persist:stream');
  this.cookiesLoaded = false;
  this.cookieStatus = 'oauth';
  store.set('accountCookieImportState', {
    browser: browserKey || null,
    profile: null,
    imported: 0,
    status: 'oauth',
    at: Date.now(),
  });
};

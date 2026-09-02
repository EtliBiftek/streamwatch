'use strict';

const { app, safeStorage } = require('electron');
const Store = require('electron-store');
const { getOAuthAppConfig } = require('./oauth-app-config');

const store = new Store();
const appConfig = getOAuthAppConfig({});
const current = store.get('oauthAccountsConfig');
const next = current && typeof current === 'object' ? { ...current } : {};

if (appConfig.youtubeClientId) next.youtubeClientId = appConfig.youtubeClientId;
if (appConfig.twitchClientId) next.twitchClientId = appConfig.twitchClientId;
if (appConfig.kickClientId) next.kickClientId = appConfig.kickClientId;
store.set('oauthAccountsConfig', next);

function encryptSecret(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return null;
  return `safe:${safeStorage.encryptString(String(value)).toString('base64')}`;
}

app.whenReady().then(() => {
  const latest = store.get('oauthAccountsConfig');
  const config = latest && typeof latest === 'object' ? { ...latest } : {};

  if (appConfig.youtubeClientSecret) {
    const encrypted = encryptSecret(appConfig.youtubeClientSecret);
    if (encrypted) config.youtubeClientSecret = encrypted;
  }
  if (appConfig.kickClientSecret) {
    const encrypted = encryptSecret(appConfig.kickClientSecret);
    if (encrypted) config.kickClientSecret = encrypted;
  }

  store.set('oauthAccountsConfig', config);
}).catch(() => {});
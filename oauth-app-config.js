'use strict';

const fs = require('fs');
const path = require('path');

let cached = null;

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function productionConfig() {
  if (cached) return cached;
  const candidates = [
    path.join(__dirname, 'oauth-production.json'),
    process.resourcesPath ? path.join(process.resourcesPath, 'oauth-production.json') : null,
    path.join(process.cwd(), 'oauth-production.json'),
  ].filter(Boolean);

  let fileConfig = {};
  for (const candidate of candidates) {
    const parsed = readJson(candidate);
    if (parsed) {
      fileConfig = parsed;
      break;
    }
  }

  cached = {
    youtubeClientId: String(process.env.STREAMWATCH_YOUTUBE_CLIENT_ID || fileConfig.youtubeClientId || '').trim(),
    youtubeClientSecret: String(process.env.STREAMWATCH_YOUTUBE_CLIENT_SECRET || fileConfig.youtubeClientSecret || '').trim(),
    twitchClientId: String(process.env.STREAMWATCH_TWITCH_CLIENT_ID || fileConfig.twitchClientId || '').trim(),
    kickClientId: String(process.env.STREAMWATCH_KICK_CLIENT_ID || fileConfig.kickClientId || '').trim(),
    kickClientSecret: String(process.env.STREAMWATCH_KICK_CLIENT_SECRET || fileConfig.kickClientSecret || '').trim(),
  };
  return cached;
}

function getOAuthAppConfig(legacy = {}) {
  const appConfig = productionConfig();
  return {
    ...legacy,
    ...(appConfig.youtubeClientId ? { youtubeClientId: appConfig.youtubeClientId } : {}),
    ...(appConfig.youtubeClientSecret ? { youtubeClientSecret: appConfig.youtubeClientSecret } : {}),
    ...(appConfig.twitchClientId ? { twitchClientId: appConfig.twitchClientId } : {}),
    ...(appConfig.kickClientId ? { kickClientId: appConfig.kickClientId } : {}),
    ...(appConfig.kickClientSecret ? { kickClientSecret: appConfig.kickClientSecret } : {}),
  };
}

function resolveSecret(value, decryptLegacy) {
  if (!value || typeof value !== 'string') return '';
  if (value.startsWith('safe:')) return typeof decryptLegacy === 'function' ? decryptLegacy(value) : '';
  return value;
}

module.exports = { getOAuthAppConfig, resolveSecret };
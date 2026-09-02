'use strict';

const { safeStorage } = require('electron');
const Store = require('electron-store');

const store = new Store();

const PLATFORM_LABELS = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  kick: 'Kick',
};

function platformFromUrl(url) {
  const value = String(url || '');
  if (/youtube\.com|youtu\.be/i.test(value)) return 'youtube';
  if (/twitch\.tv/i.test(value)) return 'twitch';
  if (/kick\.com/i.test(value)) return 'kick';
  return null;
}

function decrypt(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('safe:')) return '';
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'));
  } catch {
    return '';
  }
}

function readAccount(platform) {
  if (!PLATFORM_LABELS[platform]) return null;
  const raw = decrypt(store.get(`oauthAccountToken.${platform}`));
  if (!raw) return null;

  try {
    const token = JSON.parse(raw);
    if (!token?.accessToken || !token?.profile) return null;
    const profile = token.profile || {};
    const username = String(profile.username || profile.name || '').trim();
    const displayName = String(profile.displayName || username || PLATFORM_LABELS[platform]).trim();
    const avatarUrl = /^https?:\/\//i.test(String(profile.avatarUrl || '')) ? String(profile.avatarUrl) : '';
    return {
      platform,
      platformLabel: PLATFORM_LABELS[platform],
      username,
      displayName,
      avatarUrl,
    };
  } catch {
    return null;
  }
}

function platformLoginCss(platform) {
  if (platform === 'youtube') {
    return `
      ytd-masthead a[href*="accounts.google.com"],
      ytd-masthead a[href^="/signin"],
      ytd-masthead [aria-label*="Sign in" i],
      ytd-masthead [aria-label*="Oturum aç" i],
      ytd-masthead [aria-label*="Giriş yap" i] { display:none!important; }
    `;
  }
  if (platform === 'twitch') {
    return `
      [data-a-target="login-button"],
      [data-a-target="signup-button"],
      a[href*="/login"],
      button[aria-label*="Log in" i] { display:none!important; }
    `;
  }
  if (platform === 'kick') {
    return `
      a[href="/login"],
      a[href^="/login?"],
      [data-testid*="login" i],
      button[aria-label*="login" i] { display:none!important; }
    `;
  }
  return '';
}

async function injectOAuthIdentity(webContents, url) {
  if (!webContents || webContents.isDestroyed()) return;
  const platform = platformFromUrl(url || webContents.getURL?.());
  if (!platform) {
    webContents.executeJavaScript(`document.getElementById('__streamwatch_oauth_identity')?.remove()`).catch(() => {});
    return;
  }

  const account = readAccount(platform);
  const css = `
    ${platformLoginCss(platform)}
    #__streamwatch_oauth_identity {
      position:fixed!important;
      top:10px!important;
      right:12px!important;
      z-index:2147483647!important;
      display:flex!important;
      align-items:center!important;
      gap:8px!important;
      min-height:34px!important;
      max-width:min(320px,calc(100vw - 24px))!important;
      padding:5px 10px 5px 6px!important;
      border:1px solid rgba(255,255,255,.14)!important;
      border-radius:999px!important;
      background:rgba(12,12,16,.88)!important;
      box-shadow:0 8px 30px rgba(0,0,0,.38)!important;
      backdrop-filter:blur(12px)!important;
      -webkit-backdrop-filter:blur(12px)!important;
      color:#f5f5f7!important;
      font:600 12px/1.15 Inter,system-ui,-apple-system,"Segoe UI",sans-serif!important;
      letter-spacing:0!important;
      pointer-events:none!important;
      user-select:none!important;
    }
    #__streamwatch_oauth_identity .sw-oauth-player-avatar {
      width:24px!important;
      height:24px!important;
      border-radius:50%!important;
      object-fit:cover!important;
      background:#2a2334!important;
      flex:0 0 auto!important;
    }
    #__streamwatch_oauth_identity .sw-oauth-player-fallback {
      display:grid!important;
      place-items:center!important;
      font-size:10px!important;
      font-weight:800!important;
    }
    #__streamwatch_oauth_identity .sw-oauth-player-copy {
      min-width:0!important;
      display:flex!important;
      flex-direction:column!important;
      gap:1px!important;
    }
    #__streamwatch_oauth_identity .sw-oauth-player-name {
      overflow:hidden!important;
      text-overflow:ellipsis!important;
      white-space:nowrap!important;
      max-width:230px!important;
    }
    #__streamwatch_oauth_identity .sw-oauth-player-meta {
      display:flex!important;
      align-items:center!important;
      gap:5px!important;
      color:#a7a7b1!important;
      font-size:9px!important;
      font-weight:650!important;
      text-transform:none!important;
    }
    #__streamwatch_oauth_identity .sw-oauth-player-dot {
      width:6px!important;
      height:6px!important;
      border-radius:50%!important;
      background:#52d392!important;
      box-shadow:0 0 0 3px rgba(82,211,146,.12)!important;
      flex:0 0 auto!important;
    }
  `;
  webContents.insertCSS(css).catch(() => {});

  if (!account) {
    webContents.executeJavaScript(`document.getElementById('__streamwatch_oauth_identity')?.remove()`).catch(() => {});
    return;
  }

  const payload = JSON.stringify(account).replace(/</g, '\\u003c');
  const script = `(() => {
    const account = ${payload};
    let root = document.getElementById('__streamwatch_oauth_identity');
    if (!root) {
      root = document.createElement('div');
      root.id = '__streamwatch_oauth_identity';
      root.title = 'Bu hesap StreamWatch OAuth/API katmanında bağlıdır. Platform web sitesinin cookie oturumu ayrıdır.';
      document.documentElement.appendChild(root);
    }
    root.replaceChildren();

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'sw-oauth-player-avatar sw-oauth-player-fallback';
    avatarWrap.textContent = (account.platformLabel || 'SW').slice(0, 2).toUpperCase();

    if (account.avatarUrl) {
      const img = document.createElement('img');
      img.className = 'sw-oauth-player-avatar';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = account.avatarUrl;
      img.addEventListener('load', () => avatarWrap.replaceWith(img), { once:true });
    }

    const copy = document.createElement('div');
    copy.className = 'sw-oauth-player-copy';
    const name = document.createElement('div');
    name.className = 'sw-oauth-player-name';
    name.textContent = account.displayName || account.username || account.platformLabel;
    const meta = document.createElement('div');
    meta.className = 'sw-oauth-player-meta';
    const dot = document.createElement('span');
    dot.className = 'sw-oauth-player-dot';
    const text = document.createElement('span');
    text.textContent = account.platformLabel + ' • StreamWatch OAuth';
    meta.append(dot, text);
    copy.append(name, meta);
    root.append(avatarWrap, copy);
  })()`;
  webContents.executeJavaScript(script).catch(() => {});
}

module.exports = {
  platformFromUrl,
  readAccount,
  injectOAuthIdentity,
};

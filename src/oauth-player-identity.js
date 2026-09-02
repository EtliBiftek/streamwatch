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
      ytd-masthead a[href^="/login"],
      ytd-masthead [aria-label*="Sign in" i],
      ytd-masthead [aria-label*="Oturum aç" i],
      ytd-masthead [aria-label*="Giriş yap" i],
      ytd-button-renderer a[href*="ServiceLogin"],
      ytd-button-renderer a[href*="accounts.google.com"] { display:none!important; }
    `;
  }
  if (platform === 'twitch') {
    return `
      [data-a-target="login-button"],
      [data-a-target="signup-button"],
      a[href="/login"],
      a[href^="/login?"],
      button[aria-label*="Log in" i],
      button[aria-label*="Sign up" i] { display:none!important; }
    `;
  }
  if (platform === 'kick') {
    return `
      a[href="/login"],
      a[href^="/login?"],
      a[href="/signup"],
      a[href^="/signup?"],
      [data-testid*="login" i],
      [data-testid*="signup" i],
      button[aria-label*="login" i],
      button[aria-label*="giriş" i] { display:none!important; }
    `;
  }
  return '';
}

function authGuardScript(account) {
  const payload = JSON.stringify(account).replace(/</g, '\\u003c');
  return `(() => {
    const account = ${payload};
    const platform = account.platform;
    const guardKey = '__streamwatch_oauth_auth_guard_' + platform;

    const normalize = (value) => String(value || '')
      .toLocaleLowerCase('tr-TR')
      .replace(/\\s+/g, ' ')
      .trim();

    const looksLikeAuthText = (text) => {
      const t = normalize(text);
      if (!t) return false;
      if (platform === 'kick') {
        return (t.includes('giriş yap') || t.includes('log in') || t.includes('sign in'))
          && (t.includes('şifre') || t.includes('password'))
          && (t.includes('e-posta') || t.includes('email') || t.includes('kullanıcı adı') || t.includes('username'));
      }
      if (platform === 'twitch') {
        return (t.includes('log in') || t.includes('giriş yap') || t.includes('sign in'))
          && (t.includes('password') || t.includes('şifre'))
          && (t.includes('username') || t.includes('email') || t.includes('kullanıcı adı'));
      }
      if (platform === 'youtube') {
        return t.includes('sign in to youtube')
          || t.includes('youtube’da oturum aç')
          || t.includes('youtube\'da oturum aç')
          || (t.includes('sign in') && t.includes('youtube'));
      }
      return false;
    };

    const removeAuthRoot = (node) => {
      if (!node || node.id === '__streamwatch_oauth_identity') return false;
      let root = node.closest?.('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]');
      if (!root) {
        const form = node.matches?.('form') ? node : node.querySelector?.('form');
        if (form) {
          root = form.closest?.('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]')
            || form.parentElement?.parentElement?.parentElement
            || form.parentElement;
        }
      }
      if (!root || root === document.body || root === document.documentElement) return false;
      try { root.remove(); } catch { root.style.setProperty('display', 'none', 'important'); }
      document.documentElement.style.removeProperty('overflow');
      document.body?.style?.removeProperty('overflow');
      return true;
    };

    const sweep = () => {
      let removed = false;
      const candidates = [
        ...document.querySelectorAll('[role="dialog"], [aria-modal="true"]'),
        ...document.querySelectorAll('form'),
      ];
      for (const node of candidates) {
        const text = node.innerText || node.textContent || '';
        if (!looksLikeAuthText(text)) continue;
        removed = removeAuthRoot(node) || removed;
      }

      if (removed) {
        document.querySelectorAll('[data-radix-portal], [class*="backdrop" i], [class*="overlay" i]').forEach((node) => {
          const t = normalize(node.innerText || node.textContent || '');
          if (!t || looksLikeAuthText(t)) {
            const rect = node.getBoundingClientRect?.();
            if (rect && rect.width >= innerWidth * .7 && rect.height >= innerHeight * .7) {
              try { node.remove(); } catch { node.style.setProperty('display', 'none', 'important'); }
            }
          }
        });
      }
    };

    const explicitLoginTarget = (element) => {
      const el = element?.closest?.('a,button,[role="button"]');
      if (!el) return false;
      const href = String(el.getAttribute?.('href') || '');
      const label = normalize(el.getAttribute?.('aria-label') || el.innerText || el.textContent || '');
      if (platform === 'youtube') {
        return /accounts\\.google\\.com|\\/(?:signin|login)(?:[/?#]|$)/i.test(href)
          || label === 'sign in' || label === 'oturum aç' || label === 'giriş yap';
      }
      if (platform === 'twitch') {
        return /\\/login(?:[/?#]|$)/i.test(href)
          || label === 'log in' || label === 'giriş yap' || label === 'sign in';
      }
      if (platform === 'kick') {
        return /\\/(?:login|signup|register)(?:[/?#]|$)/i.test(href)
          || label === 'giriş yap' || label === 'log in' || label === 'sign in';
      }
      return false;
    };

    if (!window[guardKey]) {
      window[guardKey] = true;
      document.addEventListener('click', (event) => {
        if (!explicitLoginTarget(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        sweep();
      }, true);

      const observer = new MutationObserver(() => sweep());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setInterval(sweep, 2500);
    }

    sweep();
  })()`;
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

  webContents.executeJavaScript(authGuardScript(account)).catch(() => {});

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

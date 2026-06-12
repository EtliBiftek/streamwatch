/**
 * Yerleşik reklam engelleyici — Electron webRequest API ile
 * YouTube, Twitch ve Kick için optimize edilmiş
 *
 * YouTube Stratejisi:
 *   YouTube'un anti-adblock tespiti, reklam ağ isteklerinin engellenip
 *   engellenmediğini kontrol eder. Bu yüzden YouTube'a ait domain'lerin
 *   ağ isteklerini ENGELLEMİYORUZ. Bunun yerine:
 *     - Reklam elementlerini CSS ile gizliyoruz
 *     - Video reklamları otomatik atlıyoruz (skip + currentTime)
 *     - Anti-adblock popup'ını DOM'dan kaldırıyoruz
 *
 *   uBlock Origin Lite gibi tanınan reklam engelleyici extension'lar
 *   browser-manager.js tarafından yüklenmesi engelleniyor.
 */

// YouTube HARİÇ — sadece 3. parti reklam ağları için engelleme
const AD_DOMAINS = [
  // Genel reklam ağları (YouTube dışı)
  'adnxs.com', 'adsrvr.org', 'advertising.com', 'amazon-adsystem.com',
  'bidswitch.net', 'casalemedia.com', 'contextweb.com', 'criteo.com',
  'crwdcntrl.net', 'demdex.net', 'exelator.com', 'eyeota.net',
  'moatads.com', 'mookie1.com', 'openx.net', 'pubmatic.com',
  'rubiconproject.com', 'smartadserver.com',
  'taboola.com', 'outbrain.com', 'mgid.com',

  // Tracking / Analytics
  'analytics.twitter.com', 'bat.bing.com', 'cdn.krxd.net',
  'cdn.mxpnl.com', 'pixel.facebook.com',
  'tr.snapchat.com',

  // Twitch reklam sunucuları
  'ads.twitch.tv', 'ads-interfaces.sc-cdn.net',

  // Genel spam / pop-up
  'popads.net', 'popcash.net', 'propellerads.com',
];

// YouTube HARİÇ URL pattern'leri
const AD_URL_PATTERNS = [
  /^(?!.*youtube\.com).*\/adserver\//i,
  /^(?!.*youtube\.com).*\/ads\//i,
  /amazon-adsystem\.com/i,
  /moatads\.com/i,
  /taboola\.com/i,
  /outbrain\.com/i,
];

// YouTube'a özel CSS gizleme
const YOUTUBE_AD_CSS = `
  /* Anti-adblock popup'ını ve ilgili dialogları görünmez yap (display:none yerine) */
  ytd-enforcement-message-view-model,
  tp-yt-paper-dialog:has(ytd-enforcement-message-view-model),
  tp-yt-paper-dialog:has(yt-mealbar-promo-renderer),
  tp-yt-paper-dialog.ytd-popup-container:has(#feedback),
  tp-yt-iron-overlay-backdrop {
    opacity: 0 !important;
    pointer-events: none !important;
    z-index: -9999 !important;
  }

  /* Promoted / banner / merch reklamlar - anti-adblock tespiti tetiklememesi (0px boyut kontrolü) için offscreen konumlandırma kullanıyoruz */
  ytd-promoted-sparkles-web-renderer,
  ytd-promoted-video-renderer,
  ytd-display-ad-renderer,
  ytd-companion-slot-renderer,
  ytd-action-companion-ad-renderer,
  ytd-in-feed-ad-layout-renderer,
  ytd-ad-slot-renderer,
  ytd-banner-promo-renderer,
  ytd-statement-banner-renderer,
  ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
  #masthead-ad, #player-ads,
  .ytd-mealbar-promo-renderer,
  ytd-merch-shelf-renderer,
  #related ytd-promoted-sparkles-web-renderer,
  ytd-compact-promoted-video-renderer {
    position: absolute !important;
    top: -9999px !important;
    left: -9999px !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }

  /* body scroll kilidini engelle (popup açıldığında) */
  html[style*="overflow: hidden"],
  body[style*="overflow: hidden"] {
    overflow: auto !important;
  }
`;

const TWITCH_AD_CSS = `
  .ad-banner, .stream-display-ad,
  [data-a-target="video-ad-label"],
  [data-a-target="video-ad-countdown"],
  .video-player__ad-overlay { display: none !important; }
`;

const KICK_AD_CSS = `
  .ad-container, [class*="ad-banner"] { display: none !important; }
`;

class AdBlocker {
  constructor() {
    this.enabled = true;
    this.blockedCount = 0;
  }

  /**
   * Session'a reklam engelleme kurallarını uygula
   */
  attach(session) {
    if (!session) return;

    // Network-level engelleme: SADECE 3. parti reklam ağları
    // YouTube domain'leri (doubleclick, googlesyndication vb.) ENGELLENMEZ
    session.webRequest.onBeforeRequest((details, callback) => {
      if (!this.enabled) {
        callback({});
        return;
      }

      const url = details.url;

      // YouTube ekosistemi isteklerini ASLA engelleme
      if (this._isYouTubeRelated(url)) {
        callback({});
        return;
      }

      // URL pattern kontrolü (YouTube hariç)
      for (const pattern of AD_URL_PATTERNS) {
        if (pattern.test(url)) {
          this.blockedCount++;
          console.log(`[AdBlocker] Blocked URL(pattern): ${ url } `);
          callback({ cancel: true });
          return;
        }
      }

      // Domain kontrolü (YouTube hariç)
      try {
        const hostname = new URL(url).hostname;
        for (const domain of AD_DOMAINS) {
          if (hostname === domain || hostname.endsWith('.' + domain)) {
            this.blockedCount++;
            console.log(`[AdBlocker] Blocked URL(domain): ${ url } `);
            callback({ cancel: true });
            return;
          }
        }
      } catch { /* geçersiz URL */ }

      callback({});
    });

    console.log('[AdBlocker] Attached — YouTube safe mode (no network blocking for YT)');
  }

  /**
   * URL'nin YouTube ekosistemiyle ilgili olup olmadığını kontrol et
   */
  _isYouTubeRelated(url) {
    const ytDomains = [
      'youtube.com', 'youtu.be', 'ytimg.com', 'yt.be',
      'googlevideo.com', 'youtube-nocookie.com',
      'doubleclick.net', 'googlesyndication.com',
      'googleadservices.com', 'google-analytics.com',
      'googletagmanager.com', 'googletagservices.com',
      'gstatic.com', 'googleapis.com',
    ];
    try {
      const hostname = new URL(url).hostname;
      return ytDomains.some(d => hostname === d || hostname.endsWith('.' + d));
    } catch {
      return false;
    }
  }

  /**
   * WebContents'e platform-specific reklam CSS + JS enjekte et
   */
  injectCSS(webContents, url) {
    if (!webContents || webContents.isDestroyed()) return;

    let css = '';
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      css = YOUTUBE_AD_CSS;
      this._injectYouTubeAdSkipper(webContents);
    } else if (url.includes('twitch.tv')) {
      css = TWITCH_AD_CSS;
    } else if (url.includes('kick.com')) {
      css = KICK_AD_CSS;
    }

    if (css) {
      webContents.insertCSS(css).catch(() => {});
    }
  }

  /**
   * YouTube video reklamlarını DOM seviyesinde atla.
   * Ağ isteklerini değiştirmez — sadece DOM manipülasyonu.
   */
  _injectYouTubeAdSkipper(webContents) {
    if (!webContents || webContents.isDestroyed()) return;

    const script = `
  (function () {
    'use strict';
    if (window.__yzAdSkipperV4) return;
    window.__yzAdSkipperV4 = true;

    console.log('[YZ AdSkipper] v4 initialized');

    let originalPlaybackRate = 1;
    let originalMuted = false;
    let adSpeedUpActive = false;

    // Helper to query elements deep inside Shadow DOM
    function querySelectorAllDeep(selector, root = document) {
      const matches = [];
      function traverse(node) {
        if (!node) return;
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches(selector)) {
            matches.push(node);
          }
          if (node.shadowRoot) {
            traverse(node.shadowRoot);
          }
        }
        let child = node.firstChild;
        while (child) {
          traverse(child);
          child = child.nextSibling;
        }
      }
      traverse(root);
      return matches;
    }

    // Helper to get all text content including Shadow DOM
    function getTextContentDeep(node) {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue;
      }
      let text = '';
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          text += getTextContentDeep(node.childNodes[i]);
        }
      }
      if (node.shadowRoot) {
        text += getTextContentDeep(node.shadowRoot);
      }
      return text;
    }

    // ── Cookie Rızası / Kabul Et Butonlarını Otomatik Tıkla ──
    function acceptCookieConsent() {
      const containers = document.querySelectorAll(
        'ytd-consent-bump-v2-renderer, form[action*="consent"], #consent-bump, yt-consent-bump-renderer'
      );
      let clicked = false;
      for (const container of containers) {
        const buttons = querySelectorAllDeep('button, [role="button"], yt-button-shape, yt-button-renderer, yt-button-view-model', container);
        for (const btn of buttons) {
          const txt = getTextContentDeep(btn).toLowerCase();
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (
            txt.includes('kabul') || txt.includes('accept') || txt.includes('agree') || txt.includes('tümünü kabul') ||
            label.includes('kabul') || label.includes('accept') || label.includes('agree')
          ) {
            console.log('[YZ AdSkipper] Clicking Cookie/Consent Button:', txt || label);
            btn.click();
            clicked = true;
            break;
          }
        }
      }
      return clicked;
    }

    // ── Giriş Yap / Tanıtım Popup'larını Kapat ──
    function dismissLoginPromo() {
      const dialogs = document.querySelectorAll('ytd-popup-container, tp-yt-paper-dialog');
      for (const dialog of dialogs) {
        const buttons = querySelectorAllDeep('button, [role="button"], yt-button-shape, yt-button-renderer, yt-button-view-model', dialog);
        for (const btn of buttons) {
          const txt = getTextContentDeep(btn).toLowerCase();
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (
            txt.includes('teşekkür') || txt.includes('thanks') || txt.includes('hayır') || txt.includes('no thanks') || txt.includes('geç') || txt.includes('skip') ||
            label.includes('teşekkür') || label.includes('thanks') || label.includes('hayır') || label.includes('no thanks') || label.includes('geç') || label.includes('skip')
          ) {
            console.log('[YZ AdSkipper] Clicking Dismiss Sign-in Promo button:', txt || label);
            btn.click();
            break;
          }
        }
      }
    }

    // ── Anti-adblock / Mature Content popup'larını yönet ──
    function handleEnforcementMessage() {
      // Sadece ytd-enforcement-message-view-model üzerinden kontrol yapıyoruz.
      // #enforcement-message statik şablonda boş bir placeholder olarak her videoda bulunduğundan
      // silinmesi veya müdahale edilmesi oynatıcıyı (player) bozabilir.
      const enforcement = document.querySelector('ytd-enforcement-message-view-model');
      if (!enforcement) return;

      // Onay, Devam, Kabul, Anlıyorum, İzle, Proceed, Understand, Agree, Watch butonlarını ara
      const buttons = querySelectorAllDeep('button, [role="button"], yt-button-shape, yt-button-renderer, yt-button-view-model', enforcement);
      let clicked = false;

      for (const btn of buttons) {
        const txt = getTextContentDeep(btn).toLowerCase();
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();

        if (
          txt.includes('kabul') || txt.includes('devam') || txt.includes('anlıyorum') || txt.includes('izle') ||
          txt.includes('proceed') || txt.includes('understand') || txt.includes('agree') || txt.includes('watch') || txt.includes('yine de') ||
          label.includes('kabul') || label.includes('devam') || label.includes('anlıyorum') || label.includes('izle') ||
          label.includes('proceed') || label.includes('understand') || label.includes('agree') || label.includes('watch')
        ) {
          console.log('[YZ AdSkipper] Clicking Enforcement Proceed/Accept Button:', txt || label);
          btn.click();
          clicked = true;
          break;
        }
      }

      // Eğer devam/onay butonu yoksa işlem yapma (statik boş elementi silmek oynatıcıyı bozar)

      // Backdrop temizliği (sadece adblock durumunda veya onay tıklandıktan sonra)
      const backdrops = document.querySelectorAll('tp-yt-iron-overlay-backdrop');
      backdrops.forEach(bd => bd.remove());

      if (document.body && document.body.style.overflow === 'hidden') {
        document.body.style.overflow = '';
      }
      if (document.documentElement && document.documentElement.style.overflow === 'hidden') {
        document.documentElement.style.overflow = '';
      }
    }

    // ── Safe Ad Skipping (16x Speed + Mute) ──
    function skipVideoAd() {
      const video = document.querySelector('video');
      const adShowing = document.querySelector('.ad-showing, .ad-interrupting');

      // 1) Eğer reklam oynatılıyorsa
      if (adShowing && video) {
        if (!adSpeedUpActive) {
          if (video.playbackRate !== 16) {
            originalPlaybackRate = video.playbackRate || 1;
          }
          originalMuted = video.muted;
          adSpeedUpActive = true;
          console.log('[YZ AdSkipper] Ad detected. Muting and speeding up to 16x.');
        }

        video.muted = true;
        video.playbackRate = 16;

        if (video.paused) {
          video.play().catch(() => { });
        }

        const skipBtn = document.querySelector(
          '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, ' +
          '.ytp-skip-ad-button, button.ytp-ad-skip-button-modern, ' +
          '[class*="skip-button"]'
        );
        if (skipBtn) {
          console.log('[YZ AdSkipper] Skip button found! Clicking.');
          skipBtn.click();
        }
      }
      // 2) Reklam bittiyse ve hızlandırma aktifse, orijinal hıza geri dön
      else if (!adShowing && video && adSpeedUpActive) {
        adSpeedUpActive = false;
        video.playbackRate = originalPlaybackRate;
        video.muted = originalMuted;
        console.log('[YZ AdSkipper] Ad finished. Restoring speed to ' + originalPlaybackRate + 'x.');
      }

      const closeBtn = document.querySelector('.ytp-ad-overlay-close-button');
      if (closeBtn) closeBtn.click();
    }

    // ── Video Durum Loglama (Hata Ayıklama İçin) ──
    let lastVideoState = '';
    function logVideoStatus() {
      const video = document.querySelector('video');
      if (!video) {
        if (lastVideoState !== 'no-video') {
          console.log('[YZ VideoStatus] No video element found on page');
          lastVideoState = 'no-video';
        }
        return;
      }

      const srcTruncated = video.src ? (video.src.substring(0, 50) + '...') : 'empty';
      const state = 'paused:' + video.paused + ', readyState:' + video.readyState + ', src:' + srcTruncated + ', currentTime:' + video.currentTime.toFixed(1) + ', duration:' + video.duration + ', playbackRate:' + video.playbackRate + ', error:' + (video.error ? video.error.code : 'none');
      if (lastVideoState !== state) {
        console.log('[YZ VideoStatus] ' + state);
        lastVideoState = state;
      }

      // Sayfa geçişlerinde veya yeni yayın yüklenmesinde autoplay durumunu sıfırla
      if (video.__yzLastSrc !== video.src) {
        video.__yzLastSrc = video.src;
        video.__yzAutoplayed = false;
      }

      // Eğer video hazır ama pause edilmişse ve reklam yoksa, oynatmaya çalış (sadece ilk yüklemede 1 kez)
      if (video.paused && video.readyState >= 2 && !document.querySelector('.ad-showing') && !video.ended && !video.__yzAutoplayed) {
        video.play()
          .then(() => {
            video.__yzAutoplayed = true;
          })
          .catch(e => {
            if (e.name === 'NotAllowedError') {
              if (window.__yzAutoplayWarned !== true) {
                console.warn('[YZ VideoStatus] Playback blocked by autoplay policy. Waiting for user interaction.');
                window.__yzAutoplayWarned = true;
              }
            }
          });
      }
    }

    // ── MutationObserver ile izle ──
    const observer = new MutationObserver(() => {
      acceptCookieConsent();
      dismissLoginPromo();
      handleEnforcementMessage();
      skipVideoAd();
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }

    // ── Periyodik kontrol ──
    setInterval(() => {
      acceptCookieConsent();
      dismissLoginPromo();
      handleEnforcementMessage();
      skipVideoAd();
      logVideoStatus();
    }, 500);

  })();
`;

    webContents.executeJavaScript(script).catch(() => {});
  }

  getStats() {
    return { blockedCount: this.blockedCount, enabled: this.enabled };
  }
}

module.exports = AdBlocker;

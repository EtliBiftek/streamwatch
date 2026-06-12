const { WebContentsView, session, app } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const AdBlocker = require('./ad-blocker');

class BrowserManager {
  constructor() {
    this.streamView = null;
    this.streamSession = null;

    this.sidebarWidth = 280;
    this.sidebarCollapsedWidth = 64;
    this.titlebarHeight = 40;
    this.isSidebarExpanded = true;

    this.cookiesLoaded = false;
    this.cookieStatus = 'unknown';
    this.extensionsLoaded = false;
    this.initialized = false;
    this.adBlocker = new AdBlocker();

    this.browserProfiles = {
      chrome: path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
      edge: path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
      brave: path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data'),
      opera: path.join(process.env.APPDATA || '', 'Opera Software', 'Opera Stable'),
    };

    this.browserPaths = {
      chrome: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      ],
      edge: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      brave: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      ],
      opera: [
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\Opera\\opera.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\Opera GX\\opera.exe'),
        'C:\\Program Files\\Opera\\opera.exe',
      ],
      firefox: [
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
      ],
    };
  }

  // ─── Browser Detection ──────────────────────────────────────────────────

  getAvailableBrowsers() {
    const available = [];
    for (const [key, paths] of Object.entries(this.browserPaths)) {
      for (const p of paths) {
        try {
          if (fs.existsSync(p)) {
            available.push({ key, name: this._getBrowserName(key), path: p });
            break;
          }
        } catch { }
      }
    }
    return available;
  }

  _getBrowserName(key) {
    return { chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave', opera: 'Opera', firefox: 'Mozilla Firefox' }[key] || key;
  }

  setSidebarState(expanded) { this.isSidebarExpanded = expanded; }

  // ─── Initialization (cookies + extensions) ──────────────────────────────

  async initialize(browserKey) {
    if (this.initialized) return;

    this.streamSession = session.fromPartition('persist:stream');

    // Set a proper user agent
    this.streamSession.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );

    // Yerleşik reklam engelleyiciyi session'a bağla
    this.adBlocker.attach(this.streamSession);

    try {
      await this._loadCookies(browserKey);
      console.log(`[BrowserManager] Cookie loading finished. Status: ${this.cookieStatus}`);
    } catch (e) {
      console.error('[BrowserManager] Cookie loading failed:', e.message);
      this.cookieStatus = 'error';
    }

    try {
      await this._loadExtensions(browserKey);
      this.extensionsLoaded = true;
      console.log('[BrowserManager] Extensions loaded successfully');
    } catch (e) {
      console.error('[BrowserManager] Extension loading failed:', e.message);
    }

    this.initialized = true;
  }

  // ─── Stream View Management ─────────────────────────────────────────────

  async openStream(url, parentWindow, sidebarExpanded) {
    this.isSidebarExpanded = sidebarExpanded;

    const injectAll = (currentUrl) => {
      if (!this.streamView || this.streamView.webContents.isDestroyed()) return;
      this._injectPlatformCSS(currentUrl);
      this.adBlocker.injectCSS(this.streamView.webContents, currentUrl);
    };

    if (this.streamView) {
      // Reuse existing view, just navigate
      this.streamView.webContents.loadURL(url);
      this.streamView.webContents.once('did-finish-load', () => injectAll(url));
    } else {
      // Create new WebContentsView
      this.streamView = new WebContentsView({
        webPreferences: {
          session: this.streamSession,
          contextIsolation: true,
          sandbox: false,
          autoplayPolicy: 'no-user-gesture-required',
        }
      });

      parentWindow.contentView.addChildView(this.streamView);

      // Stream view konsol mesajlarını main process'e yönlendir (debug)
      this.streamView.webContents.on('console-message', (event, level, message, line, sourceId) => {
        const levelStr = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
        if (message.includes('[YZ ') || level >= 2) {
          console.log(`[StreamView ${levelStr}] ${message}`);
        }
      });

      // Media hata tespiti
      this.streamView.webContents.on('media-started-playing', () => {
        console.log('[StreamView] Media started playing');
      });
      this.streamView.webContents.on('media-paused', () => {
        console.log('[StreamView] Media paused');
      });



      this.streamView.webContents.loadURL(url);

      // Platform navigation elementlerini gizle + reklam CSS/JS enjekte et
      this.streamView.webContents.on('did-finish-load', () => {
        const currentUrl = this.streamView.webContents.getURL();
        injectAll(currentUrl);
      });

      // YouTube SPA navigasyonlarında da enjekte et
      this.streamView.webContents.on('did-navigate-in-page', (event, pageUrl) => {
        injectAll(pageUrl);
      });

      // dom-ready'de de enjekte et
      this.streamView.webContents.on('dom-ready', () => {
        const currentUrl = this.streamView.webContents.getURL();
        injectAll(currentUrl);
      });
    }

    // Hemen ve kısa gecikme ile tekrar uygula (pencere render tamamlanana kadar)
    this.showStreamView();
    this.resizeStreamView(parentWindow);
    setTimeout(() => this.resizeStreamView(parentWindow), 150);
  }

  _injectPlatformCSS(url) {
    if (!this.streamView) return;
    let css = '';

    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      // YouTube: sol sidebar, masthead search bar'ı küçült
      css = `
        /* YouTube sol guide sidebar'ı gizle */
        ytd-guide-renderer, #guide-inner-content { display: none !important; }
        tp-yt-app-drawer { display: none !important; }
        /* Mini sidebar ikonları gizle */
        ytd-mini-guide-renderer { display: none !important; }
        /* İçerik alanını tam genişliğe al */
        ytd-page-manager { margin-left: 0 !important; }
        #page-manager { margin-left: 0 !important; }
      `;
    } else if (url.includes('twitch.tv')) {
      // Twitch: sol nav sidebar
      css = `
        .side-nav { display: none !important; }
        .persistent-player { left: 0 !important; }
      `;
    }

    if (css) {
      this.streamView.webContents.insertCSS(css).catch(() => {});
    }
  }


  resizeStreamView(parentWindow) {
    if (!this.streamView || !parentWindow || parentWindow.isDestroyed()) return;

    if (parentWindow.isFullScreen()) {
      this.applyFullscreenBounds(parentWindow);
      return;
    }

    const [winWidth, winHeight] = parentWindow.getContentSize();
    const sidebarW = this.isSidebarExpanded ? this.sidebarWidth : this.sidebarCollapsedWidth;
    const x = sidebarW;
    const y = this.titlebarHeight;
    const w = Math.max(1, winWidth - x);
    const h = Math.max(1, winHeight - y);

    // Sadece boyut değiştiğinde logla (spam'ı azalt)
    const boundsKey = `${x},${y},${w},${h}`;
    if (this._lastBoundsKey !== boundsKey) {
      console.log(`[BrowserManager] Resize: win=${winWidth}x${winHeight} sidebar=${sidebarW} bounds=(${x},${y},${w},${h})`);
      this._lastBoundsKey = boundsKey;
    }
    this.streamView.setBounds({ x, y, width: w, height: h });
  }

  applyFullscreenBounds(parentWindow) {
    if (!this.streamView || !parentWindow || parentWindow.isDestroyed()) return;
    const [w, h] = parentWindow.getContentSize();
    this.streamView.setBounds({ x: 0, y: 0, width: w, height: h });
  }

  hideStreamView() {
    if (this.streamView) {
      this.streamView.setVisible(false);
    }
  }

  showStreamView() {
    if (this.streamView) {
      this.streamView.setVisible(true);
    }
  }

  closeStream(parentWindow) {
    if (this.streamView && parentWindow && !parentWindow.isDestroyed()) {
      try {
        parentWindow.contentView.removeChildView(this.streamView);
      } catch { }
      try {
        this.streamView.webContents.close();
      } catch { }
      this.streamView = null;
    }
  }

  hasActiveStream() {
    return this.streamView !== null;
  }

  reloadStream() {
    if (this.streamView && !this.streamView.webContents.isDestroyed()) {
      this.streamView.webContents.reload();
    }
  }

  // ─── Cookie Loading ─────────────────────────────────────────────────────

  async _loadCookies(browserKey) {
    const profileDir = this.browserProfiles[browserKey];
    if (!profileDir || !fs.existsSync(profileDir)) {
      console.warn('[BrowserManager] Browser profile not found:', profileDir);
      return;
    }

    const defaultProfile = path.join(profileDir, 'Default');
    // Modern Chromium stores cookies in Default/Network/Cookies, legacy in Default/Cookies
    const networkCookiesPath = path.join(defaultProfile, 'Network', 'Cookies');
    const legacyCookiesPath = path.join(defaultProfile, 'Cookies');
    const cookiesPath = fs.existsSync(networkCookiesPath) ? networkCookiesPath : legacyCookiesPath;
    const localStatePath = path.join(profileDir, 'Local State');

    if (!fs.existsSync(cookiesPath) || !fs.existsSync(localStatePath)) {
      console.warn('[BrowserManager] Cookies or Local State file not found');
      return;
    }
    console.log(`[BrowserManager] Using cookies from: ${cookiesPath}`);

    // Get the master decryption key
    const masterKey = await this._getMasterKey(localStatePath);
    if (!masterKey) {
      console.error('[BrowserManager] Could not get master key');
      this.cookieStatus = 'error';
      return;
    }

    // Read and decrypt cookies
    const cookies = await this._readCookies(cookiesPath, masterKey);
    console.log(`[BrowserManager] Read ${cookies.length} cookies from browser`);

    // Import cookies into Electron session
    let imported = 0;
    for (const cookie of cookies) {
      try {
        await this.streamSession.cookies.set(cookie);
        imported++;
      } catch (err) {
        console.warn(`[BrowserManager] Failed to set cookie for ${cookie.domain} (${cookie.name}):`, err.message);
      }
    }
    console.log(`[BrowserManager] Imported ${imported}/${cookies.length} cookies`);
    if (imported > 0) {
      this.cookieStatus = 'success';
      this.cookiesLoaded = true;
    } else if (this.cookieStatus !== 'locked') {
      this.cookieStatus = 'empty';
      this.cookiesLoaded = false;
    }
  }

  async _getMasterKey(localStatePath) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
      const encryptedKeyB64 = localState.os_crypt?.encrypted_key;
      if (!encryptedKeyB64) return null;

      const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
      // Remove "DPAPI" prefix (5 bytes)
      const dpapiBuf = encryptedKey.slice(5);
      const dpapiBufB64 = dpapiBuf.toString('base64');

      // Decrypt using DPAPI via PowerShell
      const script = `
Add-Type -AssemblyName System.Security
$encrypted = [Convert]::FromBase64String("${dpapiBufB64}")
$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($decrypted)
`;
      const result = await this._runPS(script);
      return Buffer.from(result.trim(), 'base64');
    } catch (e) {
      console.error('[BrowserManager] getMasterKey error:', e.message);
      return null;
    }
  }

  _decryptCookieValue(encryptedValue, masterKey) {
    try {
      if (!encryptedValue || encryptedValue.length < 31) return null;

      const prefix = encryptedValue.slice(0, 3).toString('utf-8');
      if (prefix !== 'v10' && prefix !== 'v20') return null;

      const nonce = encryptedValue.slice(3, 15);
      const ciphertextWithTag = encryptedValue.slice(15);

      if (ciphertextWithTag.length < 16) return null;

      const authTag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
      const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);

      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);

      // Chrome 114+ şifrelenmiş verinin başına 32-byte imza (HMAC) ekler.
      // Sadece 32. bayttan sonrasını (gerçek çerez değeri) almamız gerekir.
      if (decrypted.length > 32) {
        return decrypted.slice(32).toString('utf-8');
      }
      return decrypted.toString('utf-8');
    } catch {
      return null;
    }
  }

  async _readCookies(cookiesPath, masterKey) {
    // Copy DB using shared-read to handle browser file locks
    const tempPath = path.join(os.tmpdir(), `yz_cookies_${Date.now()}.db`);
    let copied = false;

    // Strategy 1: PowerShell with full share flags (Read+Write+Delete)
    try {
      const psScript = `
try {
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $src = [System.IO.File]::Open("${cookiesPath}", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
  $buf = New-Object byte[] $src.Length
  [void]$src.Read($buf, 0, $src.Length)
  $src.Close()
  [System.IO.File]::WriteAllBytes("${tempPath}", $buf)
  Write-Output "OK"
} catch {
  Write-Output "FAIL: $_"
}
`;
      const result = await this._runPS(psScript);
      copied = result.includes('OK') && fs.existsSync(tempPath);
      if (copied) console.log('[BrowserManager] Cookie DB copied via PowerShell shared-read');
      else console.warn('[BrowserManager] PS Strategy 1 result:', result.trim());
    } catch (e) {
      console.warn('[BrowserManager] PS Strategy 1 error:', e.message);
    }

    // Strategy 2: robocopy (can copy locked files)
    if (!copied) {
      try {
        const dir = path.dirname(cookiesPath);
        const file = path.basename(cookiesPath);
        const tempDir = path.dirname(tempPath);
        const tempFile = path.basename(tempPath);
        const roboScript = `
robocopy "${dir}" "${tempDir}" "${file}" /COPY:D /B /NJH /NJS /NP 2>$null
$copiedFile = Join-Path "${tempDir}" "${file}"
if (Test-Path $copiedFile) {
  Rename-Item -Path $copiedFile -NewName "${tempFile}" -Force
  Write-Output "OK"
} else { Write-Output "FAIL" }
`;
        const result = await this._runPS(roboScript);
        copied = result.includes('OK') && fs.existsSync(tempPath);
        if (copied) console.log('[BrowserManager] Cookie DB copied via robocopy');
        else console.warn('[BrowserManager] Robocopy result:', result.trim());
      } catch (e) {
        console.warn('[BrowserManager] Robocopy error:', e.message);
      }
    }

    // Strategy 3: Direct Node.js copy
    if (!copied) {
      try {
        fs.copyFileSync(cookiesPath, tempPath);
        copied = true;
        console.log('[BrowserManager] Cookie DB copied via Node.js');
      } catch (e) {
        console.error('[BrowserManager] All cookie DB copy strategies failed:', e.message);
        this.cookieStatus = 'locked';
        return [];
      }
    }

    // Also copy WAL/SHM files if they exist (SQLite journal)
    for (const ext of ['-wal', '-shm']) {
      const walSrc = cookiesPath + ext;
      const walDst = tempPath + ext;
      if (fs.existsSync(walSrc)) {
        try {
          const walPS = `
try {
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $s = [System.IO.File]::Open("${walSrc}", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
  $b = New-Object byte[] $s.Length
  [void]$s.Read($b, 0, $s.Length)
  $s.Close()
  [System.IO.File]::WriteAllBytes("${walDst}", $b)
  Write-Output "OK"
} catch { Write-Output "FAIL" }
`;
          await this._runPS(walPS);
        } catch { /* WAL copy is best-effort */ }
      }
    }

    try {
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const dbBuffer = fs.readFileSync(tempPath);
      const db = new SQL.Database(dbBuffer);

      // Only load cookies for streaming-related domains
      const domainFilters = [
        'youtube.com', 'google.com', 'googleapis.com', 'gstatic.com',
        'twitch.tv', 'kick.com', 'jtvnw.net', 'twitchcdn.net',
        'accounts.google.com', 'login.twitch.tv'
      ];

      const results = [];
      let stmt;
      try {
        stmt = db.prepare("SELECT host_key, name, path, encrypted_value, expires_utc, is_secure, is_httponly, samesite FROM cookies");
      } catch {
        // Older schema
        stmt = db.prepare("SELECT host_key, name, path, encrypted_value, expires_utc, is_secure, is_httponly FROM cookies");
      }

      while (stmt.step()) {
        const row = stmt.getAsObject();
        const hostKey = row.host_key;

        // Filter to relevant domains
        const isRelevant = domainFilters.some(d =>
          hostKey === d || hostKey === '.' + d ||
          hostKey.endsWith('.' + d)
        );
        if (!isRelevant) continue;

        const encVal = row.encrypted_value;
        if (!encVal || encVal.length === 0) continue;

        const decryptedValue = this._decryptCookieValue(Buffer.from(encVal), masterKey);
        if (!decryptedValue) continue;

        const isSecure = !!row.is_secure;
        const protocol = isSecure ? 'https' : 'http';
        const domain = hostKey.startsWith('.') ? hostKey.slice(1) : hostKey;

        const isHostCookie = row.name.startsWith('__Host-');
        const cookiePath = isHostCookie ? '/' : (row.path || '/');
        const cookieSecure = isHostCookie || row.name.startsWith('__Secure-') || isSecure;
        const cookieProtocol = cookieSecure ? 'https' : 'http';

        const cookie = {
          url: `${cookieProtocol}://${domain}${cookiePath}`,
          name: row.name,
          value: decryptedValue,
          path: cookiePath,
          secure: cookieSecure,
          httpOnly: !!row.is_httponly,
        };

        if (!isHostCookie) {
          cookie.domain = hostKey;
        }

        // Convert Chromium time to Unix timestamp (seconds)
        if (row.expires_utc && Number(row.expires_utc) > 0) {
          const chromiumTime = Number(row.expires_utc);
          const unixTime = (chromiumTime / 1000000) - 11644473600;
          if (unixTime > 0 && unixTime < 253402300800) {
            cookie.expirationDate = unixTime;
          }
        }

        // SameSite mapping
        if (row.samesite !== undefined) {
          const sameSiteMap = { '-1': 'unspecified', '0': 'no_restriction', '1': 'lax', '2': 'strict' };
          cookie.sameSite = sameSiteMap[String(row.samesite)] || 'no_restriction';
        }

        results.push(cookie);
      }

      stmt.free();
      db.close();
      return results;
    } catch (e) {
      console.error('[BrowserManager] readCookies error:', e.message);
      return [];
    } finally {
      try { fs.unlinkSync(tempPath); } catch { }
      try { fs.unlinkSync(tempPath + '-wal'); } catch { }
      try { fs.unlinkSync(tempPath + '-shm'); } catch { }
    }
  }

  // ─── Extension Loading ──────────────────────────────────────────────────

  async _loadExtensions(browserKey) {
    const profileDir = this.browserProfiles[browserKey];
    if (!profileDir) return;

    const extensionsDir = path.join(profileDir, 'Default', 'Extensions');
    if (!fs.existsSync(extensionsDir)) {
      console.warn('[BrowserManager] Extensions directory not found');
      return;
    }

    let loaded = 0;
    const extIds = fs.readdirSync(extensionsDir);

    for (const extId of extIds) {
      const extIdPath = path.join(extensionsDir, extId);
      try {
        const stat = fs.statSync(extIdPath);
        if (!stat.isDirectory()) continue;

        // Get the latest version directory
        const versions = fs.readdirSync(extIdPath)
          .filter(v => {
            try { return fs.statSync(path.join(extIdPath, v)).isDirectory(); } catch { return false; }
          })
          .sort();

        if (versions.length === 0) continue;

        const latestVersion = versions[versions.length - 1];
        const extFullPath = path.join(extIdPath, latestVersion);

        // Check for manifest.json
        const manifestPath = path.join(extFullPath, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;

        // Electron'da crash yapan extension'ları atla
        if (this._isIncompatibleExtension(extId, manifestPath)) {
          console.debug(`[BrowserManager] Skipped incompatible extension: ${extId}`);
          continue;
        }

        let loadPath = extFullPath;
        // uBlock Origin Lite için kopyalama ve yama işlemi uyguluyoruz
        if (extId === 'ddkjiahejlhfcafbddmgiahcphecmpfh') {
          const patchedDir = path.join(app.getPath('userData'), 'patched_extensions', extId, latestVersion);
          console.log(`[BrowserManager] Patching uBlock Origin Lite to: ${patchedDir}`);
          try {
            this._copyAndPatchFolder(extFullPath, patchedDir, extId);
            loadPath = patchedDir;
          } catch (err) {
            console.error('[BrowserManager] Copying/patching uBlock Origin Lite failed, loading original:', err.message);
          }
        }

        // Try loading the extension
        await this.streamSession.loadExtension(loadPath, { allowFileAccess: true });
        loaded++;
        console.log(`[BrowserManager] Loaded extension: ${extId}`);
      } catch (e) {
        // Many extensions won't load (MV2, incompatible) — that's fine
        console.debug(`[BrowserManager] Skipped extension ${extId}: ${e.message}`);
      }
    }
    console.log(`[BrowserManager] Loaded ${loaded}/${extIds.length} extensions`);
  }

  _copyAndPatchFolder(src, dest, extId) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyAndPatchFolder(srcPath, destPath, extId);
      } else {
        if (extId === 'ddkjiahejlhfcafbddmgiahcphecmpfh' && entry.name === 'ext-compat.js') {
          try {
            let code = fs.readFileSync(srcPath, 'utf8');
            const polyfill = `
// AntiGravity Electron Compatibility Polyfill
if (typeof self !== 'undefined') {
  if (!self.chrome) self.chrome = {};
  if (!self.chrome.permissions) {
    self.chrome.permissions = {
      onAdded: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      getAll: () => Promise.resolve({ permissions: [], origins: [] }),
      request: () => Promise.resolve(true),
      contains: () => Promise.resolve(true),
    };
  }
  if (!self.chrome.commands) {
    self.chrome.commands = {
      onCommand: { addListener: () => {} }
    };
  }
  if (!self.chrome.tabs) {
    self.chrome.tabs = {
      TAB_ID_NONE: -1,
      query: () => Promise.resolve([]),
      update: () => {},
      reload: () => {},
    };
  }
}
`;
            code = polyfill + code;
            fs.writeFileSync(destPath, code, 'utf8');
          } catch (err) {
            console.error('[BrowserManager] Failed to patch file:', err.message);
            fs.copyFileSync(srcPath, destPath);
          }
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  }

  _isIncompatibleExtension(extId, manifestPath) {
    // Bilinen uyumsuz extension ID'leri
    const KNOWN_INCOMPATIBLE = new Set([
      'eimadpbcbfnmbkopoojfekhnkhdbieeh', // uBlock Origin Brave sürümü — chrome.privacy crash
      'aapbdbdomjkkjkaonfhkkikfgjllcleb', // Google Translate — service worker sorunu
      'ghmbeldphafepmbeghdlkpapahdgbakde', // Privacy Badger — chrome.webNavigation.onAdded yok
      'jplgfhpmjnbigmhklmmbgecoobifkmpa', // Proxy ext — chrome.proxy.settings yok
      'ddkjiahejlhfcafbddmgiahcphecmpfh', // uBlock Origin Lite — YouTube anti-adblock tespitini tetikler
      'cjpalhdlnbpafiamejdnhcphjbkeiagm', // uBlock Origin — YouTube anti-adblock tespitini tetikler
      'gighmmpiobklfepjocnamgkkbiglidom', // AdBlock — YouTube anti-adblock tespitini tetikler
      'cfhdojbkjhnklbpkdaibdccddilifddb', // Adblock Plus — YouTube anti-adblock tespitini tetikler
    ]);
    if (KNOWN_INCOMPATIBLE.has(extId)) return true;

    // Manifest'teki izinlerden Electron'da olmayan API'leri tespit et
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const perms = [
        ...(manifest.permissions || []),
        ...(manifest.optional_permissions || []),
      ];
      const CRASH_PERMS = ['privacy', 'proxy', 'nativeMessaging', 'enterprise.platformKeys'];
      if (perms.some(p => CRASH_PERMS.includes(p))) return true;
    } catch {
      return true;
    }
    return false;
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  destroy(parentWindow) {
    this.closeStream(parentWindow);
  }

  // ─── PowerShell Helper ──────────────────────────────────────────────────

  _runPS(script) {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(
        os.tmpdir(),
        `yz_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`
      );

      try {
        fs.writeFileSync(scriptPath, `\ufeff${script}`, 'utf-8');
      } catch (e) {
        return reject(e);
      }

      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: 15000, encoding: 'utf-8' },
        (err, stdout, stderr) => {
          try { fs.unlinkSync(scriptPath); } catch { }
          if (err) reject(new Error(stderr?.trim() || err.message));
          else resolve(stdout || '');
        }
      );
    });
  }
}

module.exports = BrowserManager;

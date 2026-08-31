(() => {
  if (window.__streamwatchUpdaterV2Loaded || !window.api?.features) return;
  window.__streamwatchUpdaterV2Loaded = true;

  const api = window.api;
  const fx = window.api.features;
  const ex = window.api.enhancements;
  let currentState = { available: false };
  let lastNotifiedVersion = null;
  let installOverlay = null;

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '';
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function closeToast() {
    document.getElementById('swu-update-toast')?.remove();
  }

  function showToast(state) {
    if (!state?.available || state.downloading || state.installing || !state.version) return;
    if (lastNotifiedVersion === state.version && document.getElementById('swu-update-toast')) return;
    lastNotifiedVersion = state.version;
    closeToast();
    const toast = document.createElement('div');
    toast.id = 'swu-update-toast';
    toast.className = 'swu-toast';
    toast.innerHTML = `
      <div class="swu-toast-copy">
        <strong>Yeni sürüm çıktı</strong>
        <span>StreamWatch ${esc(state.version)} hazır.</span>
      </div>
      <button class="swu-toast-action">Güncelle</button>
      <button class="swu-toast-close" title="Kapat">×</button>`;
    document.body.appendChild(toast);
    toast.querySelector('.swu-toast-action').addEventListener('click', () => openUpdateDialog());
    toast.querySelector('.swu-toast-close').addEventListener('click', closeToast);
  }

  function closeOverlay() {
    if (currentState.downloading || currentState.installing) return;
    installOverlay?.remove();
    installOverlay = null;
    api.showBrowser?.();
    fx.showMultiView?.();
    ex?.showTournament?.();
  }

  async function openUpdateDialog() {
    const state = await fx.getUpdateState();
    if (!state?.available) return;
    currentState = state;
    closeToast();

    let release = null;
    try { release = await ex?.getReleaseNotes?.(); } catch { }
    const notes = release?.notes || 'Bu sürüm için değişiklik notu bulunamadı.';

    installOverlay?.remove();
    api.hideBrowser?.();
    fx.hideMultiView?.();
    ex?.hideTournament?.();

    const overlay = document.createElement('div');
    overlay.id = 'swu-update-overlay';
    overlay.className = 'swu-overlay';
    overlay.innerHTML = `
      <div class="swu-dialog">
        <div class="swu-dialog-head">
          <div>
            <strong>StreamWatch ${esc(state.version || release?.version || '')}</strong>
            <span>Yeni sürüm hazır</span>
          </div>
          <button class="swu-dialog-close" title="Kapat">×</button>
        </div>
        <div class="swu-dialog-body">
          <p class="swu-copy">Yeni sürüm uygulama açıkken otomatik algılandı. Güncelleme yalnızca sen başlattığında indirilir.</p>
          <div class="swu-changelog">${esc(notes).replaceAll('\n', '<br>')}</div>
        </div>
        <div class="swu-dialog-footer">
          <button class="swu-secondary" id="swu-release-page">Release Sayfası</button>
          <button class="swu-primary" id="swu-install">İndir ve Kur</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    installOverlay = overlay;

    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closeOverlay(); });
    overlay.querySelector('.swu-dialog-close').addEventListener('click', closeOverlay);
    overlay.querySelector('#swu-release-page').addEventListener('click', () => {
      const url = release?.url || state.releaseUrl;
      if (url) api.openExternal?.(url);
    });
    overlay.querySelector('#swu-install').addEventListener('click', beginInstall);
  }

  function renderProgressShell() {
    if (!installOverlay) return;
    const dialog = installOverlay.querySelector('.swu-dialog');
    dialog.innerHTML = `
      <div class="swu-progress-wrap">
        <div class="swu-progress-icon">↓</div>
        <strong id="swu-progress-title">Güncelleme indiriliyor</strong>
        <span id="swu-progress-percent">0%</span>
        <div class="swu-progress-track"><div id="swu-progress-bar"></div></div>
        <p id="swu-progress-detail">İndirme hazırlanıyor…</p>
        <small>İndirme tamamlanınca StreamWatch kurulup otomatik olarak yeniden açılacak.</small>
      </div>`;
  }

  async function beginInstall() {
    if (!installOverlay) return;
    renderProgressShell();
    const result = await fx.installUpdate();
    if (result?.error) {
      const title = installOverlay?.querySelector('#swu-progress-title');
      const detail = installOverlay?.querySelector('#swu-progress-detail');
      const icon = installOverlay?.querySelector('.swu-progress-icon');
      if (title) title.textContent = 'Güncelleme başarısız';
      if (detail) detail.textContent = result.error;
      if (icon) icon.textContent = '!';
      currentState = { ...currentState, downloading: false, installing: false };
    }
  }

  function applyProgress(state) {
    if (!installOverlay) return;
    const bar = installOverlay.querySelector('#swu-progress-bar');
    const percent = installOverlay.querySelector('#swu-progress-percent');
    const detail = installOverlay.querySelector('#swu-progress-detail');
    const title = installOverlay.querySelector('#swu-progress-title');
    const icon = installOverlay.querySelector('.swu-progress-icon');
    const progress = Math.max(0, Math.min(100, Number(state.progress || 0)));

    if (bar) bar.style.width = `${progress}%`;
    if (percent) percent.textContent = `${Math.round(progress)}%`;

    if (state.stage === 'installing' || state.installing) {
      if (bar) bar.style.width = '100%';
      if (percent) percent.textContent = '100%';
      if (title) title.textContent = 'Güncelleme kuruluyor';
      if (detail) detail.textContent = 'İndirme tamamlandı. Uygulama yeniden başlatılıyor…';
      if (icon) icon.textContent = '✓';
      return;
    }

    if (state.stage === 'error') {
      if (title) title.textContent = 'Güncelleme başarısız';
      if (detail) detail.textContent = state.error || state.message || 'Bilinmeyen hata';
      if (icon) icon.textContent = '!';
      return;
    }

    if (state.downloading) {
      if (title) title.textContent = 'Güncelleme indiriliyor';
      const downloaded = formatBytes(state.downloadedBytes);
      const total = formatBytes(state.totalBytes);
      if (detail) detail.textContent = state.message || (total ? `${downloaded} / ${total}` : downloaded || 'İndiriliyor…');
    }
  }

  function handleUpdateState(state) {
    if (!state) return;
    const previouslyAvailable = Boolean(currentState.available);
    const previousVersion = currentState.version;
    currentState = { ...currentState, ...state };
    applyProgress(currentState);

    if (currentState.available && !currentState.downloading && !currentState.installing) {
      if (!previouslyAvailable || previousVersion !== currentState.version) showToast(currentState);
    }
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#sw-btn-update')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openUpdateDialog();
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && installOverlay) closeOverlay();
  });

  fx.onUpdateState(handleUpdateState);
  fx.getUpdateState().then((state) => {
    currentState = state || { available: false };
    if (currentState.available) showToast(currentState);
  }).catch(() => {});
})();

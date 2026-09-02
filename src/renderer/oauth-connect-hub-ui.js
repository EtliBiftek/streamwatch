(() => {
  if (window.__streamwatchOAuthConnectHubUiLoaded || !window.api?.oauthAccounts?.openHub) return;
  window.__streamwatchOAuthConnectHubUiLoaded = true;

  const api = window.api.oauthAccounts;
  let opening = false;

  async function openHub(button) {
    if (opening) return;
    opening = true;
    const original = button?.textContent || 'Hesapları Bağla';
    if (button) {
      button.disabled = true;
      button.textContent = 'Bağlantı merkezi açılıyor…';
    }
    try {
      const result = await api.openHub();
      if (result?.error) throw new Error(result.error);
      const message = document.getElementById('sw-oauth-message');
      if (message) {
        message.textContent = 'StreamWatch Connect tarayıcıda açıldı. Platformu seçip resmî izin ekranında onay ver.';
        message.className = 'sw-oauth-message good';
      }
    } catch (error) {
      const message = document.getElementById('sw-oauth-message');
      if (message) {
        message.textContent = error?.message || 'StreamWatch Connect açılamadı.';
        message.className = 'sw-oauth-message bad';
      }
    } finally {
      opening = false;
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  function replacePlatformButtons(section) {
    section.querySelectorAll('[data-oauth-connect]').forEach((oldButton) => {
      if (oldButton.dataset.connectHubBound === '1') return;
      const button = oldButton.cloneNode(true);
      button.dataset.connectHubBound = '1';
      button.textContent = 'Bağlantı Merkezini Aç';
      button.title = 'StreamWatch Connect sayfasını aç; YouTube, Twitch veya Kick hesabını resmî izin ekranından bağla.';
      oldButton.replaceWith(button);
      button.addEventListener('click', () => openHub(button));
    });
  }

  function patch() {
    const section = document.getElementById('sw-oauth-section');
    if (!section) return false;

    const heading = section.querySelector('.sw-oauth-heading');
    const actions = section.querySelector('.sw-oauth-heading-actions');
    if (heading) {
      const small = heading.querySelector('small');
      if (small) {
        small.textContent = 'Tek tıkla StreamWatch Connect sayfasını aç. Oradan platformu seç ve YouTube, Twitch veya Kick’in resmî izin ekranında yalnızca onay ver.';
      }
    }

    if (actions && !document.getElementById('sw-oauth-open-connect-hub')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'sw-oauth-open-connect-hub';
      button.className = 'sw-oauth-btn primary';
      button.textContent = 'Hesapları Bağla';
      button.title = 'StreamWatch Connect bağlantı merkezini aç';
      actions.prepend(button);
      button.addEventListener('click', () => openHub(button));
    }

    replacePlatformButtons(section);
    return true;
  }

  const timer = setInterval(() => {
    if (patch()) clearInterval(timer);
  }, 180);
  setTimeout(() => clearInterval(timer), 20000);

  const observer = new MutationObserver(() => patch());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();

(() => {
  if (window.__streamwatchBrowserSessionBridgeLoaded || !window.api?.browserBridge) return;
  window.__streamwatchBrowserSessionBridgeLoaded = true;

  const names = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };
  let busy = new Set();

  function setMessage(text, type = '') {
    let note = document.getElementById('sw-browser-bridge-note');
    if (!note) return;
    note.textContent = text;
    note.dataset.type = type;
  }

  async function refreshAccountStatus() {
    try {
      const state = await window.api.accountBridge.getStatus();
      for (const platform of Object.keys(names)) {
        const card = document.querySelector(`#sw-account-link-section [data-platform="${platform}"]`);
        const info = state?.platforms?.[platform];
        if (!card || !info) continue;
        const badge = card.querySelector('[data-account-status]');
        if (badge) {
          badge.textContent = info.blocked ? 'Bağlantı kesildi' : info.state === 'connected' ? 'Bağlı' : info.state === 'cookies' ? 'Oturum aktarıldı' : 'Bağlı değil';
          badge.className = `sw-account-status ${info.state === 'connected' && !info.blocked ? 'ok' : info.state === 'cookies' && !info.blocked ? 'partial' : 'off'}`;
        }
        const detail = card.querySelector('[data-cookie-count]');
        if (detail) detail.textContent = info.detail || (info.cookieCount ? `${info.cookieCount} oturum çerezi mevcut` : 'Bağlı bir oturum bulunamadı.');
      }
    } catch { }
  }

  function installSetupCard(section) {
    if (document.getElementById('sw-browser-bridge-setup')) return;
    const heading = section.querySelector('.sw-account-heading');
    if (!heading) return;

    const setup = document.createElement('div');
    setup.id = 'sw-browser-bridge-setup';
    setup.className = 'sw-account-import-actions';
    setup.style.marginTop = '10px';
    setup.innerHTML = `
      <button type="button" class="sw-account-secondary-btn" id="sw-browser-bridge-install">Browser Bridge'i Kur</button>
      <span id="sw-browser-bridge-note">Tarayıcıdaki açık hesabı doğrudan bağlamak için Browser Bridge eklentisini bir kez kur.</span>`;
    heading.insertAdjacentElement('afterend', setup);

    setup.querySelector('#sw-browser-bridge-install')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Hazırlanıyor…';
      try {
        const result = await window.api.browserBridge.setup();
        if (result?.error) throw new Error(result.error);
        setMessage(`Eklenti klasörü açıldı ve yolu panoya kopyalandı: ${result.path}. Tarayıcıda Geliştirici modu → Paketlenmemiş öğe yükle → bu klasörü seç.`, 'good');
      } catch (error) {
        setMessage(error?.message || 'Browser Bridge kurulumu açılamadı.', 'bad');
      } finally {
        button.disabled = false;
        button.textContent = "Browser Bridge'i Kur";
      }
    });
  }

  function replaceConnectButtons(section) {
    section.querySelectorAll('[data-account-portal]').forEach((oldButton) => {
      if (oldButton.dataset.browserBridgeBound === '1') return;
      const card = oldButton.closest('[data-platform]');
      const platform = card?.dataset.platform;
      if (!platform) return;

      const button = oldButton.cloneNode(true);
      button.dataset.browserBridgeBound = '1';
      button.removeAttribute('data-account-portal');
      button.setAttribute('data-browser-bridge-connect', platform);
      button.textContent = 'Tarayıcı Oturumunu Bağla';
      button.title = `${names[platform]} hesabın tarayıcıda zaten açıksa mevcut oturumu StreamWatch'a aktar.`;
      oldButton.replaceWith(button);

      button.addEventListener('click', async () => {
        if (busy.has(platform)) return;
        busy.add(platform);
        button.disabled = true;
        button.textContent = 'Tarayıcı açılıyor…';
        setMessage(`${names[platform]} için tarayıcı oturumu bekleniyor…`, '');
        try {
          await window.api.accountBridge.allowPlatform(platform);
          const result = await window.api.browserBridge.start(platform);
          if (result?.error) throw new Error(result.error);
          setMessage(`${names[platform]} bağlantı sayfası seçili tarayıcı/profilde açıldı. Browser Bridge oturumu otomatik aktaracak.`, '');
        } catch (error) {
          setMessage(error?.message || `${names[platform]} bağlantısı başlatılamadı.`, 'bad');
        } finally {
          setTimeout(() => {
            busy.delete(platform);
            if (!button.isConnected) return;
            button.disabled = false;
            button.textContent = 'Tarayıcı Oturumunu Bağla';
          }, 1200);
        }
      });
    });
  }

  function patch() {
    const section = document.getElementById('sw-account-link-section');
    if (!section) return false;

    const headingText = section.querySelector('.sw-account-heading small');
    if (headingText) {
      headingText.textContent = 'Chrome/Brave/Edge hesabın zaten açıksa Browser Bridge ile o oturumu doğrudan StreamWatch’a aktar. Şifre istemez ve tarayıcının şifreli Cookies dosyasını okumaz.';
    }

    installSetupCard(section);
    replaceConnectButtons(section);

    const footnote = section.querySelector('.sw-account-footnote');
    if (footnote) {
      footnote.textContent = 'Browser Bridge yalnızca seçtiğin platformun tarayıcı oturumunu localhost üzerinden StreamWatch’a kopyalar. Bağlantıyı Kopar tarayıcı hesabından çıkış yapmaz; sadece StreamWatch oturumunu temizler.';
    }
    return true;
  }

  const timer = setInterval(() => {
    if (patch()) clearInterval(timer);
  }, 200);
  setTimeout(() => clearInterval(timer), 20000);

  const observer = new MutationObserver(() => patch());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.api.browserBridge.onState(async (result) => {
    if (!result?.platform) return;
    if (result.connected) {
      setMessage(`${names[result.platform]} başarıyla bağlandı. ${result.imported || 0} oturum çerezi aktarıldı.`, 'good');
    } else {
      setMessage(`${names[result.platform]} verileri aktarıldı ancak giriş çerezi doğrulanamadı. Tarayıcıda hesabın gerçekten açık olduğundan emin olup tekrar dene.`, 'bad');
    }
    await refreshAccountStatus();
  });
})();

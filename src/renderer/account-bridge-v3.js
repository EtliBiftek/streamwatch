(() => {
  if (window.__streamwatchAccountBridgeV3Loaded) return;
  window.__streamwatchAccountBridgeV3Loaded = true;

  function patch() {
    const section = document.getElementById('sw-account-link-section');
    if (!section) return false;

    const heading = section.querySelector('.sw-account-heading small');
    if (heading) {
      heading.textContent = 'Tarayıcıda Aç seçili tarayıcı/profilde platformu açar ve çerez okumaz. StreamWatch oturumu ayrı olarak doğrulanır.';
    }

    section.querySelectorAll('[data-account-portal]').forEach((button) => {
      button.textContent = 'Tarayıcıda Aç';
      button.title = 'Seçili tarayıcı profilinde hesabı açar; çerez içe aktarmaz.';
    });

    section.querySelectorAll('[data-account-internal]').forEach((button) => {
      button.textContent = "StreamWatch'a Bağla";
      button.title = 'StreamWatch’ın kendi kalıcı oturumunda giriş yap.';
    });

    const footnote = section.querySelector('.sw-account-footnote');
    if (footnote) {
      footnote.textContent = 'Tarayıcıda Aç hesabını mevcut tarayıcı profilinde açar; StreamWatch tarayıcı çerezlerini okumaz. Bağlantıyı Kopar yalnızca StreamWatch oturumunu temizler.';
    }

    const importActions = document.querySelector('.sw-account-import-actions');
    if (importActions) importActions.remove();

    return true;
  }

  const timer = setInterval(() => {
    if (patch()) clearInterval(timer);
  }, 200);
  setTimeout(() => clearInterval(timer), 20000);

  const observer = new MutationObserver(() => patch());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();

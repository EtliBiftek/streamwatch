# 📺 streamwatch - Yayın İzleme Uygulaması

[Türkçe](#türkçe) | [English](#english)

---

## Türkçe

`streamwatch`, Twitch, Kick ve YouTube yayınlarını tek bir modern arayüzde birleştiren, Raycast esintili koyu/açık tema tasarımına sahip, bağımsız bir masaüstü uygulamasıdır.

Bu uygulama, Chrome veya Brave profilinizdeki oturum açma durumlarını (çerezleri) ve yüklü uzantıları (reklam engelleyiciler dahil) doğrudan Electron uygulamasına entegre ederek kesintisiz ve giriş yapma zahmeti gerektirmeyen bir izleme deneyimi sunar.

###  Özellikler

- **Çoklu Platform Desteği**: YouTube, Twitch ve Kick yayınlarını tek bir panelde izleyin.
- **Kişiselleştirilmiş Profil Entegrasyonu**: Chrome veya Brave tarayıcı profil çerezlerini ve eklentilerini otomatik olarak içe aktararak oturum açık kalma durumlarını korur.
- **Gelişmiş Gömülü Tarayıcı**: Windows z-index sorunlarını çözen, açılır menü ve modalların altında düzgünce maskelenen yerel Electron `WebContentsView` entegrasyonu.
- **Dahili Reklam Engelleyici**: Yayınlardaki reklam yükünü azaltmak için yerleşik özel ağ engelleme kuralları.
- **Esnek Sidebar**: Genişletilebilir veya daraltılabilir, aranabilir ve dinamik kanal listesi.
- **Raycast Temalı Arayüz**: Degrade geçişli vurgular, modern tipografi, glassmorphism efektleri ve yumuşak animasyonlar içeren premium tasarım.
- **Sistem Çekmecesi & Başlangıç Ayarları**: Başlangıçta çalıştırma, sistem çekmecesinde (tray) arka planda çalışma ve minimize başlatma desteği.

###  Başlangıç

#### Gereksinimler

- [Node.js](https://nodejs.org/) (v16+)
- Uyumlu bir Chromium tarayıcı (Brave veya Google Chrome)

#### Kurulum

1. Depoyu bilgisayarınıza indirin veya klonlayın:
   ```bash
   git clone https://github.com/EtliBiftek/yayin-izleme.git
   cd yayin-izleme
   ```

2. Gerekli paketleri kurun:
   ```bash
   npm install
   ```

3. Uygulamayı geliştirme modunda başlatın:
   ```bash
   npm start
   ```

#### Kurulum Aşaması

Uygulama ilk kez açıldığında, tarayıcı profillerinizi tarayarak sizi bir kurulum sihirbazı ile karşılar. Oturum çerezlerinizin ve uzantılarınızın çekileceği ana tarayıcınızı (Brave veya Chrome) seçip kuruluma devam edebilirsiniz.

#### Executable (.exe) Oluşturma

Projeyi taşınabilir bir Windows yükleyicisine (`.exe`) dönüştürmek için:
```bash
npm run build
```
Derlenen yükleyici dosyası otomatik olarak `dist/` klasörünün altında oluşturulacaktır.

###  Lisans

Bu proje **MIT Lisansı** altında lisanslanmıştır. Detaylar için [Lisans Dosyası](LICENSE) veya uygulama içindeki lisans overlay'ini inceleyebilirsiniz.

---

## English

`streamwatch` is a Raycast-inspired desktop application that aggregates live streams from Twitch, Kick, and YouTube into a unified, high-performance viewing interface.

By directly integrating with your existing Google Chrome or Brave Browser profile, the application retains your active user sessions (cookies) and extensions (such as ad-blockers), removing the need to log in manually and providing a seamless viewer experience.

###  Features

- **Multi-Platform Aggregator**: Access live streams from YouTube, Twitch, and Kick inside a single UI.
- **User Session & Extension Persistence**: Automatically imports and mirrors cookies and extensions from your main browser (Chrome or Brave).
- **Embedded Browser View**: Integrated using Electron's native `WebContentsView` which respects layout grids and supports clean z-indexing for overlay popups.
- **Built-in Ad-Blocker Engine**: Custom network request interception to minimize ad intrusions.
- **Collapsible Sidebar**: Clean, searchable, and responsive channel list.
- **Raycast-Inspired Design**: Sleek dark theme featuring elegant glassmorphism panels, custom titlebar layouts, and micro-interactions.
- **System Tray & Startup Features**: Full support for auto-launch on startup, minimizing to system tray, and running headlessly in the background.

###  Getting Started

#### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- A compatible Chromium browser (Brave or Google Chrome)

#### Installation

1. Clone or download the repository:
   ```bash
   git clone https://github.com/EtliBiftek/yayin-izleme.git
   cd yayin-izleme
   ```

2. Install the node dependencies:
   ```bash
   npm install
   ```

3. Launch the application in developer mode:
   ```bash
   npm start
   ```

#### Onboarding

During the first run, a setup wizard will scan your local files for Brave and Chrome browser profiles. Select your preferred browser to allow the application to securely mirror cookies and active extensions.

#### Packaging the Executable (.exe)

To build a standalone Windows executable installer:
```bash
npm run build
```
The packaged installer will be compiled inside the `dist/` folder.

###  License

This project is licensed under the **MIT License**. Check the license overlay inside the application or see the [License Details](LICENSE).

---

###  Developer

**Pifo**

- [GitHub](https://github.com/EtliBiftek)
- [Kick](https://kick.com/pifocsgo)
- [YouTube](https://www.youtube.com/@EtliBiftek)
- [Steam](https://steamcommunity.com/id/PIFOcsgo/)

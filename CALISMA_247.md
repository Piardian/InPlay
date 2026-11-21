# Arka planda paper çalışma

8 Kasım 2026 tarihinde bu bilgisayara kuruldu. Yapılandırma `config.247.json`: `mode=paper`, `headless=true`. Gerçek emir kodu/anahtarı yoktur. Görev uygulama penceresine bağlı değildir; Codex kapatıldığında çalışmaya devam edecek şekilde Windows Görev Zamanlayıcısı tarafından başlatılır.

## Neler kuruldu?

- `Masa2-InPlay-Paper-247` adlı Windows görevi: mevcut kullanıcı oturum açtığında ve beş dakikada bir tetiklenir. Zaten çalışan gözeticiyi çoğaltmaz. Mevcut kullanıcının oturumu içindir; oturum açılmadan önce çalışan bir SYSTEM servisi değildir.
- Kullanıcının Windows Başlangıç klasöründe `Masa2 InPlay Paper 247.lnk`: oturum açılışında ikinci başlatma yolu. Tek örnek mutex'i iki motor açılmasını engeller.
- Gizli `scripts/supervisor.ps1`: paper motorunu 10 saniyede bir kontrol eder. Motor kapanırsa 30–300 saniye bekleyerek yeniden başlatır. Rate-limit hatasında bekleme 1 saattir.
- Motor beş saniyede bir `runtime/heartbeat.json` yazar. Başlangıçtan 150 saniye sonra heartbeat 90 saniyeden eskiyse gözetici kontrollü durdurma ister; 15 saniye içinde kapanmazsa yalnız kendi başlattığı işçiyi sonlandırır.
- Motorun ayrıca işletim sisteminin yönettiği `127.0.0.1:39172` tek örnek kilidi vardır. Bu yerel port veri servisi sunmaz; gelen bağlantıları kapatır. Aynı motoru terminalden ikinci kez açmak da engellenir.
- Gözetici çalışırken Windows API'siyle otomatik sistem uykusunun engellenmesini ister. Ekran kapanabilir; genel güç planı değiştirilmez. Manuel uyku, kapak kapama, kapanma veya elektrik kesintisi üzerinde garanti sağlamaz.
- Diskte 2 GB'dan az boş alan kalırsa motoru durdurup alan açılmasını bekler. Eski kayıtları kendiliğinden silmez.

## Durumu gör

Bu klasörde PowerShell:

```powershell
.\scripts\status.ps1
```

`runtime/heartbeat.json` içindeki `utc` güncel, `state` RUNNING, `mode` paper olmalıdır. `feeds.messages` sayaçlarının ilerlemesi veri alımını gösterir. Tree'nin bağlı görünmesi haber teslim edildiği anlamına gelmez; haber paketi yoksa sayacı oluşmayabilir. `runtime/supervisor.json` gözetici ve motor PID'lerini, yeniden başlatma sayısını ve bekleme nedenini gösterir. Eski bir RUNNING dosyası tek başına sağlık kanıtı değildir; tarihini ve PID'yi kontrol edin.

## Durdur / yeniden başlat

```powershell
.\scripts\stop.ps1
.\scripts\start.ps1
```

`stop.ps1`, `runtime/disabled.flag` bırakır. Böylece beş dakikalık görev veya Windows açılışı motoru tekrar etkinleştirmez. `start.ps1` bu kilidi kaldırır. Durdurmaya yaklaşık 25 saniye tanıyın. Önceki motor tamamen kapanmadan zorla açmaya gerek yoktur.

## Kayıtlar ve sınırlar

Motor kayıtları `logs/<UTC-tarih>-<pid>/events.jsonl` altındadır. 8 Kasım bağlantı düzeltmesinden itibaren her çalıştırmanın çıktıları ayrı `runtime/worker-runs/<kimlik>/stdout.log` ve `stderr.log` dosyalarında tutulur; önceki dosyaların üzerine yazılmaz. Son yollar `runtime/supervisor.json` içindedir. `runtime/fatal-history.jsonl` kalıcı motor hata ayrıntılarını, `runtime/supervisor-history.jsonl` başlatma/çıkış olaylarını tutar. Ayrıntılar [BAGLANTI_DUZELTME_2026-11-08.md](BAGLANTI_DUZELTME_2026-11-08.md) dosyasındadır. Her yeniden başlangıç yeni sanal sermaye ve en az 31 dakikalık RVOL ısınması demektir. Önceki seansın kâr/zararı silinmiş başarı gibi yorumlanmamalı; journal'lar birlikte incelenmelidir. Çökme sonrasında eski sanal pozisyonlar yeni seansa taşınmaz; eksik kapanışlar gerçek dolum gibi uydurulmaz.

Bilgisayar ve internet açık olmalıdır. Kapalı bilgisayarda, kullanıcı oturumu kapalıyken veya internet yokken kesintisiz veri toplama garantisi yoktur. İnternet kesilirse akışlar tekrar bağlanmayı dener; hacim ısınması sıfırlanabilir. Bu kurulum uptime gözetimidir, stratejinin kârlılığına veya gerçek işlem hazırlığına kanıt değildir.

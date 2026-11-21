# Bağlantı ve tanılama düzeltmesi — 8 Kasım 2026

## Bulunan ve düzeltilen sorunlar

1. Tahta snapshot REST isteğinde dört deneme sonrasında kalan geçici DNS/timeout/fetch hatası tüm motoru FATAL ile kapatıyordu. Artık o tahta geçersiz sayılır; tape ve bekleyen girişleri mevcut veri-kesintisi korumasından geçer. Sadece ilgili snapshot 5–60 saniye aralıklarla yeniden denenir. Diğer scanner pencereleri sırf bu hata nedeniyle sıfırlanmaz. Rate-limit, geçersiz veri şeması ve programlama hataları körlemesine yutulmaz.
2. Gözetici her yeni motorda aynı stdout/stderr dosyalarını açarak önceki hata izini kaybediyordu. Artık her başlatma için ayrı `runtime/worker-runs/<kimlik>/stdout.log` ve `stderr.log` vardır. Motor çıkışı ve yeniden başlatma olayları `runtime/supervisor-history.jsonl` içinde birikir. Windows Process handle'ı tutulup çıkış kodunun okunması da güvenceye alındı.
3. FATAL ayrıntısı sadece konsola gidiyordu. Artık journal FATAL olayı ve bağımsız `runtime/fatal-history.jsonl` dosyası stage, message, stack, nested cause ve hata kodunu saklar. Başlangıç ve shutdown hataları da ayrıntılıdır. Önceki dört FATAL'in kaybolmuş yığınları geri getirilemez; kesin geçmiş nedenleri belirlenmiş sayılmaz.
4. Tree paketleri yalnız sayılıyor, içerik ve filtre sonucu korunmuyordu. Yeni decoder 16 KB ile sınırlı ham paketi `TREE_RAW_PACKET`, kontrol/haber/bilinmeyen/JSON-dışı ayrımını `TREE_PACKET_CLASSIFIED` olarak kaydeder. Haber görüldüğünde kabul veya eleme nedeni ve sayısı tutulur. Basit `data` zarfı desteklenir; kaynak, konu, zaman, sembol ve dedup kuralları gevşetilmedi.
5. Transport bağlantısı ile haber teslimi ayrıldı. Heartbeat ve gözetici `dataStatus` ile `newsDelivery` alanlarını taşır. `CONNECTED_NO_NEWS_OBSERVED`, haber geldiği anlamına gelmez. Tree ping/pong zamanları ayrıca görünür. Piyasa bağlantılarında pong gelmesine rağmen 30 saniye veri gelmezse ilgili socket yeniden bağlanır; Tree'de doğal haber sessizliği aynı şekilde kopma sayılmaz.
6. Hiç açılmamış socket'in uzun bekleme sonunda başarılı bağlantı gibi değerlendirilip reconnect sayacını sıfırlama ihtimali kaldırıldı. Kapanış kodu/nedeni de kayda alındı. Kapatılmış motorun geç gelen socket hatalarının kapanmış journal'a yazması engellendi.

## Doğrulama

Strict TypeScript derlemesi ve 49 test başarılı. Yeni testler: DNS snapshot arızasından yalnız o tahtanın korunarak toparlanması, cooldown sırasında istek fırtınasının önlenmesi, rate-limit'in yutulmaması, Tree kontrol/haber ayrımı ve kabul/ret nedenleri, sınırlı raw kayıt, callback hatasının parse hatası gibi gizlenmemesi, fatal-history'nin yeni instance'ta da önceki satırı koruması ve kapatma sonrası log yazılmaması.

Gerçek Tree denemesinde bağlantı açıldı; sunucudan ping ve istemci ping'ine pong geldi. Bu denemede haber JSON paketi gelmedi. Bu, haber teslimini veya gelişmiş kaynakların ücretsiz kapsandığını doğrulamaz. Ücretsiz kaynağı ücretli/API anahtarlı erişimle değiştirmedik.

Yeni gözeticide kontrollü motor durdurma/yeniden başlatma denemesi yapıldı. Eski ve yeni stderr dosyalarının ayrı olduğu ve eski dosyanın durduğu doğrulandı. Yeni motor 12 katalizör bağlantısını açtı; Binance mesaj sayaçları ilerledi ve Tree ping/pong zamanları kaydedildi. Uzun süreli dayanıklılık bu kısa kontrolden çıkarılamaz.

## Değişmeyen araştırma kuralları

Paper modu, haber + RVOL + frekans + fiyat tepkisi şartları, yalnız B girişi, maliyet/risk kapıları ve çıkış modeli korunmuştur. Bu bir kârlılık iyileştirmesi iddiası değildir. Kontrollü yeniden başlatmalar sonrasında RVOL yeniden en az 31 dakika ısınır. Gerçek ağ/elektrik/DNS kesintisini yazılımın ortadan kaldırdığı iddia edilmez; burada toparlanma ve görünürlük iyileştirildi.

## Sonraki durum kontrolü

`scripts/status.ps1` artık sadece eski dosyadaki RUNNING yazısını göstermez: PID'nin varlığını ve heartbeat yaşını da kontrol eder; veri bağlantısı ve haber teslimi durumunu ayrı verir. Son hata dosyasının yolu bu çıktıda ve `runtime/supervisor.json` içinde bulunur.

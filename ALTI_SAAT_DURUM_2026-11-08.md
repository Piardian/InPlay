# İlk altı saatlik çalışma incelemesi

8 Kasım 2026; incelenen ana journal aralığı İstanbul saati 04:03:10–10:19:47. Son sağlık okuması yaklaşık 10:20:33. Kurulum/durdurma denemelerinin önceki seansları bu toplama dahil edilmedi.

## İşlem sonucu

- 12 IN_PLAY_RVOL olayı, 8 farklı sembol: XAUUSDT, DOGEUSDT, SOLUSDT, BTCUSDT, ETHUSDT, HYPEUSDT, 1000PEPEUSDT, CYBERUSDT. Aynı sembolün tekrar eşik geçişleri ayrı olaydır; bunlar işlem veya bağımsız fırsat sayısı değildir.
- Kabul edilen IN_PLAY_NEWS: 0. NEWS_REJECTED kaydı da 0.
- Sinyal, gönderilen emir, dolum, kapanmış işlem: 0.
- Son sağlık kaydında açık paper pozisyon 0; realize PnL 0 USD. Önceki kapanan dört seansta da kapanış 0, çözülmemiş pozisyon boş.
- İşlem izni kayıtlarının gerekçesi NO_FRESH_NEWS. Bu kararlar yalnız neden değişiminde yazıldığından gözlem sayıları süre veya bağımsız örneklem değildir.

## Hacim olayları

| İstanbul saati | Sembol | Yaklaşık son dakika quote hacmi | RVOL |
|---|---|---:|---:|
| 04:38:43 | XAUUSDT | 1.046.093 | 14,23 |
| 04:39:15 | XAUUSDT | 1.003.714 | 10,29 |
| 05:15:55 | DOGEUSDT | 1.003.378 | 14,03 |
| 05:16:00 | SOLUSDT | 3.540.670 | 10,11 |
| 05:16:01 | BTCUSDT | 8.496.553 | 10,15 |
| 05:16:19 | ETHUSDT | 6.857.980 | 10,44 |
| 06:36:42 | HYPEUSDT | 1.003.544 | 11,25 |
| 06:38:03 | HYPEUSDT | 1.254.614 | 10,00 |
| 08:17:48 | 1000PEPEUSDT | 1.053.082 | 10,00 |
| 08:17:49 | 1000PEPEUSDT | 1.053.721 | 10,00 |
| 08:42:15 | BTCUSDT | 6.684.232 | 11,44 |
| 08:52:40 | CYBERUSDT | 1.686.722 | 10,00 |

RVOL ve hacimler bir saniye kovasıyla yapılan mevcut hesabın sonuçlarıdır; stablecoin quote USD yaklaşımı kullanılır. Kayıtlar bu olaylarda kâr edileceğini göstermez. Haber + tepki + uygun tahta girişinin de bulunması gerekirdi.

## Operasyon sorunları

Gözeticinin yeniden başlatma sayacı 5. Dört journal FATAL nedeniyle kapandı (05:18:08, 05:58:26, 08:57:26, 09:33:46). Ardından 09:38:10'da başlangıç enstrüman keşfi zaman aşımıyla başarısız oldu. Son motor 09:43:27 civarında başladı. Her yeniden başlatma hacim ısınmasını sıfırlar.

DNS çözümleme hataları (ENOTFOUND/ENOENT) ve WebSocket açılış zaman aşımları hem Binance hem Tree bağlantılarında görüldü. Reconnect olayları çoklu bağlantılara ait olduğundan ayrı internet kesintisi sayısı gibi yorumlanamaz. Bu kayıtlar sorunun tamamını kullanıcının internetine veya sağlayıcıya yüklemek için yeterli değildir.

Geçmiş motorların stderr çıktısı yeniden başlatmada aynı dosyaya yazıldığından dört FATAL'in tam hata yığını bu kayıtlarla belirlenemiyor. Bu bir tanılama eksiğidir; hepsinin DNS yüzünden kapandığı ileri sürülemez.

Kapanmış seans sayaçları ve son canlı sayaç birlikte Tree için 13 paket gösteriyor. Paket içerikleri tutulmadığından bu sayının gerçek haber, karşılama veya kontrol mesajı ayrımı yapılamıyor. Kabul edilen haber olmaması, piyasada haber olmadığına kanıt değildir. Kaynak kapsamı, teslim veya ayrıştırma sorunu ayrıştırılmalı.

Son okumada motor RUNNING/paper görünüyordu; sağlık kaydı günceldi, Binance sayaçları ilerliyordu. Tree connected=false idi. Gözeticinin çalışması, haber kaynağının sağlıklı olduğu anlamına gelmiyor.

## Değerlendirme

Tarayıcı hacim olayları yakaladı, haber teyidi olmadan işlem açmadı. Fakat altı saat kesintisiz, haber akışı doğrulanmış bir ileri test tamamlanmadı. Sıfır PnL stratejinin iyi veya kötü olduğuna dair sonuç üretmez. Öncelik haber paketlerinin tanılanması, FATAL hataların kalıcı kaydı ve bağlantı dayanıklılığıdır; sırf işlem çıksın diye haber şartı kaldırılmadı. Bu incelemede strateji kuralları değiştirilmedi.

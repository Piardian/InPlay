# V2 doğrulama — 8 Kasım 2026

## Gerçekleştirilen kontroller

- `npm run check`: strict TypeScript derlemesi + 40 test, tamamı başarılı.
- `npm run demo`: sentetik muhasebe örneği başarılı. Çıkan kâr, in-play performansı değildir; fixture giriş iznini açıkça bypass eder.
- `npm start -- --duration 15`: çıkış kodu 0, oturum temiz kapandı. Seans `logs/2026-11-08T00-53-16-413Z-26312`.
- Tree, miniTicker ve 10 aggTrade bağlantısı açıldı. Seans sonu sayaçlarında 3.372 aggTrade paketi ve 12 miniTicker paketi var. Tree haber paketi alınmadı; bağlantının açılması haber teslimini doğrulamaz.
- Sinyal 0, gönderilen sanal emir 0, kapanış 0, çözülmemiş pozisyon 0. 15 başlangıç sembolünde karar gerekçesi `NO_FRESH_NEWS`.
- `npm run report` ile gerçek seans journal'ından `validation-v2-report.json` üretildi; durum `RESEARCH_ONLY_NO_EDGE_PROOF`.

## Testlerin doğruladığı önemli davranışlar

Gerçek scanner, politika, strateji ve broker birlikte kullanılarak sentetik haber + 31 dakikalık işlem geçmişi + fiyat tepkisi + duvar tüketilmesi senaryosunda B sinyali ve sanal emir üretimi test edildi. Karar kanıtı emir kaydına bağlı.

Tek başına haber veya RVOL yeni girişe yetmiyor. Haber kaynağı, konu ve zaman eksikleri; hacim eşiğinin tam sınırı; sıfır baz; düşük mesaj frekansı; fiyat tepkisi kaybı; zıt yön; BTC karşı yönü; geniş spread; yetersiz fiyat aralığı; veri gecikmesi ve eksik aggregate ID test edildi.

Başlangıç sembolü politikayı atlayamıyor. Gönderim-dolum arasında uygunluk kaybında giriş iptal oluyor. Yeni katalizör eski bekleyen emri devralamıyor. Açık pozisyon katalizör kaybında hedeflerini koruyor, süre stopu ve çıkış dolumları çalışıyor. Normal stratejide A/C girişlerinin devre dışı olması ayrıca test edildi.

Rapor, eski veya karışık sürüm seanslarını ve geçersiz muhasebeyi reddediyor; örneklem yokken başarı iddiası üretmiyor.

## Henüz doğrulanmayanlar

31 dakikadan uzun canlı scanner çalışması, canlı uygun haberin sınıflandırılması ve gerçek zamanlı B fırsatının baştan sona paper yürütülmesi bu kısa denemede gözlenmedi. Kopma testleri deterministik; uzun süreli canlı dayanıklılık testi değil. Kâr beklentisi, farklı piyasa koşulları, bağımsız holdout ve katalizörsüz karşılaştırma henüz ölçülmedi.

Bu sürüm Binance kripto içindir. Hisse in-play RVOL hesabını veya ACE'nin kurum içi stratejisini birebir temsil etmez. İşlem ücretleri varsayımdır; borsa hesabından doğrulanmadı. Gerçek emir ve sürekli servis etkinleştirilmedi.

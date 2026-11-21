# Masa 2 — Order Flow Paper Motoru

Bu klasör **Crypto In-Play v2** sürümüdür. Güncel ve öncelikli kurallar [INPLAY.md](INPLAY.md) dosyasındadır: yeni girişte haber + güncel hacim + fiyat tepkisi zorunlu, normal çalıştırmada yalnız B girişi etkindir. Aşağıdaki A/C girişleri ve sabit evren anlatımı eski motorun teknik referansıdır; v2 çalışma kuralları olarak okunmamalıdır.

TypeScript / Node.js ile L2 depth ve aggTrade kullanan araştırma ve paper-trading uygulaması. Mum, OHLCV, API anahtarı ve gerçek emir gönderme kodu içermez. Spot ve USDⓈ-M perpetual verisi birlikte izlenir; sanal emirler **yalnız Futures piyasasında** yürütülür. `signal` modunda sanal emir de açılmaz.

Çalışan bir paper uygulamasıdır; uzun süreli dayanıklılığı ve stratejilerin net avantajı doğrulanmış bir canlı işlem sistemi değildir. Kodun derlenmesi veya testlerin geçmesi, kârlılık kanıtı sayılmaz.

## Başlatma

Node.js 22 veya üzeri gerekir. PowerShell'de bu klasörde:

```powershell
npm ci
npm run check
npm run build
npm start
```

Geliştirme: `npm run dev`. İnternetsiz muhasebe örneği: `npm run demo`. Sınırlı canlı veri kontrolü: `npm start -- --duration 30`. `Ctrl+C` girişleri iptal eder, iki saniyeye kadar gözlenebilir tahtadan paper çıkış dener ve kalan pozisyonları `SESSION_END.unresolved` alanına yazar. Derinlik yokken pozisyon hayali bir fiyattan kapatılmaz. Otomatik başlatma veya arka planda sürekli çalışan görev kurulmaz.

Özel ayar:

```powershell
Copy-Item config.example.json config.local.json
npm start -- --config config.local.json
```

Yalnız sinyal için JSON içindeki `mode` değerini `signal` yapın. Belirli pariteler için örneğin `"symbols": ["BTCUSDT", "ETHUSDT"]` verin. Boş liste başlangıçta 15 ortak parite seçer. İsimler ve sayısal ayarlar çalışma zamanında Zod ile doğrulanır; bilinmeyen ayarlar hata üretir. Bütün varsayılanlar `src/config.ts` içindedir.

## Modüller

| Dosya | Görev |
| --- | --- |
| `src/connectors/binanceWs.ts` | Enstrüman/tick/lot filtreleri, evren seçimi, üç WebSocket, REST snapshot, buffer, sıra kontrolü, reconnect |
| `src/engine/orderBookManager.ts` | Yerel Spot/Futures tahtaları, density, yaş, gözlem kapsamı, spoof şüphesi ve blacklist |
| `src/engine/tapeAnalyzer.ts` | 10 saniyelik dairesel tape, yön/hacim/frekans, BTC filtresi, absorption hipotezi |
| `src/engine/strategyStateMachine.ts` | A/B/C sinyalleri, veri kapıları, cooldown, duvar kaybı ve momentum çıkışı |
| `src/simulator/paperBroker.ts` | Gecikme, post-only, kuyruk, kısmi dolum, derinlikten taker yürütme, risk, komisyon, net PnL |
| `src/index.ts` | Terminal, yaşam döngüsü, veri gecikme kontrolleri ve journal |

## Veri ve evren

Evren, hem Spot hem USDT perpetual tarafında işlem gören paritelerden seçilir. Sıralama skoru iki piyasanın 24 saatlik USDT quote volume değerlerinin küçüğüdür; böylece tek tarafta likit pariteler öne çıkmaz. Bilinen stabil coin bazları dışlanır. Liste seans boyunca sabittir; 24 saatlik ticker yalnız evren seçimi içindir, giriş kararı için kullanılmaz. BTC listede yoksa ayrıca lider veri akışı eklenir.

`@depth@100ms` diff akışı ve 1000 kademelik REST snapshot kullanılır; density ilk **50 bid + 50 ask** üzerindeki USD tutarlarının ortak ortalamasıdır. Snapshot dışındaki bilinmeyen fiyat bölgesi tamamlanmış tahta gibi kullanılmaz. Yeterli bilinen kademe kalmazsa yeniden snapshot alınır. İlk köprü ve devam eden güncellemeler Spot'ta `U/u`, Futures'ta ek olarak `pu` ile doğrulanır. Boşluk/kopma duvar yaşını ve ilgili tape ısınmasını sıfırlar. Snapshot istekleri en fazla iki eşzamanlı görevle sınırlıdır; 418/429 yanıtında süreç hata ile durur.

Spot depth+tape tek bağlantıdadır. Futures depth `/public`, aggTrade `/market` üzerinde ayrı bağlantılardadır. `ws` ping'e aynı içerikle otomatik pong verir. 15 saniye mesaj gelmeyen bağlantı yenilenir; ayrıca 23 saatte zorunlu rotasyon vardır. Reconnect artan bekleme ve jitter kullanır. Market payload'ları ve sayısal güvenli update ID'leri doğrulanır.

Kararlar yerel monoton saatle zamanlanır; borsa zaman damgası ile yerel saat arasında varsayılan 2 saniyeden büyük fark varsa veri geçersiz sayılır. Bilgisayar saati senkron olmalıdır. Her iki piyasada 10 saniyelik tape ısınması ve son iki saniyede güncel depth/tape aranır. **İşlem geçmeyen sakin bir tape de ihtiyaten uygun sayılmaz**; bu yüzden `DATA_STALE` her zaman bağlantı arızası anlamına gelmez. `buy`, `isBuyerMaker=false` olan agresif alımdır. Frekans ham alt işlemlerin değil aggTrade mesajlarının sayısıdır.

## Kararlar ve açık uygulama tercihleri

- **Duvar:** Ortalama kademe USD ×12; en az 3 saniye gözlenme. Fiyat %0,15 yakınken peak tutarın %30'undan büyük, gözlenen tape ile açıklanamayan azalma `SPOOF_DETECTED` şüphesidir; 60 saniyelik blacklist uygulanır. Görüş alanından çıkan duvara iptal etiketi verilmez. Tam kaybolup geri gelen duvar yeniden yaşlanır.
- **Güven:** Spot duvarı 1; yalnız Futures 0,5. Varsayılan minimum 1'dir. Spot/Futures eşleşmesi aynı tarafta ve gerçek fiyatlar arasında %0,15 toleransla yapılır. Bu bir istatistiksel olasılık değildir. Yalnız Spot'ta doğrulanan duvar da fiyatı Futures tick'ine çevrilerek kullanılabilir. Aynı bölgedeki eşleşen duvar çift sayılmaz.
- **A:** Duvar %0,05 veya 3 tick yakın; son iki saniyelik saldıran USD, kalan duvarın %15'inden az; BTC karşı yönde agresif değil. Duvarın bir tick önüne maker giriş; iki tick arkasına stop. Kaynak duvar kaybolursa, spoof şüphesi alırsa veya ilk tutarın %35'inin altına düşerse panic çıkış. Gönderilmiş fakat dolmamış giriş de iptal edilir.
- **B:** Daha önce yaşını tamamlayan duvarın kalan tutarı %18'den az ama sıfırdan büyük; son saniyede doğrudan o kademeye saldıran işlem tutarı ilk duvarın en az %20'si; azalışın en az yarısını gözlenen gerçekleşmeler desteklemeli. Kaynak piyasanın tape'i kullanılır. Kırılım yönünde gecikmeli taker giriş; sonraki bir saniyelik aggTrade frekansı öncekinin %60'ının altına indiğinde çıkış. Sıfırlanmış duvarın arkasından geçmişe dönük giriş yapılmaz.
- **C:** Son beş saniyede tek fiyat/yönde ortalama kademe USD ×15; en az üç saniyeye yayılan gerçekleşme; bu sırada o fiyatın bir tick ötesinde aleyhe işlem yok; o kademede görünür density yok. Son saniyelik saldırı frekansı öncekinin %60'ının altına inmeli ve önceki saniyede en az üç mesaj olmalı. Bu, iceberg kanıtı değil absorption hipotezidir. Karşı yönde taker giriş, absorption seviyesinin iki tick arkasında stop.
- **BTC:** Son iki saniyede karşı yönde %0,03 fiyat hareketi veya 0,6'dan güçlü karşı yönlü USD delta A/C girişini engeller.
- **Çıkış:** A/C için eksik belirtilen ayrıntılar sabitlendi: ilk hedef varsayılan 8 tick'in aşağı yuvarlanmış %62,5'i (5 tick), ikinci hedef 8 tick; miktar yaklaşık yarı yarıya. B de aynı koruyucu hedefleri kullanır. Tüm stratejilerde en fazla 15 saniye tutma ve ardından 5 saniye cooldown vardır. Bunlar ölçülmüş optimum değerler değildir.

## Paper dolum ve risk modeli

Emir geliş gecikmesi 100 ms'dir. Maker emir hem gönderimde hem varışta post-only kontrolünden geçer. Varışta o fiyatın görünür miktarının 1,2 katı kuyruk önceliği varsayılır. Tahta miktarının düşmesi kuyruğu ilerletmez. **Yalnız aynı fiyatta, karşı agresör yönünde ve emir aktif olduktan sonra gerçekleşen tape hacmi** önce kuyruğu tüketir, sonra kısmi dolum verir. Önceki veya tekrar gelen tape dolum üretmez. Kısmi giriş hemen stop ve hedeflerle korunur; hedeflerin de tape/kuyruk şartı vardır.

Taker emir gecikme sonrasında görünür karşı tahtayı fiyat sırasıyla tüketir; her doluma ayrıca bir tick aleyhte kayma eklenir. Aynı book update içinde tüketilmiş miktar tekrar kullanılamaz. Girişin dolmayan IOC kalanı iptal edilir; acil çıkışın kalanı açık ve beklemede kalır. Stop sabit fiyattan garanti dolum değildir. Giriş/çıkış komisyonu sırasıyla maker %0,02, taker %0,04 varsayımlarıyla her dolumda alınır. Bunlar kullanıcının borsa hesabından doğrulanmış ücretleri değildir.

Varsayılan risk bütçesi işlem başına 5 USD, sembol başına azami 500 USD notional, toplam açık ve bekleyen girişlerde 1500 USD notional, en fazla üç semboldür. Miktar lot adımına aşağı yuvarlanır; minimum miktar/notional kontrol edilir. Bekleyen girişler toplam kapasiteden düşülür. Boyutlandırma stop mesafesi, giriş/çıkış ücretleri ve tick kaymasını içerir. Gap, derinlik değişimi ve dolum gecikmesi yüzünden **5 USD garantili azami kayıp değildir**. UTC gün başlangıcına göre mark-to-market kayıp 50 USD'ye ulaşınca girişler durur ve açık pozisyonlardan çıkış istenir. Bu kilit süreç yeniden başlatılana kadar kalır.

Varsayılan `requireCostCoverage=true`: hedef mesafesinin ihtiyatlı %75'i tahmini giriş + maker hedef ücretini ve taker giriş kaymasını karşılamıyorsa işlem reddedilir. Küçük tick'li paritelerde 5–10 tick, komisyonun altında kalabilir. Bu kontrolü kapatmak yalnız test/araştırma için uygundur; edge yaratmaz. Hedef varışta marketable olmuşsa maker dolumu uydurulmaz, hedef iptal edilir ve kalan pozisyon stop/zaman/momentum korumasında kalır.

## Kayıt ve inceleme

Her çalıştırma `logs/<UTC-tarih>-<pid>/config.json` ve `events.jsonl` oluşturur. Evren/tick bilgisi, durumlar, duvarlar, sinyaller, reddedilen emirler, dolumlar, kapanışlar ve bitişte çözülmemiş pozisyonlar kaydedilir. `TRADE_CLOSED.net` iki tarafın ücretleri sonrası sonuçtur. Ekrandaki realized değer açık pozisyonların alınmış ücretlerini ve kısmi realize sonuçlarını da içerir. Equity, mevcut gözlenen çıkış fiyatı ve tahmini taker çıkış ücretini içerir; veri kesintisindeki mark yürütülebilir fiyat garantisi değildir.

`record=true` normalize depth/tape olaylarını ve senkronizasyon sonrası tahta baseline'larını ayrıca kaydeder. Kayıtlar tanılama/veri toplama içindir; otomatik replay veya crash sonrası pozisyon devam ettirme aracı pakette yoktur. Her başlangıç yeni paper sermayeyle bağımsız seanstır. Ekranda son 200 kapanış tutulur, tüm kapanışlar journal'da kalır. Journal kuyruğu 16 MB'ı aşarsa yeni işleme devam etmek yerine süreç durdurulur.

## Sınırlar ve doğrulama

L2 market-by-price, emir kimliği ve gerçek sıra önceliği sağlamaz; iptal, yeni emir ve gizli likidite tam ayrıştırılamaz. Kamuya açık depth ve aggTrade farklı akışlardır; özellikle 100 ms toplulaştırma içinde olay sırası belirsizdir. Spoof/iceberg isimleri tespit hipotezidir. 100 ms feed üzerinde Node.js ile borsa içi HFT veya milisaniye infaz garantisi verilmez.

Simülatör kendi emirlerinin gerçek piyasaya etkisini, gizli sırayı, hesabın özel ücretlerini, funding, borçlanma veya likidasyonu modellemez. Pozisyonların funding anını aşması halinde yazılan net sonuç toplam ekonomik maliyeti kapsamaz. Görünür hacim ve kuyruk varsayımları hassasiyet testi gerektirir. Gerçek emir, kimlik doğrulama, broker reconciliation ve unattended servis denetimi bu uygulamanın kapsamına dahil edilmemiştir.

`npm run check` strict TypeScript derlemesini ve deterministik davranış testlerini çalıştırır. `VALIDATION.md` yapılan kısa bağlantı testinin sonuçlarını içerir. Canlıya geçişten önce sabit kurallı ileri paper örneklemi, gerçekçi maliyet hassasiyeti, bağımsız değerlendirme ve uzun süreli kopma/yük testleri gerekir; bu paket böyle bir geçiş yapmaz.

## Resmi protokol kaynakları

- [Binance Spot WebSocket / yerel tahta kuralları](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md)
- [Futures yerel tahta ve pu kontrolü](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)
- [Futures public / market akış ayrımı](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Important-WebSocket-Change-Notice)
- [Futures REST market data ve exchangeInfo](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)

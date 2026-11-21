# Crypto In-Play v2 — paper araştırma sürümü

Bu sürümün amacı, haberli ve olağan dışı katılım gören bir üründe, tek bir giriş hipotezini tutarlı biçimde ölçmektir. ACE Trading kopyası değildir. SMB'den araştırılan genel seçim çerçevesiyle benzerlik, eşiklerin veya kriptodaki kazanç avantajının doğrulandığı anlamına gelmez. Kaynaklı inceleme üst klasördeki `ACE_INPLAY_ARASTIRMA.md` dosyasındadır.

## Kolay başlatma

Bu klasörde PowerShell açın:

```powershell
npm ci
npm run check
npm start
```

Terminal çalıştırması `Ctrl+C` ile kapatılır. Süreli kontrol `npm start -- --duration 30`. Gerçek emir göndermez. Kullanıcının 7/24 isteği üzerine ayrıca Windows arka plan görevi ve otomatik oturum açılışı kuruldu: güncel işletim talimatları [CALISMA_247.md](CALISMA_247.md) dosyasındadır. Arka plan motoru açıkken ikinci terminal örneği engellenir. Her çalıştırma bağımsız paper seansıdır; pencere ve sanal pozisyonlar yeniden başlatmada devam ettirilmez.

## Yeni işlem için bütün şartlar gerekir

1. **Yeni haber:** Tree paketinde kaynak alanı Binance EN / Upbit / Bithumb / Coinbase ile başlamalı; başlık veya gövdede listing, lists, list, launchpool, roadmap, ETF veya SEC konusu bulunmalıdır. Kaynak ve konu birlikte aranır. Başlık/gövde içinde borsa adının geçmesi, yayıncı doğrulaması sayılmaz. Bu kaynak alanına dayanan bir sınıflandırmadır; imzalı haber doğrulaması veya ekonomik önem analizi değildir.
2. **Zaman:** Haber yayın zamanı sayısal saniye/milisaniye veya ISO biçiminde bulunmalıdır. Alımda en fazla 120 saniye eski ve en fazla 5 saniye ileride olmalıdır. Zamanı olmayan haber işlem için kullanılamaz. Uygunluk yayın/alım zamanının erken olanından 15 dakika sürer. Aynı haber bu süreyi uzatmaz; daha eski haber yeni katalizörü değiştiremez.
3. **Hacim:** Güncel yaklaşık 60 saniyelik quote hacim 1 milyon doların üzerinde ve önceki 30 dakikanın dakika başına ortalamasının en az 10 katı olmalıdır. Geçmiş RVOL tetik etiketi yeterli değildir: karar ve dolum öncesinde güncel değer yeniden kontrol edilir.
4. **Katılım:** Son pencerede saniyede ortalama en az 2 aggTrade mesajı gerekir. Bu ham işlem sayısı değildir.
5. **Fiyat tepkisi:** Haber alındığındaki son güncel işlem fiyatına göre en az %0,10 değişim gerekir. Fiyat o anda yoksa ilk sonraki işlem referans olur. Yön, haber metninden tahmin edilmez; bu fiyat tepkisinden çıkarılır. Bu hareketin haber yüzünden oluştuğunu kanıtlamaz.
6. **İşlem yapılabilirlik:** Güncel tahta/tape, Spot doğrulaması ve mevcut risk kontrolleri gerekir. Spread en fazla %0,10 ve mevcut 10 tick sınırında olmalıdır. Geçmiş 60 saniyede gözlenen high-low aralığı, spread + taker giriş/maker hedef komisyonu + giriş kayması tahmininin en az 2 katı olmalıdır. Geçmiş aralık gelecekte kalan kazanç potansiyeli değildir; yalnız bir araştırma elemesidir.
7. **Tek giriş biçimi:** B stratejisi, yani yaşını tamamlamış bir duvarın gözlenen agresif işlemlerle büyük ölçüde tüketilmesi kullanılır. Yön fiyat tepkisiyle uyumlu olmalı; BTC karşı yönde olmamalıdır. A duvar sekmesi ve C absorption girişleri normal çalıştırmada devre dışıdır; eski birim testlerinde ayrı fixture olarak korunmuştur.

Eşikler `src/config.ts` içindedir; örnek ayarlar `config.example.json` dosyasındadır. Bunlar geçmiş kazancı artırmak için optimize edilmedi ve ACE'den alınmadı. Değiştirilirse farklı araştırma varyantı olarak ele alınmalıdır. Hedefte maliyet karşılama kontrolü ayrıca çalışır; uygun in-play üründe bile emir reddedilebilir.

## Giriş ile açık pozisyon yönetimi ayrıdır

Başlangıç listesindeki ürünler de aynı şartlardan geçer. Etiket sona ererse, RVOL düşerse, veri eskirse veya fiyat tepkisi kaybolursa yeni giriş engellenir ve bekleyen giriş iptal edilir. Gönderim ve simüle dolum arasında haber kimliği değişirse eski giriş iptal edilir. Kontrol strateji, broker gönderimi ve dolum yollarında uygulanır; politika bağlanmamış broker yeni girişe izin vermez.

Katalizör kaybı, açık pozisyonun hedeflerini veya stopunu kaldırmaz. Mevcut B momentum yavaşlaması, stop, hedef, süre ve günlük kayıp kontrolleri çalışır. V2, eski çıkış modelini başlangıç karşılaştırması için korur: iki tick duvar arkası stop, yaklaşık yarısı 5 tick/kalanı 8 tick hedef, en fazla 15 saniye tutma. Bunlar kazanç avantajı gösterilmiş çıkışlar değildir; funding ve gerçek borsa dolumu da modellenmez. Sentetik `npm run demo` yalnız muhasebe örneğidir, v2 strateji kazancı değildir.

## Veri, kapsam ve sınırlar

Tree anahtarsız bağlantı kullanır; ücretsiz kaynakların tamamını veya gecikmesiz teslimi garanti etmez. Binance miniTicker 24 saatlik kayan hacim taşır ve dakika hacmine dönüştürülmez. Gerçek hacim/frekans ek aggTrade akışlarından, ek fiyat hareketi göstergesi miniTicker'dan gelir. `/market` uçları, heartbeat, reconnect ve 23 saat rotasyon kullanılır.

RVOL, geçmiş günlerin aynı saatiyle karşılaştırılan hisse RVOL'u değildir. Bellekte 1 saniyelik kovalar ve en az 31 dakika ısınma kullanılır. Kesinti/eksik aggregate ID/gecikme, ısınmayı ve fiyat referansını sıfırlar. Böyle bir kesintiden sonra mevcut haberin süresi dolabilir; giriş zorlanmaz. İlk 31 dakikada uygun haber gelse bile tam hacim teyidi olmadan işlem yapılamaz.

Tarama USDⓈ-M TRADING USDT/USDC kontratlarını kapsar; quote tutarları USD yaklaşımıdır, kur dönüşümü yapılmaz. COIN-M kapsam dışıdır. Sadece tüm scanner şartları tamamlanmış adaylar dinamik tahta bağlantısına alınır; en fazla 15 ek sembol tutulur. Spot karşılığı bulunmayan veya kapasite dışındaki adaylar gerekçeyle kaydedilir. Ek abonelikler uygunluk bitse bile seans sonuna kadar tutulur; giriş izni sürmez. Otomatik kapasite tahliyesi bu sürümde yoktur.

Enstrüman kataloğu başlangıçta keşfedilir; seans sırasında borsaya tamamen yeni eklenen kontratların otomatik keşfi yoktur. Böyle bir sembol için yeniden keşif/yeniden başlatma gerekir; yeniden başlatma hacim ısınmasını da sıfırlar.

## Ne olduğunu nasıl göreceğim?

Terminalde `WATCH`, `NEWS_WAIT:<neden>` veya `IN_PLAY_CONFIRMED` görülür. Stratejinin ayrı durumu `NOT_IN_PLAY`, `DATA_STALE`, `WATCHING`, `POSITION_OPEN` vb. olabilir. Scanner teyidi tek başına emir değildir.

Journal:

- `RESEARCH_RULES`: sürüm ve araştırma ayarları.
- `IN_PLAY_NEWS` / `IN_PLAY_RVOL`: aday olayı; işlem izni anlamına gelmez.
- `NEWS_REJECTED`: kaynak, konu, zaman veya sembol sorunu.
- `IN_PLAY_DECISION`: neden değişiminde ve uygunluk sürerken 5 saniyede bir veri özeti.
- `ENTRY_BLOCKED`, `ORDER_REJECTED`, `ORDER_CANCELLED`: giriş/iptal gerekçesi.
- `SIGNAL`, `ORDER_SUBMITTED`, `TRADE_CLOSED`: karar anındaki haber kimliği, hacim, fiyat tepkisi ve maliyet/aralık bilgileriyle ilişkilendirilir.
- `CATALYST_FEED_COUNTS`: alım sayaçları. Haber sayısı sıfırsa bağlantı açılmış olması haber teslimini kanıtlamaz.

Rapor üretmek için:

```powershell
npm run report -- --session "logs/SEANS_KLASORU" --out "seans-raporu.json"
```

Rapor kapalı işlem neti, ücretler, örneklem büyüklüğü, eleme nedenleri ve çözülmemiş pozisyonları gösterir. Eski veya birleştirilmiş seansları reddeder. Tek bir iyi seans başarı veya edge kanıtı değildir. Durum daima `RESEARCH_ONLY_NO_EDGE_PROOF` olarak kalır. İleri örneklem, farklı koşullar, bağımsız değerlendirme ve katalizörsüz karşılaştırma henüz tamamlanmadı.

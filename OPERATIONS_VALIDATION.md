# 7/24 kurulum doğrulaması

8 Kasım 2026, İstanbul saati yaklaşık 04:04. Bu bir kurulum anı kaydıdır; sonraki sağlık için güncel heartbeat ve süreçlere bakılmalıdır.

- Derleme ve 42 deterministik test başarılı. Operasyon testleri ayrıca tek başına yeniden çalıştırıldı.
- Windows görevi `Masa2-InPlay-Paper-247` kuruldu, durumu Running. Kullanıcı oturum açılışı ve beş dakikalık tekrar tetikleri XML'den doğrulandı. Çalışma süresi sınırı PT0S. SYSTEM/oturum öncesi boot kurulumu yapılmadı.
- Başlangıç klasörü kısayolu oluşturuldu; çalıştırma gizli pencere ayarlı. Yeniden başlatılmış bilgisayarda gerçek logon testi yapılmadı.
- Kontrollü motor durdurma denemesinde PID 27000 kapandı; gözetici bekleme sonrasında PID 17820 ile motoru yeniden açtı ve veri alımı sürdü. Açık paper pozisyon yokken test edildi.
- `stop.ps1` devre dışı bırakma kilidi oluşturdu; motor STOPPED/unresolved=0 ve görev Ready durumuna geçti. Kilit kaldırılıp görev yeniden başlatıldı.
- Son doğrulamada tek worker PID 26084, supervisor PID 21672, mode paper, heartbeat RUNNING ve yaş 4,9 saniye. MiniTicker + 10 aggTrade bağlantısında sayaçlar ilerliyordu. Tree bağlı görünüyordu; haber teslimi gözlenmedi.
- Çalışan motorun yanına ikinci CLI motoru açma denemesi EADDRINUSE ile reddedildi; çalışan örnek etkilenmedi.
- Windows otomatik uyku engelleme API çağrısı hata vermedi. `powercfg /requests` sorgusu yönetici yetkisi istediği için liste bu oturumda doğrulanamadı. Global güç planı değiştirilmedi.
- Gerçek emir gönderilmedi. Kurulum performans/kârlılık kanıtı değildir. Durdurma testleri hacim ısınmasını sıfırladı; son worker yeniden 31 dakika ısınır.

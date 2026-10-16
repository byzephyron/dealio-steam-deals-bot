> Güncel ücretsiz kurulum için `../FREE-OPERATIONS.tr.md` kullanılır.
> Buradaki Azure Monitor/Blob şablonu ücretli alternatiftir; mevcut kurulumda uygulanmaz.


# Azure ücretli kurulum seçeneği

Bu dosyalar hazırlanmış altyapıyı içerir; bulunmaları kaynakların oluşturulduğu veya alarmların çalıştığı anlamına gelmez. Üretim mevcut Azure VM'de kalır. WSL'de üretim token'ıyla bot başlatılmaz.

## Önce doğrulanacaklar
1. Azure Portal / Cost Management + Billing'de doğru aboneliğin kredi türünü, kalan tutarını, sona erme tarihini ve harcama sınırını doğrula. Azure CLI hesap çıktısı kalan krediyi kanıtlamaz. Storage, Log Analytics ve alarm kuralları ücret üretebilir. SWA Free dışında bu pakete “ücretsiz” denmez.
2. Azure CLI ile aboneliğe giriş yap. Mevcut VM'nin sistem tarafından atanmış yönetilen kimliğini etkinleştir; principal ID'sini al. Şablon VM oluşturmaz/değiştirmez.
3. Doğrulanmış bir Azure Monitor Action Group seç. Bildirim alıcısını kullanıcı belirlemelidir.
4. main.bicep için az deployment group what-if çalıştır. Kredi ve değişiklik listesi doğrulandığında create kullan. azureCreditVerified=true yalnız gerçekten doğrulanmışsa verilir.

Parametreler: applicationId, vmPrincipalId, actionGroupId, azureCreditVerified. Bölge mevcut kaynak grubundan, Static Web Apps bölgesi westeurope olarak gelir. Mevcut üretim grubu DiscordBot-Dealio; şablon ayrılmış depolama oluşturur. Ad çakışmalarını what-if ile kontrol et.

## Depolama ve tek üretim örneği
Şablon leases ve backups özel konteynerlerini oluşturur; public blob ve Shared Key erişimi kapalıdır. VM kimliğine yalnız bu depolama hesabında Blob Data Contributor verilir. Tek seferlik yetkili Azure CLI oturumuyla leases/<DISCORD_CLIENT_ID>.lock boş blob'unu --auth-mode login kullanarak oluştur. Çalışan kilidin üzerine yazma.

Üretim .env dosyasında DEALIO_PRODUCTION=true ve AZURE_LEASE_CONTAINER_URL ayarla. Başlatma 60 saniyelik kirayı alır; 15 saniyede bir yeniler. Yenileme sonucu belirsizse Discord bağlantısı kesilir. Yerel dosya kilidi ayrıca korunur. Bütün üretim başlangıçları aynı konteyneri kullanmalıdır; eski kilitsiz kodu paralel çalıştırmak korumayı geçersiz kılar.

## Zamanlayıcılar ve günlükler
Şablon çıktılarını .env dosyasına yaz:
- AZURE_BACKUP_CONTAINER_URL
- AZURE_MONITOR_ENDPOINT
- AZURE_MONITOR_RULE_ID
- AZURE_MONITOR_STREAM=Custom-DealioHealth

dealio-backup.*, dealio-restore.*, dealio-monitor.* dosyalarını systemd alanına kur; yolların Azure checkout'una uyduğunu doğrula. Birimler User=dealiobot kullanır. journald@dealio.conf dosyasını /etc/systemd/journald@dealio.conf konumuna kur. dealio-production.conf üretim servisine drop-in olur. Kendi journald alanı yalnız Dealio günlüklerini yedi gün tutar; sistemin diğer günlüklerine dokunmaz.

Günlük tutarlı SQLite yedeği 03:15'te, aylık izole geri yükleme ayın 1'inde 04:15'te çalışır (sunucu saat dilimi). Yedek yalnız SQLite ve SHA-256 manifestidir; .env dahil değildir. Blob yaşam döngüsü yedi günden eski yedekleri siler; Azure işlemi ek zaman alabilir. Silme koruması/versiyonlama kapalıdır.

Geri yükleme en yeni yedeği geçici özel dizine indirir; checksum, SQLite bütünlüğü, yabancı anahtarlar ve güncel şemaya geçişi doğrular. Botu başlatmaz. Geçici dosyalar temizlenir.

## Bağımsız alarm denemesi
İzleme bot sürecinden ayrı systemd işiyle dakikada bir toplu metrik gönderir. Azure Monitor kuralları:
- 3 dakikadan eski yaşam sinyali veya Discord bağlantısı yok; 10 dakika metrik gelmemesi de alarmdır.
- 2 saatten eski başarılı kontrol.
- 26 saatten eski aktif teslimat kuyruğu (bir günlük özete tolerans).
- 26 saatten eski veya başarısız yedek.

Yayın öncesi test ortamının metrik zamanlayıcısını durdur, Azure Monitor'dan seçilen Action Group'a alarm ulaştığını kanıtla, geri açıp alarmın kapandığını kaydet. Bot günlüğündeki hata bunun yerine geçmez. Monitor verisi ulaşmadan diğer alarmlara güvenme.

## Test botu ve yayın kapıları
Ayrı Discord Developer Portal uygulaması oluştur. .env.test.example dosyasını .env.test olarak kopyala; yalnız test token'ını yaz. PRODUCTION_DISCORD_CLIENT_ID gerçek üretim uygulaması olmalı. Test dosyasını kaynak kontrolüne ekleme. Başlatma: DOTENV_CONFIG_PATH=.env.test npm run dev.

Türkçe/İngilizce, masaüstü/mobil gerçek Discord testlerini bitir. release-evidence.example.json kapıları varsayılan başarısızdır. Gerçek kanıt yolları ve test edilen commit'i kaydet; npm run release:check -- /path/to/evidence.json geçmeden üretimi güncelleme.

Her `evidence` alanı, ana kanıt JSON dosyasına göre çözümlenen bir kayıt JSON dosyasının yoludur. Kayıtta `schemaVersion: 1`, kapı adı (`gate`), aynı tam Git commit'i (`commit`), `passed: true`, ISO zaman (`checkedAt`), kısa özet (`summary`) ve en az bir `artifacts` dosya yolu bulunmalıdır. Artifact yolları kayıt dosyasına göre çözülür; her dosya var ve boş olmayan normal dosya olmalıdır. Örnek biçim `release-gate-record.example.json` içindedir. Otomatik kapı dosya ve revizyon tutarlılığını kontrol eder; ekran görüntüsünün veya canlı testin gerçekliğini insan incelemesiyle ayrıca doğrula. Token, profil kimliği ve kişisel verileri kanıt dosyalarına koyma.

## Tanıtım ve yasal sayfalar
SWA oluşturulunca deployment token'ını GitHub reposunun public-site ortamında AZURE_STATIC_WEB_APPS_API_TOKEN sırrı olarak sakla. Publish public Dealio pages işi elle başlatılır; yalnız build-public-site.mjs izin listesindeki dosyalar yayımlanır. Kaynak repo herkese açıktır.

Yayımlanan /terms.html, /privacy.html, /help.html ve Türkçe eşlerinin HTTP 200 olduğunu kontrol et. Yayın kanıtındaki termsUrl, privacyUrl ve supportUrl gerçek HTTPS sayfalarını göstermelidir; kapı üçünün de erişilebilir HTML olduğunu kontrol eder. Discord Developer Portal > General Information içindeki Terms of Service URL ve Privacy Policy URL değerlerini gerçek SWA adresiyle güncelle. Eski GitHub Pages bağlantıları kullanılmaz. Desteklenen resmi API işlemi doğrulanmadan bu alanların API üzerinden güncellendiği varsayılmaz.

## Geçiş ve geri dönüş
1. Yayın kanıtı geçsin; üretim HEAD ve .env konumu kaydedilsin.
2. Backup işini elle çalıştır ve izole geri yüklemeyi geçir.
3. Üretimi durdur; son tutarlı SQLite yedeği ve önceki commit'i özel operatör alanına kaydet.
4. Test edilmiş commit'e geç ve üretim dışında hazırlanmış doğrulanmış derlemeyi kur; [dağıtım rehberini](../README.tr.md) izle. Küçük üretim VM'sinde derleme veya tam test çalıştırma. Kilit, izleme ve yedek ayarları olmadan yeni sürümü açma.
5. Başlat; sağlık, kira, yeni /dealio, teslimat ve alarm verilerini kontrol et.

Şema 10'dur. Eski koda dönerken uyumlu veritabanı yedeği de gerekir. Eski kodu yeni veritabanına karşı çalıştırma. Geri yükleme sonradan silinen kullanıcıları canlandırabilir: bildirimler kapalıyken sonraki silme taleplerini uzlaştır; gerektiğinde yeniden onay al. Kod geri dönüşü bunun yerine geçmez.

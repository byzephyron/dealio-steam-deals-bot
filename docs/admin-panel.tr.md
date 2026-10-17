# Dealio yönetim paneli

Bot sahibine özel web paneli. Bot sürecinin içinde çalışır, yalnız
`127.0.0.1` adresini dinler ve SSH tüneliyle açılır. İnternete port açılmaz,
ek bulut kaynağı gerekmez.

## Kurulum

1. Uzun, rastgele bir anahtar üretin:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. VM'deki `.env` dosyasına ekleyin (paylaşmayın, commit etmeyin):

   ```env
   DEALIO_ADMIN_TOKEN=<üretilen anahtar>
   DEALIO_ADMIN_PORT=8787
   ```

3. Servisi yeniden başlatın: `sudo systemctl restart dealio`. Günlükte
   `Admin panel listening on 127.0.0.1:8787` satırı görünür.
   `ss -ltnp | grep 8787` yalnız `127.0.0.1:8787` göstermelidir.

`DEALIO_ADMIN_TOKEN` boşsa panel hiç başlamaz. Panel başlayamazsa (ör. port dolu)
bot çalışmaya devam eder; yalnız günlüğe hata yazılır.

## Açma

Windows'ta:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/admin-tunnel.ps1
```

Betik `ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 <SshTarget>` tünelini (`dealiobot@<VM genel IP>`;
`-SshTarget` parametresiyle ya da `%USERPROFILE%\.dealio\ssh-target` dosyasından okunur)
açar ve tarayıcıda `http://localhost:8787` adresini başlatır. Masaüstündeki
**Dealio Yönetim** kısayolu aynı betiği çalıştırır; pencereyi kapatmak tüneli kapatır.

Anahtar `%USERPROFILE%\.dealio\admin-token` dosyasındaysa panel giriş yapmış
olarak açılır: betik anahtarı tünel üzerinden panele gönderip bir dakika geçerli,
tek kullanımlık bir giriş kodu alır; URL'nin `#` kısmında anahtarın kendisi değil
yalnız bu kod taşınır ve sayfa onu adres çubuğundan hemen siler.

Kendi kullanıcı adınız ve şifrenizle girmek için bir kez **Sistem → Panel girişi**
bölümünde kullanıcı adı ve en az 10 karakterlik bir şifre belirleyin. Sunucuda
yalnız şifrenin scrypt özeti (`runtime_setting` tablosu) tutulur; `.env` değişmez,
bot yeniden başlatılmaz. Kaydedince diğer açık oturumlar kapanır. Bundan sonra giriş
ekranı kullanıcı adı ve şifre ister; hatalı denemeler anahtarla aynı kilide sayılır
(15 dakikada 10 deneme). Şifre belirlenmemişse ekran `DEALIO_ADMIN_TOKEN` değerini
ister. Şifreyi unutursanız masaüstü kısayoluyla (veya giriş ekranındaki "Yönetici
anahtarıyla giriş yap" ile) girip yenisini belirleyin ya da kaldırın. Oturum 12 saat
sürer, bot yeniden başlayınca kapanır.

Yerel geliştirmede (`.env.test` ile) tünel gerekmez; doğrudan
`http://localhost:8787` açılır. Sentetik verili önizleme için:
`npm run preview:admin` (Discord'a hiçbir şey göndermez).

## Ekranlar

Veri sayfaları sekme açıkken 30 saniyede bir kendini sessizce yeniler (başlıkta “● Canlı · … önce”); sekme arka plandaysa bekler, öne gelince hemen yenilenir. Loglar anlık akar, gönderimdeki duyurular 3 saniyede bir güncellenir.

Üst çubuktaki arama kutusu (veya **Ctrl+K**) kullanıcıyı adıyla, @kullanıcı adıyla, Discord ID'si veya SteamID64 ile; sunucuyu adıyla veya ID'siyle bulur ve sayfalara atlar. Ok tuşları seçer, Enter açar, Esc kapatır.

Üst çubuktaki güneş/ay düğmesi açık ve koyu tema arasında geçer; seçim bu tarayıcıda hatırlanır, seçim yoksa sistem teması izlenir. Yazı tipleri (Inter ve Archivo) panelle birlikte gelir; dışarıdan hiçbir şey yüklenmez.

| Sayfa | İçerik |
|---|---|
| Genel bakış | Eğilim çizgili sunucu/kullanıcı/aktif kullanıcı/uyarı kartları (önceki 7 güne göre değişim), **bot kontrolü** (aşağıda), sekmeli etkinlik grafiği (uyarı, aktif kullanıcı, kayıt, sunucu), kontrol durumu halkası ve başarısız kontrollerin nedeni (açıklama, kimin düzeltmesi gerektiği, sorunlu kullanıcılara bağlantı), kapasite ve uyarı kuyruğu, bot ve tarayıcı, dağılımlar |
| Sunucular | Botun olduğu sunucular (canlı), sahipleri, Dealio kullanan kişi sayısı; olay geçmişi, ayrılan ve engellenen sunucular. Detayda o sunucudan gelen kullanıcılar, **sunucudan çık** ve **engelle** |
| Kullanıcılar | Arama, durum ve son kontrol filtresi (`#/users?check=problem`), CSV; geldiği sunucu, son görülme, başarısız kontrolün nedeni. Detayda wishlist, kurallar, bildirim geçmişi, kullanım zaman çizelgesi ve işlemler |
| Oyunlar | En çok istenen, şu an indirimde, en çok uyarı ve kural konan oyunlar |
| Kullanım | Günlük aktif kullanıcı, eylemler (“Wishlist sekmesine geçti” gibi düz cümlelerle; kayıtlı kod ipucunda ve CSV'de), kurulum hunisi ve başarısızlık sebepleri, kurulum türü, kaynak sunucular |
| Duyurular | Dört dilde duyuru yazma, Discord önizlemesi, hedef kitle, gönderim takibi, duraklat/sürdür/iptal |
| Sistem | Sağlık, süreç, veritabanı, tarayıcı; **şimdi tara**, **bildirimleri şimdi dene**; otomatik tarama, kayıtları aç/kapat, kullanıcı sınırı, bot durum metni; engellenen kullanıcılar |
| Denetim | Panelden yapılan tüm işlemler (1 yıl) |
| Loglar | Bot sürecinin son 1000 satırı, canlı akış |

### Bot kontrolü

Genel bakıştaki kartta beş işlem var; hepsi Denetim'e yazılır.

- **Şimdi tara**: tüm aktif kullanıcıları hemen kontrol eder (duraklatılmışken de çalışır).
- **Bekleyen uyarıları gönder**: kuyruktaki uyarıları sıradaki denemeyi beklemeden dener.
- **Otomatik tarama**: kapatınca zamanlanmış taramalar atlanır, takvim yine kurulur; bot, komutlar ve bekleyen uyarılar çalışır. Ayar veritabanında saklanır, yeniden başlatmada korunur.
- **Yeniden başlat**: botu düzgünce kapatır ve 75 koduyla çıkar; systemd (`Restart=on-failure`) birkaç saniyede yeniden açar. Panel oturumu kapanır; sayfa bot dönünce giriş ekranına yenilenir.
- **Durdur** (`DURDUR` yazarak onay): botu kapatır ve 0 koduyla çıkar, systemd yeniden açmaz. Panel de kapanır; yeniden açmak için VM'de `sudo systemctl start dealio`. Healthchecks bu sırada “bot kapalı” uyarısı gönderir.

## Kullanıcı işlemleri

İzlemeyi durdur/aç (açmak DM engelini de temizler), şimdi kontrol et, test
uyarısı, DM gönder, bölge ve dil değiştir, engelle/engeli kaldır, verileri sil.
Hepsi Discord komutlarıyla aynı servislerden ve kullanıcı başına kilitten geçer.
Veri silme `/delete-data` ile aynıdır ve silme günlüğüne yazılır.

Engellenen hesap Dealio'nun komut ve düğmelerini kullanamaz; yalnız
`/delete-data` açık kalır. Engelli sunucuya eklenen bot hemen çıkar.

## Duyurular ve DM

- Yalnız kurulumu tamamlamış (DM onayı vermiş), engellenmemiş ve DM'i kapalı
  olmayan kullanıcılar alıcıdır.
- Alıcılar Discord çağrısından önce veritabanına yazılır; her deneme öncesinde
  `sending` olarak işaretlenir. Teslim en az bir kez garantilidir (yeniden
  başlatmada yarım kalan gönderim tekrar denenir).
- Hız: 1,5 saniyede bir mesaj. Discord hız sınırı deneme hakkı harcamaz;
  50007 (DM kapalı) ve 50278 (ortak sunucu ya da uygulama kurulumu yok) kullanıcının DM engelini
  işaretler; kullanıcı ayrıntısındaki kod (`DISCORD_DM_BLOCKED` / `DISCORD_NO_MUTUAL_GUILD`) nedeni gösterir.
- Kullanıcı kendi dilini, yoksa İngilizceyi, o da yoksa yazılan başka bir dili görür.
- Toplu duyuruyu başlatmak için onay kutusuna `GÖNDER` yazılır. Duyuruları
  servisle ilgili ve seyrek tutun; Discord istenmeyen toplu DM'leri spam sayabilir.

## Toplanan kullanım verisi

Gizlilik politikasında (`docs/privacy*.html`, 7 Ekim 2026) açıklandığı gibi:

- `interaction_event`: kullanıcı, sunucu (DM'de boş), bağlam, kurulum türü,
  komut/düğme adı (girdi metni değil), Discord dili, zaman. 90 gün.
- `guild_event`: botun eklendiği/çıkarıldığı sunucu, ad, üye sayısı, zaman.
- `admin_audit`: panel işlemleri, hedef hesabın Discord kimliği (hesap silinince
  hash'i) ve ayrıntı, 1 yıl.
- `broadcast`, `broadcast_recipient`: duyuru/mesaj metni, hedef kitle (doğrudan mesajda
  alıcı kimliği) ve teslim durumu; oluşturulmasından 90 gün sonra (gönderim bitmişse) silinir.
- `user_block`, `guild_block`, `runtime_setting`.

`/delete-data` kullanım ve teslim kayıtlarını da siler; silme günlüğü yedekten
dönen eski kullanım kayıtlarını da temizler. Yalnız o kişiye giden doğrudan
mesajları siler, diğer `broadcast.audience` listelerinden kimliği çıkarır ve
`admin_audit` satırlarındaki kimliği silme günlüğündeki hash ile değiştirir. Engel
kaydı korunur; gizlilik politikası bunu açıkça yazar.

## Güvenlik

- Yalnız `127.0.0.1`; `Host` başlığı localhost değilse 421 (DNS rebinding).
- Tek anahtar, sabit-zamanlı karşılaştırma; 15 dakikada 10 hatalı denemede kilit.
- `HttpOnly; SameSite=Strict` oturum çerezi, her değişiklikte CSRF başlığı ve
  `Origin` kontrolü; yıkıcı işlemler hedef kimliğin yazılmasını ister.
- Sıkı CSP (satır içi betik yok), `X-Frame-Options: DENY`, `nosniff`.
- Anahtar günlüğe yazılmaz; log görünümü `redactSecrets` ile maskelenir.
- Discord profilleri bellekte önbelleklenir, veritabanına yazılmaz.

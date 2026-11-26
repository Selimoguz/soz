# soz-guard: kurulum, deneme ve kaldırma

Bu belge ekipte bir deneme içindir: nasıl kurulur, kurduktan sonra ne görülür, beğenilmezse nasıl
durdurulur ve nasıl tamamen kaldırılır. Buradaki her komut soz-guard 0.5 sürümüyle denendi.

## Ne yapar

Claude Code ile çalışan bir ajan "bitti" deyip durmak istediğinde, soz-guard yapılan değişikliğe bakar.
İşte TODO, boş hata yakalama, uydurma veri varsa, testler geçmiyorsa ya da ajan testleri silmiş,
zayıflatmış veya kapatmışsa ajanı durdurur ve ona neyin eksik olduğunu söyler. Ajan işi bitirince
durmasına izin verir. Ajanın "testler geçti" sözüne bakmaz; testleri kendisi çalıştırır.

İki parçası vardır:

| Parça | Nerede | Ne işe yarar | İlk denemede |
|---|---|---|---|
| **Ajan kancası** | Claude'un çalıştığı yer (patron için sunucudaki çalışma klasörü, ikinci geliştirici için kendi makinesi) | Ajanı iş sırasında durdurur, eksiği söyler | **Evet** |
| **Sunucu kapısı** | Sunucudaki git deposu | Bitmemiş işin `main`e girmesini engeller | İkinci aşamada |

İlk deneme yalnızca ajan kancasıyla yapılabilir. Kapı daha sıkıdır, çünkü push'u reddeder. Kanca
alışıldıktan sonra kurulması önerilir.

## Neye dokunur

| Yer | Ne eklenir | Git'e girer mi |
|---|---|---|
| Makine | `soz-guard` komutu (`npm install -g`) | Hayır |
| Proje | `.soz-guard.json` (hangi testlerin geçmesi gerektiği), `CLAUDE.md` içine kısa bir kurallar bölümü, `.gitignore`'a iki satır | **Evet**, bir kez commit edilir |
| Proje | `.claude/settings.local.json` (bu makinenin kancası), `.soz-guard/` (kararların kaydı) | Hayır |
| Sunucu deposu (kapı) | `hooks/pre-receive` (karar verir), `hooks/post-receive` (paketi push kesinleşince yayına bağlar), depo klasöründe `.soz-guard/` (ayar, raporlar, kayıt) | Hayır |

Arka planda çalışan bir servis yoktur, internete bağlanmaz, kodunuzu ya da git geçmişinizi değiştirmez.
Yalnızca ajan durmak istediğinde (ve kapı kuruluysa push geldiğinde) çalışır.

## A. Ajan kancasını kurmak

Gereken: Node 18 veya üstü, git, Claude Code.

**1. Her makinede bir kez** (patron için sunucuda, kendi kullanıcısıyla; ikinci geliştirici için kendi
makinesinde):

```sh
npm install -g @sezeren/soz-guard
```

Linux'ta `-g` kurulum yönetici yetkisi isteyebilir (`sudo npm install -g ...`). Kurulduğunu
`soz-guard log --verify` ile görebilirsiniz; komut bulunamazsa npm'in global klasörü PATH'te değildir.

**2. Projede bir kez, deponun sahibi yapar.** Proje klasöründe:

```sh
soz-guard init --local
```

Çıktı ne eklediğini söyler. `package.json`'da `test` betiği varsa `.soz-guard.json`'a "işin bitmesi için
`npm test` geçmeli" diye yazar. Projenin gerçek test komutu başkaysa onu `"run"` kısmına yazın. Test
yoksa `"checks": []` kalır; o zaman soz-guard yalnızca yarım iş ve testlerin zayıflatılmasına bakar.

Sonra eklenen üç dosyayı **hemen commit edin.** Commit edilmeden açılan bir Claude oturumu bunları
"kurallar değişti" diye görür ve ajanı durdurur (denendi):

```sh
git add .gitignore .soz-guard.json CLAUDE.md
git commit -m "soz-guard denemesi"
```

**3. Diğer geliştiriciler** değişikliği çekince kendi makinelerinde yalnızca şunu çalıştırır:

```sh
soz-guard init --local
```

Ayarlar zaten commit edildiği için bu komut yalnızca o makinenin kancasını ekler.

**4. Açık Claude oturumlarını kapatıp yeniden açın.** Claude Code kancaları oturum başında okur; açık
oturumlar soz-guard'ı görmez. Konuşma geçmişi kaybolmaz.

**5. Neyi koruduğuna bakın.** Proje klasöründe:

```sh
soz-guard doctor
```

Yalnızca okur, hiçbir şeyi değiştirmez. İş bitince hangi testlerin çalışacağını, projede olup da
soz-guard'ın çalıştırmadığı test komutlarını (ör. `package.json`'daki `npm test`, `.soz-guard.json`'da
zorunlu kontrol değilse), etkin kuralları, kancaların durumunu ve sunucudaki soz-guard gate'i (push
denetimi) söyler. Sunucu bu makineden okunamıyorsa "buradan doğrulanamadı" der; bu, projenin kendi
betikleriyle ilgili değildir. Her yeni Claude oturumu da bunun özetiyle, `soz-guard ·` ile
başlayan bir satırla açılır. Claude masaüstü uygulaması bu satırı ekranda göstermediği için orada satırı
ajan ilk cevabının başına yazar; soz-guard yazıp yazmadığını denetler. Satır görünmüyorsa kancalar
çalışmıyordur; nedenini `soz-guard doctor` söyler.

## Kurduktan sonra neler göreceksiniz

| Durum | Ne olur | Ne yapılır |
|---|---|---|
| Ajan TODO bırakıp durmak istiyor | Durdurulur, dosya ve satır söylenir; ajan genellikle bitirir | Bir şey yapmanız gerekmez |
| Testler geçmiyor | Durdurulur, testin çıktısı ajana gösterilir | Bir şey yapmanız gerekmez |
| Ajan üç kez durduruldu, hâlâ bitmedi | Durmasına izin verilir; size "iş bitmedi" diye ayrı bir mesaj gelir | İşe siz bakarsınız |
| Ajan bir şeyi bilerek bıraktı (`soz-guard: ignore <neden>`) | Durabilir; bıraktığı satırlar ve nedenleri size gösterilir | Okursunuz |
| Ajan bir testi sildi ya da değiştirdi | Durdurulur. Değişiklik doğruysa (eski bir test gerçekten gereksizse) sizin onayınız gerekir | Proje klasöründe, terminalde: `soz-guard accept "neden"`, sonra `yes` yazın |
| Her duruşta testler çalışıyor, uzun sürüyor | Aynı değişiklik için sonuç tekrar kullanılır, ama her yeni değişiklikte testler yeniden çalışır | Uzunsa `.soz-guard.json`'da `"when": ["src/**"]` ile yalnızca kod değişince çalıştırın |
| Boşuna durdurdu | Bu denemenin asıl ölçeceği şey bu | Not alın (aşağıda: "Deneme süresince") |

## B. Sunucu kapısı (ikinci aşama)

Push'lar sunucudaki bir git deposuna geliyorsa kapı o depoya kurulur. Korunan dala (örneğin `main`)
gelen her push için kapı geçici bir klasör açar, kurulum komutunu (örneğin `npm ci`) ve testleri
çalıştırır. İş bitmemişse push reddedilir ve push yapana nedeni gösterilir. Diğer dallar serbesttir.

**Önemli:** Patron Remote-SSH ile çalıştığı için Claude sunucuda, patronun kullanıcısıyla komut
çalıştırabilir. Kapının işe yaraması için ana deponun ayrı bir kullanıcıya (örneğin `git`) ait olması
ve geliştiricilerin (ve ajanlarının) bu deponun klasörüne yazamaması gerekir. Patronun kullanıcısında
şifresiz `sudo` varsa ajan da kapıyı aşabilir.

```sh
# git kullanıcısı olarak, bir kez
npm install -g @sezeren/soz-guard
cd /srv/git/proje.git
soz-guard gate install --branches main --setup "npm ci"
```

| Durum | Ne olur | Ne yapılır |
|---|---|---|
| `main`e push | Push, testler bitene kadar bekler | — |
| İş bitmemiş | `! [remote rejected] main -> main (pre-receive hook declined)` ve nedeni | Geliştirici düzeltip tekrar push eder |
| Test değişikliği gerçekten doğru | Reddedilir, onay komutu gösterilir | Bir kişi sunucuda: `sudo -u git soz-guard gate approve <hash> "neden"`, sonra tekrar push |
| Bir dalı birleştirmeden önce bakmak | — | `sudo -u git soz-guard gate check dal-adi --base main` |

**İsteğe bağlı iki ayar:**

- `--require-task`: `main` yalnızca onaylı bir görevin teslimini alır. Görev, `acceptance/<görev>.json`
  dosyasıyla ya da commit mesajındaki `Task: T1` satırıyla belirtilir ve o commit üzerinde `complete`
  olmalıdır. Görevsiz acil bir düzeltme, ancak bir kişi o commit'i gerekçesiyle onaylarsa girer:
  `soz-guard gate approve <hash> "neden görevsiz"`. Boş bir depoya yapılan ilk push için de bu onay gerekir.
- `--build "<komut>" --package <yol>`: Kapı paketi kendisi bir kez derler, testlere paketin yerini
  (`$SOZ_GUARD_PACKAGE`) verir ve paketin özetini kaydeder. Paketi başlatıp kullanmak testin işidir; önemli
  maddelerin testi paketi bu yoldan başlatmalıdır. Kişinin "gördüm, doğru" onayı da o pakete bağlıdır. Yalnızca
  `main`'e kabul edilen push bir paketi yayına çıkarır; elle yapılan `gate check` onu değiştiremez. Canlıya o
  paketin aynısı gider ve sonradan kontrol edilir:

  ```sh
  soz-guard gate package <hash> --to D:/deploy/yeni-surum      # onaylanan paketin kopyası
  soz-guard gate package <hash> --verify D:/siteler/uygulama --ignore logs   # canlıdaki klasör aynı mı
  ```

  Canlı sunucu başka bir makineyse orada `soz-guard digest <klasör>` çalıştırılır ve çıkan özet kapının
  kaydıyla karşılaştırılır.

## Durdurma ve kaldırma

### Geçici olarak durdurmak

**Ajan kancası** (her makinede): `.claude/settings.local.json` dosyasını silin. Dosyada Claude'un
kendi yazdığı izinler de varsa yalnızca `"hooks"` kısmındaki soz-guard satırlarını silin. Ardından Claude
oturumlarını yeniden açın. Geri açmak için `soz-guard init --local` yeterlidir.

**Sunucu kapısı**: Kancanın adını değiştirmek kapıyı anında kapatır (denendi):

```sh
mv /srv/git/proje.git/hooks/pre-receive /srv/git/proje.git/hooks/pre-receive.kapali
```

Geri açmak için adını eski hâline getirin. Acil bir düzeltmenin hemen gitmesi gerekirse yol budur.

### Tamamen kaldırmak

Proje klasöründe (denendi: proje kurulumdan önceki hâline döner):

1. `.claude/settings.local.json` dosyasını silin (ya da yukarıdaki gibi yalnızca soz-guard satırlarını).
2. `.soz-guard.json` dosyasını silin.
3. `CLAUDE.md`'de `<!-- soz-guard -->` satırından başlayan "Finished means finished" bölümünü silin.
   Dosyayı `init` oluşturduysa dosyanın tamamını silin.
4. `.gitignore`'dan `.claude/settings.local.json` ve `.soz-guard/` satırlarını silin.
5. `.soz-guard/` klasörünü silin. Bu klasör kayıtları tutar; deneme sonucunu değerlendirecekseniz önce
   içindeki `log.jsonl`'i saklayın.
6. Değişikliği commit edin. Her makinede: `npm uninstall -g soz-guard`.

Sunucuda: `hooks/pre-receive` ve `hooks/post-receive` dosyalarını silin, depo klasöründeki `.soz-guard/` klasörünü silin (önce
`log.jsonl`'i saklayın), `npm uninstall -g soz-guard`.

## Deneme süresince

Her karar kaydedilir. Proje klasöründe:

```sh
soz-guard log --last 50      # son kararlar: ne zaman, neden durdurdu
soz-guard log --verify       # kayıt sonradan değiştirilmiş mi
```

Kapı kuruluysa sunucudaki bütün kararlar tek yerdedir: `sudo -u git soz-guard gate log --last 50`.

Kayıtlar her makinede ayrı tutulur. Değerlendirme için her geliştirici hafta sonunda
`soz-guard log --last 200` çıktısını gönderir. Her durdurma için tek bir soru sorulur: **gerçek bir eksiği
mi yakaladı, yoksa boşuna mı durdurdu?** Bir iki haftanın sonunda bu sayılar devam edip etmemeye karar
vermek için yeterlidir.

## Bilinen sınırlar

- Ajan kancası bir hız kesicidir, kilit değildir: ajan makinedeki her şeyi yapabildiği için isterse aşabilir.
  Asıl kural sunucu kapısıdır.
- soz-guard işin istenen şey olup olmadığını bilmez; testlerin ölçtüğünü bilir. Test yoksa yalnızca yarım
  işi ve testlerin zayıflatılmasını yakalar.

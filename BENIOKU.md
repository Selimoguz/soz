# soz (Türkçe özet)

**Modelin yazdığı, kodun çalıştırmadan önce kanıtladığı küçük bir plan dili.**

Model araçları tek tek çağırmak yerine işin tamamını küçük bir plan olarak yazar. Denetleyici, hiçbir
şey çalışmadan önce dört şeyi kanıtlar:

- **Kaynak:** her değer nereden geldiğini bilir (kullanıcının mesajı, bir araç ya da model).
  Kullanıcı 20 kasa istediyse ve planda 25 yazıyorsa plan çalışmaz. Modelin uydurduğu bir değer bir
  şeyi değiştiren işleme gidemez, uydurma bir eşiğe bağlı bir koşulla da yapılamaz.
- **Etki:** planın neye dokunduğu (`read`, `write`, `external`, `money` ya da alanın kendi etkileri,
  örneğin `erp.post`) ve onay gerekip gerekmediği metninden bilinir.
- **Sınır:** döngüler yalnızca sonlu listeler üzerindedir; en fazla kaç işlem çağrılacağı önceden
  bilinir.
- **Yalıtım:** plan veridir; okumak hiçbir şey çalıştırmaz.

Geçerli bir plan önce **önizlenir**: okumalar çalışır, yazmalar yalnızca adım olarak listelenir.
Kişi önizlemenin bütününü **bir kez** onaylar. **Yürütme** planı canlı verilerle yeniden çalıştırır ve
onaylanandan farklı bir adıma gelirse durur. **Tekrar anahtarı** iş verisinden türetilir: aynı adım
ikinci kez çalışmaz. Sonucu bilinmeyen bir işlem tekrar denenmez. Her şey SHA-256 ile zincirlenmiş bir
**denetim kaydına** yazılır.

**Politika:** ev sahibi, talebi yapan kişi için kurallar koyar. Kurallar yasaklayabilir ("saha
elemanı ödeme yapamaz"), rol ile ek onay isteyebilir ("10.000 üstü ödemeyi finanstan biri, talebi
yapan dışında, onaylar") ve bir değerin nereden gelebileceğini sınırlayabilir ("tutar faturadan
okunur, yazılmaz").

```sh
sbcl --script examples/order/demo.lisp      # sipariş
sbcl --script examples/payments/demo.lisp   # ödeme: uydurma tutar/IBAN, aynı faturayı iki kez ödeme
sbcl --script examples/devops/demo.lisp     # sunucu: staging yerine production, onaydan sonra değişen durum
```

**MCP geçidi** (`impl/lisp/soz-mcp.lisp`) bunu Claude Desktop, Cursor gibi istemcilere kod değiştirmeden
getirir. Okuma araçları doğrudan kullanılır. Değişiklik yapan araçlar modele hiç gösterilmez; model
plan yazar, kullanıcı önizlemeyi kendi istemcisinde (MCP elicitation) onaylar, geçit tam olarak onu
çalıştırır.

**İki uygulama:** Common Lisp referans uygulaması ve bağımlılıksız TypeScript uygulaması
(`impl/ts/`) aynı 143 uyumluluk vakasını geçer.

## soz-guard: modele kod yazdıranlar için

Model çok sekmede hızla kod yazarken işi **söylemeden** yarım bırakır: bir `TODO`, hiçbir şey yapmayan
bir buton, yutulan bir hata, `// ... ekranın kalanı`, gerçek veri yerine `example.com`. Sonra "bitti"
der. [soz-guard](guard/README.md) bir Claude Code kancasıdır: model bitirmeye çalıştığında bu
değişikliklerde yarım iş varsa satır satır gösterir ve bitirmesini ya da bilerek bırakılanı **beyan
etmesini** (`soz-guard: ignore <neden>`) ister. Yarım bırakmak serbest; söylemeden bırakmak değil.

Projede bir kez kurulur (Node 22.6+ ve git gerekir), sonra VS Code dahil her sekmede çalışır:

```sh
node --experimental-strip-types C:/ml/soz/guard/src/cli.ts init
```

Yalnızca değişen satırlara bakar; eski TODO'larla uğraşmaz. Mantık hatasını yakalamaz, onu testler
yakalar.

Ayrıntılar için [README.md](README.md) (İngilizce), dilin tanımı için [SPEC.md](SPEC.md), başka
dillerde yazılacak uygulamalar için [conformance/](conformance/README.md).

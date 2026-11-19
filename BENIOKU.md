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

```sh
sbcl --script examples/order/demo.lisp
```

Ayrıntılar için [README.md](README.md) (İngilizce), dilin tanımı için [SPEC.md](SPEC.md), başka
dillerde yazılacak uygulamalar için [conformance/](conformance/README.md).

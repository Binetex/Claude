# Email-ассеты TheFlow

Картинки для transactional-писем. Лежат в `public/`, поэтому отдаются по прямым
production-URL и не требуют авторизации — почтовые клиенты грузят их анонимно.

| Файл | Публичный URL | Что лежит |
|---|---|---|
| `logo.png` | `https://floremart.com/email-assets/theflow/logo.png` | 320 × 62, PNG с прозрачностью, 6 КБ. Показывается на 160 px — двойной запас под retina |
| `review-hero.jpg` | `https://floremart.com/email-assets/theflow/review-hero.jpg` | 950 × 111, JPEG q72, 35 КБ. Показывается на 600 × 70 |

## Откуда взято

Исходники — с боевого сайта, скачаны в `docs/email-templates/source-assets/`:

- `logo_tf.svg` — `https://theflow.la/wp-content/uploads/2025/06/test4-light.svg`, 1083 × 208
- `banner_tf.jpg` — `https://theflow.la/wp-content/uploads/2025/12/bannerspring.jpg`, 1600 × 899

**Логотип с сайта белый** (вариант «light», под тёмный фон) — на белой карточке письма он
был бы невидим. `logo_tf_dark.svg` это тот же файл с `fill="white"` → `fill="#2b2723"`,
то есть в цвет кнопки и заголовков письма. Менять цвет письма — менять и его.

**SVG в письмо класть нельзя**: Gmail, Outlook и почти все мобильные клиенты его не
показывают. Поэтому логотип растрируется в PNG.

## Пересобрать

Растеризация — через headless Chrome: `rsvg-convert`/ImageMagick на машине нет, а `sips`
не умеет SVG. `--default-background-color=00000000` даёт прозрачный фон.

```bash
cd docs/email-templates/source-assets
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Логотип: 320 × 62 PNG с прозрачностью
sed 's/fill="white"/fill="#2b2723"/g' logo_tf.svg > logo_tf_dark.svg
printf '%s' '<style>html,body{margin:0;background:transparent}img{display:block;width:320px}</style><img src="logo_tf_dark.svg">' > /tmp/logo.html
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --allow-file-access-from-files --screenshot=../../../public/email-assets/theflow/logo.png \
  --window-size=320,62 "file:///tmp/logo.html"
```

Hero — это **полоса, вырезанная из баннера**: окно 950 × 111 по исходнику со смещением
(650, 554), то есть плотная часть букета без пустой стены слева. Пропорция 600 : 70 —
ровно та, в которой полоса показывается в письме.

```bash
printf '%s' '<style>html,body{margin:0}.w{width:950px;height:111px;overflow:hidden;position:relative}.w img{position:absolute;width:1600px;left:-650px;top:-554px}</style><div class="w"><img src="banner_tf.jpg"></div>' > /tmp/hero.html
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --screenshot=/tmp/hero_raw.png --window-size=950,111 "file:///tmp/hero.html"
sips -s format jpeg -s formatOptions 72 /tmp/hero_raw.png \
  --out ../../../public/email-assets/theflow/review-hero.jpg
```

## Что важно

**Ассеты попадают на прод только деплоем.** `public/` отдаётся сборкой Next.js, поэтому
после добавления файлов нужен обычный `./deploy.sh`. Проверить, что всё встало:

```bash
curl -I https://floremart.com/email-assets/theflow/logo.png
```

Ожидается `200` и `content-type: image/png`.

**Полоса на мобильном сжимается вместе с шириной.** Картинка отдаётся как обычный `img`
с `width:100%`, поэтому на экране 390 px высота становится ~43 px вместо 70. Держать
фиксированные 70 px можно только через background-image с VML-подпоркой под Outlook —
ради декоративной полоски это не стоит усложнения. Из того же следует: **в полосу нельзя
класть текст**, он станет нечитаемым.

**Не заменять на внешние ссылки.** Картинки специально скопированы к нам, а не подключены
с `theflow.la`: письмо живёт в почте клиента годами, а на сайте файл переименуют или
перезальют при следующем редизайне.

Шаблон, который на них ссылается: `docs/email-templates/theflow-review-request.html`.
Парный шаблон другого магазина: `public/email-assets/julies-flowers/`.

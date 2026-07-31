# Email-ассеты Julie's Flowers

Картинки для transactional-писем. Лежат в `public/`, поэтому отдаются по прямым
production-URL и не требуют авторизации — почтовые клиенты грузят их анонимно.

| Файл | Публичный URL | Что лежит |
|---|---|---|
| `logo.png` | `https://floremart.com/email-assets/julies-flowers/logo.png` | 320 × 85, PNG с прозрачностью, 14 КБ. Показывается на 160 px — двойной запас под retina |
| `review-hero.jpg` | `https://floremart.com/email-assets/julies-flowers/review-hero.jpg` | 1200 × 800, JPEG q68, 195 КБ. Показывается на 600 px |

Оба получены из оригиналов владельца: `docs/email-templates/source-assets/`
(`logo_jf.png` 1387 × 370 и `review-hero-jf.png` 1536 × 1024). Исходники лежат вне
`public/` намеренно — всё, что в `public/`, раздаётся наружу, и тащить туда лишние
мегабайты незачем.

Пересобрать при необходимости:

```bash
cd public/email-assets/julies-flowers
sips -Z 320 ../../../docs/email-templates/source-assets/logo_jf.png --out logo.png
sips -Z 1200 ../../../docs/email-templates/source-assets/review-hero-jf.png \
     -s format jpeg -s formatOptions 68 --out review-hero.jpg
```

## Что важно

**Ассеты попадают на прод только деплоем.** `public/` отдаётся сборкой Next.js, поэтому
после добавления файлов нужен обычный `./deploy.sh`. Проверить, что всё встало:

```bash
curl -I https://floremart.com/email-assets/julies-flowers/logo.png
```

Ожидается `200` и `content-type: image/png`.

**Вес письма.** Почтовые клиенты обрезают тяжёлые письма (Gmail — около 102 КБ HTML),
но картинки грузятся отдельно и в этот лимит не входят. Тем не менее держите hero
в разумных пределах: на мобильном интернете тяжёлая картинка просто не успеет
загрузиться до того, как письмо прочитают.

**Не заменять на внешние ссылки.** Хостинг у нас нужен для того, чтобы URL не протухал
и не зависел от чужого сервиса: письмо живёт в почте клиента годами.

Шаблон, который на них ссылается: `docs/email-templates/julies-flowers-review-request.html`.

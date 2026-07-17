# Handoff — Floremart

Дата: 2026-07-17. Актуально на коммит `277d3f0` (main, запушен и задеплоен на floremart.com).

---

## 1. Текущее состояние проекта

- **Production**: https://floremart.com — живой, работает. CloudPanel (Nginx reverse proxy + Let's Encrypt SSL) → PM2 (процесс `floremart`, порт 3010) → Next.js → Neon PostgreSQL (отдельный prod-проект).
- **Владелец создан**: `owner@floremart.com` (пароль передан владельцу вне этого документа).
- **В production БД сейчас**: 1 пользователь (владелец). **Флористов и колл-центра — ноль.** Это прямо блокирует нормальную работу назначения заказов (см. раздел 8).
- **Подключён 1 реальный магазин Shopify**: O'hara Florist (dev-магазин, домен `p7mx1v-pz.myshopify.com`), OAuth пройден, токен получен, 4 вебхука зарегистрированы. Через него прошёл один настоящий тестовый заказ — создался корректно, но висит неназначенным (нет флористов).
- **GitHub**: https://github.com/Binetex/Claude, ветка `main`, публичный репозиторий.
- **Локальная разработка**: отдельный dev-проект Neon (с сид-данными на 18 сценариев), путь `/Users/belford/Claude Code/florist-dashboard`.
- **Соседний проект (НЕ в этом git-репозитории)**: `/Users/belford/Claude Code/floremart-shopify-app` — Shopify CLI-проект (`shopify.app.toml`) для приложения "Floremart Sync". Управляется отдельно через `shopify app deploy`, не имеет собственного git — см. раздел 9 и 14.

---

## 2. Что реализовано в этой сессии

Сессия покрыла три больших блока:

**A. Ревизия и укрепление этапа 1** (до деплоя):
- Полный код-ревью с отчётом, все найденные проблемы исправлены.
- Новая функция: переключатель `Florist.financeVisibility` (MAKER_ONLY/FULL) — владелец решает, видит ли конкретный флорист только свою цену или ещё и налог/доставку/чаевые/итог клиента.
- Редактируемые цены товаров под флориста на `/dashboard/products` (было read-only).
- 8 интеграционных тестов (vitest) на ядро назначения/отказа/переназначения/цен.
- `.nvmrc`, `engines`, `postinstall: prisma generate`, `AUTH_SECRET` обязателен в production (fail-fast).
- Обнаружен и исправлен баг `.gitignore` — `.env*` случайно исключал `.env.example` из git.

**B. Production-деплой на CloudPanel/PM2**:
- Рефакторинг маршрутов: всё закрытое приложение переехало под `/dashboard/*`, `/` стал публичным лендингом.
- `ecosystem.config.js`, `deploy.sh`, `.env.production.example`, `DEPLOY.md`, обновлённый `README.md`.
- `/api/health`, feature-флаги интеграций (`src/lib/featureFlags.ts`), `scripts/create-owner.ts` (безопасный CLI).
- Реальный деплой: SSH-ключ, CloudPanel Reverse Proxy сайт, PM2, systemd автозапуск (`pm2-claudecode.service`), первый владелец создан.
- Найден и исправлен баг: демо-креды показывались на production login (теперь скрыты за `NODE_ENV`).

**C. Реальная интеграция Shopify**:
- OAuth-подключение магазина владельцем (`/dashboard/sites` → «Подключить Shopify»).
- Приём и обработка вебхуков заказов (`orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`) с проверкой HMAC-подписи.
- Идемпотентный маппинг заказа Shopify → наша модель, сопоставление товаров, вызов уже готового авто-назначения.
- UI создания пользователей (`/dashboard/users`) с выбором роли (основной/второстепенный флорист, колл-центр).
- Авто-расстановка приоритета флористов для новых сайтов.
- **Три реальных бага найдены и исправлены прямо во время живого тестирования на настоящем магазине** (см. раздел 9) — это нормальная часть работы, не показатель нестабильности.

---

## 3. Изменённые файлы и зачем

Полная история — `git log --oneline`. Ключевые коммиты и что они привнесли:

| Коммит | Файлы/область | Зачем |
|---|---|---|
| `166c9a4` | Всё ядро (auth, rbac, modules/*, app/(owner)\|(florist)\|(callcenter)) | Этап 1: рабочее ядро системы |
| `40353b2` | Перенос `src/app/(owner\|florist\|callcenter)` → `src/app/dashboard/(...)`, новый `src/app/page.tsx`, `ecosystem.config.js`, `deploy.sh`, `DEPLOY.md`, `scripts/create-owner.ts`, `src/lib/featureFlags.ts`, `src/app/api/health/route.ts` | Подготовка к production-деплою, единое приложение под `/dashboard/*` |
| `2e5706e` | `src/app/login/page.tsx` | Убрать демо-креды из production |
| `ed5f14c` | `src/integrations/shopify/{oauth,webhookAuth,ingestOrder}.ts`, `src/app/api/integrations/shopify/oauth/callback/route.ts`, `src/app/api/webhooks/[platform]/route.ts`, `src/app/dashboard/(owner)/sites/ConnectShopifyForm.tsx`, `prisma/schema.prisma` (+`shopifyShopDomain`/`shopifyAccessToken` на `Site`) | Первая версия реальной интеграции Shopify |
| `a61a6fc` | `src/integrations/shopify/oauth.ts` | Фикс: разделитель `state` ломался на точках в домене магазина |
| `1ec7a34` | `src/integrations/shopify/webhooks.ts` (новый), OAuth callback | Явная регистрация вебхуков через GraphQL — декларация в TOML не сработала |
| `9694601` | `src/integrations/shopify/ingestOrder.ts`, `prisma/schema.prisma` (+`@@unique([siteId, externalId])` на `Order`) | Фикс гонки create/updated вебхуков |
| `277d3f0` | `src/app/dashboard/(owner)/users/CreateUserForm.tsx` (новый), `.../users/page.tsx`, `.../actions.ts` (`ownerCreateUser`), `src/modules/assignments/service.ts` (`autoAssignSitePriorities`) | UI создания сотрудников, авто-приоритет флористов для новых сайтов |

---

## 4. Архитектура Shopify-интеграции

```
Владелец (браузер)
  → /dashboard/sites, вводит домен магазина
  → ownerConnectShopify() [server action] строит подписанный state, редиректит
  → Shopify: экран согласия на установку
  → редирект на /api/integrations/shopify/oauth/callback?shop=...&code=...&state=...&hmac=...
       1. verifyCallbackHmac() — проверка подписи query-параметров
       2. verifyOAuthState() — проверка нашего state (CSRF + TTL 10 мин)
       3. exchangeCodeForToken() — POST /admin/oauth/access_token → access_token
       4. GET /admin/api/2026-07/shop.json — красивое имя магазина (не критично)
       5. prisma.site.upsert() — создание/обновление Site (shopifyShopDomain, shopifyAccessToken)
       6. registerOrderWebhooks() — явная регистрация 4 вебхуков через GraphQL
       7. если сайт был только что создан → autoAssignSitePriorities()
  → редирект обратно на /dashboard/sites

Shopify (позже, при заказах)
  → POST /api/webhooks/shopify, заголовки X-Shopify-Hmac-Sha256 / X-Shopify-Shop-Domain / X-Shopify-Topic
       1. verifyWebhookHmac(rawBody, header) — по СЫРОМУ телу, до JSON.parse
       2. ingestShopifyOrder(topic, shopDomain, payload):
          - найти Site по shopifyShopDomain
          - orders/cancelled → updateMany orderStatus=CANCELLED, выход
          - иначе: попытаться СОЗДАТЬ заказ (create-then-catch-conflict, не check-then-create —
            см. раздел 9 про гонку); при конфликте уникальности (siteId, externalId) — упасть
            на безопасное обновление (только paymentStatus/orderStatus, НЕ трогать
            cardMessage/customerNote/адрес)
          - при создании: сопоставить line_items с нашими Product по externalId
            (variant_id/product_id), смаппить открытку/дату доставки из note_attributes
            (эвристика по regex на имя атрибута)
          - если оплачен → assignInitial(order.id) [существующая, не изменённая логика]
       3. ответ 200 всегда (даже при внутренней ошибке маппинга — иначе Shopify зациклит ретраи;
          ошибка логируется в PM2 логи)
```

**Модель приложения в Shopify**: "Floremart Sync", создано через Dev Dashboard (dev.shopify.com), **Custom Distribution** (не публикуется в App Store, устанавливается только в конкретные магазины по прямой ссылке/OAuth). `embedded = false` — у приложения нет собственного UI внутри админки Shopify, только API+вебхуки.

**Важное открытие**: декларация `[[webhooks.subscriptions]]` в `shopify.app.toml` **не подписывает вебхуки автоматически** при установке — проверено вживую (после первого успешного install `webhookSubscriptions` был пуст). Поэтому регистрация сделана явно через GraphQL-мутацию `webhookSubscriptionCreate` в нашем коде, идемпотентно (пропускает уже зарегистрированные темы).

---

## 5. Environment variables (только имена, без значений)

### Обязательные всегда
| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | Строка подключения к PostgreSQL (Neon) |
| `AUTH_SECRET` | Секрет подписи сессий. Обязателен в production (fail-fast без него) |
| `NODE_ENV` | `development` / `production` |

### Production-специфичные
| Переменная | Назначение |
|---|---|
| `PORT` | Локальный порт для `next start` (Nginx проксирует на него) |
| `APP_URL` | Публичный базовый URL (по умолчанию `https://floremart.com`); должен побайтово совпадать с `redirect_uri`, зарегистрированным в `shopify.app.toml` |

### Feature-флаги интеграций
| Переменная | Статус |
|---|---|
| `SHOPIFY_ENABLED` | Реализовано и включено на floremart.com |
| `WOOCOMMERCE_ENABLED` | Каркас, не реализовано — держать `false` |
| `QUO_ENABLED` | Не реализовано — держать `false` |
| `BURQ_ENABLED` | Не реализовано — держать `false` |
| `EMAIL_ENABLED` | Не реализовано — держать `false` |
| `TELEGRAM_ENABLED` | Не реализовано — держать `false` |

### Shopify
| Переменная | Назначение |
|---|---|
| `SHOPIFY_CLIENT_ID` | Из Shopify Dev Dashboard приложения "Floremart Sync" → Settings → Credentials. Один на все подключаемые магазины |
| `SHOPIFY_CLIENT_SECRET` | Оттуда же. Используется и для OAuth, и для проверки HMAC вебхуков (это один и тот же секрет) |

### Только для разового использования (не хранится в `.env`)
| Переменная | Назначение |
|---|---|
| `OWNER_PASSWORD` | Передаётся один раз в момент вызова `npm run create-owner`, нигде не сохраняется |

Полные шаблоны — [.env.example](../.env.example) (dev) и [.env.production.example](../.env.production.example) (prod).

---

## 6. Используемые API: endpoints и scopes

### Shopify — исходящие вызовы (наш сервер → Shopify)

| Метод/URL | Тип | Назначение |
|---|---|---|
| `GET https://{shop}/admin/oauth/authorize` | OAuth (браузер владельца) | Экран согласия на установку |
| `POST https://{shop}/admin/oauth/access_token` | REST | Обмен `code` → `access_token` |
| `GET https://{shop}/admin/api/2026-07/shop.json` | REST | Имя магазина (косметика) |
| `POST https://{shop}/admin/api/2026-07/graphql.json` | GraphQL | Запрос `webhookSubscriptions`, `currentAppInstallation`; мутация `webhookSubscriptionCreate` |

**Scopes** (заданы в `shopify.app.toml` и в `oauth.ts::REQUIRED_SCOPES`): `read_orders`, `write_orders`.
`write_orders` пока фактически не используется (нет `pushUpdate`), запрошен заранее под будущую обратную запись.

**Webhook-топики**, зарегистрированные на подключённый магазин: `ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_PAID`, `ORDERS_CANCELLED` → все на один callback `https://floremart.com/api/webhooks/shopify`.

### Наши endpoints (Shopify/владелец → наш сервер)

| Метод/URL | Auth | Назначение |
|---|---|---|
| `GET /api/health` | Нет | Health-check для PM2/Nginx/мониторинга |
| `GET /api/integrations/shopify/oauth/callback` | Сессия OWNER + HMAC+state от Shopify | Завершение OAuth |
| `POST /api/webhooks/[platform]` (`platform=shopify\|woocommerce`) | HMAC от Shopify (для shopify); woocommerce — нет проверки, каркас | Приём заказов |

---

## 7. Что протестировано и работает

- **Ядро (не менялось в этой сессии, но перепроверено)**: авторизация, RBAC (владелец/флорист/колл-центр), скрытие финансов, снимок цены при назначении, отказ/переназначение — 8 vitest-тестов, все проходят.
- **Production-инфраструктура**: HTTPS/SSL через CloudPanel, Nginx reverse proxy → PM2 → Next.js, health-check, вход, RBAC-редиректы, secure/httpOnly cookies, доступ к чужому заказу по прямому URL → 404 — всё проверено вживую на floremart.com.
- **Shopify OAuth**: полный цикл подключения магазина проверен вживую на O'hara Florist (после исправления бага с `state`).
- **Регистрация вебхуков**: подтверждена через GraphQL-запрос `webhookSubscriptions` — все 4 темы видны с правильным `callbackUrl`.
- **Проверка HMAC вебхука**: валидная подпись принимается, невалидная отклоняется 401 — проверено локально сфабрикованными запросами.
- **Маппинг заказа**: локально протестирован с реалистичным payload — открытка/заметка/дата доставки/адрес/суммы маппятся верно.
- **Сопоставление товаров и авто-цена**: протестировано — при совпадении `externalId` цена флориста подставляется и назначение проходит.
- **Идемпотентность/гонка**: протестировано отправкой `orders/create` и `orders/updated` **одновременно** на один и тот же заказ — создаётся ровно один заказ, без ошибок.
- **Реальный заказ**: один настоящий тестовый заказ с O'hara Florist прошёл весь путь end-to-end (создался, оплата распознана) — не хватило только автоназначения флориста, т.к. в проде их ещё нет.
- **Создание пользователей**: транзакционная логика (User + опционально Florist) протестирована локально, роль/financeVisibility проставляются верно.
- **Авто-приоритет флористов**: протестирован, включая идемпотентность (повторный вызов не дублирует), и **отдельно перепроверен после найденного и исправленного бага сортировки**.

---

## 8. Что не работает / требует доработки

**Блокирует нормальную работу прямо сейчас:**
- В production **нет ни одного флориста/колл-центра** — только владелец. Нужно зайти на `/dashboard/users` и создать хотя бы одного флориста, иначе новые заказы Shopify продолжат попадать в «Требует назначения».
- Тестовый заказ O'hara Florist (`orderNumber: O'HARA FLORIST-1058`) висит неназначенным — после создания хотя бы одного флориста нужно либо вручную переназначить его через UI («Переназначить» на странице заказа), либо запустить `autoAssignSitePriorities` для этого сайта задним числом (не сделано автоматически — функция применяется только к НОВЫМ сайтам).

**Функциональные пробелы:**
- Нет UI для ручного редактирования приоритета флористов по сайту (есть только авто-расстановка при создании сайта).
- Нет UI для создания/редактирования `Site` вручную — сайты появляются только через Shopify OAuth-подключение.
- `pushUpdate` (запись изменений из дашборда обратно в Shopify — например, статус/дата доставки) не реализована.
- Нет синхронизации каталога товаров из Shopify — `Product`/`FloristProductPrice` заводятся владельцем вручную; если `externalId` не совпадает с `variant_id`/`product_id` заказа, цена флориста будет $0.
- WooCommerce, Telegram, Quo (SMS/email), Burq (доставка) — только заглушки за feature-флагами.
- Нет фоновой очереди (BullMQ/Redis) — `src/lib/jobs.ts` только логирует. Обработка вебхука Shopify происходит **синхронно прямо в HTTP-хендлере** (сознательное отступление от исходного плана «вебхук только принимает, тяжёлая работа в фоне» — безопасно при текущей нагрузке, см. CLAUDE.md п.11).
- Нет периодического добора пропущенных вебхуков (если Shopify не смог доставить вебхук после ретраев).
- Нет UI редактирования/деактивации/смены пароля пользователей — только создание.
- `pm2 startup` настроен (systemd юнит `pm2-claudecode.service`, `enabled`), но **не проверен реальной перезагрузкой сервера**.

---

## 9. Известные баги и ограничения

### Исправленные в этой сессии (для истории — если симптомы вернутся, смотреть сюда)
1. **`.gitignore` исключал `.env.example`** — паттерн `.env*` был слишком широким. Исправлено на точные имена.
2. **Демо-креды на production login** — блок с `owner@demo.local` рендерился независимо от окружения. Исправлено — скрыт за `NODE_ENV !== "production"`.
3. **OAuth `state` ломался на доменах с точками** — `createOAuthState`/`verifyOAuthState` использовали `.` одновременно как разделитель полей и как часть самого домена магазина (`o-hara-florist.myshopify.com`). Исправлено — разделитель `|`.
4. **Вебхуки не регистрировались автоматически** — декларация в `shopify.app.toml` не сработала на практике (подтверждено вживую). Исправлено — явная регистрация через GraphQL в OAuth callback.
5. **Гонка `orders/create`/`orders/updated`** — Shopify иногда шлёт оба вебхука почти одновременно, `check-then-create` не атомарен, второй запрос падал на `UNIQUE (orderNumber)`. Исправлено — `create-then-catch-conflict` + явный `@@unique([siteId, externalId])`.
6. **Сортировка флористов по enum в БД** — `orderBy: { financeVisibility: "asc" }` сортирует по порядку ОБЪЯВЛЕНИЯ enum в schema.prisma (`MAKER_ONLY` объявлен первым), а не по алфавиту — второстепенный флорист чуть не оказался приоритетнее основного. Исправлено — явная сортировка в коде.

### Текущие ограничения (не баги, осознанные компромиссы)
- **Эвристика маппинга открытки/даты доставки** (`src/integrations/shopify/ingestOrder.ts`, `findNoteAttribute`) ищет `note_attributes` по regex на ИМЯ атрибута (`/card|gift.?message/i`, `/delivery.*date/i`, `/delivery.*(time|window)/i`). Это завязано на то, как конкретная тема/чекаут магазина называет свои поля — для другого магазина с другими названиями полей регэкспы может понадобиться скорректировать.
- **Синхронная обработка вебхука** (см. раздел 8) — при большом объёме заказов может понадобиться реальная очередь раньше, чем планировалось.
- **`floremart-shopify-app` не в git** — это отдельная директория рядом с репозиторием, только на локальной машине разработчика. Если её потерять, `shopify.app.toml` и связь через `shopify app config link` придётся воссоздавать заново (сам конфиг не секретный, но неудобство есть). См. раздел 14.

---

## 10. Следующие задачи (по приоритету)

1. **[Владелец, вручную]** Создать хотя бы одного флориста через `/dashboard/users`.
2. Разобраться с зависшим заказом O'hara Florist (переназначить вручную или применить `autoAssignSitePriorities` задним числом).
3. UI редактирования приоритета флористов по сайту (сейчас только авто при создании).
4. UI создания/редактирования `Site` вручную (не только через Shopify OAuth).
5. `pushUpdate` — обратная запись статуса/даты доставки в Shopify.
6. Синхронизация каталога товаров из Shopify (авто-создание `Product` по `variant_id`/`product_id`).
7. Реальная фоновая очередь (BullMQ/Redis) вместо синхронной обработки вебхука.
8. Периодический добор пропущенных заказов (на случай недоставленных вебхуков).
9. WooCommerce — реальная интеграция (по аналогии с Shopify).
10. Telegram-уведомления флористам.
11. Quo (SMS/email) и Burq (доставка).
12. UI редактирования/деактивации пользователей, смена пароля.
13. Перенести `floremart-shopify-app` под контроль версий.
14. Проверить `pm2 startup` реальной перезагрузкой сервера (с согласия владельца — см. раздел 14).

Полный чек-лист — [TODO.md](../TODO.md).

---

## 11. Команды: локальный запуск, деплой, проверка

### Локальная разработка
```bash
nvm use                      # подхватит версию из .nvmrc (24)
npm install                  # зависимости + автогенерация клиента Prisma
cp .env.example .env         # заполнить DATABASE_URL (dev-проект Neon!) и AUTH_SECRET
npm run db:migrate           # применить миграции
npm run db:seed              # тестовые данные (18 сценариев) — ТОЛЬКО для dev
npm run dev                  # http://localhost:3000
```

### Проверки (гонять перед любым коммитом)
```bash
npm run typecheck            # tsc --noEmit
npm run lint                 # ESLint
npm test                     # vitest — интеграционные тесты, пишут/чистят свою БД
npm run build                # production-сборка (ловит больше, чем dev)
```

### Production-деплой (см. полную инструкцию — [DEPLOY.md](../DEPLOY.md))
```bash
# На сервере, в директории сайта:
./deploy.sh                  # git fetch/reset → npm ci → prisma migrate deploy → build → pm2 reload
```
Обновление production — тем же `./deploy.sh` после `git push` из dev-окружения.

### Первый владелец / доступ на сервер
```bash
npm run create-owner         # интерактивный CLI, скрытый ввод пароля, отказывает если owner уже есть
ssh -i ~/.ssh/floremart_deploy claudecode@74.214.175.249   # доступ на прод-сервер (ключ только у разработчика)
```

### Shopify CLI-проект (`../floremart-shopify-app`, отдельно от этого репо)
```bash
cd ../floremart-shopify-app
shopify app deploy --allow-updates   # задеплоить изменения shopify.app.toml
```

---

## 12. Миграции, cron, вебхуки, PM2, сервисы

### Миграции (`prisma/migrations/`, по порядку)
1. `20260716205003_init` — вся исходная схема этапа 1.
2. `20260716211830_florist_finance_visibility` — `FloristFinanceVisibility` enum + поле на `Florist`.
3. `20260717091733_shopify_site_credentials` — `shopifyShopDomain`/`shopifyAccessToken` на `Site`.
4. `20260717095351_order_site_external_id_unique` — `@@unique([siteId, externalId])` на `Order` (защита от гонки вебхуков).

Применяются **только** через `prisma migrate deploy` (в `deploy.sh`). Никогда `db push`/`migrate reset` — см. раздел 14.

### Cron
Нет ни одной cron-задачи. Периодический добор пропущенных заказов не реализован (см. раздел 10, п.8).

### Webhooks
- **Входящие** (Shopify → нас): 4 подписки (`ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_PAID`, `ORDERS_CANCELLED`) на `https://floremart.com/api/webhooks/shopify`, зарегистрированы через GraphQL при OAuth-подключении каждого магазина (не глобально — per-магазин).
- Endpoint также принимает `platform=woocommerce`, но это каркас без реальной обработки.

### PM2
- Один процесс: `floremart` (`ecosystem.config.js`), пользователь `claudecode`, порт 3010, `interpreter: process.execPath` (фикс для nvm-окружений).
- `pm2_home = /home/claudecode/.pm2` — изолирован от других сайтов на том же сервере.
- systemd-автозапуск: `pm2-claudecode.service` (`enabled`, не протестирован реальной перезагрузкой).

### Прочие сервисы
- **Neon PostgreSQL** — две отдельные базы (dev и prod), никакого Postgres на самом VPS.
- **CloudPanel** — Nginx reverse proxy + Let's Encrypt для домена floremart.com; управляет только этим сайтом, других сайтов на сервере не касается.
- Node.js 24 доступен на сервере через `nvm`, принадлежащий пользователю `floremart` (не `claudecode`) — `claudecode` пользуется им через членство в группе `floremart`.

---

## 13. Архитектурные решения и почему

- **Модульный монолит, не микросервисы** — один Next.js-проект, интеграции изолированы адаптерами (`src/integrations/*`). Проще эксплуатировать на одном VPS, соответствует масштабу задачи.
- **`/dashboard/*` вместо отдельного поддомена** — явное требование: одно приложение, `/` — публичный лендинг, вся приватная часть под одним префиксом.
- **Отдельные Neon-проекты для dev и prod** — исходно предлагалось делить одну БД, но `prisma/seed.ts` полностью очищает все таблицы перед заливкой демо-данных; общая база означала риск случайно стереть боевые заказы локальным `db:seed`. Решение принято осознанно после явного предупреждения.
- **CloudPanel Reverse Proxy + свой PM2**, а не встроенное управление Node в CloudPanel — даёт полный контроль над процессом (interpreter, env, логи) независимо от того, как панель видит остальные сайты на сервере.
- **Custom Distribution Shopify-приложение**, не публичное — соответствует модели «владелец сам подключает свои магазины», не требует ревью Shopify App Store.
- **Явная регистрация вебхуков через GraphQL** вместо декларации в `shopify.app.toml` — вынужденное решение, задокументированный факт не сработал на практике (см. раздел 9).
- **`create-then-catch-conflict` вместо `check-then-create`** для идемпотентности заказов — единственный по-настоящему атомарный способ при конкурентных вебхуках; проверка-потом-запись всегда рейсится в многопроцессном/многопоточном приёме HTTP.
- **Синхронная обработка вебхука** вместо очереди — прагматичный выбор для текущего объёма (единицы запросов в секунду), `jobs.ts` пока не более чем логгер. Явно помечено как технический долг в CLAUDE.md, не выдаётся за «сделано по плану».
- **Случайно сгенерированный пароль при создании пользователя**, а не выбор владельцем — исключает слабые пароли и не заставляет владельца печатать чужой будущий пароль в форму (которая может попасть в историю браузера/автозаполнение).
- **Нет синхронизации каталога товаров из Shopify** — оставлено ручное управление `Product`/`FloristProductPrice` владельцем, как в исходном ТЗ; авто-синхронизация каталога не запрашивалась и добавляет объём (webhook на product/update, маппинг вариантов и т.д.) — сознательно не делалось без отдельного запроса.
- **Авто-приоритет флористов сортирует в коде, не через `orderBy` по enum** — после найденного бага (раздел 9, п.6) сделано намеренно явным, чтобы порядок не зависел от того, в каком порядке кто-то однажды объявил значения enum в схеме.

---

## 14. Что нельзя менять без отдельного анализа

- **RBAC и ролевые сериализаторы** (`serializeForOwner`/`serializeForCallCenter`/`serializeForFlorist`, `src/modules/orders/serialize.ts`) — это граница безопасности системы. Флорист/колл-центр не должны получать финансовые поля **на уровне сервера**, не только в вёрстке. Любое изменение здесь требует повторной проверки того, что скрытые поля физически отсутствуют в ответе (не просто не отображаются).
- **`cardMessage`/`customerNote`** — никогда не перезаписывать автоматически при синхронизации (правило из исходного ТЗ, закреплено в коде: обновление существующего заказа при повторном вебхуке НЕ трогает эти поля).
- **Снимок цены флориста** (`floristTotal`, `floristItemPrice`) — фиксируется в момент назначения. Изменение прайс-листа никогда не должно задним числом менять уже размещённые заказы.
- **Только `prisma migrate deploy` в production.** Никогда `prisma db push` или `prisma migrate reset` — необратимо для боевых данных.
- **`@@unique([siteId, externalId])` на `Order`** — не убирать, это единственная защита от дублей при гонке вебхуков (раздел 9, п.5).
- **Другие сайты/сервисы на VPS ServerOptima** — никогда не трогать глобальный Nginx/PHP/CloudPanel-конфиг, чужие Virtual Host'ы, чужие PM2-процессы, чужие базы данных, чужие SSL-сертификаты без отдельного явного подтверждения от владельца сервера на каждое такое действие.
- **`pm2 startup`/systemd** — уже настроено; менять или повторно запускать эту команду не нужно без причины (может создать дублирующие юниты).
- **`floremart-shopify-app` вне git** — если кто-то решит перенести его под контроль версий или пересоздать, учтите, что `client_id`/redirect/scopes там должны остаться синхронизированы с `SHOPIFY_CLIENT_ID`/`APP_URL` в `.env` на сервере — рассинхрон сломает OAuth молча (Shopify отклонит `redirect_uri`, не совпадающий побайтово).
- **Секреты** (`AUTH_SECRET`, `SHOPIFY_CLIENT_SECRET`, `DATABASE_URL` с паролем) уже несколько раз попадали в текст диалога в процессе разработки (при вставке пользователем/при отладке) — это исторический факт, не текущая уязвимость кода, но если параноидально подходить к ротации — эти секреты стоит считать потенциально просвеченными и при желании сменить.

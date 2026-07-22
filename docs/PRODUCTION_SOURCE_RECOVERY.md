# Production Source Recovery — Floremart

Отчёт о безопасном восстановлении актуального исходного кода Floremart напрямую
с production-сервера. Копия сделана **read-only**: ничего на production не менялось,
deploy/PM2/миграции/БД не затрагивались.

## 1. Когда сделана копия

- Дата/время (локально): **2026-07-17 23:39** (тег каталога `20260717-2339`).
- Каталог новой копии: `floremart-from-production-20260717-2339/`.
- Резервная копия прежней локальной папки: `floremart-local-backup-20260717-2339/`
  (полная, 43 648 файлов = точная копия исходной `florist-dashboard/`; исходная папка
  не перемещалась и не изменялась).

## 2. С какого сервера и пути

| Параметр | Значение |
|---|---|
| SSH | `claudecode@74.214.175.249` (hostname `flowers`), ключ `~/.ssh/floremart_deploy` |
| Production путь | `/home/claudecode/htdocs/floremart.com` → realpath `/home/floremart/htdocs/floremart.com` |
| PM2 process | `floremart` (id 0, online, порт 3010) — **не перезапускался** |
| Направление копирования | `production → local` (rsync pull). Направление `local → production` не использовалось. |

Проверено, что production-путь относится **только** к floremart.com.

## 3. Какие файлы исключены

Скопирован только исходный код. Через `rsync` (без `--delete`) исключены:

- `.env`, `.env.*`, любые `.env*` (реальные секреты **не копировались**);
- `node_modules/`, `.next/`, `.git/` (историю Git намеренно **не** копировали — восстановим отдельно);
- `logs/`, `*.log`;
- `public/uploads/` (пользовательские загрузки; на проде там только `.gitkeep`);
- `.DS_Store`, `*.tsbuildinfo`, `.deploy-fast.deps.hash`;
- потенциальные секреты/сертификаты: `*.pem *.key *.crt *.cert *.pfx *.p12 *.keystore id_rsa*`;
- потенциальные дампы БД: `*.sql.gz *.dump *.dump.gz dumps/ backups/`, а также кэш/temp.

**Важная поправка:** первичный прогон дополнительно исключал `*.sql`, из-за чего не скопировались
Prisma-миграции `prisma/migrations/*/migration.sql` (это исходный код, а не дампы). Проверено, что
единственные `.sql` в репозитории — 10 легитимных `migration.sql`; настоящих дампов БД в репозитории нет.
Каталог `prisma/migrations/` до-качан отдельно **без** `*.sql`-исключения. Все 10 миграций на месте.

`.git` с production **не копировался**.

## 4. Результаты diff (read-only, production-копия vs текущая локальная папка)

Сравнение с исключением артефактов (`node_modules`, `.next`, `.git`, `logs`, `.env*`,
`public/uploads`, `.DS_Store`, `*.tsbuildinfo`):

- только на production-копии: **0**
- отличаются по содержимому: **0**
- только локально: **10** — и все они являются исключёнными артефактами/секретами
  (`.env`, `.env.example`, `.env.production.example`, `.git`, `.next`, `logs`,
  `node_modules`, `public/uploads`, `.DS_Store`, `tsconfig.tsbuildinfo`).

**Вывод:** исходный код production и текущей локальной папки **идентичен** (0 расхождений в коде).
Ничего не объединялось автоматически. Prisma `schema.prisma` совпадает с production побайтово
(SHA-256 `11914c3c50e358de14551b78d4fb7d42c4255f5561428d3b93a290a4de9939da`).

## 5. Результаты build (в новой копии, без production-БД)

Окружение: Node **v24.18.0** (nvm, совпадает с production и `.nvmrc`), npm 11.16.0.

| Шаг | Результат |
|---|---|
| `npm ci` (lockfileVersion 3, совпадает с прод) | ✅ 556 пакетов, exit 0 |
| `npx prisma generate` | ✅ Prisma Client 7.8.0 → `src/generated/prisma` |
| `npm run typecheck` (`tsc --noEmit`) | ✅ без ошибок |
| `npm run build` (`next build`, Next.js 16.2.10) | ✅ Compiled successfully, 18 маршрутов, BUILD_ID `lzC5oTyhhDiRFTZuV_nNn` |

`npm audit`: 5 moderate-уязвимостей (не исправлялись — вне задачи).

## 6. Известные ограничения

- **Env-переменные.** Реальный production `.env` не копировался. Для `next build` использованы
  **временные фейковые placeholder-значения** (`DATABASE_URL`, `AUTH_SECRET`, `SHOPIFY_CLIENT_ID/SECRET`),
  переданные только через переменные окружения текущей shell-сессии и **не записанные на диск**.
- Без реальных секретов **нельзя** проверить: подключение к БД, реальные Prisma-запросы/миграции на данных,
  Shopify OAuth/webhook HMAC, вход/сессии (подпись `AUTH_SECRET`). Их корректность здесь не верифицирована.
- Шаблоны `.env.example` / `.env.production.example` в копию не попали (под правилом `.env*`).
  Это документация без секретов; при необходимости их можно скопировать отдельно.
- Пользовательские загрузки (`public/uploads/`) намеренно не копировались.
- История Git с production не восстановлена (копировался только код). Восстановление истории — отдельный шаг.

## 7. Почему эта копия — новая базовая версия

- Production на floremart.com — единственный достоверный источник актуального кода;
  GitHub устарел, состоянию прежней локальной папки доверять было нельзя.
- Эта копия получена напрямую с production в read-only режиме, в **отдельном** каталоге
  (исходная локальная папка не тронута, есть её полный бэкап).
- Код побайтово соответствует production (diff = 0 расхождений), собирается и проходит typecheck.
- В копии инициализирован **новый локальный** Git-репозиторий, без origin:
  - `main` → коммит `chore: snapshot current production source` (чистый снимок прод-кода);
  - рабочая ветка `refactor/agent-architecture-foundation`.

Поэтому этот каталог принимается за новую базовую версию для дальнейшей работы.

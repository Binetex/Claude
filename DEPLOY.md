# Деплой Floremart на CloudPanel (ServerOptima VPS)

## Два режима деплоя

1) **./deploy-fast.sh — БЫСТРЫЙ (по умолчанию для solo-разработки).**
   Текущая локальная рабочая папка → production напрямую через `rsync --delete`, без GitHub
   и без git. Для быстрых итераций. Не применяет миграции автоматически: при неприменённых
   миграциях останавливается и просит подтверждения. Сборка безопасная (старый `.next`
   сохраняется в `.next.previous` и возвращается, если build упал). Защищённые пути на сервере
   (`.env`, `.env.*`, `node_modules`, `public/uploads`, файлы других сайтов) исключены из rsync
   и `--delete` их не трогает.

2) **./deploy.sh — СТАБИЛЬНЫЙ (из GitHub).**
   `git reset --hard origin/main` → `npm ci` → `prisma migrate deploy` → build → `pm2 reload`.
   Для выката проверенной версии из GitHub.

> ⚠️ После `./deploy-fast.sh` production ОПЕРЕЖАЕТ GitHub. НЕ запускай `./deploy.sh`, пока
> локальные изменения не запушены в GitHub — иначе `git reset --hard origin/main` откатит
> сервер к старой версии и потеряет быстрый деплой.

## 0. Шпаргалка (быстрый доступ, проверено вживую 2026-07-17)

```bash
# Подключение
ssh -i ~/.ssh/floremart_deploy claudecode@74.214.175.249

# Директория сайта (симлинк на /home/floremart/htdocs, но заходить через этот путь)
cd /home/claudecode/htdocs/floremart.com

# node/pm2 НЕ в PATH пользователя claudecode — они принадлежат пользователю floremart,
# claudecode имеет доступ только через членство в группе floremart. Перед npm/pm2/deploy.sh:
export PATH=/home/floremart/.nvm/versions/node/v24.18.0/bin:$PATH

# Обновление (обычный путь)
./deploy.sh

# Проверка после деплоя
curl -s https://floremart.com/api/health   # {"status":"ok","db":"ok"}
```

Всё одной строкой (готово для копирования):
```bash
ssh -i ~/.ssh/floremart_deploy claudecode@74.214.175.249 \
  "export PATH=/home/floremart/.nvm/versions/node/v24.18.0/bin:\$PATH && cd /home/claudecode/htdocs/floremart.com && ./deploy.sh"
```

Production-архитектура:

```
Браузер (HTTPS)
  → Nginx (управляется CloudPanel, свой vhost + свой SSL-сертификат для floremart.com)
    → 127.0.0.1:3010 (только localhost, наружу не торчит)
      → PM2 → next start (Node.js процесс)
        → Neon PostgreSQL (внешняя управляемая БД, на VPS ничего не ставим)
```

Работаем **только** с сайтом floremart.com: отдельный system-пользователь CloudPanel,
отдельный vhost, отдельный PM2-процесс, отдельный `.env`. Другие сайты на сервере не трогаем.

**Neon: отдельный production-проект**, не тот, что использовался в разработке — в текущем
dev-проекте есть демо-данные (сид), их не должно быть в production. Создайте новый проект
на neon.tech перед первым деплоем и используйте его connection string в `DATABASE_URL`.

---

## 1. Production environment variables

Файл `.env` в директории сайта (НЕ в git). Шаблон — [.env.production.example](./.env.production.example).

| Переменная | Назначение | Пример |
|---|---|---|
| `DATABASE_URL` | Строка подключения к Neon Postgres (рекомендуется отдельный prod-проект в Neon) | `postgresql://user:pass@ep-....neon.tech/db?sslmode=require` |
| `AUTH_SECRET` | Секрет подписи сессий. Обязателен — процесс не стартует без него в production | 64-символьный hex, см. команду ниже |
| `NODE_ENV` | Режим | `production` |
| `PORT` | Локальный порт, на который PM2 поднимает Next.js (Nginx проксирует на него) | `3010` — **проверьте, что порт свободен на сервере** |
| `SHOPIFY_ENABLED` | Feature-флаг интеграции (реализована) | `true` на floremart.com |
| `SHOPIFY_CLIENT_ID` | Из Shopify Dev Dashboard приложения "Floremart Sync" → Settings → Credentials | — |
| `SHOPIFY_CLIENT_SECRET` | Оттуда же. Общий на все подключаемые магазины, не хранится per-сайт | — |
| `APP_URL` | Публичный базовый URL — должен совпадать с `redirect_uri` в `shopify.app.toml` | `https://floremart.com` (значение по умолчанию, можно не задавать) |
| `WOOCOMMERCE_ENABLED` | Feature-флаг интеграции (каркас, не реализована) | `false` |
| `QUO_ENABLED` | Feature-флаг интеграции (SMS, не реализована) | `false` |
| `BURQ_ENABLED` | Feature-флаг интеграции (доставка, не реализована) | `false` |
| `EMAIL_ENABLED` | Feature-флаг интеграции (email, не реализована) | `false` |
| `TELEGRAM_ENABLED` | Feature-флаг интеграции (уведомления, не реализована) | `false` |

Сгенерировать `AUTH_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 2. Что требуется на сервере (проверить один раз)

Это единственный раздел, где могут понадобиться действия, выходящие за пределы сайта
floremart.com (глобальный npm-пакет, systemd). Ничего из этого **не изменяет** конфигурацию
других сайтов, но затрагивает сервер в целом — выполняйте осознанно.

```bash
node -v        # нужно ≥ 20.9 (в идеале 24, как в .nvmrc)
pm2 -v         # если команда не найдена — см. ниже
git --version
```

**Если `pm2` не установлен** — это единственный по-настоящему глобальный шаг:
```bash
sudo npm install -g pm2
pm2 startup    # выведет команду для автозапуска PM2 при перезагрузке сервера — выполнить её
```
`pm2 startup` создаёт systemd-юнит для PM2 (не для конкретного сайта). Если на сервере уже
есть PM2 с другими процессами — **пропустите этот шаг полностью**, ничего переустанавливать
не нужно, наш процесс просто добавится в тот же PM2-демон под своим именем `floremart`.

---

## 3. Первый деплой

### 3.1. Создать сайт в CloudPanel (UI)

1. CloudPanel → **Sites** → **Add Site** → тип **Reverse Proxy** (не PHP/статика).
2. Domain: `floremart.com` (+ добавить `www.floremart.com` как алиас, если нужно).
3. Reverse Proxy target: `http://127.0.0.1:3010` — этот порт совпадает с `PORT` из `.env`.
4. Создать сайт — CloudPanel создаст отдельного system-пользователя и директорию
   `/home/claudecode/htdocs/floremart.com`.
5. Вкладка **SSL/TLS** → **New Let's Encrypt Certificate** — выпустить сертификат
   на `floremart.com` (независимо от сертификатов других сайтов).

### 3.2. Развернуть код на сервере

```bash
# Под пользователем сайта (не root), в директории сайта:
cd /home/claudecode/htdocs/floremart.com

git clone https://github.com/Binetex/Claude.git .
# при первом клоне git спросит логин/PAT-токен — ввести свои

cp .env.production.example .env
nano .env    # заполнить DATABASE_URL и AUTH_SECRET реальными значениями

npm install                    # тянет зависимости, postinstall сам вызовет prisma generate
npx prisma migrate deploy      # применяет миграции к ПУСТОЙ prod-базе (только migrate deploy!)
npm run build

mkdir -p logs
pm2 start ecosystem.config.js
pm2 save                       # чтобы процесс пережил перезапуск сервера
```

Либо тем же самым занимается `./deploy.sh --first-run` после `git clone` и заполнения `.env`.

### 3.3. Создать первого владельца

```bash
OWNER_PASSWORD='придумайте-сложный-пароль' \
  npm run create-owner -- --email owner@floremart.com --name "Имя Владельца" --yes
```
Без `OWNER_PASSWORD`/`--yes` команда запросит email/имя/пароль интерактивно, ввод пароля
скрыт. Повторный запуск откажет («владелец уже существует»), пока не передан `--force`.

### 3.4. Проверить

```bash
curl -s http://127.0.0.1:3010/api/health    # {"status":"ok","db":"ok"}
curl -sI https://floremart.com/api/health   # 200 через Nginx/SSL
```
Откройте `https://floremart.com/login` в браузере, войдите под созданным владельцем.

---

## 4. Обновление приложения

```bash
cd /home/claudecode/htdocs/floremart.com
./deploy.sh
```
Делает: `git fetch/reset` → `npm ci` → `prisma migrate deploy` → `next build` → `pm2 reload`
(reload — без даунтайма, старый процесс отдаёт текущие запросы, пока новый поднимается).

Вручную по шагам, если нужен контроль на каждом этапе:
```bash
git fetch origin main && git reset --hard origin/main
npm ci
npx prisma migrate deploy
npm run build
pm2 reload ecosystem.config.js
```

---

## 5. Откат на предыдущую версию

Prisma-миграции **необратимы штатными средствами** (никаких `migrate reset`/`db push` —
это ваше явное требование). Поэтому откат кода и откат схемы БД — разные операции:

**Откат кода** (если новый релиз не менял схему БД, самый частый случай):
```bash
cd /home/claudecode/htdocs/floremart.com
git log --oneline -10              # найти хеш предыдущего рабочего коммита
git reset --hard <предыдущий-коммит-хеш>
npm ci
npm run build
pm2 reload ecosystem.config.js
```

**Если релиз добавлял новую миграцию БД** — откат кода до неё вызовет рассинхрон (старый
код + новая схема). Варианты, от самого безопасного:
1. Написать и применить новую forward-миграцию, отменяющую изменения (`prisma migrate dev`
   локально → закоммитить → `migrate deploy` на сервере). Это единственный способ,
   согласованный с правилом «только Prisma Migrations».
2. Восстановить БД из бэкапа (раздел 6) на момент до миграции — используется только при
   реальной аварии, приводит к потере данных, созданных после бэкапа.

---

## 6. Резервное копирование базы (Neon)

**Рекомендуемый способ — встроенное в Neon:** в консоли Neon (neon.tech) → ваш проект →
**Branches** → **Create branch** от нужной точки времени (Neon хранит историю изменений
и позволяет создать ветку/снапшот без какой-либо настройки на сервере). Это самый быстрый
и надёжный бэкап — доступен всегда, без установки инструментов.

**Альтернатива — файловый дамп** (если нужен offline-бэкап), выполнять с локальной машины
или с сервера, если там есть `pg_dump`:
```bash
pg_dump "$DATABASE_URL" -F c -f "floremart-backup-$(date +%Y%m%d-%H%M).dump"
```
Восстановление в новую БД:
```bash
pg_restore -d "$NEW_DATABASE_URL" "floremart-backup-....dump"
```
На Mac, если `pg_dump` не установлен: `brew install libpq && brew link --force libpq`.

---

## 7. Частые проверки после деплоя

```bash
pm2 status floremart          # процесс online
pm2 logs floremart --lines 50 # последние логи
curl -s http://127.0.0.1:3010/api/health
```

Secure cookies: приложение всегда помечает cookie сессии `Secure` в production
(`src/lib/auth.ts`) — это безопасно, так как Nginx (CloudPanel) терминирует HTTPS снаружи;
внутренний HTTP-хоп до `127.0.0.1:3010` браузер никогда не видит напрямую.

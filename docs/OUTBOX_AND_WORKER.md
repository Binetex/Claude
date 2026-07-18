# Outbox & Worker — надёжная фоновая доставка событий

Персистентный transactional outbox + отдельный worker-процесс. Заменяет fire-and-forget
in-process шину: доменные события сохраняются в БД ДО обработки и не теряются при рестарте PM2.
Реализовано локально и безопасно — **миграции не применялись, prod не затрагивался, реальные
сообщения не отправлялись** (mock-провайдеры).

## Архитектура

```
бизнес-код ─ publishEvent(repo, name, payload) ─▶ OutboxEvent (PENDING)   ← персистентно, в той же БД
                                                        │
                                   floremart-worker (отдельный процесс PM2)
                                   ┌──────────────────────────────────────┐
                                   │ tick():                              │
                                   │  1. recoverStuck (зависшие PROCESSING)│
                                   │  2. claimBatch (FOR UPDATE SKIP LOCKED,│
                                   │     attempts++, lease lockedBy)       │
                                   │  3. handler(record):                  │
                                   │     order.delivery.completed →        │
                                   │       SMS ┐ Telegram ┐ email ┐ push ┐ │  ← независимо (allSettled)
                                   │       completion-sync ┘ (guard runOnce)│
                                   │  4. success→PROCESSED | fail→FAILED    │
                                   │     (backoff) | исчерпано→DEAD_LETTER  │
                                   └──────────────────────────────────────┘
```

Модули: `src/outbox/` (types, memoryRepository, prismaRepository, worker, handlers,
idempotency, publisher, logger, deliveryResolver), точка входа `scripts/outbox-worker.ts`.

## Гарантии
- **At-least-once**: событие сохранено до обработки; рестарт не теряет его.
- **Ровно-один сайд-эффект**: `ProcessedOperation` guard (`runOnce`) — повторная доставка не
  шлёт вторую SMS/Telegram, не повторяет fulfillment/Burq, не дублирует историю.
- **Не берут дважды**: `FOR UPDATE SKIP LOCKED` — два worker'а получают непересекающиеся наборы.
- **Не зависает навсегда**: `attempts` инкрементится при claim; зависшие PROCESSING
  восстанавливаются по таймауту; poison-событие в итоге уходит в `DEAD_LETTER`.
- **Изоляция downstream**: сбой Telegram не блокирует SMS/email/push/Shopify (`Promise.allSettled`).
- **Graceful shutdown**: SIGTERM/SIGINT → текущий батч доводится, цикл выходит.
- **Безопасные логи**: только id/тип/агрегат/попытки/статус/усечённая ошибка — без payload/PII.

## Точные изменения Prisma (подготовлено, НЕ применено)
Файл `prisma/schema.prisma` (additive, существующие модели не тронуты):

```prisma
enum OutboxStatus { PENDING PROCESSING PROCESSED FAILED DEAD_LETTER }

model OutboxEvent {
  id             String       @id @default(cuid())
  eventType      String
  aggregateType  String
  aggregateId    String
  payload        Json
  idempotencyKey String       @unique
  status         OutboxStatus @default(PENDING)
  attempts       Int          @default(0)
  maxAttempts    Int          @default(8)
  availableAt    DateTime     @default(now())
  lockedAt       DateTime?
  lockedBy       String?
  processedAt    DateTime?
  lastError      String?
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
  @@index([status, availableAt])
  @@index([status, lockedAt])
  @@index([aggregateType, aggregateId])
}

model ProcessedOperation {
  id           String   @id @default(cuid())
  operationKey String   @unique
  kind         String
  externalId   String?
  createdAt    DateTime @default(now())
  @@index([kind])
}
```

Offline SQL: `prisma/migrations/20260718040000_outbox_events/migration.sql` (сгенерирован
через `prisma migrate diff`, **не применён**). Применение — решение владельца.

## Env-переменные
| Переменная | Назначение | По умолчанию |
|---|---|---|
| `DATABASE_URL` | та же БД, что у приложения (worker пишет/читает outbox) | — (обязательна) |
| `WORKER_ID` | идентификатор инстанса в lease/логах | авто (`worker-<pid>-<rand>`) |
| `OUTBOX_BATCH_SIZE` | размер батча за тик | `20` |
| `OUTBOX_POLL_MS` | интервал поллинга при пустой очереди (мс) | `1000` |
| `OUTBOX_STUCK_MS` | порог «зависшего» PROCESSING (мс) | `60000` |

Новых ОБЯЗАТЕЛЬНЫХ переменных, кроме уже существующего `DATABASE_URL`, нет. Реальные провайдеры
(Quo/Telegram/SMTP/WebPush) добавят свои ключи позже за фиче-флагами.

## Локальный запуск worker'а
Требует применённой миграции в ЛОКАЛЬНОЙ тестовой БД (НЕ prod):
```bash
# 1) локальная БД (PGlite) + миграции + сев — см. AUTONOMOUS_REFACTOR_REPORT.md
DATABASE_URL=<local> npx prisma migrate deploy   # применит и 20260718040000_outbox_events
# 2) запуск worker'а (условие react-server нужно для server-only модулей)
DATABASE_URL=<local> npm run worker
# = NODE_OPTIONS=--conditions=react-server tsx scripts/outbox-worker.ts
```

## PM2 (пример, НЕ применён)
Готовый пример — `ecosystem.worker.example.js` (процесс `floremart-worker`). Запуск отдельно:
```bash
pm2 start ecosystem.worker.example.js
```
Либо добавить блок в рабочий `ecosystem.config.js` (предложенный diff, применяет владелец):
```diff
   apps: [
     { name: "floremart", script: "./node_modules/.bin/next", args: "start", /* ... */ },
+    {
+      name: "floremart-worker",
+      script: "./node_modules/.bin/tsx",
+      args: "scripts/outbox-worker.ts",
+      interpreter: process.execPath,
+      node_args: "--conditions=react-server",
+      instances: 1,
+      exec_mode: "fork",
+      autorestart: true,
+      max_memory_restart: "300M",
+      kill_timeout: 10000,
+      env: { NODE_ENV: "production" },
+      out_file: "./logs/worker-out.log",
+      error_file: "./logs/worker-error.log",
+      merge_logs: true,
+    },
   ],
```
PM2 в этой сессии не запускался, `ecosystem.config.js` не менялся.

## Интеграция (следующие шаги, за отдельным подтверждением)
1. Применить миграцию (dev → prod через обычный `deploy.sh`, с бэкапом БД).
2. Заменить `eventBus.publish` на `publishEvent(repo, ...)` в реальных потоках (ingest/assignments)
   за фиче-флагом — публикация в outbox в той же транзакции, что и изменение заказа.
3. Подключить реальные провайдеры (Quo/Telegram/SMTP/WebPush) за `MessageProvider` + фиче-флаги.
4. Реальный completion-sync (Shopify/Woo fulfillment) в handler'е (сейчас placeholder).
5. Запустить `floremart-worker` в PM2.

## Известные ограничения
- Prisma-реализация репозитория/guardّа проверена типами; поведенческие тесты — на in-memory
  реализации (миграция не применялась). E2E против БД — после применения миграции локально.
- `senderTelegramId`/`senderPushToken` в модели `Order` отсутствуют → Telegram/push для отправителя
  пока не резолвятся (нужны поля подписок, см. PROPOSED_SCHEMA_CHANGES.md).
- Провайдеры — mock; реальной отправки нет.
- Admin-страница `/dashboard/system-events` до применения миграции показывает уведомление
  «таблица не создана» (defensive), в навигацию не добавлена.

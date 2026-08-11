-- Ключ Brevo и статус его проверки становятся принадлежностью МАГАЗИНА.
--
-- Зачем: у магазинов разные аккаунты Brevo (у theflow.la свой), а ключ в системе был один на
-- всё. Общего ключа больше нет; одно и то же значение у разных магазинов допустимо.
--
-- Перенос данных обязателен и идёт здесь же: действующий общий ключ копируется КАЖДОМУ магазину,
-- иначе после деплоя Email замолчал бы у всех до ручной простановки ключей. Значение копируется
-- уже зашифрованным, расшифровка не нужна и не производится.

-- 1. Секреты: siteId (NULL = уровень аккаунта, так остаются подписи вебхуков QUO).
ALTER TABLE "IntegrationSecret" ADD COLUMN "siteId" TEXT;

ALTER TABLE "IntegrationSecret"
  ADD CONSTRAINT "IntegrationSecret_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "IntegrationSecret_provider_kind_siteId_active_idx"
  ON "IntegrationSecret"("provider", "kind", "siteId", "active");

-- 2. Копия действующего общего ключа Brevo каждому магазину. Если общего ключа в БД нет
--    (работали через env BREVO_API_KEY) — не вставится ничего, и ключи проставляются руками.
INSERT INTO "IntegrationSecret" ("id", "provider", "kind", "encryptedValue", "maskedSuffix", "active", "createdAt", "updatedAt", "siteId")
SELECT
  md5(random()::text || clock_timestamp()::text || s."id"),
  i."provider", i."kind", i."encryptedValue", i."maskedSuffix", i."active",
  NOW(), NOW(), s."id"
FROM "IntegrationSecret" i
CROSS JOIN "Site" s
WHERE i."provider" = 'BREVO' AND i."kind" = 'api_key' AND i."active" = true AND i."siteId" IS NULL;

-- 3. Общий ключ Brevo удаляется — но ТОЛЬКО если копии реально созданы. Безусловный DELETE
--    уничтожил бы единственный экземпляр ключа в случае, когда копировать оказалось некуда
--    (например, магазинов нет вовсе). Приложение общий ключ всё равно больше не читает, поэтому
--    оставшаяся строка безвредна, а вот потерянный ключ владельцу пришлось бы искать в Brevo.
--    Секреты QUO не трогаются: у них siteId остаётся NULL по смыслу.
DELETE FROM "IntegrationSecret"
WHERE "provider" = 'BREVO' AND "kind" = 'api_key' AND "siteId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "IntegrationSecret"
    WHERE "provider" = 'BREVO' AND "kind" = 'api_key' AND "siteId" IS NOT NULL
  );

-- 4. Статус проверки подключения — по строке на магазин.
--    Прежний singleton описывал общий ключ; раздаём его копию тем магазинам, которым только что
--    достался тот же ключ, чтобы бейдж «подключено» не обнулился без причины.
ALTER TABLE "BrevoAccountStatus" ADD COLUMN "siteId" TEXT;

INSERT INTO "BrevoAccountStatus" ("id", "connStatus", "verifiedAt", "accountEmail", "errorSafe", "createdAt", "updatedAt", "siteId")
SELECT
  md5(random()::text || clock_timestamp()::text || s."id"),
  st."connStatus", st."verifiedAt", st."accountEmail", st."errorSafe", NOW(), NOW(), s."id"
FROM (SELECT * FROM "BrevoAccountStatus" WHERE "siteId" IS NULL ORDER BY "createdAt" DESC LIMIT 1) st
CROSS JOIN "Site" s
WHERE EXISTS (
  SELECT 1 FROM "IntegrationSecret" k
  WHERE k."provider" = 'BREVO' AND k."kind" = 'api_key' AND k."siteId" = s."id"
);

-- Прежний singleton убирается только после того, как копии разошлись по магазинам; иначе строка
-- со статусом просто останется и будет вычищена вместе со следующей проверкой подключения.
DELETE FROM "BrevoAccountStatus"
WHERE "siteId" IS NULL
  AND EXISTS (SELECT 1 FROM "BrevoAccountStatus" WHERE "siteId" IS NOT NULL);

-- Если копий не появилось (магазинов нет / ключа не было), осиротевшая строка не даст выставить
-- NOT NULL — удаляем её здесь: статус проверки восстанавливается одним нажатием кнопки.
DELETE FROM "BrevoAccountStatus" WHERE "siteId" IS NULL;

ALTER TABLE "BrevoAccountStatus" ALTER COLUMN "siteId" SET NOT NULL;

CREATE UNIQUE INDEX "BrevoAccountStatus_siteId_key" ON "BrevoAccountStatus"("siteId");

ALTER TABLE "BrevoAccountStatus"
  ADD CONSTRAINT "BrevoAccountStatus_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

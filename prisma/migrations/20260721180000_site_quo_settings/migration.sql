-- QUO per-site: тумблер + статус подключения. Аддитивно, без изменения существующих полей.
ALTER TABLE "Site" ADD COLUMN "quoEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Site" ADD COLUMN "quoLastCheckAt" TIMESTAMP(3);
ALTER TABLE "Site" ADD COLUMN "quoConnectionError" TEXT;

-- Backfill: не отключать уже работающие магазины (напр. TheFlow) — у кого номер уже привязан,
-- тому включаем QUO, чтобы отправка/маршрутизация не сломались после добавления гейта quoEnabled.
UPDATE "Site" SET "quoEnabled" = true WHERE "quoPhoneNumberId" IS NOT NULL;

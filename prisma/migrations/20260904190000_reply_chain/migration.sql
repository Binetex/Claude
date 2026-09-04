-- Ожидание ответа становится ОБЩИМ механизмом: любое правило может ждать ответ на своё
-- сообщение и, если тишина, запускать СЛЕДУЮЩЕЕ правило — цепочка любой длины, любая сторона.
--
-- До этого эскалация «получатель молчит» была зашита в код: ровно два шага (переспросить
-- получателя → сказать заказчику), два специальных события под них и галочка, доступная только
-- для SMS получателю. Владелец справедливо сказал, что зашили частный случай вместо механизма.
--
-- МИГРАЦИЯ ТОЛЬКО ДОБАВЛЯЕТ. Ни одна колонка здесь не удаляется и не переименовывается, и это
-- не аккуратность ради аккуратности: deploy.sh применяет миграции ДО сборки и перезапуска, то
-- есть несколько минут с новой схемой работает СТАРЫЙ код. Prisma перечисляет колонки поимённо,
-- поэтому удалённое поле в этот момент означает «column does not exist» на каждом запросе:
-- лежащий дашборд и, что хуже, события очереди, сгорающие в dead-letter вместе с неотправленными
-- клиентам SMS. По той же причине сохраняется работоспособность автоотката deploy.sh: он
-- возвращает ПРЕДЫДУЩУЮ сборку на уже мигрированную базу, и она обязана работать.
-- Старые колонки (`Automation.awaitRecipientReply`, `Site.recipientRetryAfterMin`,
-- `Site.recipientAlertAfterMin`) сносит отдельная миграция СЛЕДУЮЩИМ деплоем.

-- 1. Ссылка «не ответят — запустить это правило». Ожидание выражается самой ссылкой.
ALTER TABLE "Automation" ADD COLUMN "noReplyNextAutomationId" TEXT;
ALTER TABLE "Automation"
  ADD CONSTRAINT "Automation_noReplyNextAutomationId_fkey"
  FOREIGN KEY ("noReplyNextAutomationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Automation_noReplyNextAutomationId_idx" ON "Automation"("noReplyNextAutomationId");

-- 2. Сроки ожидания перестают быть «про получателя»: это пауза перед следующим шагом любой
--    цепочки. Значения переносятся один в один — у владельца там 60 и 20 минут.
ALTER TABLE "Site" ADD COLUMN "awaitReplyFirstMin" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Site" ADD COLUMN "awaitReplyNextMin" INTEGER NOT NULL DEFAULT 20;
UPDATE "Site" SET "awaitReplyFirstMin" = "recipientRetryAfterMin", "awaitReplyNextMin" = "recipientAlertAfterMin";

-- 3. Перенос живой цепочки. Проверяем ВХОД до правок: молча проехавшая миграция здесь хуже
--    упавшей — она бы тихо выключила работающую эскалацию или, наоборот, включила лишнюю.
DO $$
DECLARE flagged int; no_reply int; unreachable int; dead_flows int;
BEGIN
  SELECT count(*) INTO flagged FROM "Automation" WHERE "awaitRecipientReply" = true AND "deletedAt" IS NULL;
  SELECT count(*) INTO no_reply FROM "Automation" WHERE "triggerType" = 'RECIPIENT_NO_REPLY' AND "deletedAt" IS NULL;
  SELECT count(*) INTO unreachable FROM "Automation" WHERE "triggerType" = 'RECIPIENT_UNREACHABLE' AND "deletedAt" IS NULL;
  SELECT count(*) INTO dead_flows FROM "AutomationFlow"
    WHERE "triggerType" IN ('RECIPIENT_NO_REPLY', 'RECIPIENT_UNREACHABLE') AND "deletedAt" IS NULL;

  RAISE NOTICE 'Перенос цепочки: ждущих правил %, шагов «переспросить» %, шагов «сказать заказчику» %', flagged, no_reply, unreachable;

  -- Шаги должны быть по одному: иначе непонятно, какой из них чей, а угадывание здесь
  -- оборачивается лишними сообщениями живым людям.
  IF no_reply > 1 OR unreachable > 1 THEN
    RAISE EXCEPTION 'Перенос цепочки: шагов больше одного (переспросить %, заказчику %) — свяжите правила вручную до деплоя', no_reply, unreachable;
  END IF;
  -- Маркетинговая цепочка на эти события после переноса не сработает никогда и молча.
  IF dead_flows > 0 THEN
    RAISE EXCEPTION 'Перенос цепочки: % маркетинговых цепочек висят на снимаемых событиях — переведите их на другое событие', dead_flows;
  END IF;
END $$;

-- 3.1 Ждущее правило → «переспросить». Ждущее — то, у которого стоит галочка (её ставила
--     миграция 20260904160000), то есть ровно то, что запускает эскалацию сейчас.
UPDATE "Automation" a
SET "noReplyNextAutomationId" = (
  SELECT n.id FROM "Automation" n
  WHERE n."triggerType" = 'RECIPIENT_NO_REPLY' AND n."deletedAt" IS NULL
  LIMIT 1
)
WHERE a."awaitRecipientReply" = true AND a."deletedAt" IS NULL;

-- 3.2 «Переспросить» → «сказать заказчику».
UPDATE "Automation" a
SET "noReplyNextAutomationId" = (
  SELECT n.id FROM "Automation" n
  WHERE n."triggerType" = 'RECIPIENT_UNREACHABLE' AND n."deletedAt" IS NULL
  LIMIT 1
)
WHERE a."triggerType" = 'RECIPIENT_NO_REPLY' AND a."deletedAt" IS NULL;

-- 4. Шаги цепочки больше не висят на собственных событиях: их запускает предыдущее правило.
UPDATE "Automation"
SET "triggerType" = 'CHAINED'
WHERE "triggerType" IN ('RECIPIENT_NO_REPLY', 'RECIPIENT_UNREACHABLE');

-- 5. Проверяем РЕЗУЛЬТАТ: шаг без предшественника не сработает никогда, а пара правил без
--    общего магазина оборвёт цепочку на первом же шаге — и то и другое молча.
DO $$
DECLARE orphans int; disjoint int;
BEGIN
  SELECT count(*) INTO orphans
  FROM "Automation" c
  WHERE c."triggerType" = 'CHAINED' AND c."deletedAt" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "Automation" p WHERE p."noReplyNextAutomationId" = c.id);
  IF orphans > 0 THEN
    RAISE EXCEPTION 'Перенос цепочки: % шаг(ов) остались без предшественника — деплой остановлен', orphans;
  END IF;

  SELECT count(*) INTO disjoint
  FROM "Automation" p
  WHERE p."noReplyNextAutomationId" IS NOT NULL AND p."deletedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "AutomationSite" ps
      JOIN "AutomationSite" ns ON ns."siteId" = ps."siteId"
      WHERE ps."automationId" = p.id AND ns."automationId" = p."noReplyNextAutomationId"
    );
  IF disjoint > 0 THEN
    RAISE EXCEPTION 'Перенос цепочки: % связ(ей) без общего магазина — цепочка оборвалась бы на первом шаге', disjoint;
  END IF;
END $$;

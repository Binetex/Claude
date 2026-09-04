-- Срок ожидания живёт ТОЛЬКО на правиле.
--
-- Пока сроков было два — на магазине и на правиле — владелец видел две настройки для одного и
-- того же и справедливо спросил, зачем вторая. Переносим значения магазина в правила, которые
-- на них опирались, и магазинные поля перестают читаться кодом.
--
-- Только добавление данных: колонки Site (`awaitReplyFirstMin`, `awaitReplyNextMin`) остаются в
-- базе до общей миграции зачистки — деплой применяет миграции ДО перезапуска, и несколько минут
-- с новой схемой работает старый код, которому эти колонки нужны.
UPDATE "Automation" a
SET "noReplyAfterMin" = COALESCE(
  (
    SELECT MAX(CASE WHEN a."triggerType" = 'CHAINED' THEN s."awaitReplyNextMin" ELSE s."awaitReplyFirstMin" END)
    FROM "AutomationSite" asite
    JOIN "Site" s ON s.id = asite."siteId"
    WHERE asite."automationId" = a.id
  ),
  CASE WHEN a."triggerType" = 'CHAINED' THEN 20 ELSE 60 END
)
WHERE a."noReplyNextAutomationId" IS NOT NULL
  AND a."noReplyAfterMin" IS NULL
  AND a."deletedAt" IS NULL;

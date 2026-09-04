-- Тайминги эскалации «получатель молчит» — настройка магазина, а не константа кода.
-- Владелец меняет их в «Автоматизации → Настройки по магазинам» рядом со временем
-- ежедневных триггеров: там же, где решается, когда вообще задаётся вопрос.
ALTER TABLE "Site" ADD COLUMN "recipientRetryAfterMin" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Site" ADD COLUMN "recipientAlertAfterMin" INTEGER NOT NULL DEFAULT 20;

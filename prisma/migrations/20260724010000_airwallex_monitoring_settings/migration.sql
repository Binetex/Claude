-- Airwallex Payment Monitoring: пер-сайтовые настройки API-опроса (отдельно от разбора meta).
-- Только additive. Credentials хранятся зашифрованными (secretBox); включить мониторинг можно
-- лишь после успешного Verify (airwallexApiVerifiedAt).
ALTER TABLE "WooCommerceConnection"
  ADD COLUMN "airwallexMonitoringEnabled"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "airwallexApiClientIdEncrypted" TEXT,
  ADD COLUMN "airwallexApiKeyEncrypted"      TEXT,
  ADD COLUMN "airwallexApiKeyMask"           TEXT,
  ADD COLUMN "airwallexApiEnv"               TEXT NOT NULL DEFAULT 'prod',
  ADD COLUMN "airwallexPendingThresholdMin"  INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "airwallexApiVerifiedAt"        TIMESTAMP(3),
  ADD COLUMN "airwallexApiConnStatus"        TEXT,
  ADD COLUMN "airwallexApiErrorSafe"         TEXT;

import "server-only";

/**
 * Feature-флаги реальных внешних интеграций. Пока все выключены (этап 1) —
 * адаптеры остаются заглушками независимо от значения флага; когда адаптер
 * получит реальную реализацию (этап 2), он сам должен проверять свой флаг
 * перед выполнением сетевого вызова.
 */
export type IntegrationFlag =
  | "SHOPIFY_ENABLED"
  | "WOOCOMMERCE_ENABLED"
  | "QUO_ENABLED"
  | "BURQ_ENABLED"
  | "EMAIL_ENABLED"
  | "TELEGRAM_ENABLED";

function readFlag(name: IntegrationFlag): boolean {
  return process.env[name] === "true";
}

export const featureFlags = {
  shopify: readFlag("SHOPIFY_ENABLED"),
  woocommerce: readFlag("WOOCOMMERCE_ENABLED"),
  quo: readFlag("QUO_ENABLED"),
  burq: readFlag("BURQ_ENABLED"),
  email: readFlag("EMAIL_ENABLED"),
  telegram: readFlag("TELEGRAM_ENABLED"),
} as const;

/**
 * ГЛАВНЫЙ аварийный выключатель ВСЕЙ Burq runtime-логики (scheduler, ingest/assignment/pickup/tz
 * hooks, recovery, worker handlers, webhook processing, любые вызовы Burq API, создание Burq
 * OutboxEvent). При false — все эти пути делают полный no-op. Читается динамически (env), чтобы
 * менять без пересборки и тестировать. НЕ управляет UI настроек Burq и сохранением/проверкой
 * credentials — они работают независимо. Per-site Site.burqDraftAutoCreateEnabled НЕ может обойти
 * этот глобальный gate (проверяется раньше per-site логики).
 */
export function isBurqRuntimeEnabled(): boolean {
  return process.env.BURQ_RUNTIME_ENABLED === "true";
}

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

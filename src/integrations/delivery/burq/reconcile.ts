/**
 * Anti-rollback применения статуса доставки. Чистая функция.
 *  - stale-event: событие старше уже применённого — не применяем;
 *  - hard-terminal: DELIVERED/CANCELLED/RETURNED/FAILED не откатываем более ранним/иным статусом;
 *  - manual-lock: ручное решение (MANUAL_ADMIN) DELIVERED/CANCELLED поздний webhook не перебивает;
 *  - PROBLEM (attempting reroute) НЕ блокирует последующий официальный delivered, если ручного
 *    решения ещё не было (см. требование §6).
 */
import type { DeliveryProviderStatus } from "@/generated/prisma/enums";

export type ExistingDeliveryState = {
  status: DeliveryProviderStatus;
  providerEventAt: Date | null;
  resolutionSource: "BURQ_WEBHOOK" | "MANUAL_ADMIN" | "POLLING" | "SYSTEM" | null;
};

export type IncomingDeliveryUpdate = {
  status: DeliveryProviderStatus;
  providerEventAt: Date | null;
  /** true — обновление от сотрудника (ручное), а не от Burq. */
  manual?: boolean;
};

const HARD_TERMINAL = new Set<DeliveryProviderStatus>(["DELIVERED", "CANCELLED", "RETURNED", "FAILED"]);

export function shouldApplyDeliveryUpdate(existing: ExistingDeliveryState, incoming: IncomingDeliveryUpdate): { apply: boolean; reason: string } {
  // Ручные действия сотрудника проходят всегда (их anti-rollback — на уровне UI/подтверждения).
  if (incoming.manual) return { apply: true, reason: "manual_action" };

  // Ручное решение DELIVERED/CANCELLED заблокировано для поздних webhook.
  if (existing.resolutionSource === "MANUAL_ADMIN" && (existing.status === "DELIVERED" || existing.status === "CANCELLED")) {
    return { apply: false, reason: "manual_decision_locked" };
  }

  // Out-of-order: событие старше применённого.
  if (existing.providerEventAt && incoming.providerEventAt && incoming.providerEventAt < existing.providerEventAt) {
    return { apply: false, reason: "stale_event" };
  }

  // Hard-terminal не откатываем (PROBLEM НЕ входит — допускает поздний delivered).
  if (HARD_TERMINAL.has(existing.status) && existing.status !== incoming.status) {
    return { apply: false, reason: "terminal_no_rollback" };
  }

  return { apply: true, reason: "ok" };
}

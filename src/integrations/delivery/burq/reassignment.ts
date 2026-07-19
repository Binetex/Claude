/**
 * Решение при ПЕРЕНАЗНАЧЕНИИ флориста после того, как Burq draft уже создан. Чистая функция.
 *
 * Ключевое правило Burq: удалить (DELETE) можно только НЕИНИЦИИРОВАННЫЙ draft (статус `request`
 * → DRAFT_PENDING/DRAFT_CREATED). Как только флорист вручную оформил доставку в Burq (курьер
 * ищется/назначен/в пути), draft инициирован — удалять/переносить автоматически нельзя.
 *
 * Исходы:
 *  - DELETE_AND_RECREATE — draft ещё не инициирован: DELETE в Burq, старую Delivery → CANCELLED
 *    (FLORIST_REASSIGNED), создать новую attempt с pickup нового флориста;
 *  - FLAG_PROBLEM — draft уже инициирован/активен: пометить проблему, ручное решение оператором.
 */
import type { DeliveryProviderStatus } from "@/generated/prisma/enums";

export type ReassignmentDecision =
  | { action: "DELETE_AND_RECREATE" }
  | { action: "FLAG_PROBLEM"; reason: "draft_initiated" | "terminal" };

/** Неинициированные (безопасные к DELETE) статусы черновика. */
const UNINITIATED = new Set<DeliveryProviderStatus>(["DRAFT_PENDING", "DRAFT_CREATED"]);

const TERMINAL = new Set<DeliveryProviderStatus>(["DELIVERED", "CANCELLED", "RETURNED", "FAILED"]);

export function decideReassignment(currentStatus: DeliveryProviderStatus): ReassignmentDecision {
  if (UNINITIATED.has(currentStatus)) return { action: "DELETE_AND_RECREATE" };
  if (TERMINAL.has(currentStatus)) return { action: "FLAG_PROBLEM", reason: "terminal" };
  return { action: "FLAG_PROBLEM", reason: "draft_initiated" };
}

import "server-only";
/**
 * Кто писал инструкцию курьеру и видит ли её курьер — для карточки заказа и для разбора ИИ.
 *
 * Своей колонки «написал ИИ» нет: правку человека и так записывает аудит карточки (блок
 * `courierNote`), а ИИ пишет мимо него. Значит, «человек правил» — это строка аудита с полем
 * `courierNote`, и выводится из записей, а не хранится вторым флагом, который мог бы разойтись.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { deliveryStage } from "@/integrations/delivery/burq/reassignment";

export async function courierNoteEditedByHuman(prisma: PrismaClient, orderId: string): Promise<boolean> {
  const audits = await prisma.orderAudit.findMany({ where: { orderId, block: "courierNote" }, select: { changed: true } });
  return audits.some((a) => a.changed != null && typeof a.changed === "object" && "courierNote" in a.changed);
}

export type CourierNoteView = {
  /** Текст собрал ИИ, человек его не правил. */
  byAi: boolean;
  /** Курьер уже вызван: новый текст он не увидит, передавать надо самим. */
  courierCalled: boolean;
};

export async function loadCourierNoteView(prisma: PrismaClient, orderId: string, courierNote: string): Promise<CourierNoteView> {
  const [byHuman, current] = await Promise.all([
    courierNoteEditedByHuman(prisma, orderId),
    prisma.delivery.findFirst({
      where: { orderId, isCurrentAttempt: true, externalDeliveryId: { not: null } },
      select: { status: true },
    }),
  ]);
  return {
    byAi: courierNote.trim() !== "" && !byHuman,
    courierCalled: current != null && deliveryStage(current.status) === "dispatched",
  };
}

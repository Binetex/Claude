import "server-only";
/**
 * Prisma-реализация DraftCreatePort: чтение контекста заказа и транзакционное сохранение
 * Burq draft (Delivery + DeliveryIntent + DeliveryStatusEvent). Оркестрация — в draftHandler.ts.
 *
 * pickup читается ТОЛЬКО из точек назначенного флориста (resolvePickupForOrder: ручной выбор
 * в заказе, иначе основная точка). Никаких fallback на Site/Google/customer.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { mapBurqStatus } from "./statusMap";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { getBurqDimensions } from "./settings";
import { combineDropoffNotes } from "./dropoffNotes";
import { resolvePickupForOrder } from "./pickupResolution";
import type { DraftContext, DraftCreatePort, PersistDraftInput } from "./draftHandler";

export function createPrismaDraftPort(prisma: PrismaClient): DraftCreatePort {
  return {
    async loadContext(orderId: string): Promise<DraftContext | null> {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderStatus: true,
          deliveryDate: true,
          currentFloristId: true,
          recipientName: true,
          recipientPhone: true,
          addressLine: true,
          apartment: true,
          city: true,
          zip: true,
          customerNote: true,
          pickupLocationOverrideId: true,
          site: { select: { burqDraftAutoCreateEnabled: true, burqDefaultDropoffInstructions: true } },
          deliveryIntent: { select: { scheduleVersion: true } },
          currentFlorist: { select: { id: true, pickupLocations: true } },
          deliveries: { select: { attemptNumber: true, isCurrentAttempt: true, externalDeliveryId: true } },
        },
      });
      if (!order) return null;

      const hasCurrentDraft = order.deliveries.some((d) => d.isCurrentAttempt && d.externalDeliveryId);
      const maxAttempt = order.deliveries.reduce((m, d) => Math.max(m, d.attemptNumber), 0);
      const resolved = resolvePickupForOrder({
        overrideId: order.pickupLocationOverrideId,
        floristPickups: order.currentFlorist?.pickupLocations ?? [],
      });
      const pl = resolved?.location ?? null;

      return {
        order: {
          id: order.id,
          orderStatus: order.orderStatus,
          deliveryDate: order.deliveryDate ?? null,
          scheduleVersion: order.deliveryIntent?.scheduleVersion ?? 0,
          siteAutoCreateEnabled: order.site?.burqDraftAutoCreateEnabled ?? false,
          dropoff: {
            recipientName: order.recipientName,
            recipientPhone: order.recipientPhone,
            addressLine: order.addressLine,
            apartment: order.apartment,
            city: order.city,
            // У Order пока нет поля state получателя — прокидываем null (sandbox-gate: Burq
            // dropoff может требовать штат; см. отчёт о недостающих полях).
            recipientState: null,
            zip: order.zip,
            // Стандартный dropoff-текст магазина + инструкция заказа (дедуп, пустое → null).
            dropoffInstructions: combineDropoffNotes(order.site?.burqDefaultDropoffInstructions, order.customerNote),
          },
        },
        floristId: order.currentFloristId,
        pickup: pl
          ? {
              locationName: pl.locationName,
              contactName: pl.contactName,
              contactPhone: pl.contactPhone,
              addressLine: pl.addressLine,
              apartmentOrSuite: pl.apartmentOrSuite,
              city: pl.city,
              state: pl.state,
              zip: pl.zip,
              courierInstructions: pl.courierInstructions,
              isActive: pl.isActive,
            }
          : null,
        pickupLocationId: pl?.id ?? null,
        hasCurrentDraft,
        nextAttemptNumber: maxAttempt + 1,
        dimensions: await getBurqDimensions(),
      };
    },

    async markIntent(orderId, status, reason) {
      await prisma.deliveryIntent.upsert({
        where: { orderId },
        create: { orderId, intentStatus: status, lastSkipReason: reason },
        update: { intentStatus: status, lastSkipReason: reason },
      });
    },

    async persistDraft(input: PersistDraftInput) {
      const normalized = mapBurqStatus(input.rawStatus);
      // Точку НЕ перевыбираем: пишем ровно ту, что ушла в Burq (её выбрал резолвер в loadContext).
      const pickupLocationId = input.pickupLocationId;

      await prisma.$transaction(async (tx) => {
        // Гарантия одного текущего attempt: снимаем флаг с прочих.
        await tx.delivery.updateMany({
          where: { orderId: input.orderId, isCurrentAttempt: true },
          data: { isCurrentAttempt: false },
        });
        const delivery = await tx.delivery.create({
          data: {
            orderId: input.orderId,
            provider: "BURQ",
            floristId: input.floristId,
            pickupLocationId,
            expectedFloristId: input.floristId,
            attemptNumber: input.attemptNumber,
            isCurrentAttempt: true,
            externalDeliveryId: input.externalDeliveryId,
            externalOrderRef: input.referenceId,
            checkoutUrl: input.checkoutUrl,
            isDraft: true,
            status: normalized,
            rawProviderStatus: input.rawStatus,
            providerEventAt: new Date(),
            idempotencyKey: `burq:create:${input.orderId}:${input.attemptNumber}`,
            resolutionSource: "SYSTEM",
          },
        });
        await tx.deliveryStatusEvent.create({
          data: {
            deliveryId: delivery.id,
            rawStatus: input.rawStatus,
            normalizedStatus: normalized,
            source: "SYSTEM",
            newStatus: normalized,
            occurredAt: new Date(),
          },
        });
        await tx.deliveryIntent.upsert({
          where: { orderId: input.orderId },
          create: { orderId: input.orderId, intentStatus: "DRAFT_CREATED" },
          update: { intentStatus: "DRAFT_CREATED", lastSkipReason: null },
        });
      });
    },

    /**
     * Результат проверки курьеров. Пишется всегда, когда проверка состоялась, — и когда
     * курьеры есть тоже: иначе «не проверяли» и «проверяли, всё хорошо» неразличимы.
     *
     * Тревога поднимается ТОЛЬКО при нуле и только в Telegram владельцу: на экранах баннер
     * строится из этих же полей и отдельного уведомления не требует.
     */
    async recordCourierAvailability(input) {
      const checkedAt = new Date();
      await prisma.delivery.updateMany({
        where: { orderId: input.orderId, attemptNumber: input.attemptNumber },
        data: { couriersCheckedAt: checkedAt, couriersAvailable: input.count },
      });
      if (input.count > 0) return;

      await publishTelegramNotification(prisma, {
        type: "delivery.no_couriers",
        orderId: input.orderId,
        // Попытка в ключе: повторная доставка — это новая проверка и новый повод сказать.
        occurrenceKey: `${input.orderId}:a${input.attemptNumber}`,
        context: { checkedAt: checkedAt.toISOString().slice(11, 16) },
      });
    },
  };
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Опрос статусов открытых доставок.
 *
 * Цена ошибки известна: M-THEFLOW-002 курьер привёз и загрузил фото, а у нас заказ сутки
 * висел «ожидает курьера». Webhook по этой доставке не мог найти её — метки, по которой он
 * ищет, у заведённой руками доставки нет. Опрос спрашивает Burq по ЕГО номеру заказа, и
 * поэтому работает независимо от метки.
 *
 * Проверяется ОТБОР: кого дёргаем, а кого нет. Ошибка здесь либо оставляет заказы немыми,
 * либо бесконечно долбит чужой API.
 */
vi.mock("@/lib/featureFlags", () => ({ isBurqRuntimeEnabled: () => true }));
vi.mock("./settings", () => ({
  getBurqRuntimeClient: async () => ({
    getOrder: async () => ({ status: "delivered", courierName: null, courierPhone: null, trackingUrl: null }),
  }),
}));
vi.mock("./webhookHandler", () => ({ makeCompletedPublisher: () => async () => undefined }));
vi.mock("./podService", () => ({ refetchPodForDelivery: async () => ({ outcome: "no_photo", count: 0 }) }));

const applySpy = vi.fn(async (..._args: unknown[]) => ({ outcome: "applied" as const, status: "DELIVERED" as const, delivered: true, deliveryId: "d1" }));
vi.mock("./statusIngest", () => ({ applyDeliveryStatusUpdate: (...a: unknown[]) => applySpy(...a) }));

const { syncOpenDeliveryStatuses } = await import("./statusSync");

let captured: Record<string, unknown> = {};
const fakePrisma = (rows: { id: string; externalDeliveryId: string | null }[]) =>
  ({
    delivery: {
      findMany: async (args: { where: Record<string, unknown>; take: number }) => {
        captured = args.where;
        return rows;
      },
    },
  }) as unknown as PrismaClient;

beforeEach(() => {
  captured = {};
  applySpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("отбор доставок для опроса", () => {
  it("берёт только ТЕКУЩУЮ попытку и только не-черновики", async () => {
    // Черновик — ещё не доставка: у него нет курьера, и статус там не меняется.
    await syncOpenDeliveryStatuses(fakePrisma([]));
    expect(captured.isCurrentAttempt).toBe(true);
    expect(captured.isDraft).toBe(false);
  });

  it("берёт только те, у кого есть номер заказа в Burq", async () => {
    // Именно по нему и спрашиваем: без него опрос невозможен.
    await syncOpenDeliveryStatuses(fakePrisma([]));
    expect(captured.externalDeliveryId).toEqual({ not: null });
  });

  it("не трогает завершённые: доставлено, отменено, возвращено", async () => {
    await syncOpenDeliveryStatuses(fakePrisma([]));
    expect(captured.status).toEqual({ notIn: ["DELIVERED", "CANCELLED", "RETURNED"] });
  });

  it("PROBLEM опрашивается — такая доставка ещё может доехать", async () => {
    await syncOpenDeliveryStatuses(fakePrisma([]));
    const excluded = (captured.status as { notIn: string[] }).notIn;
    expect(excluded).not.toContain("PROBLEM");
  });

  it("не дёргает Burq вечно: окно два дня", async () => {
    // Незавершённая доставка старше — застряла, её разбирают руками, а не опросом.
    const now = new Date("2026-08-08T12:00:00.000Z");
    await syncOpenDeliveryStatuses(fakePrisma([]), now);
    const order = captured.order as { deliveryDate: { gte: Date } };
    expect(order.deliveryDate.gte.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });

  it("спрашивает ТОЛЬКО там, где события молчат", async () => {
    // Главная экономия: по доставке, о которой Burq исправно сообщает, запрос лишний.
    const now = new Date("2026-08-08T12:00:00.000Z");
    await syncOpenDeliveryStatuses(fakePrisma([]), now);
    const or = captured.OR as [{ lastWebhookAt: null }, { lastWebhookAt: { lt: Date } }];
    expect(or[0]).toEqual({ lastWebhookAt: null }); // вебхука не было вовсе
    expect(or[1].lastWebhookAt.lt.toISOString()).toBe("2026-08-08T11:40:00.000Z"); // молчит 20 мин
  });

  it("пустая выборка не ходит в Burq вовсе", async () => {
    const res = await syncOpenDeliveryStatuses(fakePrisma([]));
    expect(res).toEqual({ scanned: 0, updated: 0, failed: 0 });
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe("применение статуса", () => {
  it("ищет доставку по НАШЕМУ id, а не по метке Burq", async () => {
    // В этом вся суть: метки у ручной доставки нет, и искать по ней бессмысленно.
    await syncOpenDeliveryStatuses(fakePrisma([{ id: "d1", externalDeliveryId: "o_123" }]));
    const input = applySpy.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(input?.deliveryId).toBe("d1");
    expect(input?.externalOrderRef).toBeUndefined();
    expect(input?.source).toBe("POLLING");
  });

  it("считает применённые обновления", async () => {
    const res = await syncOpenDeliveryStatuses(fakePrisma([{ id: "d1", externalDeliveryId: "o_123" }]));
    expect(res).toEqual({ scanned: 1, updated: 1, failed: 0 });
  });
});

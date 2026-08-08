import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Пересчёт дня по изменению заказа — то, что заменило интервальный пересчёт в воркере.
 *
 * Цена ошибки известна: интервал не срабатывал из-за перезапусков на деплое, и заработок
 * молча отставал — доставленный заказ M-THEFLOW-002 не попал в день Насти. Теперь пересчёт
 * висит на самих изменениях, поэтому пропуск вызова = снова тихо неверные деньги.
 */
vi.mock("./config", () => ({
  primaryShareGate: () => ({ enabled: true, startDate: new Date("2026-08-01T00:00:00.000Z") }),
}));

const recalcSpy = vi.fn(async (..._a: unknown[]) => ({ days: 0, complete: 0, detector: {} }));
vi.mock("./fix", () => ({ recalculateAffectedFinance: (...a: unknown[]) => recalcSpy(...a) }));

const { recomputeDaysForOrder, recomputeDayForOrder } = await import("./orderDayHook");

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const fakePrisma = (opts: { profile?: boolean; owner?: boolean; deliveryDate?: Date } = {}) =>
  ({
    floristFinanceProfile: { findFirst: async () => (opts.profile === false ? null : { id: "p1" }) },
    user: { findFirst: async () => (opts.owner === false ? null : { id: "u1" }) },
    order: {
      findUnique: async () => ({ deliveryDate: opts.deliveryDate ?? day("2026-08-07") }),
    },
  }) as unknown as PrismaClient;

/** Дни, с которыми позвали пересчёт. */
const calledDays = (): string[] => {
  const days = recalcSpy.mock.calls[0]?.[1] as Date[] | undefined;
  return (days ?? []).map((d) => d.toISOString().slice(0, 10));
};

beforeEach(() => recalcSpy.mockClear());

describe("что пересчитывается", () => {
  it("один день — обычное изменение заказа", async () => {
    await recomputeDaysForOrder(fakePrisma(), "o1", [day("2026-08-07")]);
    expect(calledDays()).toEqual(["2026-08-07"]);
  });

  it("перенос даты — ОБА дня, откуда ушёл и куда пришёл", async () => {
    await recomputeDaysForOrder(fakePrisma(), "o1", [day("2026-08-05"), day("2026-08-07")]);
    expect(calledDays()).toEqual(["2026-08-05", "2026-08-07"]);
  });

  it("дубли дней не удваивают работу", async () => {
    await recomputeDaysForOrder(fakePrisma(), "o1", [day("2026-08-07"), day("2026-08-07")]);
    expect(calledDays()).toEqual(["2026-08-07"]);
  });

  it("дни до старта расчёта не трогаются", async () => {
    await recomputeDaysForOrder(fakePrisma(), "o1", [day("2026-07-20"), day("2026-08-07")]);
    expect(calledDays()).toEqual(["2026-08-07"]);
  });

  it("все дни до старта — пересчёта нет вовсе", async () => {
    await recomputeDaysForOrder(fakePrisma(), "o1", [day("2026-07-20")]);
    expect(recalcSpy).not.toHaveBeenCalled();
  });

  it("короткая форма берёт дату доставки из заказа", async () => {
    await recomputeDayForOrder(fakePrisma({ deliveryDate: day("2026-08-06") }), "o1");
    expect(calledDays()).toEqual(["2026-08-06"]);
  });
});

describe("пересчёт не должен ронять вызывающего", () => {
  it("нет профиля основного флориста — тихо выходим", async () => {
    await expect(recomputeDaysForOrder(fakePrisma({ profile: false }), "o1", [day("2026-08-07")])).resolves.toBeUndefined();
    expect(recalcSpy).not.toHaveBeenCalled();
  });

  it("нет владельца, которым подписать пересчёт — тихо выходим", async () => {
    await expect(recomputeDaysForOrder(fakePrisma({ owner: false }), "o1", [day("2026-08-07")])).resolves.toBeUndefined();
    expect(recalcSpy).not.toHaveBeenCalled();
  });

  it("упавший пересчёт не выбрасывает наружу", async () => {
    // Иначе вебхук курьера или сохранение заказа падали бы из-за финансов.
    recalcSpy.mockRejectedValueOnce(new Error("база недоступна"));
    await expect(recomputeDaysForOrder(fakePrisma(), "o1", [day("2026-08-07")])).resolves.toBeUndefined();
  });

  it("отсутствующий заказ в короткой форме не ломает ничего", async () => {
    const empty = { order: { findUnique: async () => null } } as unknown as PrismaClient;
    await expect(recomputeDayForOrder(empty, "нет-такого")).resolves.toBeUndefined();
    expect(recalcSpy).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from "vitest";
import { indexByExternalId, type CatalogRow } from "./matchIndex";

/**
 * Цена ошибки здесь уже известна: заказ JF-1000970 связался с удалённым дублем товара, у
 * которого не было цены флориста, и второстепенный флорист увидел в позиции полную цену
 * клиента ($239 вместо $167). Побеждала просто последняя строка выборки.
 */
const row = (id: string, opts: Partial<CatalogRow> & { tag: string }): CatalogRow & { tag: string } => ({
  externalId: id,
  remoteDeleted: false,
  lastSyncedAt: null,
  ...opts,
});

const tagOf = (m: Map<string, { tag: string }>, id: string) => m.get(id)?.tag;

describe("индекс каталога по внешнему id", () => {
  it("живая запись побеждает удалённую независимо от порядка", () => {
    const live = row("1000380", { tag: "live" });
    const dead = row("1000380", { tag: "dead", remoteDeleted: true });
    expect(tagOf(indexByExternalId([live, dead]), "1000380")).toBe("live");
    expect(tagOf(indexByExternalId([dead, live]), "1000380")).toBe("live");
  });

  it("среди живых берётся синхронизированная свежее", () => {
    const old = row("77", { tag: "old", lastSyncedAt: new Date("2026-08-01T00:00:00Z") });
    const fresh = row("77", { tag: "fresh", lastSyncedAt: new Date("2026-08-07T00:00:00Z") });
    expect(tagOf(indexByExternalId([fresh, old]), "77")).toBe("fresh");
    expect(tagOf(indexByExternalId([old, fresh]), "77")).toBe("fresh");
  });

  it("удалённая запись остаётся, если живой нет вовсе", () => {
    // Товар действительно убрали из магазина: связать заказ со старой записью лучше, чем
    // не связать ни с чем — иначе позиция теряет состав букета и цену флориста.
    const dead = row("99", { tag: "dead", remoteDeleted: true });
    expect(tagOf(indexByExternalId([dead]), "99")).toBe("dead");
  });

  it("свежесть НЕ перебивает удалённость", () => {
    // Удалённая может быть синхронизирована позже живой — приоритет всё равно у живой.
    const live = row("5", { tag: "live", lastSyncedAt: new Date("2026-08-01T00:00:00Z") });
    const dead = row("5", { tag: "dead", remoteDeleted: true, lastSyncedAt: new Date("2026-08-09T00:00:00Z") });
    expect(tagOf(indexByExternalId([dead, live]), "5")).toBe("live");
  });

  it("разные id не мешают друг другу, пустой вход даёт пустую карту", () => {
    const m = indexByExternalId([row("a", { tag: "A" }), row("b", { tag: "B" })]);
    expect([tagOf(m, "a"), tagOf(m, "b")]).toEqual(["A", "B"]);
    expect(indexByExternalId([]).size).toBe(0);
  });
});

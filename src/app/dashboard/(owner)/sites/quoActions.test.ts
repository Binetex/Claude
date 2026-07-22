import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Юнит-тесты серверных действий привязки QUO-номера (мок-слой, без БД/сети):
 * список номеров, валидная привязка (id+номер+включение), отклонение несуществующего id,
 * запрет дубликата на другом Site, «ошибка проверки не стирает привязку», отвязка не трогает историю.
 */

const listPhoneNumbers = vi.fn<() => Promise<{ id: string; number?: string }[]>>();
const siteUpdate = vi.fn<(a: { where: unknown; data: Record<string, unknown> }) => Promise<unknown>>();
const siteFindFirst = vi.fn<(a: unknown) => Promise<unknown>>();
const siteFindUnique = vi.fn<(a: unknown) => Promise<unknown>>();

vi.mock("@/lib/rbac", () => ({ requireRole: vi.fn(async () => ({ id: "u", role: "OWNER" })) }));
vi.mock("@/lib/db", () => ({ prisma: { site: { update: (a: unknown) => siteUpdate(a as { where: unknown; data: Record<string, unknown> }), findFirst: (a: unknown) => siteFindFirst(a), findUnique: (a: unknown) => siteFindUnique(a) } } }));
vi.mock("@/integrations/quo/config", () => ({ getQuoConfig: () => ({ apiKey: "secret", baseUrl: "https://api" }) }));
vi.mock("@/lib/featureFlags", () => ({ featureFlags: { quo: true } }));
vi.mock("@/integrations/quo/client", () => ({ createQuoClient: () => ({ listPhoneNumbers: () => listPhoneNumbers() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { ownerQuoListNumbers, ownerQuoSaveNumber, ownerQuoCheckConnection, ownerQuoUnlink } from "./quoActions";

beforeEach(() => {
  listPhoneNumbers.mockReset();
  siteUpdate.mockReset(); siteUpdate.mockResolvedValue({});
  siteFindFirst.mockReset(); siteFindFirst.mockResolvedValue(null);
  siteFindUnique.mockReset(); siteFindUnique.mockResolvedValue(null);
});

describe("ownerQuoListNumbers", () => {
  it("возвращает номера с читаемым лейблом, без секретов", async () => {
    listPhoneNumbers.mockResolvedValue([{ id: "PN1", number: "+13105558421" }]);
    const r = await ownerQuoListNumbers();
    expect(r.numbers).toHaveLength(1);
    expect(r.numbers![0]).toMatchObject({ id: "PN1", number: "+13105558421" });
    expect(r.numbers![0].label).toContain("PN1");
    expect(JSON.stringify(r)).not.toContain("secret"); // ключ не утёк
  });
});

describe("ownerQuoSaveNumber", () => {
  it("валидный id → сохраняет id + фактический номер + включает QUO", async () => {
    listPhoneNumbers.mockResolvedValue([{ id: "PN1", number: "+13105558421" }]);
    const r = await ownerQuoSaveNumber("s1", "PN1");
    expect(r).toEqual({ ok: true });
    expect(siteUpdate).toHaveBeenCalledTimes(1);
    expect(siteUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: "s1" },
      data: { quoPhoneNumberId: "PN1", quoPhoneNumber: "+13105558421", quoEnabled: true, quoConnectionError: null },
    });
  });

  it("несуществующий id → ошибка, привязка НЕ пишется", async () => {
    listPhoneNumbers.mockResolvedValue([{ id: "PN2", number: "+1999" }]);
    const r = await ownerQuoSaveNumber("s1", "PN1");
    expect(r.error).toBeTruthy();
    expect(siteUpdate).not.toHaveBeenCalled();
  });

  it("дубликат id на другом Site → запрет (и без вызова QUO/записи)", async () => {
    siteFindFirst.mockResolvedValue({ id: "otherSite" });
    const r = await ownerQuoSaveNumber("s1", "PN1");
    expect(r.error).toContain("другому магазину");
    expect(listPhoneNumbers).not.toHaveBeenCalled();
    expect(siteUpdate).not.toHaveBeenCalled();
  });
});

describe("ownerQuoCheckConnection — ошибка не стирает привязку", () => {
  it("QUO API недоступен → ошибка, quoPhoneNumberId НЕ обнуляется", async () => {
    siteFindUnique.mockResolvedValue({ quoPhoneNumberId: "PN1" });
    listPhoneNumbers.mockRejectedValue(new Error("network"));
    const r = await ownerQuoCheckConnection("s1");
    expect(r.error).toBeTruthy();
    // Апдейт только помечает ошибку, привязку не трогает.
    const data = siteUpdate.mock.calls[0]?.[0]?.data ?? {};
    expect(data).toHaveProperty("quoConnectionError");
    expect(data).not.toHaveProperty("quoPhoneNumberId");
  });
});

describe("ownerQuoUnlink — чистит только привязку, историю не трогает", () => {
  it("обнуляет привязку и выключает QUO; не обращается к orderCommunication", async () => {
    const r = await ownerQuoUnlink("s1");
    expect(r).toEqual({ ok: true });
    expect(siteUpdate.mock.calls[0][0].data).toMatchObject({ quoPhoneNumberId: null, quoPhoneNumber: null, quoEnabled: false });
    // prisma-мок не содержит orderCommunication — если бы действие его дёргало, тест упал бы.
  });
});

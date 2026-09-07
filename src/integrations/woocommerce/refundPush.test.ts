import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Запись возврата в магазин. Проверяем ровно то, что дороже всего ошибиться:
 * возврат помечается «сделан вне магазина» (иначе плагин вернёт деньги второй раз),
 * и своя запись узнаётся по метке, а не по совпадению суммы.
 */
const requests: { path: string; init: Record<string, unknown> }[] = [];
let response: unknown = { id: 0 };

vi.mock("./client", () => ({
  wooRequest: async (_creds: unknown, path: string, init: Record<string, unknown> = {}) => {
    requests.push({ path, init });
    return { data: response, total: null, totalPages: null, status: 200 };
  },
}));

const { recordWooRefund, findRecordedRefund, WOO_REFUND_MARKER_KEY } = await import("./refundPush");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const creds = { siteId: "s1", storeUrl: "https://shop", apiBaseUrl: "https://shop/wp-json/wc/v3", apiVersion: "wc/v3", consumerKey: "ck", consumerSecret: "cs" } as any;

beforeEach(() => {
  requests.length = 0;
  response = { id: 0 };
});

describe("recordWooRefund", () => {
  it("возврат записывается как сделанный ВНЕ магазина: api_refund=false", async () => {
    // true заставило бы плагин Airwallex вернуть деньги второй раз — этого значения быть не должно.
    response = { id: 77 };
    const id = await recordWooRefund(creds, "1234", { amount: 25.5, reason: "Requested by customer", airwallexRefundId: "rfd_1" });

    expect(id).toBe(77);
    expect(requests).toHaveLength(1);
    const body = requests[0].init.body as Record<string, unknown>;
    expect(requests[0].path).toBe("/orders/1234/refunds");
    expect(requests[0].init.method).toBe("POST");
    expect(body.api_refund).toBe(false);
    expect(body.amount).toBe("25.50");
    expect(body.reason).toBe("Requested by customer");
    expect(body.meta_data).toEqual([{ key: WOO_REFUND_MARKER_KEY, value: "rfd_1" }]);
  });
});

describe("findRecordedRefund", () => {
  it("находит СВОЮ запись по метке возврата Airwallex", async () => {
    response = [
      { id: 10, amount: "25.50", meta_data: [{ key: "other", value: "x" }] },
      { id: 11, amount: "25.50", meta_data: [{ key: WOO_REFUND_MARKER_KEY, value: "rfd_1" }] },
    ];
    expect(await findRecordedRefund(creds, "1234", "rfd_1")).toBe(11);
  });

  it("чужой возврат на ту же сумму своей записью не считается", async () => {
    // Частичные возвраты одинаковыми суммами — обычное дело; по сумме их путать нельзя.
    response = [{ id: 10, amount: "25.50", meta_data: [] }];
    expect(await findRecordedRefund(creds, "1234", "rfd_1")).toBeNull();
  });

  it("возвратов нет вовсе — записывать можно", async () => {
    response = [];
    expect(await findRecordedRefund(creds, "1234", "rfd_1")).toBeNull();
  });
});

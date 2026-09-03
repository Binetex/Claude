/**
 * Догоняющий синк заказов Woo — страховка от задержки вебхуков магазина.
 *
 * История: 03.09.2026 заказ THEFLOW-20654 создан в 17:43, вебхук о нём пришёл в 18:18 (WP-Cron
 * на стороне магазина выключен, доставку тянет его планировщик). 34 минуты заказа не было в
 * дашборде. Эти тесты закрепляют то, из-за чего страховка может молча перестать работать.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

const syncWooOrders = vi.fn();
vi.mock("./orderSync", () => ({ syncWooOrders: (siteId: string) => syncWooOrders(siteId) }));

import { recoverWooOrders } from "./ordersRecovery";

const prismaWith = (rows: { siteId: string }[]) => {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { client: { wooCommerceConnection: { findMany } } as unknown as PrismaClient, findMany };
};

beforeEach(() => {
  syncWooOrders.mockReset();
  syncWooOrders.mockResolvedValue(undefined);
});

describe("догоняющий синк заказов Woo", () => {
  it("синхронизирует каждый подключённый магазин", async () => {
    const { client } = prismaWith([{ siteId: "s1" }, { siteId: "s2" }]);

    const res = await recoverWooOrders(client);

    expect(syncWooOrders.mock.calls.map((c) => c[0])).toEqual(["s1", "s2"]);
    expect(res).toEqual({ sites: 2, failed: 0 });
  });

  it("отключённые подключения не трогает — фильтр в запросе", async () => {
    const { client, findMany } = prismaWith([]);

    await recoverWooOrders(client);

    const where = findMany.mock.calls[0][0].where;
    expect(where.connStatus).toEqual({ not: "DISCONNECTED" });
    expect(where.site).toEqual({ platform: "WOOCOMMERCE" });
    expect(syncWooOrders).not.toHaveBeenCalled();
  });

  it("сбой одного магазина не отменяет остальные и виден в отчёте", async () => {
    // Иначе первый же магазин с протухшими кредами выключил бы страховку для всех — молча.
    const { client } = prismaWith([{ siteId: "s1" }, { siteId: "s2" }, { siteId: "s3" }]);
    syncWooOrders.mockImplementation((siteId: string) => {
      if (siteId === "s2") return Promise.reject(new Error("401 unauthorized"));
      return Promise.resolve(undefined);
    });

    const res = await recoverWooOrders(client);

    expect(syncWooOrders).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ sites: 3, failed: 1 });
  });

  it("магазинов нет — проход пустой, без обращений к Woo", async () => {
    const { client } = prismaWith([]);
    await expect(recoverWooOrders(client)).resolves.toEqual({ sites: 0, failed: 0 });
  });
});

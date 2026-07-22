/**
 * Автоматическая регистрация подписок при подключении магазина.
 *
 * Инцидент 22.07.2026: у магазина Par подключение было CONNECTED, scopes выданы, но ни одной
 * подписки в Shopify не существовало — заказы молча не приходили трое суток, потому что
 * registerWebhooks не вызывался ниоткуда. Тесты фиксируют контракт хука:
 *  - при успешной проверке подключения подписки сверяются автоматически;
 *  - при неуспешной — не дёргаем Shopify (валидного токена всё равно нет);
 *  - сбой регистрации НЕ ломает подключение (credentials уже сохранены).
 *
 * ВАЖНО: здесь НЕТ beforeEach с mockClear/mockReset. В vitest 4 очистка мока в beforeEach
 * приводит к тому, что throw из мока засчитывается тесту как необработанная ошибка, хотя код
 * её корректно ловит. Поэтому реализацию задаёт каждый тест сам, а «не вызывался» проверяется
 * дельтой числа вызовов.
 */
import { describe, it, expect, vi } from "vitest";
import type { ConnectionResult } from "./connectionLogic";

const { registerMock } = vi.hoisted(() => ({ registerMock: vi.fn() }));
vi.mock("./webhookRegistration", () => ({ registerWebhooks: registerMock }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("./connection", () => ({ checkConnection: vi.fn() }));
vi.mock("@/lib/crypto/secretBox", () => ({ encryptSecret: (s: string) => s, maskSecret: () => "***" }));

import { ensureWebhooksBestEffort } from "./management";

const okResult = { ok: true, status: "CONNECTED", grantedScopes: [], error: null } as unknown as ConnectionResult;
const failResult = { ok: false, status: "REAUTH_REQUIRED", grantedScopes: [], error: "нет доступа" } as unknown as ConnectionResult;

const callCount = () => registerMock.mock.calls.length;

describe("ensureWebhooksBestEffort", () => {
  it("успешное подключение → подписки регистрируются автоматически", async () => {
    registerMock.mockResolvedValue({ created: ["ORDERS_CREATE"], existing: [], failed: [] });
    const before = callCount();
    await ensureWebhooksBestEffort("site1", okResult);
    expect(callCount()).toBe(before + 1);
    expect(registerMock).toHaveBeenLastCalledWith("site1");
  });

  it("проверка подключения не прошла → Shopify не дёргаем", async () => {
    const before = callCount();
    await ensureWebhooksBestEffort("site1", failResult);
    expect(callCount()).toBe(before);
  });

  it("все подписки уже на месте → вызов идемпотентен", async () => {
    registerMock.mockResolvedValue({ created: [], existing: ["ORDERS_CREATE"], failed: [] });
    const before = callCount();
    await ensureWebhooksBestEffort("site1", okResult);
    expect(callCount()).toBe(before + 1);
  });

  it("часть топиков не создалась → подключение НЕ падает", async () => {
    registerMock.mockResolvedValue({ created: [], existing: [], failed: [{ topic: "ORDERS_CREATE", error: "denied" }] });
    await expect(ensureWebhooksBestEffort("site1", okResult)).resolves.toBeUndefined();
  });

  it("Shopify недоступен → исключение проглатывается, подключение остаётся валидным", async () => {
    registerMock.mockImplementation(() => { throw new Error("network down"); });
    await expect(ensureWebhooksBestEffort("site1", okResult)).resolves.toBeUndefined();
  });
});

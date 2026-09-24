import { describe, it, expect } from "vitest";
import { RETRYABLE_DELIVERY_STATUSES } from "./retryService";

/**
 * Когда привязка существующего Burq Order спрашивает подтверждение.
 *
 * 24.09.2026 (OHARA-1073): флорист завёл доставку в кабинете Burq руками, наш автомат секундой
 * позже создал СВОЙ черновик — и привязка настоящей доставки упёрлась в вопрос «у заказа уже
 * есть активная доставка». Про пустую заготовку, которую в Burq никто не оформлял. На телефоне
 * вопрос был не виден, и это читалось как «кнопка не работает».
 */
const AUTO_REPLACEABLE = new Set<string>([...RETRYABLE_DELIVERY_STATUSES, "DRAFT_PENDING", "DRAFT_CREATED"]);

describe("замена текущей попытки при ручной привязке", () => {
  it("неотправленный черновик заменяется без вопроса", () => {
    expect(AUTO_REPLACEABLE.has("DRAFT_PENDING")).toBe(true);
    expect(AUTO_REPLACEABLE.has("DRAFT_CREATED")).toBe(true);
  });

  it("провальная попытка заменяется без вопроса", () => {
    for (const s of ["CANCELLED", "FAILED", "PROBLEM", "RETURNED"]) expect(AUTO_REPLACEABLE.has(s)).toBe(true);
  });

  it("живая доставка требует подтверждения: за курьера уже платят", () => {
    for (const s of ["SCHEDULED", "COURIER_ASSIGNED", "COURIER_EN_ROUTE_TO_PICKUP", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "DELIVERED"]) {
      expect(AUTO_REPLACEABLE.has(s)).toBe(false);
    }
  });
});

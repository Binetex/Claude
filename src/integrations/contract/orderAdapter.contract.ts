import { expect } from "vitest";
import type { OrderAdapter } from "@/integrations/types";
import type { NormalizedOrder } from "@/integrations/normalized";

/**
 * Общая контракт-сюита для `OrderAdapter`. Любая реализация (Shopify/Woo/будущие) должна
 * проходить её — так интеграции остаются поведенчески совместимыми и UI/бизнес-логика
 * не зависят от конкретной платформы. Вызывается из per-adapter тестов с валидным payload.
 */
export function assertOrderAdapterContract(adapter: OrderAdapter, rawPayload: unknown): NormalizedOrder {
  const order = adapter.parseWebhook(rawPayload);

  // Платформа адаптера согласована с результатом.
  expect(order.platform).toBe(adapter.platform);

  // Обязательные идентификаторы и структура.
  expect(typeof order.externalId).toBe("string");
  expect(order.externalId.length).toBeGreaterThan(0);
  expect(Array.isArray(order.items)).toBe(true);

  // Денежные поля — числа (не Decimal, не строки): безопасно для сериализации в UI.
  for (const [key, value] of Object.entries(order.money)) {
    expect(typeof value, `money.${key} должно быть числом`).toBe("number");
    expect(Number.isFinite(value), `money.${key} конечно`).toBe(true);
  }

  // Каждая позиция — консистентна.
  for (const item of order.items) {
    expect(typeof item.name).toBe("string");
    expect(typeof item.quantity).toBe("number");
    expect(item.quantity).toBeGreaterThanOrEqual(0);
    expect(typeof item.unitPrice).toBe("number");
    expect(Number.isFinite(item.unitPrice)).toBe(true);
  }

  // Нормализованные статусы заполнены внутренними enum-значениями.
  expect(order.status.payment).toBeTruthy();
  expect(order.status.order).toBeTruthy();

  // createdAt — сериализуемая строка (ISO), не Date-объект.
  expect(typeof order.createdAt).toBe("string");

  // Идемпотентность парсинга: тот же payload → тот же externalId и число позиций.
  const again = adapter.parseWebhook(rawPayload);
  expect(again.externalId).toBe(order.externalId);
  expect(again.items.length).toBe(order.items.length);

  return order;
}

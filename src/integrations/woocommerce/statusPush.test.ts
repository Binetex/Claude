import { describe, it, expect } from "vitest";
import { isPushableWooStatus, WOO_PAID_STATUS } from "./statusPush";

describe("какие статусы Woo можно перевести в оплаченные", () => {
  it("перезаписываем ожидание оплаты, включая собственный статус плагина Airwallex", () => {
    // Ради этого статуса всё и делается: заказ висит в нём, пока платёж не разрешится.
    expect(isPushableWooStatus("airwallex-pending")).toBe(true);
    expect(isPushableWooStatus("pending")).toBe(true);
    expect(isPushableWooStatus("on-hold")).toBe(true);
  });

  it("не трогаем уже оплаченные — писать нечего и лишний вебхук не будим", () => {
    expect(isPushableWooStatus("processing")).toBe(false);
    expect(isPushableWooStatus("completed")).toBe(false);
  });

  it("не перебиваем терминальные решения магазина", () => {
    expect(isPushableWooStatus("cancelled")).toBe(false);
    expect(isPushableWooStatus("refunded")).toBe(false);
  });

  it("отказ магазина не переписываем молча: это расхождение для человека", () => {
    // Airwallex говорит «оплачено», Woo — «отказ». Тихо назначить processing здесь было бы
    // подменой чужого решения; такие случаи монитор помечает как mismatch и уведомляет владельца.
    expect(isPushableWooStatus("failed")).toBe(false);
  });

  it("незнакомый статус — не наш случай, молчим", () => {
    expect(isPushableWooStatus("wc-custom-thing")).toBe(false);
    expect(isPushableWooStatus(null)).toBe(false);
    expect(isPushableWooStatus(undefined)).toBe(false);
    expect(isPushableWooStatus("")).toBe(false);
  });

  it("регистр и пробелы не влияют", () => {
    expect(isPushableWooStatus("  Airwallex-Pending ")).toBe(true);
    expect(isPushableWooStatus("PENDING")).toBe(true);
  });

  it("в магазин пишется именно processing", () => {
    expect(WOO_PAID_STATUS).toBe("processing");
  });
});

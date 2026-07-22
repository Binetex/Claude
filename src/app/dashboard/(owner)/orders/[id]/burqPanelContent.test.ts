import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Гварды объединённого блока доставки (#4/#5). Панель — client-компонент с server-actions
 * (useActionState), поэтому проверяем исходник: удалённые подсказки отсутствуют, а перенесённое
 * содержимое (в т.ч. ручная привязка Burq Order ID) сохранено.
 */
const dir = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(dir, "BurqDeliveryPanel.tsx"), "utf8");

describe("#4 — Burq UI не содержит удалённых подсказок", () => {
  it("нет кнопки «Открыть Burq Dashboard»", () => {
    expect(panel).not.toContain("Открыть Burq Dashboard");
  });
  it("нет поиска по имени получателя и подсказки Live/Test mode", () => {
    expect(panel).not.toContain("buildDeliveryPanelView");
    expect(panel).not.toContain("findByNameText");
    expect(panel).not.toContain("modeHint");
    expect(panel).not.toContain("recipientName");
    expect(panel).not.toContain("dashboardUrl");
  });
});

describe("#4 — объединённый блок сохраняет нужное содержимое", () => {
  it("нормализованный + raw Burq статус, курьер, Доставка (факт), Proof of delivery", () => {
    expect(panel).toContain("rawProviderStatus");
    expect(panel).toContain("Курьер:");
    expect(panel).toContain("Доставка (факт)");
    expect(panel).toContain("Proof of delivery");
  });
  it("проблема/отмена + новая попытка + история", () => {
    expect(panel).toContain("Создать новую доставку Burq");
    expect(panel).toContain("История доставок Burq");
  });
  it("#5 — ручная привязка Burq Order ID сохранена", () => {
    expect(panel).toContain("<BurqLinkForm");
  });
});

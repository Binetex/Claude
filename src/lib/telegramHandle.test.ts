import { describe, it, expect } from "vitest";
import { normalizeTelegramHandle } from "./telegramHandle";

describe("ник в Telegram", () => {
  it("с «@», без него и ссылкой t.me — одно и то же", () => {
    expect(normalizeTelegramHandle("@arina_fl")).toBe("@arina_fl");
    expect(normalizeTelegramHandle(" arina_fl ")).toBe("@arina_fl");
    expect(normalizeTelegramHandle("https://t.me/arina_fl")).toBe("@arina_fl");
  });

  it("пусто — ника нет; не похоже на ник — отказ", () => {
    expect(normalizeTelegramHandle("  ")).toBeNull();
    expect(normalizeTelegramHandle("Арина")).toBeUndefined();
    expect(normalizeTelegramHandle("@abc")).toBeUndefined();
  });
});

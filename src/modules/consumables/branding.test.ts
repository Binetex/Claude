import { describe, it, expect } from "vitest";
import { storeHasBranding } from "./service";

/**
 * Своя упаковка у магазина определяет записки Care Guide. Конверт THEFLOW владелец перевёл на ручной
 * учёт (10.10.2026) — записки от этого не должны пропасть.
 */
describe("своя упаковка магазина", () => {
  it("конверт стал ручным, а записки остались — магазин всё ещё со своей упаковкой", () => {
    const items = [
      { siteId: "tf", autoRule: null },
      { siteId: "tf", autoRule: "CARE_GUIDE_VASE" },
      { siteId: "tf", autoRule: "CARE_GUIDE_BOUQUET" },
    ];
    expect(storeHasBranding(items, "tf")).toBe(true);
    expect(storeHasBranding(items, "par")).toBe(false);
  });

  it("общие позиции (без магазина) упаковку магазину не дают", () => {
    expect(storeHasBranding([{ siteId: null, autoRule: "CARE_GUIDE_VASE" }], "tf")).toBe(false);
  });
});

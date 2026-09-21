import { describe, it, expect } from "vitest";
import { decideReassignment } from "./reassignment";

/**
 * Пересоздание доставки опирается на то же правило Burq, что и переназначение флориста:
 * удалить по API можно только НЕИНИЦИИРОВАННЫЙ черновик. От этого зависит, спросит ли кнопка
 * подтверждение, — а цена ошибки здесь два курьера на один букет.
 */
describe("что можно сделать с текущей доставкой", () => {
  it("черновик не инициирован — удаляем в Burq и пересоздаём молча", () => {
    expect(decideReassignment("DRAFT_PENDING")).toEqual({ action: "DELETE_AND_RECREATE" });
    expect(decideReassignment("DRAFT_CREATED")).toEqual({ action: "DELETE_AND_RECREATE" });
  });

  it("доставка уже кончилась — отменять в Burq нечего", () => {
    for (const s of ["DELIVERED", "CANCELLED", "RETURNED", "FAILED"] as const) {
      expect(decideReassignment(s)).toEqual({ action: "FLAG_PROBLEM", reason: "terminal" });
    }
  });

  it("курьер ищется, назначен или уже едет — живая доставка, нужен человек", () => {
    // Ровно эти случаи кнопка обязана показать с подтверждением: DELETE по API запрещён,
    // и новая встанет рядом со старой.
    for (const s of ["SCHEDULED", "COURIER_ASSIGNED", "COURIER_EN_ROUTE_TO_PICKUP", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "PROBLEM"] as const) {
      expect(decideReassignment(s)).toEqual({ action: "FLAG_PROBLEM", reason: "draft_initiated" });
    }
  });
});

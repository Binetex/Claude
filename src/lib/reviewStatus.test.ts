import { describe, it, expect } from "vitest";
import { reviewStatusText } from "./reviewStatus";

/**
 * Владелец смотрит в список и спрашивает «что с ним сейчас». Ответом должна быть фраза, а не
 * ярлык шага: «ждёт звонка» не отвечает, звонили уже или нет.
 */
describe("reviewStatusText", () => {
  it("новый запрос — «ещё не звонили»", () => {
    expect(reviewStatusText("NEW", 0, 2)).toBe("ещё не звонили");
  });

  it("у звонков видно, какая попытка идёт", () => {
    expect(reviewStatusText("CALLING", 1, 2)).toBe("звоним, попытка 2 из 2");
    // Попыток сделано больше, чем разрешено (настройку уменьшили) — номер не выходит за предел.
    expect(reviewStatusText("CALLING", 5, 2)).toBe("звоним, попытка 2 из 2");
  });

  it("ход клиента и закрытые состояния тоже словами", () => {
    expect(reviewStatusText("LINK_SENT", 2, 2)).toContain("ждём клиента");
    expect(reviewStatusText("READY_TO_CHECK", 0, 2)).toContain("проверить");
    expect(reviewStatusText("CONFIRMED", 0, 2)).toBe("отзыв получен");
  });
});

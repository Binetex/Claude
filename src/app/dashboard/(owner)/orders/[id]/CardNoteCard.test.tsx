import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CardNoteCard } from "./CardNoteCard";

/**
 * Начальное состояние свёрнутого блока. Проверяется разметкой, а не глазами: правило
 * «раскрыт, если есть что показать» один раз уже сломалось.
 *
 * Заметка заказчика здесь больше НЕ живёт — она уехала в плашку под полосой доставки
 * (`CustomerNoteBanner`). Последний тест закрепляет именно это: вернувшееся сюда второе
 * поле на то же значение спорило бы с плашкой через OCC.
 */
// TooltipProvider — как в корневом layout: кнопки копирования внутри блока живут в нём.
const render = (cardMessage: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <CardNoteCard orderId="o1" updatedAt="2026-08-06T00:00:00.000Z" cardMessage={cardMessage} collapsible />
    </TooltipProvider>
  );

// React отдаёт булев атрибут как open="" — голого `open` в разметке не будет.
const isOpen = (html: string) => /<details[^>]*\sopen(=""|[\s>])/.test(html);

describe("CardNoteCard — свёрнут или раскрыт", () => {
  it("есть открытка — раскрыт", () => {
    expect(isOpen(render("С днём рождения!"))).toBe(true);
  });

  it("пусто — свёрнут", () => {
    expect(isOpen(render(""))).toBe(false);
  });

  it("одни пробелы — это пусто, а не содержимое", () => {
    expect(isOpen(render("   "))).toBe(false);
  });

  it("текст открытки показан", () => {
    expect(render("Поздравляю")).toContain("Поздравляю");
  });

  it("заметки заказчика в блоке нет — она живёт своей плашкой наверху", () => {
    const html = render("Поздравляю");
    expect(html).not.toContain("Заметка заказчика");
    expect(html).not.toContain("Добавить заметку заказчика");
  });
});

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CardNoteCard } from "./CardNoteCard";

/**
 * Начальное состояние свёрнутого блока. Проверяется разметкой, а не глазами: правило
 * «раскрыт, если есть что показать» один раз уже сломалось — учитывалась только открытка,
 * и заказ с заметкой заказчика открывался свёрнутым.
 */
// TooltipProvider — как в корневом layout: кнопки копирования внутри блока живут в нём.
const render = (cardMessage: string, customerNote: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <CardNoteCard
        orderId="o1"
        updatedAt="2026-08-06T00:00:00.000Z"
        cardMessage={cardMessage}
        customerNote={customerNote}
        collapsible
      />
    </TooltipProvider>
  );

// React отдаёт булев атрибут как open="" — голого `open` в разметке не будет.
const isOpen = (html: string) => /<details[^>]*\sopen(=""|[\s>])/.test(html);

describe("CardNoteCard — свёрнут или раскрыт", () => {
  it("есть открытка — раскрыт", () => {
    expect(isOpen(render("С днём рождения!", ""))).toBe(true);
  });

  it("есть только заметка заказчика — тоже раскрыт", () => {
    expect(isOpen(render("", "Позвонить за час до доставки"))).toBe(true);
  });

  it("есть и то и другое — раскрыт", () => {
    expect(isOpen(render("Поздравляю", "Оставить у двери"))).toBe(true);
  });

  it("пусто — свёрнут", () => {
    expect(isOpen(render("", ""))).toBe(false);
  });

  it("одни пробелы — это пусто, а не содержимое", () => {
    expect(isOpen(render("   ", "\n  \t "))).toBe(false);
  });

  it("раскрытый блок сразу показывает заметку, а не кнопку «добавить»", () => {
    const html = render("", "Позвонить за час");
    expect(html).toContain("Позвонить за час");
    expect(html).not.toContain("Добавить заметку заказчика");
  });
});

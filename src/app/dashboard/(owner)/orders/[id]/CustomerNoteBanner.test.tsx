import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CustomerNoteBanner } from "./CustomerNoteBanner";

/**
 * Заметка заказчика на первом экране. История: она лежала внизу свёрнутого блока «Открытка»,
 * и «позвонить за час до доставки» видел только тот, кто знал, куда смотреть.
 *
 * Тесты закрепляют то, ради чего плашка сделана: заметка ВИДНА сразу и жёлтым, а пустая
 * заметка не занимает первый экран.
 */
// TooltipProvider — как в корневом layout: кнопка копирования внутри плашки живёт в нём.
const render = (customerNote: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <CustomerNoteBanner orderId="o1" updatedAt="2026-09-04T00:00:00.000Z" customerNote={customerNote} />
    </TooltipProvider>
  );

describe("плашка «Заметка заказчика»", () => {
  it("текст заметки виден сразу, без раскрытия", () => {
    const html = render("Позвонить за час до доставки");
    expect(html).toContain("Позвонить за час до доставки");
    expect(html).toContain("Заметка заказчика");
    expect(html).not.toContain("<details");
  });

  it("заметку можно править и копировать прямо из плашки", () => {
    // Компонент ролей не знает: пускает или нет — решает saveOrderBlock. Здесь важно
    // лишь то, что оба действия доступны в самой плашке, а не спрятаны в другом блоке.
    const html = render("Оставить у консьержа");
    expect(html).toContain("Изменить");
    expect(html).toContain("Копировать");
  });

  it("переносы строк не склеиваются — заметку пишут списком", () => {
    // Текст рендерится как есть; склейка строк («Код 42 Позвонить») теряет смысл записи.
    const html = render("Код 42\nПозвонить");
    expect(html).toContain("Код 42\nПозвонить");
  });

  it("пустая заметка не рисует плашку, но добавить заметку можно", () => {
    const html = render("");
    expect(html).not.toContain("ЗАМЕТКА ЗАКАЗЧИКА");
    expect(html).not.toContain("Изменить");
    expect(html).toContain("Добавить заметку заказчика");
  });

  it("пробелы — это пусто, а не заметка", () => {
    expect(render("   \n \t ")).toContain("Добавить заметку заказчика");
  });
});

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CourierNoteCard } from "./CourierNoteCard";

/**
 * Инструкция курьеру — отдельное поле, единственное уезжающее в Burq.
 *
 * История: раньше курьеру уходила «заметка заказчика», а команда пользуется ею как
 * внутренней записью — курьер читал «Просит пораньше» и «Тест». Эти тесты закрепляют
 * границу: здесь пишут ДЛЯ курьера и знают, что текст уйдёт наружу.
 */
const render = (courierNote: string, deliveryAlreadyCreated = false) =>
  renderToStaticMarkup(
    <CourierNoteCard
      orderId="o1"
      updatedAt="2026-09-04T00:00:00.000Z"
      courierNote={courierNote}
      deliveryAlreadyCreated={deliveryAlreadyCreated}
    />
  );

describe("инструкция курьеру", () => {
  it("показывает текст и даёт его править", () => {
    const html = render("Ворота со стороны Sunset, код 3262");
    expect(html).toContain("Ворота со стороны Sunset, код 3262");
    expect(html).toContain("Инструкция курьеру");
    expect(html).toContain("Изменить");
  });

  it("пустая — только тихая кнопка, поле заполняется редко", () => {
    const html = render("");
    expect(html).toContain("Добавить инструкцию курьеру");
    expect(html).not.toContain("Изменить");
  });

  it("когда курьер уже вызван — честно предупреждает, что текст до него не дойдёт", () => {
    // Инструкцию созданного черновика Burq изменить нельзя, а пересоздавать доставку
    // из-за правки текста значило бы отменить вызванного курьера.
    expect(render("Код 3262", true)).toContain("Курьер уже вызван");
  });

  it("пока курьер не вызван — предупреждения нет", () => {
    expect(render("Код 3262", false)).not.toContain("Курьер уже вызван");
  });

  it("переносы строк сохраняются", () => {
    expect(render("Ворота с Sunset\nКод 3262")).toContain("Ворота с Sunset\nКод 3262");
  });
});

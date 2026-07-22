import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunicationTimeline, type TimelineItem } from "./CommunicationTimeline";

function item(over: Partial<TimelineItem>): TimelineItem {
  return {
    id: "c1", type: "SMS", direction: "INBOUND", status: "RECEIVED", partyRole: "CUSTOMER",
    externalPhone: "+13105551234", messageText: "hi", durationSeconds: null, recordingUrl: null,
    transcript: null, summary: null, attachments: [], occurredAt: "2026-07-20T10:00:00Z", sentByName: null, ...over,
  };
}

describe("CommunicationTimeline (render)", () => {
  it("рендерит элементы в переданном порядке и без ошибок", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ id: "a", messageText: "FIRST" }), item({ id: "b", messageText: "SECOND" })]} />);
    expect(html).toContain("FIRST");
    expect(html).toContain("SECOND");
    expect(html.indexOf("FIRST")).toBeLessThan(html.indexOf("SECOND")); // порядок сохранён
  });

  it("длинный транскрипт сворачивается (кнопка «Показать полностью») (§16.5)", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ type: "CALL", status: "COMPLETED", transcript: "т".repeat(400) })]} />);
    expect(html).toContain("Показать полностью");
  });

  it("короткий транскрипт без кнопки сворачивания", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ type: "CALL", status: "COMPLETED", transcript: "коротко" })]} />);
    expect(html).not.toContain("Показать полностью");
    expect(html).toContain("коротко");
  });

  it("отсутствие записи/транскрипта обрабатывается без ошибки (§16.11)", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ type: "CALL", status: "MISSED", recordingUrl: null, transcript: null, summary: null })]} />);
    expect(html).toContain("Запись недоступна");
  });

  it("запись воспроизводится через player + ссылку", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ type: "CALL", status: "COMPLETED", recordingUrl: "https://rec/1.mp3" })]} />);
    expect(html).toContain("<audio");
    expect(html).toContain("Открыть запись");
  });

  it("пустая история — без ошибки", () => {
    expect(renderToStaticMarkup(<CommunicationTimeline items={[]} />)).toContain("Коммуникаций пока нет");
  });

  it("адаптивно для 375px: перенос/обрезка, без фиксированной большой ширины", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ messageText: "оченьдлинноесловобезпробелов".repeat(10), transcript: null })]} />);
    expect(html).toContain("break-words"); // длинный текст переносится
    expect(html).toContain("flex-wrap"); // шапка переносится
    expect(html).not.toMatch(/w-\[\d{3,}px\]/); // нет фиксированной ширины в сотни px
  });

  it("исходящее → автор «🌸 Вы» (вместо «SMS»)", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ direction: "OUTBOUND", status: "DELIVERED", messageText: "hi" })]} inboundLabel="Получатель" />);
    expect(html).toContain("Вы");
    expect(html).not.toContain("→ SMS");
  });

  it("входящее → автор = метка активной вкладки (Получатель / Заказчик)", () => {
    const recip = renderToStaticMarkup(<CommunicationTimeline items={[item({ direction: "INBOUND" })]} inboundLabel="Получатель" />);
    expect(recip).toContain("Получатель");
    const cust = renderToStaticMarkup(<CommunicationTimeline items={[item({ direction: "INBOUND" })]} inboundLabel="Заказчик" />);
    expect(cust).toContain("Заказчик");
  });

  it("пропущенный входящий звонок: автор — сторона, статус «пропущен»", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ type: "CALL", direction: "INBOUND", status: "MISSED", messageText: null })]} inboundLabel="Заказчик" />);
    expect(html).toContain("Заказчик");
    expect(html).toContain("пропущен");
  });

  it("MMS с фото: миниатюра (img) + ссылка «Открыть»", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ messageText: null, attachments: [{ url: "https://cdn.example/p1.jpg", type: "image/jpeg" }] })]} />);
    expect(html).toContain("<img");
    expect(html).toContain("https://cdn.example/p1.jpg");
    expect(html).toContain("Открыть");
    expect(html).not.toContain("(без текста)"); // не выглядит пустым
  });

  it("несколько вложений — показываются все", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ messageText: "две картинки", attachments: [{ url: "https://cdn.example/a.png", type: "image/png" }, { url: "https://cdn.example/b.png", type: "image/png" }] })]} />);
    expect(html).toContain("https://cdn.example/a.png");
    expect(html).toContain("https://cdn.example/b.png");
    expect(html).toContain("две картинки"); // текст SMS не потерян
  });

  it("MMS без текста и без вложений → «(без текста)», не пустая строка", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ messageText: null, attachments: [] })]} />);
    expect(html).toContain("(без текста)");
  });

  it("не-image вложение → безопасная ссылка с именем/типом (без <img>)", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ messageText: null, attachments: [{ url: "https://cdn.example/doc.pdf", type: "application/pdf" }] })]} />);
    expect(html).toContain("https://cdn.example/doc.pdf");
    expect(html).toContain("application/pdf");
    expect(html).not.toContain("<img");
  });

  it("вложение с «битым»/необычным url не роняет ленту", () => {
    expect(() => renderToStaticMarkup(<CommunicationTimeline items={[item({ messageText: null, attachments: [{ url: "not a real url", type: null }] })]} />)).not.toThrow();
  });

  it("обычный SMS без вложений не изменился", () => {
    const html = renderToStaticMarkup(<CommunicationTimeline items={[item({ messageText: "просто текст" })]} />);
    expect(html).toContain("просто текст");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("(без текста)");
  });
});

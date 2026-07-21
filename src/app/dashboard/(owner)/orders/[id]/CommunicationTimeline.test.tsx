import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunicationTimeline, type TimelineItem } from "./CommunicationTimeline";

function item(over: Partial<TimelineItem>): TimelineItem {
  return {
    id: "c1", type: "SMS", direction: "INBOUND", status: "RECEIVED", partyRole: "CUSTOMER",
    externalPhone: "+13105551234", messageText: "hi", durationSeconds: null, recordingUrl: null,
    transcript: null, summary: null, occurredAt: "2026-07-20T10:00:00Z", sentByName: null, ...over,
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
});

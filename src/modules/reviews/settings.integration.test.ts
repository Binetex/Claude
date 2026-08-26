/**
 * Настройки сообщений клиенту. Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, что ломается молча: несуществующая переменная подставляется пустотой (клиент
 * получит фразу с дырой), текст без ссылки бессмысленен, а кириллица в сообщении американскому
 * покупателю — брак, о котором иначе узнаёшь только по тишине в ответ.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { saveReviewSettings, listReviewSettings } from "./settings";
import { resolveReviewSettings, DEFAULT_REVIEW_SETTINGS } from "./requests";

const RUN = `rset-${Date.now()}`;
let siteId = "";

const base = {
  askSmsTemplate: "Hi {{sender_name}}, please review us: {{review_url}}",
  askBrevoTemplateId: "",
  reminderSmsTemplate: "",
  reminderBrevoTemplateId: "",
  promiseWaitDays: "",
  maxCallAttempts: "",
  callRetryDays: "",
};

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "RST", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;
});

beforeEach(async () => {
  await prisma.siteReviewSettings.deleteMany({ where: { siteId } });
});

afterAll(async () => {
  await prisma.siteReviewSettings.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("проверка текста", () => {
  it("несуществующая переменная — ошибка, а не тихая дыра во фразе", async () => {
    const res = await saveReviewSettings(siteId, {
      ...base,
      askSmsTemplate: "Hi {{customer_first_name}}, review us: {{review_url}}",
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("customer_first_name");
  });

  it("текст без ссылки на отзыв не сохраняется", async () => {
    expect(await saveReviewSettings(siteId, { ...base, askSmsTemplate: "Hi {{sender_name}}, thanks!" })).toMatchObject({ ok: false });
  });

  it("кириллица сохраняется, но с предупреждением", async () => {
    // Запрещать владельцу собственный ввод не станем, но сказать обязаны: заметить это иначе
    // можно только по молчанию покупателей.
    const res = await saveReviewSettings(siteId, {
      ...base,
      askSmsTemplate: "Привет {{sender_name}}, оставьте отзыв: {{review_url}}",
    });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.warning).toContain("кириллица");
  });

  it("нормальный английский текст сохраняется без замечаний", async () => {
    const res = await saveReviewSettings(siteId, base);
    expect(res).toEqual({ ok: true, warning: undefined });
    const row = await prisma.siteReviewSettings.findUniqueOrThrow({ where: { siteId } });
    expect(row.askSmsTemplate).toBe(base.askSmsTemplate);
  });
});

describe("сроки", () => {
  it("пустые поля означают значения по умолчанию, а не ноль", async () => {
    // Ноль попыток звонка означал бы «никогда не звонить», а пустое поле — «как обычно».
    expect(await saveReviewSettings(siteId, base)).toMatchObject({ ok: true });
    expect(await resolveReviewSettings(prisma, siteId)).toEqual(DEFAULT_REVIEW_SETTINGS);
  });

  it("заданные сроки доходят до воронки", async () => {
    await saveReviewSettings(siteId, { ...base, maxCallAttempts: "3", callRetryDays: "2", promiseWaitDays: "21" });
    expect(await resolveReviewSettings(prisma, siteId)).toEqual({
      maxCallAttempts: 3,
      callRetryDays: 2,
      promiseWaitDays: 21,
    });
  });

  it("бессмысленные числа отвергаются", async () => {
    expect(await saveReviewSettings(siteId, { ...base, maxCallAttempts: "0" })).toMatchObject({ ok: false });
    expect(await saveReviewSettings(siteId, { ...base, promiseWaitDays: "-5" })).toMatchObject({ ok: false });
    expect(await saveReviewSettings(siteId, { ...base, callRetryDays: "полтора" })).toMatchObject({ ok: false });
  });

  it("Brevo Template ID должен быть положительным числом", async () => {
    expect(await saveReviewSettings(siteId, { ...base, askBrevoTemplateId: "abc" })).toMatchObject({ ok: false });
    expect(await saveReviewSettings(siteId, { ...base, askBrevoTemplateId: "12" })).toMatchObject({ ok: true });
  });
});

describe("экран настроек", () => {
  it("без строки настроек поля пустые, а сроки — значения по умолчанию", async () => {
    const view = (await listReviewSettings()).find((s) => s.siteId === siteId)!;
    expect(view.askSmsTemplate).toBe("");
    expect(view.maxCallAttempts).toBe(String(DEFAULT_REVIEW_SETTINGS.maxCallAttempts));
  });
});

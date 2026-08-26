import { describe, it, expect } from "vitest";
import { DEFAULT_ASK_SMS, DEFAULT_REMINDER_SMS } from "./sendLink";
import { SMS_VARIABLES } from "@/modules/automations/variables";
import { extractVariables, renderTemplate } from "@/modules/automations/template";

/**
 * Тексты, которые уходят КЛИЕНТУ. Проверяется два свойства, каждое из которых ломалось молча:
 * язык (клиенты американские, русский текст в SMS — брак) и существование переменных (рендер
 * заменяет неизвестное имя пустой строкой, поэтому опечатка не падает, а съедает часть фразы).
 */
const KNOWN = new Set(SMS_VARIABLES.map((v) => v.key));

describe("шаблоны сообщений клиенту", () => {
  for (const [name, template] of [
    ["просьба об отзыве", DEFAULT_ASK_SMS],
    ["напоминание", DEFAULT_REMINDER_SMS],
  ] as const) {
    it(`${name}: только существующие переменные`, () => {
      const unknown = extractVariables(template).filter((v) => !KNOWN.has(v));
      expect(unknown).toEqual([]);
    });

    it(`${name}: по-английски, без кириллицы`, () => {
      // Клиенты у всех магазинов американские. Русский — язык интерфейса владельца, не переписки.
      expect(template).not.toMatch(/[а-яА-ЯёЁ]/);
    });

    it(`${name}: ссылка на отзыв обязательна — без неё сообщение бессмысленно`, () => {
      expect(template).toContain("{{review_url}}");
    });

    it(`${name}: подставляется целиком и влезает в одну SMS`, () => {
      const rendered = renderTemplate(template, {
        sender_name: "Sarah",
        store_name: "TheFlow",
        review_url: "https://g.page/r/xxxxxxxxxxxx/review",
      });
      expect(rendered.missing).toEqual([]);
      expect(rendered.text).not.toContain("{{");
      // Длинные SMS режутся на сегменты и стоят дороже; 320 знаков — два сегмента латиницей.
      expect(rendered.text.length).toBeLessThan(320);
    });
  }
});

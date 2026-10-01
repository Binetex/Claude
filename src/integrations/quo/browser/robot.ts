import "server-only";
/**
 * Робот отправки SMS через веб-приложение Quo (my.quo.com) — живёт только в воркере.
 *
 * Делает то же, что человек: открывает ящик номера магазина (`/inbox/<PN…>` — тот же id, что у API),
 * «Send a message», вписывает номер получателя, ждёт, пока Quo его примет, набирает текст, нажимает
 * «Send message» и ждёт сообщение в ленте. Проверено 01.10.2026 на проде: с сервера, без повторного
 * входа, вебхук Quo приносит такое сообщение как обычное исходящее.
 *
 * Правила:
 * - Сообщения строго по одному: браузер один, две отправки в одной вкладке смешали бы поля.
 * - Всё, что сломалось ДО нажатия «Отправить», — `not_sent`: сообщение уйдёт через API. После
 *   нажатия — только `sent` или `unknown`: повтор через API отправил бы клиенту второе SMS.
 * - Вход делает ВЛАДЕЛЕЦ (`scripts/quo-browser-login.ts`), робот лишь пользуется сессией и
 *   сохраняет её обновления. Вышел из аккаунта — не входит сам, а пишет владельцу и на 10 минут
 *   отдаёт всё API. Проверок «не робот» и капчи не обходит: упёрся — тот же путь через API.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserSender, BrowserSendInput, BrowserSendResult } from "./transport";

const QUO = "https://my.quo.com";
/** Ожидание одного шага (страница, поле, ответ на нажатие). */
const STEP_MS = 20_000;
/** Вышли из аккаунта — столько не пробуем браузер вовсе: каждый заход упирался бы в страницу входа. */
const LOGGED_OUT_PAUSE_MS = 10 * 60_000;
/** Сессию (обновлённые токены) пишем на диск не чаще: файл — пара мегабайт. */
const SAVE_EVERY_MS = 10 * 60_000;

export type QuoBrowserOptions = {
  /** Файл сессии от `scripts/quo-browser-login.ts`. */
  statePath: string;
  /** Сессия больше не пускает: пора владельцу войти заново. */
  onLoggedOut?: () => Promise<void> | void;
  headless?: boolean;
};

class NotSent extends Error {}

const norm = (t: string) => t.replace(/[\s\u{FEFF}]+/gu, " ").trim();

export function createQuoBrowserSender(opts: QuoBrowserOptions): { send: BrowserSender; close: () => Promise<void> } {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let pausedUntil = 0;
  let savedAt = Date.now();

  async function reset(): Promise<void> {
    const b = browser;
    browser = null;
    page = null;
    await b?.close().catch(() => {});
  }

  async function ensurePage(): Promise<Page> {
    if (page && !page.isClosed()) return page;
    await reset();
    if (!existsSync(opts.statePath)) throw new NotSent("no_session_file");
    browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext({ storageState: opts.statePath, viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.setDefaultTimeout(STEP_MS);
    return page;
  }

  /** Обновлённые токены — в файл, атомарно: оборванная запись не должна оставить битую сессию. */
  async function saveSession(force = false): Promise<void> {
    if (!page || (!force && Date.now() - savedAt < SAVE_EVERY_MS)) return;
    try {
      const state = await page.context().storageState({ indexedDB: true });
      mkdirSync(dirname(opts.statePath), { recursive: true });
      const tmp = `${opts.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, opts.statePath);
      savedAt = Date.now();
    } catch (err) {
      console.warn("[quo-browser] сессия не сохранена:", err instanceof Error ? err.message : String(err));
    }
  }

  async function sendOne(input: BrowserSendInput): Promise<BrowserSendResult> {
    if (Date.now() < pausedUntil) return { outcome: "not_sent", reason: "logged_out" };
    let pressed = false;
    try {
      const p = await ensurePage();
      await p.goto(`${QUO}/inbox/${encodeURIComponent(input.fromPhoneNumberId)}`, { waitUntil: "domcontentloaded" });
      const compose = p.getByRole("button", { name: "Send a message", exact: true }).first();
      // Ящик открылся или выкинуло на вход — что раньше. Проигравшее ожидание гасит свою ошибку само:
      // необработанный отказ промиса уронил бы весь воркер.
      await Promise.race([compose.waitFor().then(() => true, () => false), p.waitForURL(/\/login/).then(() => true, () => false)]);
      if (/\/login/.test(p.url())) {
        pausedUntil = Date.now() + LOGGED_OUT_PAUSE_MS;
        await reset();
        await opts.onLoggedOut?.();
        return { outcome: "not_sent", reason: "logged_out" };
      }
      // Ящика с таким номером нет (номер убрали из аккаунта) — Quo открыл другой.
      if (!p.url().includes(`/inbox/${input.fromPhoneNumberId}`)) throw new NotSent("inbox_not_found");
      await p.keyboard.press("Escape").catch(() => {}); // всплывающие подсказки и предложения тарифа
      await compose.click();

      const to = p.locator("input[aria-label='participant input']");
      await to.fill(input.to);
      await to.press("Enter");
      // Получатель принят: область разговора получила имя — номер или контакт («Conversation with …»).
      // Пока не принят, она называется просто «Conversation with».
      await p.getByRole("region", { name: /^Conversation with \S/ }).waitFor();

      const box = p.locator("[aria-label='message input']");
      await box.click();
      const lines = input.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await p.keyboard.press("Shift+Enter");
        if (lines[i]) await p.keyboard.insertText(lines[i]);
      }
      // В поле ровно наш текст: подсказки и быстрые вставки ничего не добавили.
      if (norm(await box.innerText()) !== norm(input.text)) {
        await box.fill("").catch(() => {});
        throw new NotSent("composer_mismatch");
      }

      await input.beforeSend?.();
      pressed = true;
      await p.getByRole("button", { name: "Send message", exact: true }).click();

      // Ушло: поле очистилось, а в ленте разговора появилось наше сообщение.
      await p.waitForFunction(() => (document.querySelector("[aria-label='message input']")?.textContent ?? "").replace(/[\s\u{FEFF}]+/gu, "") === "");
      const firstLine = lines.find((l) => l.trim()) ?? input.text;
      await p.getByRole("region", { name: /^Conversation with/ }).getByRole("listitem").filter({ hasText: firstLine.trim() }).last().waitFor();
      await saveSession();
      return { outcome: "sent" };
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
      await reset(); // следующий заход — с чистого листа
      return pressed ? { outcome: "unknown", reason } : { outcome: "not_sent", reason };
    }
  }

  const send: BrowserSender = (input) => {
    const run = queue.then(() => sendOne(input));
    queue = run.catch(() => {});
    return run;
  };

  async function close(): Promise<void> {
    await queue;
    await saveSession(true);
    await reset();
  }

  return { send, close };
}

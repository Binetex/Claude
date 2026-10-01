import { chromium } from "playwright-core";
import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Вход в Quo для отправки SMS через браузер — делает ВЛАДЕЛЕЦ, сам, на своём компьютере.
 *
 * Открывает окно Chrome на странице входа Quo. Владелец входит как удобно (почта и пароль, код на
 * почту); скрипт пароля не видит и ничего не вводит. Как только открылся ящик Quo, сессия
 * сохраняется в .quo-browser/state.json (в git не попадает, права 600) — с ней робот на сервере
 * работает от имени владельца, пока Quo её не сбросит. Рядом — снимок интерфейса ящика без
 * сообщений клиентов (только роли и подписи кнопок): по нему пишется сам робот.
 *
 *   npm run quo:login        # нужен установленный Google Chrome
 */

const STATE = process.env.QUO_BROWSER_STATE_PATH ?? ".quo-browser/state.json";
const LOGIN_URL = "https://my.quo.com/login";
const WAIT_MIN = 30;
/** Страницы, где вход ещё не закончен. */
const NOT_IN = /\/(login|signup|sign-up|verify|auth|callback|magic|code|onboarding)\b/i;

async function main() {
  // Обычный Google Chrome владельца, но с чистым временным профилем: ни его закладок, ни других
  // сессий робот не видит, а качать отдельный браузер на компьютер владельца не нужно.
  const browser = await chromium.launch({ headless: false, channel: process.env.QUO_LOGIN_CHANNEL ?? "chrome" });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(LOGIN_URL);
    // QUO_LOGIN_EMAIL: выбрать «Email & password» и вписать почту. Пароль скрипт не вводит никогда —
    // его набирает владелец сам в этом окне.
    const email = process.env.QUO_LOGIN_EMAIL?.trim();
    if (email) {
      await page.getByText(/email\s*&\s*password/i).first().click();
      const field = page.locator('input[name="username"], input[type="email"]').first();
      await field.waitFor({ timeout: 30_000 });
      await field.fill(email);
      await page.getByRole("button", { name: /^continue$/i }).first().click().catch(() => {});
      console.log("Почта вписана — введите пароль в окне и нажмите Enter.");
    }
    console.log(`Войдите в Quo в открывшемся окне. Жду до ${WAIT_MIN} минут…`);
    // Опрос адреса, а не waitForURL: после входа Quo переходит в ящик без перезагрузки страницы, и
    // ожидание «загрузки» не наступало. Путь страницы пишем в лог — по нему видно, где застрял вход.
    const deadline = Date.now() + WAIT_MIN * 60_000;
    let lastPath = "";
    for (;;) {
      if (page.isClosed()) throw new Error("Окно входа закрыли до конца входа — сессия не сохранена.");
      const url = new URL(page.url());
      if (url.pathname !== lastPath) console.log(`  страница: ${url.hostname}${(lastPath = url.pathname)}`);
      if (url.hostname === "my.quo.com" && url.pathname !== "/" && !NOT_IN.test(url.pathname)) break;
      if (Date.now() > deadline) throw new Error(`За ${WAIT_MIN} минут вход не завершился — сессия не сохранена.`);
      await page.waitForTimeout(2_000);
    }
    // Ящик догружается после перехода: даём ему открыться, чтобы в сессию попали все токены.
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(5_000);

    mkdirSync(dirname(STATE), { recursive: true });
    await context.storageState({ path: STATE, indexedDB: true });
    chmodSync(STATE, 0o600);
    // Только каркас: роли и подписи кнопок, без текста переписки (интерактивные элементы и заголовки).
    const outline = await page.locator("nav, header, aside, [role=toolbar], [role=navigation], button, [role=button], textarea, [contenteditable=true]").evaluateAll((els) =>
      els.slice(0, 400).map((e) => {
        const el = e as HTMLElement;
        const label = el.getAttribute("aria-label") ?? el.getAttribute("data-testid") ?? el.getAttribute("placeholder") ?? (el.tagName === "BUTTON" ? (el.innerText || "").slice(0, 40) : "");
        return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} ${label}`.trim();
      }),
    );
    writeFileSync(join(dirname(STATE), "outline.txt"), `${page.url()}\n${outline.join("\n")}\n`, { mode: 0o600 });
    console.log(`Готово: сессия сохранена в ${STATE}. Окно можно не трогать — закрываю.`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

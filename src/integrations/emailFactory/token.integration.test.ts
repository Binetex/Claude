/**
 * Токен Email Factory на реальной БД (throwaway prisma dev).
 *
 * Проверяется ровно то, что у секрета смысловое, а не декоративное: наружу не утекает значение,
 * замена не оставляет второй строки, неудачное сохранение НЕ уносит с собой рабочий токен, а
 * «удалить» действительно удаляет, а не прячет за флагом.
 *
 * Запись глобальная (`siteId = null`) — по правилам проекта такие в тестах опасны, они протекают
 * в чужие прогоны. Здесь это безопасно ровно по одной причине: `provider = "EMAIL_FACTORY"` не
 * использует больше никто, и уборка идёт по нему же. Добавлять сюда записи с другим provider или
 * с siteId нельзя.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

import { prisma } from "@/lib/db";
import { saveEmailFactoryToken, clearEmailFactoryToken, resolveEmailFactoryToken, loadEmailFactoryView } from "./token";

const PROVIDER = "EMAIL_FACTORY";
const TOKEN = "ef-token-abcdefghijklmnop-1234";
const OTHER_TOKEN = "ef-token-zyxwvutsrqponml-9876";

const rows = () => prisma.integrationSecret.findMany({ where: { provider: PROVIDER } });
const wipe = () => prisma.integrationSecret.deleteMany({ where: { provider: PROVIDER } });

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("хранение", () => {
  it("токена нет — resolve отдаёт null, вид говорит «не настроено»", async () => {
    expect(await resolveEmailFactoryToken(prisma)).toBeNull();
    const view = await loadEmailFactoryView(prisma);
    expect(view.configured).toBe(false);
    expect(view.maskedSuffix).toBeNull();
  });

  it("сохранённый токен читается обратно, а наружу уходит только маска", async () => {
    expect(await saveEmailFactoryToken(prisma, TOKEN)).toEqual({ ok: true });

    expect(await resolveEmailFactoryToken(prisma)).toBe(TOKEN);

    const view = await loadEmailFactoryView(prisma);
    expect(view.configured).toBe(true);
    expect(view.maskedSuffix).toBe(`********${TOKEN.slice(-4)}`);
    // Ключевое: ни маска, ни что-либо ещё в виде не содержит самого значения.
    expect(JSON.stringify(view)).not.toContain(TOKEN);

    // И в БД лежит шифртекст, а не исходник.
    const [row] = await rows();
    expect(row.encryptedValue).not.toContain(TOKEN);
  });

  it("токен вокруг обрезается по пробелам", async () => {
    await saveEmailFactoryToken(prisma, `  ${TOKEN}\n`);
    expect(await resolveEmailFactoryToken(prisma)).toBe(TOKEN);
  });
});

describe("замена", () => {
  it("после замены остаётся РОВНО одна строка и действует новый токен", async () => {
    await saveEmailFactoryToken(prisma, TOKEN);
    await saveEmailFactoryToken(prisma, OTHER_TOKEN);

    expect(await resolveEmailFactoryToken(prisma)).toBe(OTHER_TOKEN);
    // Не «одна активная», а одна вообще: старый секрет не остаётся лежать погашенным — иначе он
    // попадёт в дамп базы и в бэкапы уже после того, как его отозвали.
    expect(await rows()).toHaveLength(1);
  });

  it("отказ на проверке НЕ уносит рабочий токен", async () => {
    await saveEmailFactoryToken(prisma, TOKEN);

    for (const bad of ["", "   ", "коротко"]) {
      const res = await saveEmailFactoryToken(prisma, bad);
      expect(res).toHaveProperty("error");
    }

    // Проверки обязаны отрабатывать ДО удаления старой строки. Иначе промах при вставке нового
    // токена оставил бы аккаунт вообще без подключения, а на экране — «токена нет».
    expect(await resolveEmailFactoryToken(prisma)).toBe(TOKEN);
    expect(await rows()).toHaveLength(1);
  });
});

describe("удаление", () => {
  it("«удалить» стирает строку, а не гасит её флагом", async () => {
    await saveEmailFactoryToken(prisma, TOKEN);
    await clearEmailFactoryToken(prisma);

    expect(await resolveEmailFactoryToken(prisma)).toBeNull();
    expect((await loadEmailFactoryView(prisma)).configured).toBe(false);
    // Владелец жмёт «Удалить», чтобы отозвать доступ. Значение не должно продолжать лежать в БД
    // расшифровываемым — поэтому проверяется физическое отсутствие строки.
    expect(await rows()).toHaveLength(0);
  });

  it("удаление, когда токена и не было, не падает", async () => {
    expect(await clearEmailFactoryToken(prisma)).toEqual({ ok: true });
    expect(await rows()).toHaveLength(0);
  });
});

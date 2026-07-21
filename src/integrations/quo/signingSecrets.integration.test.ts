/**
 * DB integration: безопасное хранение QUO webhook signing secrets (IntegrationSecret).
 * Требует CREDENTIALS_ENCRYPTION_KEY (шифрование) + локальный DATABASE_URL.
 */
import { describe, it, expect, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { maskSecret } from "@/lib/crypto/secretBox";
import { verifyQuoSignature } from "./signature";
import { addQuoSigningSecret, listQuoSigningSecretsMasked, getActiveQuoSigningSecrets, removeQuoSigningSecret } from "./signingSecrets";

const created: string[] = [];
const signKey = () => crypto.randomBytes(24).toString("base64");
function sign(rawBody: string, tsMs: number, keyB64: string): string {
  const sig = crypto.createHmac("sha256", Buffer.from(keyB64, "base64")).update(`${tsMs}.${rawBody}`).digest("base64");
  return `hmac;1;${tsMs};${sig}`;
}

afterAll(async () => {
  if (created.length) await prisma.integrationSecret.deleteMany({ where: { id: { in: created } } });
});

describe("QUO signing secrets — хранение", () => {
  it("add: значение зашифровано, маска = ******** + последние 4, значение не утекает в список", async () => {
    const S = signKey();
    const r = await addQuoSigningSecret(prisma, S);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    created.push(r.id);
    const row = await prisma.integrationSecret.findUniqueOrThrow({ where: { id: r.id }, select: { encryptedValue: true, maskedSuffix: true } });
    expect(row.encryptedValue).not.toEqual(S);
    expect(row.encryptedValue).not.toContain(S); // ciphertext не содержит plaintext
    expect(row.maskedSuffix).toBe(maskSecret(S));
    expect(row.maskedSuffix.endsWith(S.slice(-4))).toBe(true); // только последние 4
    const masked = await listQuoSigningSecretsMasked(prisma);
    expect(JSON.stringify(masked)).not.toContain(S); // полное значение не в списке
  });

  it("getActive расшифровывает обратно и этим ключом проходит проверка подписи", async () => {
    const S = signKey();
    const r = await addQuoSigningSecret(prisma, S);
    if (!r.ok) throw new Error("add failed");
    created.push(r.id);
    const active = await getActiveQuoSigningSecrets(prisma);
    expect(active).toContain(S);
    const body = JSON.stringify({ hello: "mms" });
    const ts = Date.now();
    const header = sign(body, ts, S);
    expect(verifyQuoSignature(body, header, S, { nowMs: ts })).toEqual({ valid: true });
  });

  it("dedup: тот же secret второй раз не добавляется", async () => {
    const S = signKey();
    const r1 = await addQuoSigningSecret(prisma, S);
    if (!r1.ok) throw new Error("add failed");
    created.push(r1.id);
    const r2 = await addQuoSigningSecret(prisma, S);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/уже/i);
  });

  it("remove: секрет физически удалён и больше не принимается", async () => {
    const S = signKey();
    const r = await addQuoSigningSecret(prisma, S);
    if (!r.ok) throw new Error("add failed");
    expect(await getActiveQuoSigningSecrets(prisma)).toContain(S);
    expect((await removeQuoSigningSecret(prisma, r.id)).ok).toBe(true);
    const after = await getActiveQuoSigningSecrets(prisma);
    expect(after).not.toContain(S);
    const body = "{}", ts = Date.now(), header = sign(body, ts, S);
    expect(after.some((k) => verifyQuoSignature(body, header, k, { nowMs: ts }).valid)).toBe(false);
  });

  it("env + DB объединяются; и env-ключ, и новый DB-ключ проходят (без restart)", async () => {
    const envKey = signKey();
    const dbKey = signKey();
    const r = await addQuoSigningSecret(prisma, dbKey);
    if (!r.ok) throw new Error("add failed");
    created.push(r.id);
    const merged = [...new Set([envKey, ...(await getActiveQuoSigningSecrets(prisma))])]; // как в роуте
    const body = "{}", ts = Date.now();
    expect(merged.some((k) => verifyQuoSignature(body, sign(body, ts, envKey), k, { nowMs: ts }).valid)).toBe(true);
    expect(merged.some((k) => verifyQuoSignature(body, sign(body, ts, dbKey), k, { nowMs: ts }).valid)).toBe(true);
  });
});

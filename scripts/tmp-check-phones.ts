/** РАЗОВАЯ проверка (07.09.2026): сколько заказов с номерами, которые мы гарантированно не наберём. */
import { prisma } from "../src/lib/db";
import { normalizePhone } from "../src/lib/phone";

/** Наш «+1» приклеен к тому, что номером США быть не может: неверная длина или код района с 0/1. */
function brokenUsNumber(raw: string | null | undefined): boolean {
  const v = (raw ?? "").trim();
  if (!v || v.startsWith("+")) return false; // с явным кодом страны — не наш случай
  const n = normalizePhone(v);
  if (!n.startsWith("+1")) return false;
  const digits = n.slice(1);
  if (digits.length !== 11) return true; // +1 и не 10 цифр после него
  return /^1[01]/.test(digits); // код района не может начинаться с 0 или 1
}

async function main() {
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: new Date("2026-06-01") } },
    select: { orderNumber: true, senderPhone: true, recipientPhone: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const bad = orders.filter((o) => brokenUsNumber(o.senderPhone) || brokenUsNumber(o.recipientPhone));
  console.log(`Заказов с 1 июня: ${orders.length}, из них с ненаборным номером: ${bad.length}`);
  for (const o of bad.slice(0, 20)) {
    const marks = [
      brokenUsNumber(o.senderPhone) ? `заказчик ${o.senderPhone} → ${normalizePhone(o.senderPhone)}` : null,
      brokenUsNumber(o.recipientPhone) ? `получатель ${o.recipientPhone} → ${normalizePhone(o.recipientPhone)}` : null,
    ].filter(Boolean);
    console.log(`  ${o.orderNumber} (${o.createdAt.toISOString().slice(0, 10)}): ${marks.join("; ")}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

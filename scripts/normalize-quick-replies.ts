import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { toSmsText, smsSegments } from "../src/lib/smsText";

/**
 * Разово: заготовки ответов (MessageTemplate), уже лежащие в базе, — базовым SMS-алфавитом.
 *
 * Их завели скриптом из сообщений владельца с телефона (seed-message-templates.ts), и в них ’, эмодзи
 * и длинные тире: оператор вставлял такую заготовку, и SMS уходила частями по 70 знаков вместо 160 —
 * вдвое-втрое дороже (владелец 01.10.2026). Отправка теперь чистит текст сама (quo/send.ts), а новые
 * правки заготовок сохраняются чистыми; этот скрипт приводит к тому же виду то, что сохранено раньше,
 * чтобы оператор видел в поле ровно то, что уйдёт клиенту. Остальной текст не меняется.
 *
 *   npx tsx scripts/normalize-quick-replies.ts            # показать, что изменится
 *   npx tsx scripts/normalize-quick-replies.ts --live     # записать
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const live = process.argv.includes("--live");
  const all = await prisma.messageTemplate.findMany({ orderBy: { position: "asc" }, select: { id: true, title: true, text: true } });
  const changes = all.map((t) => ({ ...t, next: toSmsText(t.text) })).filter((t) => t.next !== t.text);

  console.log(`Заготовок: ${all.length}. Изменится: ${changes.length}.`);
  let before = 0;
  let after = 0;
  for (const t of changes) {
    const a = smsSegments(t.text);
    const b = smsSegments(t.next);
    before += a.segments;
    after += b.segments;
    console.log(`\n• ${t.title}: ${a.segments} ч. (${a.encoding}) → ${b.segments} ч. (${b.encoding})`);
    console.log(`  было:  ${t.text}`);
    console.log(`  стало: ${t.next}`);
  }
  if (changes.length) console.log(`\nЧастей на одну отправку каждой из изменённых: ${before} → ${after}.`);
  if (!live) return console.log("\nDRY-RUN. Повторите с --live, чтобы записать.");

  await prisma.$transaction(changes.map((t) => prisma.messageTemplate.update({ where: { id: t.id }, data: { text: t.next } })));
  console.log(`\nЗаписано: ${changes.length}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

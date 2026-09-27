/**
 * Разово ставит флористам время начала работы (Florist.workStartMin) по словам владельца
 * (28.09.2026): Настя начинает около 10:00, Ольга около 12:00. Дальше правится в «Флористах».
 *
 * Трогает только тех, у кого время ещё не задано. Сухой прогон по умолчанию, запись — --apply.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/set-florist-work-start.ts [--apply]
 */
import { prisma } from "../src/lib/db";

const BY_NAME: Record<string, number> = { "Настя": 10 * 60, "Olga": 12 * 60, "Ольга": 12 * 60 };

async function main() {
  const apply = process.argv.includes("--apply");
  const florists = await prisma.florist.findMany({ select: { id: true, workStartMin: true, user: { select: { name: true } } } });
  for (const f of florists) {
    const want = BY_NAME[f.user.name];
    if (want == null) continue;
    if (f.workStartMin != null) {
      console.log(`${f.user.name}: уже задано ${f.workStartMin} мин — не трогаю`);
      continue;
    }
    console.log(`${f.user.name}: ${apply ? "ставлю" : "поставил бы"} начало ${Math.floor(want / 60)}:${String(want % 60).padStart(2, "0")}`);
    if (apply) await prisma.florist.update({ where: { id: f.id }, data: { workStartMin: want } });
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

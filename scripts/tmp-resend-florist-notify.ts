/**
 * РАЗОВЫЙ скрипт (07.09.2026): переотправить флористу два уведомления о назначении, которые
 * не ушли, пока была снята галочка «Флористам» в настройках Telegram. Удалить после прогона.
 *
 * Ничего не чинит и не меняет: только кладёт в очередь те же события, что кладёт назначение
 * заказа. Отправляет их обычный обработчик обычным путём.
 */
import { prisma } from "../src/lib/db";
import { publishTelegramNotification } from "../src/integrations/telegram/events";

const ORDER_IDS = ["cmtrf5dbg001pbcmlv3h7zmw0", "cmtrffz5w000f4lml1i6b78wi"];
const RESEND_MARK = "manual-resend-20260907";

async function main() {
  const s = await prisma.telegramSettings.findUnique({ where: { id: "singleton" } });
  console.log(`Telegram: включён=${s?.enabled}, флористам=${s?.notifyFlorists}`);
  if (!s?.enabled || !s.notifyFlorists) {
    console.log("Уведомления флористам сейчас выключены — верните галочку, иначе повтор снова пропустят.");
    return;
  }

  for (const id of ORDER_IDS) {
    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, orderNumber: true, currentFloristId: true },
    });
    if (!order) {
      console.log(`${id}: заказ не найден — пропуск`);
      continue;
    }
    if (!order.currentFloristId) {
      console.log(`${order.orderNumber}: флорист не назначен — пропуск`);
      continue;
    }
    const florist = await prisma.florist.findUnique({
      where: { id: order.currentFloristId },
      select: { user: { select: { name: true } } },
    });
    const already = await prisma.telegramMessage.findUnique({
      where: { dedupeKey: `order:${order.id}:florist:${order.currentFloristId}` },
      select: { id: true },
    });
    if (already) {
      console.log(`${order.orderNumber}: сообщение флористу уже есть — пропуск`);
      continue;
    }

    await publishTelegramNotification(prisma, {
      type: "order.assigned",
      orderId: order.id,
      floristId: order.currentFloristId,
      occurrenceKey: `${order.id}:${order.currentFloristId}:${RESEND_MARK}`,
      context: { floristName: florist?.user.name ?? null },
    });
    console.log(`${order.orderNumber}: уведомление поставлено в очередь для ${florist?.user.name ?? order.currentFloristId}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

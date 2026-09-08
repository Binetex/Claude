/** РАЗОВАЯ проверка (07.09.2026): почему QUO ответил 400 на конкретную отправку. Только чтение. */
import { prisma } from "../src/lib/db";
import { toE164, normalizePhone } from "../src/lib/phone";

const IDS = ["cmtrfgd8o001c4lml6zmlde60"];

async function main() {
  for (const id of IDS) {
    const c = await prisma.orderCommunication.findUnique({
      where: { id },
      select: {
        id: true, status: true, occurredAt: true, externalPhone: true, externalPhoneNormalized: true,
        storePhone: true, providerPhoneNumberId: true, messageText: true, rawMetadata: true, partyRole: true,
        order: { select: { orderNumber: true, senderPhone: true, recipientPhone: true, senderName: true, recipientName: true} },
      },
    });
    if (!c) {
      console.log(`${id}: записи нет`);
      continue;
    }
    console.log("— заказ:", c.order?.orderNumber ?? "(без заказа)");
    console.log("— адресат:", c.partyRole, c.externalPhone, "→ нормализовано:", c.externalPhoneNormalized);
    console.log("— E.164 повторно:", toE164(c.externalPhone), "| normalizePhone:", normalizePhone(c.externalPhone));
    console.log("— номер отправителя:", c.storePhone, c.providerPhoneNumberId);
    console.log("— длина текста:", c.messageText?.length ?? 0);
    console.log("— ошибка:", JSON.stringify(c.rawMetadata));
    console.log("— телефоны заказа: заказчик", c.order?.senderPhone, "| получатель", c.order?.recipientPhone);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

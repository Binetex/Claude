import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Первое наполнение заготовок ответов (MessageTemplate).
 *
 * Тексты не придуманы: это то, что владелец за последние месяцы писал клиентам руками —
 * выгружено из OrderCommunication (OUTBOUND, sentByUserId не пуст) и перенесено дословно.
 * Поменяно ровно три вещи, и только там, где текст иначе нельзя переиспользовать:
 *   — имена и телефоны заменены переменными ({{sender_name}}, {{recipient_phone}});
 *   — ссылка на отзыв заменена на {{review_url}}: она разная у каждого магазина и даже у
 *     каждой точки по индексу, а список заготовок один на всё;
 *   — «she/her» про получателя заменено на «they/them»: заготовка уходит кому угодно.
 * Цифры и города (3 PM, 7–8 PM, Los Angeles) оставлены как есть — заготовка вставляется в
 * поле, а не отправляется, и правится под случай.
 *
 *   npx tsx scripts/seed-message-templates.ts            # показать, что будет добавлено
 *   npx tsx scripts/seed-message-templates.ts --live     # добавить
 *
 * Безопасно запускать повторно: заготовка с таким же заголовком не трогается, поэтому
 * правки владельца скрипт не затирает.
 *
 * Заготовки про самовывоз здесь НЕТ и быть не может: список общий на все магазины, а ответ
 * разный (Flowerbar Glendale — настоящий магазин с витриной, остальные возят только курьером),
 * поэтому один текст врал бы половине магазинов. Это отвечает ассистент по базе знаний.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TEMPLATES: { title: string; text: string }[] = [
  {
    title: "Спросить время доставки",
    text: "Good afternoon, this is flowers delivery! We have a delivery set for you for today, what is the best time for us to deliver it? And what’s the apartment unit? Thank you🙏🏻",
  },
  {
    title: "Букет готов — когда удобно",
    text: "Hi! Your bouquet is ready! Please let us know when you will be ready to receive the bouquet? ☺️🙏",
  },
  {
    title: "Как попасть в здание",
    text: "Is there any instructions how to get into the building for courier?",
  },
  {
    title: "Апартаменты: нет квартиры и телефона",
    text: "Hi! 🌸 We checked the address and it appears to be an apartment building. Unfortunately, the apartment number and the recipient’s phone number were not provided with the order.\n\nCould you please let us know where exactly we should deliver the bouquet and where the courier can leave it?",
  },
  {
    title: "Номер получателя не американский",
    text: "Hello! We’re unable to contact the recipient because the phone number provided is not a U.S. number. The delivery address is an apartment building, so our courier may not be able to get inside without contacting the recipient.\n\nPlease let us know how the courier should enter the building or reach the recipient.",
  },
  {
    title: "Заказчику: ждём ответа получателя",
    text: "Hello! Thank you very much for your order.\nYour bouquet is ready. Since {{recipient_name}} lives in an apartment building, we are waiting for them to reply with the delivery instructions for our courier and to confirm a convenient time to receive the bouquet.\nIf possible, could you please help us clarify this information? We would really appreciate it.\nThank you so much!",
  },
  {
    title: "Не дозвонились получателю",
    text: "Hello again, is {{recipient_phone}} the correct number? We just called and the person who picked up the phone said that it’s not them.",
  },
  {
    title: "Трек-ссылка",
    text: "Your bouquet is with the courier now 🌸\n{{tracking_url}}",
  },
  {
    title: "Задержка — чуть позже окна",
    text: "We have a very high volume of orders today, so yes, your delivery may be slightly delayed and arrive a little after 3 PM. However, we’ll do everything possible to have it delivered by 3 PM. We apologize for the delay and appreciate your understanding.",
  },
  {
    title: "Задержка — трек-ссылка скоро",
    text: "We’re experiencing a slight delay with the delivery, but your bouquet will be on its way shortly. We’ll send you the tracking link as soon as the courier picks it up. Thank you for your patience! 🌸",
  },
  {
    title: "Не успеваем: перенос или отмена",
    text: "Got it! We’re very sorry, but we’re extremely busy with orders today. Would it be okay if we deliver your bouquet between 7–8 PM?\n\nAlternatively, we can reschedule the delivery for tomorrow, or cancel the order if that works better for you. Please let us know which option you prefer 🌸",
  },
  {
    title: "Перенос на утро следующего дня",
    text: "Hello {{sender_name}},\n\nWe’re very sorry, but we’re experiencing an unusually high volume of orders today, and we’re concerned that we may not be able to deliver your order on time.\n\nWould it be possible to reschedule your delivery for tomorrow morning (the first half of the day)? We sincerely apologize for the inconvenience and greatly appreciate your understanding.\n\nThank you very much!",
  },
  {
    title: "Ваза закончилась — замена",
    text: "Unfortunately, the vase shown in the photo is sold out right now. We can replace it with this vase instead.\n\nIt’s also a large vase, just a little shorter, and we’ll make this replacement at no extra charge.\n\nIf that works for you, we’ll prepare everything and deliver your order as planned.",
  },
  {
    title: "Цветок не в сезон",
    text: "Unfortunately, no, we don’t have peonies available at any of our locations right now. They’re currently out of season.",
  },
  {
    title: "Доставим заранее — букет доживёт",
    text: "We can deliver your bouquet late in the evening. The flowers will be placed in a disposable vase with water and packed in a transportation box, so they will stay fresh. This way, they will be in perfect condition even if you plan to give them as a gift the next morning ☺️",
  },
  {
    title: "Адрес вне зоны доставки",
    text: "Hello! Unfortunately, the delivery address you provided is outside of our delivery area.\n\nIf possible, please provide another delivery address within our area. Otherwise, we will need to cancel the order and issue you a full refund.",
  },
  {
    title: "Подтвердить получение",
    text: "The courier just let us know that the bouquet has been delivered. Could you please confirm if you received it?",
  },
  {
    title: "Просьба об отзыве + бонус",
    text: "If you have a minute, would you mind leaving us a quick review?\nAnd we have a little thank you for you too. I can either refund $10 from today’s order - basically give you the delivery or service fee back...\nor, if you think you’ll order flowers with us again, I can make you a personal $20 coupon for your next order.\nWhatever you’d prefer! {{review_url}}",
  },
  {
    title: "Спасибо за отзыв",
    text: "Thank you so much! 💖 We’re so happy that you liked the flowers. Thank you for your kind words and wonderful feedback — it means a lot to us!",
  },
  {
    title: "Уход за букетом",
    text: "Yes, flower food is included in the little packet that comes with your bouquet, so be sure to add it to fresh water. It really helps the flowers last longer. We also recommend trimming the stems at an angle every couple of days, changing the water regularly, and keeping the vase out of direct sunlight and away from ripening fruit. Enjoy your flowers! 🌸",
  },
  {
    title: "Извиниться за авто-сообщение про апартаменты",
    text: "My apologies — that was an automated message about the apartment sent by mistake. Please disregard it. Your bouquet will be delivered shortly. Thank you for your patience and understanding!",
  },
];

async function main() {
  const live = process.argv.includes("--live");
  const owner = await prisma.user.findFirst({ where: { role: "OWNER" }, orderBy: { createdAt: "asc" }, select: { id: true, email: true } });
  if (!owner) throw new Error("В системе нет владельца — некого записать в createdBy.");

  const existing = await prisma.messageTemplate.findMany({ select: { title: true, position: true } });
  const taken = new Set(existing.map((t) => t.title));
  const start = existing.reduce((max, t) => Math.max(max, t.position), 0);
  const fresh = TEMPLATES.filter((t) => !taken.has(t.title));

  console.log(`Заготовок в базе: ${existing.length}. В скрипте: ${TEMPLATES.length}. Добавится: ${fresh.length}.`);
  for (const t of fresh) console.log(`  + ${t.title}`);
  if (!live) return console.log("\nDRY-RUN. Повторите с --live, чтобы записать.");

  await prisma.$transaction(
    fresh.map((t, i) =>
      prisma.messageTemplate.create({ data: { title: t.title, text: t.text, position: start + i + 1, createdBy: owner.id } }),
    ),
  );
  console.log(`\nЗаписано: ${fresh.length} (createdBy ${owner.email}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

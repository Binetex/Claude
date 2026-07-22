import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const D = (n: number) => new Prisma.Decimal(n);
const PASSWORD = "password123";

// Смещения дат от «сегодня»
const today = new Date();
today.setHours(0, 0, 0, 0);
const at = (days: number, h = 12) => {
  const d = new Date(today);
  d.setDate(d.getDate() + days);
  d.setHours(h, 0, 0, 0);
  return d;
};

async function main() {
  console.log("Очистка базы…");
  // Порядок важен из-за внешних ключей.
  await prisma.message.deleteMany();
  await prisma.orderAssignment.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.floristProductPrice.deleteMany();
  await prisma.product.deleteMany();
  await prisma.siteFloristPriority.deleteMany();
  await prisma.florist.deleteMany();
  await prisma.user.deleteMany();
  await prisma.site.deleteMany();

  const hash = await bcrypt.hash(PASSWORD, 10);

  console.log("Пользователи…");
  await prisma.user.create({
    data: { name: "Владелец", email: "owner@demo.local", role: "OWNER", passwordHash: hash, phone: "+1 555 100 0000" },
  });
  await prisma.user.create({
    data: { name: "Оператор колл-центра", email: "cc@demo.local", role: "CALL_CENTER", passwordHash: hash, phone: "+1 555 200 0000" },
  });

  const florist1User = await prisma.user.create({
    data: { name: "Флорист №1 — Анна", email: "florist1@demo.local", role: "FLORIST", passwordHash: hash, phone: "+1 555 300 0001", telegramId: "florist1_tg" },
  });
  const florist2User = await prisma.user.create({
    data: { name: "Флорист №2 — Борис", email: "florist2@demo.local", role: "FLORIST", passwordHash: hash, phone: "+1 555 300 0002", telegramId: "florist2_tg" },
  });
  // Флорист №1 — основной на большинстве сайтов, видит полную раскладку (налог/доставка/чаевые).
  // Флорист №2 — резервный, видит только назначенную ему цену изготовления (по умолчанию).
  const florist1 = await prisma.florist.create({ data: { userId: florist1User.id, financeVisibility: "FULL" } });
  const florist2 = await prisma.florist.create({ data: { userId: florist2User.id, financeVisibility: "MAKER_ONLY" } });

  console.log("Сайты и бренды…");
  const siteA = await prisma.site.create({
    data: {
      name: "Bloom & Co (WooCommerce)",
      shortName: "BLOOM",
      platform: "WOOCOMMERCE",
      connectionStatus: "CONNECTED",
      colorTag: "#db2777", // розовый
    },
  });
  const siteB = await prisma.site.create({
    data: {
      name: "Petals NYC (Shopify)",
      shortName: "PETALS",
      platform: "SHOPIFY",
      connectionStatus: "CONNECTED",
      colorTag: "#7c3aed", // фиолетовый
    },
  });

  // Приоритеты: у сайта A основной — Флорист №1, резерв — Флорист №2.
  //             у сайта B основной — Флорист №2, резерв — Флорист №1.
  await prisma.siteFloristPriority.createMany({
    data: [
      { siteId: siteA.id, floristId: florist1.id, position: 0 },
      { siteId: siteA.id, floristId: florist2.id, position: 1 },
      { siteId: siteB.id, floristId: florist2.id, position: 0 },
      { siteId: siteB.id, floristId: florist1.id, position: 1 },
    ],
  });

  console.log("Товары и цены флористов…");
  // Товар: [сайт, название, картинка, externalId, цена сайта, базоваяЦенаФлориста(f1), overrideФ2]
  const productDefs = [
    { site: siteA, name: "Red Roses Bouquet", ext: "WOO-1001", list: 175, f1: 100, f2: 65, img: img("Red Roses", "#db2777") },
    { site: siteA, name: "Spring Tulips", ext: "WOO-1002", list: 120, f1: 70, f2: 55, img: img("Tulips", "#ec4899") },
    { site: siteA, name: "White Lilies", ext: "WOO-1003", list: 140, f1: 85, f2: 60, img: img("Lilies", "#f472b6") },
    { site: siteB, name: "Sunflower Joy", ext: "SHOP-2001", list: 95, f1: 55, f2: 50, img: img("Sunflowers", "#7c3aed") },
    { site: siteB, name: "Orchid Elegance", ext: "SHOP-2002", list: 210, f1: 130, f2: 120, img: img("Orchids", "#8b5cf6") },
    { site: siteB, name: "Mixed Seasonal", ext: "SHOP-2003", list: 130, f1: 75, f2: 70, img: img("Seasonal", "#a78bfa") },
  ];

  const products: Record<string, { id: string; siteId: string; list: number; f1: number; f2: number; name: string; img: string }> = {};
  for (const p of productDefs) {
    const created = await prisma.product.create({
      data: {
        name: p.name,
        siteId: p.site.id,
        externalId: p.ext,
        image: p.img,
        status: "ACTIVE",
        floristPrice: D(p.f1), // базовая цена флориста
        minPrice: D(p.list),
        maxPrice: D(p.list),
        lastSyncedAt: new Date(),
        variants: {
          create: [
            { externalId: `${p.ext}-V1`, title: "Default Title", listPrice: D(p.list), available: true, position: 1 },
          ],
        },
      },
    });
    // Индивидуальные override'ы флористов (variantId = null → на весь товар).
    await prisma.floristProductPrice.createMany({
      data: [
        { productId: created.id, floristId: florist1.id, makeCost: D(p.f1) },
        { productId: created.id, floristId: florist2.id, makeCost: D(p.f2) },
      ],
    });
    products[p.name] = { id: created.id, siteId: p.site.id, list: p.list, f1: p.f1, f2: p.f2, name: p.name, img: p.img };
  }

  const floristCost = (productName: string, floristKey: "f1" | "f2") => products[productName][floristKey];

  // Универсальный конструктор заказа
  let orderSeq = 1000;
  async function makeOrder(opts: {
    site: typeof siteA;
    platform: "WOOCOMMERCE" | "SHOPIFY";
    items: { product: string; qty: number; options?: string }[];
    deliveryDay: number;
    window?: string;
    recipient: { name: string; phone: string; email?: string | null; address: string; apartment?: string | null; city: string; zip: string };
    sender?: { name: string; phone: string; email?: string | null };
    card?: string;
    note?: string;
    paid: boolean;
    orderStatus: string;
    assignmentStatus: string;
    deliveryStatus?: string;
    assignedFlorist?: typeof florist1 | null;
    priceMode?: "AUTO" | "MANUAL";
    manualTotal?: number;
    readyDay?: number | null;
    bouquetPhoto?: string | null;
    trackingUrl?: string | null;
    deliveryActualCost?: number;
    tip?: number;
    discount?: number;
    declinedBy?: (typeof florist1)[];
    messages?: { channel: "SMS" | "EMAIL"; direction: "OUTBOUND" | "INBOUND"; party: "SENDER" | "RECIPIENT"; body: string }[];
  }) {
    orderSeq += 1;
    const floristKey = opts.assignedFlorist?.id === florist1.id ? "f1" : "f2";

    // Финансы
    let itemsTotal = 0;
    const itemsData = opts.items.map((it) => {
      const p = products[it.product];
      const line = p.list * it.qty;
      itemsTotal += line;
      const fCost = opts.assignedFlorist ? floristCost(it.product, floristKey) * it.qty : 0;
      return {
        productId: p.id,
        name: p.name,
        image: p.img,
        quantity: it.qty,
        options: it.options ?? "",
        externalPrice: D(p.list),
        floristItemPrice: D(fCost),
      };
    });
    const tax = Math.round(itemsTotal * 0.08 * 100) / 100;
    const tip = opts.tip ?? 0;
    const discount = opts.discount ?? 0;
    const deliveryCustomerCost = 15;
    const customerTotal = itemsTotal + tax + tip + deliveryCustomerCost - discount;

    let floristTotal = 0;
    if (opts.priceMode === "MANUAL" && opts.manualTotal != null) floristTotal = opts.manualTotal;
    else if (opts.assignedFlorist) floristTotal = opts.items.reduce((s, it) => s + floristCost(it.product, floristKey) * it.qty, 0);

    const deliveryActualCost = opts.deliveryActualCost ?? 0;
    const estimatedProfit = itemsTotal - floristTotal - deliveryActualCost;

    const card = opts.card ?? "";
    const note = opts.note ?? "";
    const sender = opts.sender ?? { name: "John Sender", phone: "+1 212 555 0100", email: "john.sender@example.com" };

    const order = await prisma.order.create({
      data: {
        orderNumber: `#${orderSeq}`,
        siteId: opts.site.id,
        platform: opts.platform,
        source: "Website",
        externalCreatedAt: at(-1, 9),
        deliveryDate: at(opts.deliveryDay, 12),
        deliveryWindow: opts.window ?? "12:00 – 16:00",
        senderName: sender.name,
        senderPhone: sender.phone,
        senderEmail: sender.email ?? null,
        recipientName: opts.recipient.name,
        recipientPhone: opts.recipient.phone,
        recipientEmail: opts.recipient.email ?? null,
        addressLine: opts.recipient.address,
        apartment: opts.recipient.apartment ?? null,
        city: opts.recipient.city,
        zip: opts.recipient.zip,
        cardMessage: card,
        originalCardMessage: card,
        customerNote: note,
        originalCustomerNote: note,
        itemsTotal: D(itemsTotal),
        tax: D(tax),
        tip: D(tip),
        discount: D(discount),
        deliveryCustomerCost: D(deliveryCustomerCost),
        customerTotal: D(customerTotal),
        floristTotal: D(floristTotal),
        deliveryActualCost: D(deliveryActualCost),
        estimatedProfit: D(estimatedProfit),
        paymentStatus: opts.paid ? "PAID" : "UNPAID",
        orderStatus: opts.orderStatus as never,
        assignmentStatus: opts.assignmentStatus as never,
        deliveryStatus: (opts.deliveryStatus ?? "PENDING") as never,
        syncStatus: "SYNCED",
        currentFloristId: opts.assignedFlorist?.id ?? null,
        priceMode: opts.priceMode ?? "AUTO",
        readyAt: opts.readyDay != null ? at(opts.readyDay, 11) : null,
        bouquetPhotoUrl: opts.bouquetPhoto ?? null,
        trackingUrl: opts.trackingUrl ?? null,
        externalId: `${opts.platform}-${orderSeq}`,
        lastSyncedAt: new Date(),
        items: { create: itemsData },
      },
    });

    // История отказов
    for (const f of opts.declinedBy ?? []) {
      await prisma.orderAssignment.create({
        data: { orderId: order.id, floristId: f.id, state: "DECLINED", respondedAt: new Date(), priceMode: "AUTO", floristTotalSnapshot: D(0) },
      });
    }
    // Текущее назначение
    if (opts.assignedFlorist) {
      const accepted = ["FLORIST_ACCEPTED", "IN_PROGRESS", "READY", "AWAITING_COURIER", "IN_TRANSIT", "DELIVERED"].includes(opts.orderStatus);
      await prisma.orderAssignment.create({
        data: {
          orderId: order.id,
          floristId: opts.assignedFlorist.id,
          state: accepted ? "ACCEPTED" : "ASSIGNED",
          respondedAt: accepted ? new Date() : null,
          priceMode: opts.priceMode ?? "AUTO",
          floristTotalSnapshot: D(floristTotal),
        },
      });
    }
    // Сообщения
    if (opts.messages?.length) {
      await prisma.message.createMany({ data: opts.messages.map((m) => ({ ...m, orderId: order.id })) });
    }
    return order;
  }

  console.log("Заказы (18 сценариев)…");

  const rcpt = (over: Partial<{ name: string; phone: string; email: string | null; address: string; apartment: string | null; city: string; zip: string }> = {}) => ({
    name: "Mary Recipient",
    phone: "+1 917 555 0111",
    email: "mary.r@example.com",
    address: "245 Oak Street",
    apartment: "Apt 4B",
    city: "Austin",
    zip: "78701",
    ...over,
  });

  const sampleSms = [
    { channel: "SMS" as const, direction: "OUTBOUND" as const, party: "RECIPIENT" as const, body: "Ваш букет будет доставлен сегодня в интервале 12:00–16:00." },
    { channel: "SMS" as const, direction: "INBOUND" as const, party: "RECIPIENT" as const, body: "Спасибо! Буду дома." },
  ];
  const sampleEmail = [
    { channel: "EMAIL" as const, direction: "OUTBOUND" as const, party: "SENDER" as const, body: "Заказ подтверждён. Спасибо за покупку в Bloom & Co!" },
  ];

  // 1. Оплаченный, назначен основному флористу (сайт A → Ф1), ждёт принятия
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "Red Roses Bouquet", qty: 1 }],
    deliveryDay: 0, recipient: rcpt(), card: "С днём рождения! Люблю тебя.", note: "Позвонить за 30 минут до доставки.",
    paid: true, orderStatus: "ASSIGNED", assignmentStatus: "ASSIGNED", assignedFlorist: florist1, messages: sampleSms,
  });

  // 2. Неоплаченный
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "Spring Tulips", qty: 1 }],
    deliveryDay: 2, recipient: rcpt({ name: "Alan Poe", phone: "+1 917 555 0222" }), card: "Скорейшего выздоровления!",
    paid: false, orderStatus: "AWAITING_PAYMENT", assignmentStatus: "UNASSIGNED", assignedFlorist: null,
  });

  // 3. Назначен, ещё не принят (сайт B → Ф2)
  await makeOrder({
    site: siteB, platform: "SHOPIFY", items: [{ product: "Sunflower Joy", qty: 1 }],
    deliveryDay: 0, recipient: rcpt({ name: "Kate Sun", city: "Brooklyn", zip: "11201", address: "88 Pine Ave" }),
    card: "Хорошего дня!", paid: true, orderStatus: "ASSIGNED", assignmentStatus: "ASSIGNED", assignedFlorist: florist2, messages: sampleSms,
  });

  // 4. Принят флористом
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "White Lilies", qty: 1 }],
    deliveryDay: 1, recipient: rcpt({ name: "Nina West" }), card: "Поздравляю с годовщиной!",
    paid: true, orderStatus: "FLORIST_ACCEPTED", assignmentStatus: "ACCEPTED", assignedFlorist: florist1,
  });

  // 5. В работе
  await makeOrder({
    site: siteB, platform: "SHOPIFY", items: [{ product: "Orchid Elegance", qty: 1 }],
    deliveryDay: 0, recipient: rcpt({ name: "Omar Ray", city: "Queens", zip: "11101" }), card: "С уважением.",
    paid: true, orderStatus: "IN_PROGRESS", assignmentStatus: "ACCEPTED", assignedFlorist: florist2,
  });

  // 6. Готов (с фото букета)
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "Red Roses Bouquet", qty: 1 }],
    deliveryDay: 0, recipient: rcpt({ name: "Lena Ford" }), card: "Just because ♥",
    paid: true, orderStatus: "READY", assignmentStatus: "ACCEPTED", assignedFlorist: florist1,
    readyDay: 0, bouquetPhoto: img("Ready Bouquet", "#16a34a"),
  });

  // 7. В пути
  await makeOrder({
    site: siteB, platform: "SHOPIFY", items: [{ product: "Mixed Seasonal", qty: 1 }],
    deliveryDay: 0, recipient: rcpt({ name: "Paul Kim", city: "Bronx", zip: "10451" }), card: "Enjoy!",
    paid: true, orderStatus: "IN_TRANSIT", assignmentStatus: "ACCEPTED", assignedFlorist: florist2,
    readyDay: 0, deliveryStatus: "IN_TRANSIT", trackingUrl: "https://track.example.com/abc123",
    deliveryActualCost: 12, bouquetPhoto: img("Ready Bouquet", "#16a34a"),
  });

  // 8. Доставлен (с фото доставки)
  const delivered = await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "Spring Tulips", qty: 1 }],
    deliveryDay: -1, recipient: rcpt({ name: "Rosa Diaz" }), card: "С праздником!",
    paid: true, orderStatus: "DELIVERED", assignmentStatus: "ACCEPTED", assignedFlorist: florist1,
    readyDay: -1, deliveryStatus: "DELIVERED", trackingUrl: "https://track.example.com/done1",
    deliveryActualCost: 10, bouquetPhoto: img("Ready Bouquet", "#16a34a"),
  });
  await prisma.order.update({ where: { id: delivered.id }, data: { deliveryPhotoUrl: img("Delivered", "#0891b2") } });

  // 9. Без флориста (требует назначения) — например, у сайта нет активных или заказ снят
  await makeOrder({
    site: siteB, platform: "SHOPIFY", items: [{ product: "Sunflower Joy", qty: 1 }],
    deliveryDay: 1, recipient: rcpt({ name: "Greg House", city: "Newark", zip: "07102" }), card: "Get well!",
    paid: true, orderStatus: "CONFIRMED", assignmentStatus: "UNASSIGNED", assignedFlorist: null,
  });

  // 10 + 11. Основной отказался → передан резерву.
  // Сайт A: основной Ф1 отказался, передан Ф2 (резерв). Сейчас назначен Ф2, ждёт принятия.
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "White Lilies", qty: 1 }],
    deliveryDay: 1, recipient: rcpt({ name: "Tom Ash" }), card: "Thinking of you.",
    paid: true, orderStatus: "ASSIGNED", assignmentStatus: "ASSIGNED", assignedFlorist: florist2,
    declinedBy: [florist1], messages: sampleEmail,
  });

  // 12. Ручная цена флориста
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "Red Roses Bouquet", qty: 1 }],
    deliveryDay: 2, recipient: rcpt({ name: "Vera Lynn" }), card: "Congrats!",
    paid: true, orderStatus: "FLORIST_ACCEPTED", assignmentStatus: "ACCEPTED", assignedFlorist: florist1,
    priceMode: "MANUAL", manualTotal: 90,
  });

  // 13. Авто цена (явный пример, сайт B → Ф2)
  await makeOrder({
    site: siteB, platform: "SHOPIFY", items: [{ product: "Orchid Elegance", qty: 1 }],
    deliveryDay: 2, recipient: rcpt({ name: "Ian Cole", city: "Jersey City", zip: "07302" }), card: "Best wishes.",
    paid: true, orderStatus: "ASSIGNED", assignmentStatus: "ASSIGNED", assignedFlorist: florist2, priceMode: "AUTO",
  });

  // 14. Несколько товаров
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE",
    items: [
      { product: "Red Roses Bouquet", qty: 2, options: "Ваза: стеклянная; Лента: красная" },
      { product: "Spring Tulips", qty: 1, options: "Цвет: микс" },
      { product: "White Lilies", qty: 1 },
    ],
    deliveryDay: 1, recipient: rcpt({ name: "Big Order" }), card: "С юбилеем! Желаем счастья.",
    paid: true, orderStatus: "IN_PROGRESS", assignmentStatus: "ACCEPTED", assignedFlorist: florist1,
  });

  // 15. Длинный текст открытки
  await makeOrder({
    site: siteB, platform: "SHOPIFY", items: [{ product: "Mixed Seasonal", qty: 1 }],
    deliveryDay: 0, recipient: rcpt({ name: "Long Card" }),
    card: "Дорогая мама! Спасибо тебе за всё, что ты для меня сделала за эти годы.\nТы всегда была рядом в трудную минуту, поддерживала и верила в меня.\nЖелаю тебе крепкого здоровья, счастья и долгих лет жизни.\nЛюблю тебя больше всего на свете. Твоя дочь.",
    paid: true, orderStatus: "ASSIGNED", assignmentStatus: "ASSIGNED", assignedFlorist: florist2,
  });

  // 16. Длинный customer note
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "White Lilies", qty: 1 }],
    deliveryDay: 1, recipient: rcpt({ name: "Long Note" }), card: "С любовью.",
    note: "Пожалуйста, доставьте строго после 15:00 — получатель на работе до этого времени.\nКонсьержу можно оставить букет, квартира 12, код домофона 4590.\nЕсли никто не откроет — позвоните отправителю. Не оставляйте под дверью!",
    paid: true, orderStatus: "FLORIST_ACCEPTED", assignmentStatus: "ACCEPTED", assignedFlorist: florist1,
  });

  // 17. Без email получателя
  await makeOrder({
    site: siteB, platform: "SHOPIFY", items: [{ product: "Sunflower Joy", qty: 1 }],
    deliveryDay: 0, recipient: rcpt({ name: "No Email", email: null }), card: "Hi!",
    paid: true, orderStatus: "ASSIGNED", assignmentStatus: "ASSIGNED", assignedFlorist: florist2,
  });

  // 18. Без номера апартаментов
  await makeOrder({
    site: siteA, platform: "WOOCOMMERCE", items: [{ product: "Spring Tulips", qty: 1 }],
    deliveryDay: 0, recipient: rcpt({ name: "No Apt", apartment: null, address: "12 Private House Rd" }), card: "Warm wishes.",
    paid: true, orderStatus: "ASSIGNED", assignmentStatus: "ASSIGNED", assignedFlorist: florist1,
  });

  const counts = {
    users: await prisma.user.count(),
    sites: await prisma.site.count(),
    products: await prisma.product.count(),
    orders: await prisma.order.count(),
  };
  console.log("Готово:", counts);
  console.log(`\nВход для всех ролей — пароль: ${PASSWORD}`);
  console.log("  Владелец:     owner@demo.local");
  console.log("  Колл-центр:   cc@demo.local");
  console.log("  Флорист №1:   florist1@demo.local");
  console.log("  Флорист №2:   florist2@demo.local");
}

// Простая SVG-картинка-заглушка в виде data URI (без внешних запросов).
function img(label: string, color: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><rect width='400' height='400' fill='${color}'/><text x='50%' y='50%' font-family='sans-serif' font-size='28' fill='white' text-anchor='middle' dominant-baseline='middle'>${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

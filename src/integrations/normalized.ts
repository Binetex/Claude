/**
 * Нормализованные модели внешних систем.
 *
 * Бизнес-модули и UI работают ТОЛЬКО с этими типами — платформенная форма
 * (Shopify/WooCommerce/Burq/Quo/Telegram) не должна протекать за пределы адаптера.
 * Типы «плоские» и сериализуемые: без Prisma.Decimal (используем number) и без
 * Date-объектов на границе UI (ISO-строки). Это делает их безопасными для передачи
 * из Server в Client Components.
 *
 * Импорты из `@/generated/prisma/enums` — ТОЛЬКО type-only (стираются при компиляции),
 * поэтому этот модуль не тянет серверные зависимости и не помечен `server-only`.
 */
import type {
  OrderStatus,
  PaymentStatus,
  DeliveryStatus,
} from "@/generated/prisma/enums";

/** Поддерживаемые платформы-источники (совпадает с Prisma enum Platform). */
export type IntegrationPlatform = "SHOPIFY" | "WOOCOMMERCE";

/** Каналы доставки сообщений (шире, чем Prisma MessageChannel — включает Telegram/Push). */
export type MessageChannel = "SMS" | "EMAIL" | "TELEGRAM" | "PUSH";

export type NormalizedAddress = {
  name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  zip: string;
  country: string | null;
};

export type NormalizedCustomer = {
  externalId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
};

export type NormalizedOrderItem = {
  externalId: string | null;
  productExternalId: string | null;
  variantExternalId: string | null;
  name: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  /** Цена покупателю за единицу (в валюте заказа). */
  unitPrice: number;
  image: string | null;
};

/** Внутреннее представление внешних статусов оплаты/выполнения. */
export type NormalizedExternalStatus = {
  payment: PaymentStatus;
  order: OrderStatus;
  delivery: DeliveryStatus | null;
};

export type NormalizedOrder = {
  platform: IntegrationPlatform;
  externalId: string;
  /** Человекочитаемый номер во внешней системе (напр. order_number Shopify). */
  externalNumber: string | null;
  createdAt: string; // ISO
  deliveryDate: string | null; // ISO date
  deliveryWindow: string | null;
  sender: NormalizedCustomer;
  recipient: NormalizedCustomer;
  shippingAddress: NormalizedAddress | null;
  cardMessage: string;
  customerNote: string;
  items: NormalizedOrderItem[];
  money: {
    itemsTotal: number;
    tax: number;
    tip: number;
    discount: number;
    deliveryCost: number;
    total: number;
  };
  status: NormalizedExternalStatus;
  /** Сырой payload для аудита/отладки; бизнес-логика на него не опирается. */
  raw: unknown;
};

/** Событие изменения статуса доставки от провайдера (Burq и т.п.). */
export type NormalizedDeliveryEvent = {
  provider: string; // "burq", ...
  externalId: string; // id доставки во внешней системе
  status: DeliveryStatus; // уже нормализованный внутренний статус
  trackingUrl: string | null;
  occurredAt: string; // ISO
  raw: unknown;
};

/** Событие сообщения (доставлено/прочитано/ответ клиента) от messaging-провайдера. */
export type NormalizedMessageEvent = {
  channel: MessageChannel;
  direction: "OUTBOUND" | "INBOUND";
  party: "SENDER" | "RECIPIENT";
  externalId: string | null;
  body: string;
  occurredAt: string; // ISO
  raw: unknown;
};

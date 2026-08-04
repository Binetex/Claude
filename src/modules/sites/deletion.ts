import "server-only";
/**
 * Полное удаление магазина.
 *
 * Отличается от «Отключить» принципиально: отключение снимает credentials и webhooks, но
 * сохраняет сам Site вместе с историей. Здесь запись исчезает совсем — вместе со всем, что
 * без неё не имеет смысла.
 *
 * Зачем понадобилось: незавершённое подключение (домен ввели с ошибкой, магазин так и не
 * активировался) оставалось в списке навсегда и мешало как дубликат.
 *
 * ГЛАВНОЕ ПРАВИЛО: заказы неприкосновенны. Сайт с заказами не удаляется ВООБЩЕ — ни с
 * подтверждением, ни с галочкой. Заказ — это деньги, доставки, переписка с клиентом и
 * начисления флористу; каскад по нему невосстановим, а «случайно нажал» стоило бы всей
 * истории магазина. Всё остальное, что висит на сайте, — это его настройки и служебные
 * записи: без сайта они и так мусор, поэтому уходят вместе с ним, но пересчитываются и
 * показываются человеку ДО удаления.
 */
import { prisma } from "@/lib/db";

export type SiteDeletionImpact = {
  siteId: string;
  name: string;
  shortName: string;
  platform: string;
  /** Домен магазина, как его видит владелец. null — подключение не доведено до конца. */
  domain: string | null;
  connectionStatus: string;
  /** Подключение не завершено: нет ни токена, ни client id. */
  neverConnected: boolean;
  /** Заказы — единственный жёсткий блокер. */
  orders: number;
  /** Что будет удалено вместе с сайтом. Только ненулевое, в порядке значимости. */
  willDelete: Array<{ label: string; count: number }>;
  /** Удаление разрешено. */
  canDelete: boolean;
  /** Почему нельзя. Пусто, когда можно. */
  blockers: string[];
};

/**
 * Что произойдёт при удалении. Ничего не меняет — только считает.
 *
 * Считается ВСЁ, а не «есть/нет»: владелец должен видеть числа, а не «будут затронуты
 * связанные данные». Строки с нулём в отчёт не попадают — они бы только зашумляли список.
 */
export async function getSiteDeletionImpact(siteId: string): Promise<SiteDeletionImpact | null> {
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return null;

  const [
    orders, products, syncs, shopifyWebhooks, wooWebhooks, wooConnection,
    automations, flowSites, flowRuns, emailSettings, emailTemplates,
    floristPriorities, feeModels, consumablesRates, taxPolicies, financeIssues,
    financeProfileSites, vaseCosts,
  ] = await Promise.all([
    prisma.order.count({ where: { siteId } }),
    prisma.product.count({ where: { siteId } }),
    prisma.siteSync.count({ where: { siteId } }),
    prisma.shopifyWebhook.count({ where: { siteId } }),
    prisma.wooCommerceWebhook.count({ where: { siteId } }),
    prisma.wooCommerceConnection.count({ where: { siteId } }),
    prisma.automationSite.count({ where: { siteId } }),
    prisma.automationFlowSite.count({ where: { siteId } }),
    prisma.automationFlowRun.count({ where: { siteId } }),
    prisma.siteEmailSettings.count({ where: { siteId } }),
    prisma.siteEmailTemplate.count({ where: { siteId } }),
    prisma.siteFloristPriority.count({ where: { siteId } }),
    prisma.siteAcquiringFeeModel.count({ where: { siteId } }),
    prisma.consumablesRate.count({ where: { siteId } }),
    prisma.ownerTaxPolicy.count({ where: { siteId } }),
    prisma.financeIssue.count({ where: { siteId } }),
    prisma.floristFinanceProfileSite.count({ where: { siteId } }),
    prisma.vasePurchaseCost.count({ where: { product: { siteId } } }),
  ]);

  const willDelete = [
    { label: "Товары каталога", count: products },
    { label: "Закупочные стоимости ваз", count: vaseCosts },
    { label: "Подписки на webhook (Shopify)", count: shopifyWebhooks },
    { label: "Подписки на webhook (WooCommerce)", count: wooWebhooks },
    { label: "Подключение WooCommerce", count: wooConnection },
    { label: "Записи синхронизации", count: syncs },
    { label: "Правила автоматизаций", count: automations },
    { label: "Цепочки автоматизаций", count: flowSites },
    { label: "Запуски цепочек", count: flowRuns },
    { label: "Настройки Email", count: emailSettings },
    { label: "Шаблоны Email", count: emailTemplates },
    { label: "Приоритеты флористов", count: floristPriorities },
    { label: "Модели комиссии эквайринга", count: feeModels },
    { label: "Ставки расходников", count: consumablesRates },
    { label: "Налоговые политики", count: taxPolicies },
    { label: "Записи «требует заполнения»", count: financeIssues },
    { label: "Привязки к финансовым профилям", count: financeProfileSites },
  ].filter((r) => r.count > 0);

  const blockers: string[] = [];
  if (orders > 0) {
    blockers.push(
      `К магазину привязано заказов: ${orders}. Такой магазин не удаляется: вместе с ним ушли бы ` +
        `история доставок, переписка с клиентами и начисления флористам. Используйте «Отключить» — ` +
        `он снимет credentials и webhooks, но сохранит всю историю.`
    );
  }

  return {
    siteId: site.id,
    name: site.name,
    shortName: site.shortName,
    platform: site.platform,
    domain: site.normalizedShopDomain ?? site.shopifyShopDomain,
    connectionStatus: site.connectionStatus,
    neverConnected: !site.accessTokenEncrypted && !site.shopifyAccessToken && !site.clientIdEncrypted,
    orders,
    willDelete,
    canDelete: blockers.length === 0,
    blockers,
  };
}

export class SiteDeletionError extends Error {
  constructor(
    public readonly reason: "not_found" | "has_orders",
    message: string
  ) {
    super(message);
    this.name = "SiteDeletionError";
  }
}

/**
 * Удаляет магазин целиком.
 *
 * Проверка заказов делается ЗДЕСЬ, а не только в UI: экран мог быть открыт минуту назад, а
 * за это время в магазин мог прийти первый заказ. Решение о деньгах не может зависеть от
 * того, насколько свежая страница у человека в браузере.
 *
 * Часть связей объявлена в схеме как Restrict — они специально не каскадятся, чтобы Site
 * нельзя было снести случайным `delete`. Здесь они удаляются явно и по одной, внутри
 * транзакции: либо уходит всё, либо не уходит ничего.
 */
export async function deleteSiteCompletely(siteId: string): Promise<{ name: string; domain: string | null }> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, name: true, normalizedShopDomain: true, shopifyShopDomain: true },
  });
  if (!site) throw new SiteDeletionError("not_found", "Магазин не найден — возможно, он уже удалён.");

  const orders = await prisma.order.count({ where: { siteId } });
  if (orders > 0) {
    throw new SiteDeletionError(
      "has_orders",
      `Магазин нельзя удалить: к нему привязано заказов — ${orders}. Воспользуйтесь «Отключить».`
    );
  }

  await prisma.$transaction(async (tx) => {
    // Связи с onDelete: Restrict — каскад их не заберёт, убираем руками.
    // Порядок важен: сначала то, что ссылается на товары, потом сами товары.
    await tx.vasePurchaseCost.deleteMany({ where: { product: { siteId } } });
    await tx.floristFinanceProfileSite.deleteMany({ where: { siteId } });
    await tx.siteAcquiringFeeModel.deleteMany({ where: { siteId } });
    await tx.consumablesRate.deleteMany({ where: { siteId } });
    await tx.ownerTaxPolicy.deleteMany({ where: { siteId } });
    await tx.financeIssue.deleteMany({ where: { siteId } });

    // Остальное (товары с вариантами, вебхуки, синхронизации, автоматизации, Email,
    // приоритеты, WooCommerce-подключение) уходит каскадом вместе с Site.
    await tx.site.delete({ where: { id: siteId } });
  });

  return { name: site.name, domain: site.normalizedShopDomain ?? site.shopifyShopDomain };
}

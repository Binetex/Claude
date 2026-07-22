import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { getAppUrl } from "@/lib/appUrl";
import {
  verifyCallbackHmac,
  verifyOAuthState,
  exchangeCodeForToken,
  isValidShopDomain,
} from "@/integrations/shopify/oauth";
import { registerOrderWebhooks } from "@/integrations/shopify/webhooks";
import { autoAssignSitePriorities } from "@/modules/assignments/service";
import { startProductSyncInBackground } from "@/modules/catalog/sync";

/**
 * Callback после согласия владельца магазина на установку приложения.
 * Только владелец нашей системы мог инициировать поток (см. ownerConnectShopify),
 * но саму сессию тут не проверяем строго — верификация идёт через HMAC + state
 * (это подпись Shopify, а не наша сессия пользователя браузера).
 */
export async function GET(request: Request) {
  // Только владелец нашей системы может завершить подключение (та же вкладка,
  // где он был залогинен, когда инициировал редирект на Shopify).
  await requireRole("OWNER");

  const url = new URL(request.url);
  const params = url.searchParams;

  const shop = params.get("shop");
  const code = params.get("code");
  const state = params.get("state");

  if (!shop || !code || !state || !isValidShopDomain(shop)) {
    return NextResponse.json({ error: "Некорректный запрос от Shopify" }, { status: 400 });
  }
  if (!verifyCallbackHmac(params)) {
    return NextResponse.json({ error: "Неверная подпись запроса" }, { status: 401 });
  }
  if (!verifyOAuthState(state, shop)) {
    return NextResponse.json({ error: "Истёкшая или недействительная ссылка подключения" }, { status: 401 });
  }

  const accessToken = await exchangeCodeForToken(shop, code);

  // Красивое имя магазина — не критично. Таймзону из API НЕ берём: Site.timezone — ручная
  // настройка Floremart (владелец задаёт в карточке сайта).
  let shopName = shop.replace(".myshopify.com", "");
  try {
    const shopInfoRes = await fetch(`https://${shop}/admin/api/2026-07/shop.json`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (shopInfoRes.ok) {
      const data = (await shopInfoRes.json()) as { shop?: { name?: string } };
      if (data.shop?.name) shopName = data.shop.name;
    }
  } catch {
    // Не критично — оставляем производное от домена имя.
  }

  const wasAlreadyConnected = await prisma.site.findUnique({ where: { shopifyShopDomain: shop } });

  const site = await prisma.site.upsert({
    where: { shopifyShopDomain: shop },
    update: {
      shopifyAccessToken: accessToken,
      connectionStatus: "CONNECTED",
    },
    create: {
      name: shopName,
      shortName: shopName.slice(0, 20).toUpperCase(),
      platform: "SHOPIFY",
      connectionStatus: "CONNECTED",
      shopifyShopDomain: shop,
      shopifyAccessToken: accessToken,
    },
  });

  try {
    await registerOrderWebhooks(shop, accessToken);
  } catch (err) {
    // Магазин уже подключён и токен сохранён — не роняем весь флоу из-за вебхуков,
    // но громко логируем: без них заказы не будут приходить.
    console.error(`[shopify] не удалось зарегистрировать вебхуки для ${shop}:`, err);
  }

  if (!wasAlreadyConnected) {
    // Новый сайт — автоматически расставляем приоритет флористов, чтобы заказы
    // сразу начали назначаться, а не зависали в «Требует назначения» до тех пор,
    // пока owner не настроит это вручную (ручной настройки приоритетов пока нет в UI).
    await autoAssignSitePriorities(site.id);
  }

  // Первичный импорт товаров стартует в фоне — не заставляем владельца ждать,
  // сразу возвращаем его в интерфейс. Прогресс виден на /dashboard/sites (SiteSync).
  startProductSyncInBackground(site.id);

  return NextResponse.redirect(`${getAppUrl()}/dashboard/sites`);
}

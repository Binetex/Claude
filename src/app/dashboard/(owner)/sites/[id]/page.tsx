import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { REQUIRED_WEBHOOK_TOPICS } from "@/integrations/shopify/customApp/webhookRegistration";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SiteCardActions } from "../SiteCardActions";
import { DeleteSiteDialog } from "../DeleteSiteDialog";
import { SiteBurqAutoCreateSetting } from "../SiteBurqAutoCreateSetting";
import { SiteNameForm } from "../SiteNameForm";
import { SiteSyncControls } from "../SiteSyncControls";
import { WooSiteControls } from "../WooSiteControls";
import { WooSettings } from "../WooSettings";
import { AirwallexMonitoringPanel } from "../AirwallexMonitoringPanel";
import { SiteTimezoneSetting } from "../SiteTimezoneSetting";
import { SiteBurqDropoffSetting } from "../SiteBurqDropoffSetting";
import { SiteQuoSetting } from "../SiteQuoSetting";
import { SiteEmailPanel } from "../SiteEmailPanel";
import { BrevoAccountPanel } from "../BrevoAccountPanel";
import { SiteSettingsTabs, type SettingsSection } from "../SiteSettingsTabs";
import { connStatusMeta, syncSnapshot, dateTime } from "../siteMeta";
import { loadSiteEmailSettingsViews } from "@/integrations/email/settings";
import { getBrevoAccountViews } from "@/integrations/email/accountKey";
import { isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { diffScopes } from "@/integrations/shopify/customApp/scopes";

export const dynamic = "force-dynamic";

/**
 * Настройки ОДНОГО магазина, разложенные по вкладкам. Раньше все панели всех магазинов жили на
 * одной странице простынёй; при пяти магазинах это пять одинаковых простыней подряд.
 *
 * Секреты (clientSecretEncrypted/accessTokenEncrypted/…) сюда не выбираются — как и в списке,
 * серверная память их не видит, наружу уходят только маски.
 */
export default async function SiteSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const site = await prisma.site.findUnique({
    where: { id },
    select: {
      id: true, name: true, shortName: true, platform: true, colorTag: true,
      burqDraftAutoCreateEnabled: true,
      connectionStatus: true, shopifyShopDomain: true, timezone: true, burqDefaultDropoffInstructions: true,
      quoPhoneNumberId: true, quoPhoneNumber: true, quoEnabled: true, quoLastCheckAt: true, quoConnectionError: true,
      authMode: true, shopifyConnStatus: true, lastConnectionCheckAt: true, lastSyncAt: true,
      grantedScopes: true, connectionError: true,
      webhooks: { select: { topic: true, status: true } },
      floristPriorities: {
        orderBy: { position: "asc" },
        select: { id: true, position: true, florist: { select: { user: { select: { name: true } } } } },
      },
      syncs: {
        select: {
          kind: true, status: true, total: true, processed: true, created: true,
          updated: true, skipped: true, errors: true, errorMessage: true, finishedAt: true,
        },
      },
      wooConnection: {
        select: {
          storeUrl: true, apiBaseUrl: true, connStatus: true, connectionError: true,
          storeName: true, currency: true, wooVersion: true, wpVersion: true,
          consumerSecretMask: true, lastConnectionCheckAt: true, lastProductSyncAt: true, lastOrderSyncAt: true,
          orderMetaMapping: true, airwallexEnabled: true, klarnaPayLaterPendingIsConfirmed: true,
          airwallexPaymentMethodIds: true, airwallexMetaKeys: true, payLaterMaxWaitMinutes: true, unknownBehavior: true,
          airwallexMonitoringEnabled: true, airwallexApiClientIdEncrypted: true, airwallexApiKeyEncrypted: true,
          airwallexApiKeyMask: true, airwallexApiEnv: true, airwallexPendingThresholdMin: true,
          airwallexApiVerifiedAt: true, airwallexApiConnStatus: true, airwallexApiErrorSafe: true,
          pushPaidStatusToWoo: true,
        },
      },
      _count: { select: { orders: true, products: true, wooWebhooks: true } },
    },
  });

  if (!site) notFound();

  const [emailViews, brevoViews] = await Promise.all([
    loadSiteEmailSettingsViews(prisma, [site.id]),
    getBrevoAccountViews(prisma, [site.id]),
  ]);
  const emailView = emailViews[site.id];
  const brevoView = brevoViews[site.id];
  const cryptoConfigured = isCredentialCryptoConfigured();
  const snapshot = syncSnapshot(site.syncs);

  const sections: SettingsSection[] = [
    {
      key: "general",
      label: "Основное",
      content: (
        <>
          <Card>
            <CardBody className="space-y-3 text-sm">
              <div>
                <div className="mb-1 text-xs text-slate-400">Название</div>
                <SiteNameForm siteId={site.id} name={site.name} />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div><div className="text-xs text-slate-400">Короткое имя</div>{site.shortName}</div>
                <div><div className="text-xs text-slate-400">Платформа</div>{site.platform}</div>
                <div><div className="text-xs text-slate-400">Заказов / товаров</div>{site._count.orders} / {site._count.products}</div>
                {site.shopifyShopDomain && (
                  <div className="col-span-2 sm:col-span-3">
                    <div className="text-xs text-slate-400">Домен Shopify</div>{site.shopifyShopDomain}
                  </div>
                )}
              </div>
              <SiteTimezoneSetting siteId={site.id} current={site.timezone} />
            </CardBody>
          </Card>

          <Card>
            <CardBody className="text-sm">
              <div className="mb-1 text-xs text-slate-400">Приоритет флористов</div>
              {site.floristPriorities.length === 0 ? (
                <div className="text-xs text-slate-400">Не задан</div>
              ) : (
                <ol className="space-y-1">
                  {site.floristPriorities.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-xs text-white">{p.position + 1}</span>
                      <span className="text-slate-700">{p.florist.user.name}</span>
                      {p.position === 0 && <span className="text-xs text-emerald-600">основной</span>}
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>

          {/* Удаление стоит у ВСЕХ магазинов, а не только у подключённых: чаще всего удаляют
              как раз незавершённое подключение — домен ввели с ошибкой, магазин так и не
              активировался, а в списке он остался дубликатом. Диалог сам посчитает связи и
              не даст удалить магазин с заказами. */}
          <Card>
            <CardBody className="flex items-center justify-between text-sm">
              <span className="text-xs text-slate-500">Удаление магазина. Диалог покажет связанные данные и не даст удалить магазин с заказами.</span>
              <DeleteSiteDialog siteId={site.id} siteName={site.name} />
            </CardBody>
          </Card>
        </>
      ),
    },
    {
      key: "connection",
      label: "Подключение",
      hint: site.connectionStatus === "CONNECTED" ? "подключён" : null,
      content: (
        <>
          {site.platform === "WOOCOMMERCE" && site.wooConnection && (
            <Card>
              <CardBody className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-slate-100 text-slate-700 border-slate-200">WooCommerce</Badge>
                  <Badge className={(connStatusMeta[site.wooConnection.connStatus] ?? connStatusMeta.DISCONNECTED).className}>
                    {(connStatusMeta[site.wooConnection.connStatus] ?? { label: site.wooConnection.connStatus }).label}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                  <div className="col-span-2"><span className="text-slate-400">URL:</span> {site.wooConnection.storeUrl}</div>
                  <div><span className="text-slate-400">Валюта:</span> {site.wooConnection.currency ?? "—"}</div>
                  <div><span className="text-slate-400">WooCommerce:</span> {site.wooConnection.wooVersion ?? "—"}</div>
                  <div><span className="text-slate-400">Webhooks:</span> {site._count.wooWebhooks}</div>
                  <div><span className="text-slate-400">Проверка:</span> {dateTime(site.wooConnection.lastConnectionCheckAt)}</div>
                  <div><span className="text-slate-400">Секрет:</span> {site.wooConnection.consumerSecretMask || "—"}</div>
                </div>
                {site.wooConnection.connectionError && <div className="text-xs text-orange-700">{site.wooConnection.connectionError}</div>}
                <WooSiteControls
                  siteId={site.id}
                  snapshot={snapshot}
                  connected={site.wooConnection.connStatus === "CONNECTED" || site.wooConnection.connStatus === "DEGRADED"}
                  storeUrl={site.wooConnection.storeUrl}
                />
                <WooSettings
                  siteId={site.id}
                  metaMapping={(site.wooConnection.orderMetaMapping as Record<string, string> | null) ?? null}
                  payment={{
                    airwallexEnabled: site.wooConnection.airwallexEnabled,
                    klarnaPayLaterPendingIsConfirmed: site.wooConnection.klarnaPayLaterPendingIsConfirmed,
                    airwallexPaymentMethodIds: site.wooConnection.airwallexPaymentMethodIds,
                    paymentIntentStatusKey: (site.wooConnection.airwallexMetaKeys as { paymentIntentStatusKey?: string } | null)?.paymentIntentStatusKey ?? null,
                    payLaterMaxWaitMinutes: site.wooConnection.payLaterMaxWaitMinutes,
                    unknownBehavior: site.wooConnection.unknownBehavior,
                  }}
                />
              </CardBody>
            </Card>
          )}

          {site.authMode === "CUSTOM_APP" && (
            <Card>
              <CardBody className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-slate-100 text-slate-700 border-slate-200">Custom App</Badge>
                  {site.shopifyConnStatus && (
                    <Badge className={(connStatusMeta[site.shopifyConnStatus] ?? connStatusMeta.DISCONNECTED).className}>
                      {(connStatusMeta[site.shopifyConnStatus] ?? { label: site.shopifyConnStatus }).label}
                    </Badge>
                  )}
                </div>
                {site.shopifyShopDomain && (
                  <div className="text-xs text-slate-500"><span className="text-slate-400">Домен:</span> {site.shopifyShopDomain}</div>
                )}
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                  <div><span className="text-slate-400">Последняя проверка:</span> {dateTime(site.lastConnectionCheckAt)}</div>
                  <div><span className="text-slate-400">Последняя синхр.:</span> {dateTime(site.lastSyncAt)}</div>
                </div>
                {(() => {
                  const missing = diffScopes(site.grantedScopes).missing;
                  return missing.length ? <div className="text-xs text-orange-700">Не хватает scopes: {missing.join(", ")}</div> : null;
                })()}
                {(() => {
                  // Без подписок магазин молча не получает заказы — показываем это явно.
                  const active = site.webhooks.filter((w) => w.status === "ACTIVE").length;
                  const hasOrders = site.webhooks.some((w) => w.topic === "ORDERS_CREATE" && w.status === "ACTIVE");
                  if (active >= REQUIRED_WEBHOOK_TOPICS.length && hasOrders) {
                    return <div className="text-xs text-emerald-700">Подписки на webhook: {active} активных ✓</div>;
                  }
                  return (
                    <div className="text-xs text-orange-700">
                      Подписки на webhook: {active} из {REQUIRED_WEBHOOK_TOPICS.length}
                      {hasOrders ? "" : " — нет ORDERS_CREATE, новые заказы не придут"}. Нажмите «Проверить подписки».
                    </div>
                  );
                })()}
                {site.connectionError && <div className="text-xs text-red-600">{site.connectionError}</div>}
                <SiteCardActions siteId={site.id} />
              </CardBody>
            </Card>
          )}

          {/* Все блоки вкладки условные: у магазина без подключения не выполнится ни один,
              и вкладка была бы пустым экраном без объяснения. */}
          {!site.wooConnection && site.authMode !== "CUSTOM_APP" && (
            <Card>
              <CardBody className="space-y-1 text-sm">
                <div className="font-medium text-slate-700">Магазин не подключён</div>
                <p className="text-xs text-slate-500">
                  Здесь появятся данные подключения, проверка и синхронизация. Подключить магазин
                  можно в блоке «Подключить новый магазин» на <Link href="/dashboard/sites" className="text-sky-600 underline">списке сайтов</Link>.
                </p>
              </CardBody>
            </Card>
          )}

          {site.platform !== "WOOCOMMERCE" && site.connectionStatus === "CONNECTED" && (
            <Card>
              <CardBody className="text-sm">
                <div className="mb-1.5 text-xs text-slate-400">Синхронизация</div>
                <SiteSyncControls siteId={site.id} initial={snapshot} />
              </CardBody>
            </Card>
          )}
        </>
      ),
    },
    {
      key: "sms",
      label: "SMS",
      hint: site.quoEnabled && site.quoPhoneNumberId ? "вкл" : "выкл",
      content: (
        <Card>
          <CardBody className="text-sm">
            <SiteQuoSetting
              siteId={site.id}
              current={{
                quoPhoneNumberId: site.quoPhoneNumberId,
                quoPhoneNumber: site.quoPhoneNumber,
                quoEnabled: site.quoEnabled,
                quoLastCheckAt: site.quoLastCheckAt ? site.quoLastCheckAt.toISOString() : null,
                quoConnectionError: site.quoConnectionError,
              }}
            />
          </CardBody>
        </Card>
      ),
    },
    {
      key: "email",
      label: "Email",
      hint: !brevoView.configured ? "нет ключа" : emailView.enabled ? "вкл" : "выкл",
      content: (
        <>
          <BrevoAccountPanel siteId={site.id} view={brevoView} />
          <Card>
            <CardBody className="text-sm">
              <SiteEmailPanel siteId={site.id} initial={emailView} />
            </CardBody>
          </Card>
        </>
      ),
    },
    {
      key: "delivery",
      label: "Доставка",
      hint: site.burqDraftAutoCreateEnabled ? "автосоздание" : null,
      content: (
        <Card>
          <CardBody className="space-y-3 text-sm">
            <SiteBurqAutoCreateSetting siteId={site.id} enabled={site.burqDraftAutoCreateEnabled} />
            <SiteBurqDropoffSetting siteId={site.id} current={site.burqDefaultDropoffInstructions} />
          </CardBody>
        </Card>
      ),
    },
  ];

  // Панель Airwallex живёт на подключении WooCommerce — у магазинов без него вкладки нет вовсе,
  // пустая вкладка «Оплаты» только сбивала бы с толку.
  if (site.platform === "WOOCOMMERCE" && site.wooConnection) {
    sections.push({
      key: "payments",
      label: "Оплаты",
      hint: site.wooConnection.airwallexMonitoringEnabled ? "наблюдение" : null,
      content: (
        <AirwallexMonitoringPanel
          siteId={site.id}
          initial={{
            monitoringEnabled: site.wooConnection.airwallexMonitoringEnabled,
            pushPaidStatusToWoo: site.wooConnection.pushPaidStatusToWoo,
            clientIdConfigured: !!site.wooConnection.airwallexApiClientIdEncrypted,
            apiKeyConfigured: !!site.wooConnection.airwallexApiKeyEncrypted,
            apiKeyMask: site.wooConnection.airwallexApiKeyMask,
            env: site.wooConnection.airwallexApiEnv === "demo" ? "demo" : "prod",
            pendingThresholdMin: site.wooConnection.airwallexPendingThresholdMin,
            verifiedAt: site.wooConnection.airwallexApiVerifiedAt ? site.wooConnection.airwallexApiVerifiedAt.toISOString() : null,
            connStatus: site.wooConnection.airwallexApiConnStatus,
            errorSafe: site.wooConnection.airwallexApiErrorSafe,
            cryptoConfigured,
          }}
        />
      ),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link href="/dashboard/sites" className="text-sm text-slate-400 hover:text-slate-600">← Сайты</Link>
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: site.colorTag }} />
          <h1 className="text-lg font-semibold text-slate-900">{site.name}</h1>
          <span className="text-xs text-slate-400">{site.shortName}</span>
        </div>
        <Badge className={site.connectionStatus === "CONNECTED" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-600 border-slate-200"}>
          {site.connectionStatus === "CONNECTED" ? "Подключён" : site.connectionStatus}
        </Badge>
      </div>

      <SiteSettingsTabs sections={sections} />
    </div>
  );
}

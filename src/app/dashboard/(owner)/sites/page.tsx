import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { AddSitePanel } from "./AddSitePanel";
import { SiteQuoWebhookSecurity } from "./SiteQuoWebhookSecurity";
import { connStatusMeta, dateTime } from "./siteMeta";
import { loadSiteEmailSettingsViews } from "@/integrations/email/settings";
import { listQuoSigningSecretsMasked } from "@/integrations/quo/signingSecrets";
import { getQuoSigningKeys } from "@/integrations/quo/config";
import { isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { EmailFactoryTokenPanel } from "./EmailFactoryTokenPanel";
import { loadEmailFactoryView } from "@/integrations/emailFactory/token";

export const dynamic = "force-dynamic";

/**
 * Список магазинов. Настройки самого магазина живут на его странице (`/dashboard/sites/[id]`)
 * — здесь только то, по чему магазин узнают и выбирают: имя, платформа, состояние подключения
 * и включённые каналы. Раньше все панели всех магазинов лежали прямо здесь, и страница была
 * пятью одинаковыми простынями подряд.
 *
 * Под списком — то, что НЕ принадлежит магазину: подключение нового и подпись вебхуков QUO
 * (она общая на всю систему, в отличие от ключа Brevo — тот теперь у каждого магазина свой).
 * Именно под, а не над: инструкция по подключению занимает целый экран, и страница «Сайты»
 * начиналась бы не с сайтов.
 */
export default async function SitesPage() {
  const emailFactoryView = await loadEmailFactoryView(prisma);
  // Явный select: ни секретов, ни полей, которые нужны только на странице магазина.
  const sites = await prisma.site.findMany({
    select: {
      id: true, name: true, shortName: true, platform: true, colorTag: true,
      connectionStatus: true, shopifyShopDomain: true,
      quoEnabled: true, quoPhoneNumberId: true,
      shopifyConnStatus: true, lastSyncAt: true,
      wooConnection: { select: { connStatus: true, storeUrl: true, lastOrderSyncAt: true } },
    },
    orderBy: { name: "asc" },
  });

  const emailViews = await loadSiteEmailSettingsViews(prisma, sites.map((s) => s.id));
  const quoSecrets = await listQuoSigningSecretsMasked(prisma).catch(() => []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Сайты</h1>

      <AddSitePanel />

      <div className="space-y-2">
        {sites.map((s) => {
          const email = emailViews[s.id];
          // Платформенный статус точнее, но он есть не всегда: у магазина без подключения
          // строки нет вовсе, и без запасного варианта незавершённое подключение выглядело бы
          // в списке ровно как рабочий магазин.
          const platformStatus = s.platform === "WOOCOMMERCE" ? s.wooConnection?.connStatus : s.shopifyConnStatus;
          const lastSync = s.wooConnection?.lastOrderSyncAt ?? s.lastSyncAt;
          const meta = (platformStatus && connStatusMeta[platformStatus]) ?? connStatusMeta[s.connectionStatus] ?? {
            label: s.connectionStatus,
            className: "bg-slate-100 text-slate-600 border-slate-200",
          };
          return (
            <Link
              key={s.id}
              href={`/dashboard/sites/${s.id}`}
              className="block rounded-lg transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              <Card>
                <CardBody className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.colorTag }} />
                  <div className="min-w-[180px] flex-1">
                    <div className="font-medium text-slate-900">{s.name}</div>
                    <div className="text-xs text-slate-400">
                      {s.shortName} · {s.platform}
                      {s.shopifyShopDomain ? ` · ${s.shopifyShopDomain}` : ""}
                      {s.wooConnection?.storeUrl ? ` · ${s.wooConnection.storeUrl}` : ""}
                    </div>
                  </div>

                  <div className="text-xs text-slate-400">
                    {lastSync ? `синхр. ${dateTime(lastSync)}` : "синхронизации не было"}
                  </div>

                  {/* Каналы: видно с одного взгляда, где магазин молчит и почему туда стоит зайти. */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className={s.quoEnabled && s.quoPhoneNumberId ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-500 border-slate-200"}>
                      SMS {s.quoEnabled && s.quoPhoneNumberId ? "вкл" : "выкл"}
                    </Badge>
                    <Badge
                      className={
                        !email?.brevoApiKeyConfigured
                          ? "bg-amber-100 text-amber-800 border-amber-200"
                          : email.enabled
                            ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                            : "bg-slate-100 text-slate-500 border-slate-200"
                      }
                    >
                      Email {!email?.brevoApiKeyConfigured ? "без ключа" : email.enabled ? "вкл" : "выкл"}
                    </Badge>
                    {meta && <Badge className={meta.className}>{meta.label}</Badge>}
                  </div>

                </CardBody>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Ниже — то, что НЕ принадлежит конкретному магазину. Токен Email Factory здесь по той же
          причине: он один на аккаунт и видит все домены. Выбор домена — в карточке магазина. */}
      <EmailFactoryTokenPanel view={emailFactoryView} />

      <SiteQuoWebhookSecurity
        secrets={quoSecrets.map((s) => ({ id: s.id, maskedSuffix: s.maskedSuffix, createdAt: s.createdAt.toISOString() }))}
        envCount={getQuoSigningKeys().length}
        cryptoConfigured={isCredentialCryptoConfigured()}
      />
    </div>
  );
}

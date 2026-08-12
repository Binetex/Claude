import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { loadEmailFactoryView } from "@/integrations/emailFactory/token";
import { EmailFactoryPanel } from "./EmailFactoryPanel";

export const dynamic = "force-dynamic";

export default async function EmailFactorySettingsPage() {
  await requireRole("OWNER");

  // Адрес для проверки фильтра подставляем из настроек магазина: клиенты отвечают на тот же
  // адрес, с которого им пишут. Это подсказка в поле, а не настройка — её можно перебить руками.
  const [view, sample] = await Promise.all([
    loadEmailFactoryView(prisma),
    prisma.siteEmailSettings.findFirst({
      where: { enabled: true, senderEmail: { not: null } },
      select: { senderEmail: true },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Email Factory</h1>
        <p className="mt-1 text-xs text-slate-500">
          Второй почтовый канал — только для ручной переписки с клиентом. Автоматические письма по событиям заказа остаются на
          Brevo и сюда не переезжают: иначе одно письмо ушло бы дважды с двух разных адресов. Пока здесь только подключение —
          самой интеграции ещё нет.
        </p>
      </div>

      <EmailFactoryPanel view={view} defaultAddress={sample?.senderEmail ?? ""} />
    </div>
  );
}

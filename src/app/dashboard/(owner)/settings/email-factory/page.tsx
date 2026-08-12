import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { loadEmailFactoryView } from "@/integrations/emailFactory/token";
import { EmailFactoryPanel } from "./EmailFactoryPanel";

export const dynamic = "force-dynamic";

export default async function EmailFactorySettingsPage() {
  await requireRole("OWNER");
  const view = await loadEmailFactoryView(prisma);

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

      <EmailFactoryPanel view={view} />
    </div>
  );
}

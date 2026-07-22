import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { loadTelegramSettingsView } from "@/integrations/telegram/settings";
import { listTelegramEvents } from "@/integrations/telegram/registry";
import { Card, CardBody } from "@/components/ui/Card";
import { TelegramSettingsForm } from "./TelegramSettingsForm";

export const dynamic = "force-dynamic";

export default async function TelegramSettingsPage() {
  await requireRole("OWNER");
  const view = await loadTelegramSettingsView(prisma);
  const events = listTelegramEvents().map((e) => ({ type: e.type, audience: e.audience, description: e.description }));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Telegram-уведомления</h1>
        <p className="text-sm text-slate-500">
          Внутренние уведомления сотрудникам. Токен хранится в зашифрованном виде и обратно не показывается.
          Включить уведомления можно только после успешной проверки подключения.
        </p>
      </div>

      <TelegramSettingsForm initial={view} />

      <Card>
        <CardBody className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">Какие события отправляются</h2>
          <ul className="space-y-1 text-xs text-slate-600">
            {events.map((e) => (
              <li key={e.type} className="flex gap-2">
                <span className={`shrink-0 rounded border px-1.5 py-px text-[11px] ${e.audience === "OWNER" ? "border-sky-200 bg-sky-50 text-sky-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                  {e.audience === "OWNER" ? "владельцу" : "флористам"}
                </span>
                <span><code className="rounded bg-slate-100 px-1">{e.type}</code> — {e.description}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

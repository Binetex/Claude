import { requireRole } from "@/lib/rbac";
import { listReviewSettings, DEFAULT_TEXTS } from "@/modules/reviews/settings";
import { SMS_VARIABLES } from "@/modules/automations/variables";
import { MessagesPanel } from "./MessagesPanel";

export const dynamic = "force-dynamic";

/** Что увидит клиент и по каким срокам работает воронка. Настраивается на каждый магазин. */
export default async function ReviewMessagesPage() {
  await requireRole("OWNER");
  const sites = await listReviewSettings();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Сообщения клиенту</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Два сообщения: просьба об отзыве и напоминание тем, кто обещал и забыл. Уходят по SMS, а
          если SMS не смогла — письмом по шаблону Brevo. Тексты пишутся по-английски: покупатели
          англоязычные.
        </p>
      </div>
      <MessagesPanel
        sites={sites}
        defaults={DEFAULT_TEXTS}
        variables={SMS_VARIABLES.map((v) => ({ key: v.key, label: v.label }))}
      />
    </div>
  );
}

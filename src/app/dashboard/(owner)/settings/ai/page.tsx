import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { loadAiModelSettings } from "@/integrations/deepseek/settings";
import { AiModelForm } from "./AiModelForm";

export const dynamic = "force-dynamic";

export default async function AiModelSettingsPage() {
  await requireRole("OWNER");
  const current = await loadAiModelSettings(prisma);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Модель ассистента"
        description="Кто именно отвечает клиентам от имени магазинов: ключ доступа, адрес API и модель. Меняется на ходу — перезапуск сервера не нужен."
      />
      <AiModelForm current={current} />
    </div>
  );
}

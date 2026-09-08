import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { loadAiModelSettings, resolveDeepseekConfig } from "@/integrations/deepseek/settings";
import { fetchModelBalance, type ModelBalance } from "@/integrations/deepseek/balance";
import { AiModelForm } from "./AiModelForm";

export const dynamic = "force-dynamic";

export default async function AiModelSettingsPage() {
  await requireRole("OWNER");
  const current = await loadAiModelSettings(prisma);

  // Остаток спрашиваем у провайдера на каждом открытии страницы: он меняется сам по себе, и
  // кешировать его — значит однажды показать бодрое число при нулевом счёте.
  const cfg = await resolveDeepseekConfig(prisma);
  const balance: ModelBalance | null = cfg ? await fetchModelBalance(cfg) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Модель ассистента"
        description="Кто именно отвечает клиентам от имени магазинов: ключ доступа, адрес API и модель. Меняется на ходу — перезапуск сервера не нужен."
      />
      <AiModelForm current={current} balance={balance} />
    </div>
  );
}

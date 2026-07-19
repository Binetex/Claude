import { loadBurqSettingsForUi, BURQ_WEBHOOK_PATH } from "@/integrations/delivery/burq/settings";
import { getAppUrl } from "@/lib/appUrl";
import { BurqSettingsForm } from "./BurqSettingsForm";

export const dynamic = "force-dynamic";

export default async function BurqSettingsPage() {
  const settings = await loadBurqSettingsForUi();
  const webhookUrl = `${getAppUrl().replace(/\/+$/, "")}${BURQ_WEBHOOK_PATH}`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Интеграция доставки — Burq</h1>
        <p className="text-sm text-slate-500">
          Ключи хранятся в зашифрованном виде (AES-256-GCM); в интерфейсе показывается только маска. Реальные вызовы Burq
          не выполняются, пока авто-создание доставок выключено.
        </p>
      </div>
      <BurqSettingsForm settings={settings} webhookUrl={webhookUrl} />
    </div>
  );
}

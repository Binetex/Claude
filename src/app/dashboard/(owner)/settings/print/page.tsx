import { requireRole } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/misc";
import { loadAllPrintSettings } from "@/modules/print/settingsStore";
import { PrintSettingsForm } from "./PrintSettingsForm";

export const dynamic = "force-dynamic";

/**
 * Настройки печати записок. Две раскладки настраиваются отдельно: какая достанется
 * флористу, решает его доступ к ценам (`financeVisibility`), а не эта страница.
 *
 * Сам владелец записки не печатает — поэтому у каждой раскладки есть «Посмотреть образец»
 * с тестовой запиской. Без него проверять правки пришлось бы через флориста.
 */
export default async function PrintSettingsPage() {
  await requireRole("OWNER");
  const settings = await loadAllPrintSettings();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Печать записок"
        description="Поля, кегли и переходы размеров для двух форматов листа. Значения применяются сразу — флористу достаточно обновить страницу печати."
      />
      <PrintSettingsForm layout="tall" initial={settings.tall} />
      <PrintSettingsForm layout="wide" initial={settings.wide} />
    </div>
  );
}

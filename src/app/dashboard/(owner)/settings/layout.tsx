import { requireRole } from "@/lib/rbac";
import { SettingsTabs } from "./SettingsTabs";

/**
 * Обвязка раздела «Настройки»: вкладки на каждой странице.
 *
 * Своего заголовка «Настройки» здесь нет намеренно — как в «Финансах» и «Отзывах»: раздел
 * называет активный пункт в сайдбаре, а страница называет себя сама. Заголовок раздела давал
 * три подписи подряд: «Настройки», вкладка «Пользователи», заголовок «Пользователи».
 *
 * Это ЕДИНСТВЕННАЯ проверка прав для страниц раздела — своей они не имеют. Выносить любую из
 * них из-под этого layout нельзя, не добавив requireRole в саму страницу.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireRole("OWNER");

  return (
    <div className="space-y-4">
      <SettingsTabs />
      {children}
    </div>
  );
}

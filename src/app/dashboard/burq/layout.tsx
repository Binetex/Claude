import { requireUser } from "@/lib/rbac";
import { AppShell } from "@/components/AppShell";
import { navFor } from "@/lib/nav";
import { SettingsTabs } from "@/app/dashboard/(owner)/settings/SettingsTabs";

/**
 * Настройки Burq доступны ЛЮБОМУ аутентифицированному пользователю админки (requireUser,
 * НЕ OWNER-only). Отдельный сегмент вне role-групп, чтобы страницу мог открыть любой роль.
 *
 * Меню берётся общее (navFor): раньше здесь было своё, из двух строк, и клик по разделу
 * стирал остальное меню целиком. У владельца сверху ещё и вкладки «Настроек» — для него
 * Burq одна из них, хотя страница и живёт вне сегмента (owner).
 */
export default async function BurqLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const owner = user.role === "OWNER";
  return (
    <AppShell user={user} nav={await navFor(user)}>
      {owner ? (
        <div className="space-y-4">
          <SettingsTabs />
          {children}
        </div>
      ) : (
        children
      )}
    </AppShell>
  );
}

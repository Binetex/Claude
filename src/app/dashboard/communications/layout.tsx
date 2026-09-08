import { requireUser } from "@/lib/rbac";
import { AppShell } from "@/components/AppShell";
import { navFor } from "@/lib/nav";

/**
 * Раздел «Другие сообщения» — ЛЮБОМУ аутентифицированному сотруднику (requireUser,
 * НЕ OWNER-only). Отдельный сегмент вне role-групп, чтобы страницу мог открыть любой роль.
 *
 * Меню берётся общее (navFor): раньше здесь было своё, из двух строк, и клик по разделу
 * стирал остальное меню целиком. Пункт «Другие сообщения» есть и у владельца, и у колл-центра.
 */
export default async function CommunicationsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <AppShell user={user} nav={await navFor(user)}>
      {children}
    </AppShell>
  );
}

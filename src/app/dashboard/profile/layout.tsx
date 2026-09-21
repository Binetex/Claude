import { requireUser } from "@/lib/rbac";
import { AppShell } from "@/components/AppShell";
import { navFor } from "@/lib/nav";

/**
 * Профиль открывает ЛЮБОЙ вошедший (requireUser), поэтому сегмент лежит вне role-групп:
 * своё фото меняет и флорист, и колл-центр, и владелец.
 */
export default async function ProfileLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <AppShell user={user} nav={await navFor(user)}>{children}</AppShell>;
}

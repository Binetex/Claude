import { requireRole } from "@/lib/rbac";
import { AppShell } from "@/components/AppShell";
import { navFor } from "@/lib/nav";

export default async function CallCenterLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("CALL_CENTER");
  return (
    <AppShell user={user} nav={await navFor(user)}>
      {children}
    </AppShell>
  );
}

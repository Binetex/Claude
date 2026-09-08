import { requireFlorist } from "@/lib/rbac";
import { AppShell } from "@/components/AppShell";
import { navFor } from "@/lib/nav";

export default async function FloristLayout({ children }: { children: React.ReactNode }) {
  const user = await requireFlorist();
  return (
    <AppShell user={user} nav={await navFor(user)}>
      {children}
    </AppShell>
  );
}

import { requireUser } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/misc";
import { AvatarForm } from "./AvatarForm";

export const dynamic = "force-dynamic";

const roleLabel = { OWNER: "Владелец", FLORIST: "Флорист", CALL_CENTER: "Колл-центр" } as const;

export default async function ProfilePage() {
  const user = await requireUser();
  return (
    <div className="max-w-xl space-y-4">
      <PageHeader title="Профиль" description="Фото видно в шапке всем, кто работает в системе. Имя и доступ меняет владелец в «Настройках»." />
      <AvatarForm name={user.name} email={user.email} role={roleLabel[user.role]} avatarUrl={user.avatarUrl} />
    </div>
  );
}

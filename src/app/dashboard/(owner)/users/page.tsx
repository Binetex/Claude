import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { Role } from "@/generated/prisma/enums";
import { CreateUserForm } from "./CreateUserForm";

export const dynamic = "force-dynamic";

const roleLabel: Record<Role, string> = {
  OWNER: "Владелец",
  FLORIST: "Флорист",
  CALL_CENTER: "Колл-центр",
};

export default async function UsersPage() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: { florist: { select: { financeVisibility: true } } },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Пользователи</h1>

      <Card>
        <CardHeader><CardTitle>Добавить сотрудника</CardTitle></CardHeader>
        <CardBody>
          <CreateUserForm />
        </CardBody>
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
              <th className="px-3 py-2">Имя</th>
              <th className="px-3 py-2">Роль</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Телефон</th>
              <th className="px-3 py-2">Telegram</th>
              <th className="px-3 py-2">Статус</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate-50">
                <td className="px-3 py-2 font-medium text-slate-800">{u.name}</td>
                <td className="px-3 py-2">
                  {roleLabel[u.role]}
                  {u.florist && (
                    <span className="ml-1 text-xs text-slate-400">
                      ({u.florist.financeVisibility === "FULL" ? "основной" : "второстепенный"})
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">{u.email}</td>
                <td className="px-3 py-2 text-slate-600">{u.phone ?? "—"}</td>
                <td className="px-3 py-2 text-slate-600">{u.telegramId ?? "—"}</td>
                <td className="px-3 py-2">
                  <Badge className={u.active ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-600 border-slate-200"}>
                    {u.active ? "активен" : "отключён"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

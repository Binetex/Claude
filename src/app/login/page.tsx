import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { homePathFor } from "@/lib/rbac";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(homePathFor(user.role));

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Image src="/logo.png" alt="FloreMart" width={940} height={188} priority className="h-9 w-auto" />
          <div className="mt-2 text-sm text-slate-500">Единый дашборд заказов</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <LoginForm />
        </div>
        {process.env.NODE_ENV !== "production" && (
          <div className="mt-6 rounded-lg border border-slate-200 bg-white/60 p-4 text-xs text-slate-500">
            <div className="mb-1 font-semibold text-slate-600">Демо-доступы (пароль: password123)</div>
            <ul className="space-y-0.5">
              <li>Владелец — owner@demo.local</li>
              <li>Колл-центр — cc@demo.local</li>
              <li>Флорист №1 — florist1@demo.local</li>
              <li>Флорист №2 — florist2@demo.local</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

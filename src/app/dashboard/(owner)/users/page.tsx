import { redirect } from "next/navigation";

/** Переехало в «Настройки → Пользователи». Адрес оставлен ради старых закладок. */
export default function UsersLegacyRedirect() {
  redirect("/dashboard/settings/users");
}

import { redirect } from "next/navigation";

/** Переехало в «Настройки → Системные события». Адрес оставлен ради старых закладок. */
export default function SystemEventsLegacyRedirect() {
  redirect("/dashboard/settings/system-events");
}

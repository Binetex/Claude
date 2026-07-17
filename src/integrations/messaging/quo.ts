import "server-only";
import type { MessagingAdapter } from "@/integrations/types";
import { enqueue } from "@/lib/jobs";
import { featureFlags } from "@/lib/featureFlags";

/** Заглушка адаптера сообщений Quo (этап 1). SMS — под QUO_ENABLED, email — под EMAIL_ENABLED. */
export const quoAdapter: MessagingAdapter = {
  async sendSms(to, body) {
    if (!featureFlags.quo) return;
    await enqueue("message.send.sms", { to, body });
  },
  async sendEmail(to, subject, body) {
    if (!featureFlags.email) return;
    await enqueue("message.send.email", { to, subject, body });
  },
};

import "server-only";
/** Одна точка подключения ассистента к воркеру: имя события и его обработчик. */
export { ASSISTANT_INCOMING_EVENT } from "./events";
export { buildAssistantHandler } from "./handler";
export { ASSISTANT_EMAIL_EVENT } from "./events";
export { buildAssistantEmailHandler } from "./emailHandler";

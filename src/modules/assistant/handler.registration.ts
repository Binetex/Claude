import "server-only";
/** Одна точка подключения ассистента к воркеру: имя события и его обработчик. */
export { ASSISTANT_INCOMING_EVENT } from "./events";
export { buildAssistantHandler } from "./handler";

/** Печатный CSS открыток. US Letter (НЕ A4). 1 лист = 1 заказ, обе половины центрированы H+V. */
export const PRINT_CSS = `
@page { size: Letter portrait; margin: 0; }
.measurer { position: absolute; left: -99999px; top: 0; visibility: hidden; box-sizing: border-box; font-family: var(--font-lora), Georgia, serif; text-align: center; }
.toolbar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 12px 16px; background: #0f172a; color: #fff; z-index: 10; }
.toolbar-title { font: 600 14px system-ui, sans-serif; margin-right: auto; }
.toolbar-btn { font: 600 13px system-ui, sans-serif; padding: 8px 14px; border-radius: 8px; border: 0; background: #22c55e; color: #08260f; cursor: pointer; }
.toolbar-btn.ghost { background: transparent; color: #cbd5e1; border: 1px solid #334155; }
.empty { padding: 40px; text-align: center; color: #64748b; font: 14px system-ui, sans-serif; }
.doc { background: #e2e8f0; }
.sheet {
  width: 8.5in; height: 11in; margin: 0 auto; background: #fff; box-sizing: border-box;
  display: flex; flex-direction: column; page-break-after: always; break-after: page;
}
/* Линия разреза строго посередине листа */
.cut-line { border-top: 1px dashed #94a3b8; }
.half {
  width: 8.5in; height: 5.5in; box-sizing: border-box; padding: 0.5in;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; overflow: hidden;
  font-family: var(--font-lora), Georgia, serif; color: #111;
}
/* Получатель — по центру, ФИО обычного размера (как основной текст) */
.rec-name { font-size: 16pt; font-weight: 400; line-height: 1.35; }
.rec-phone { font-size: 16pt; margin-top: 6px; }
.rec-addr { font-size: 16pt; margin-top: 6px; line-height: 1.35; }
/* Текст открытки — крупно, по центру, с сохранением переносов */
.msg { white-space: pre-wrap; line-height: 1.4; max-width: 100%; }
@media screen { .sheet { box-shadow: 0 1px 6px rgba(0,0,0,.15); margin: 16px auto; } }
@media print { .no-print { display: none !important; } .doc { background: #fff; } .sheet { margin: 0; box-shadow: none; } }
`;

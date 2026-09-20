"use client";
/**
 * Редактор заготовок: список с правкой на месте плюс форма добавления внизу.
 *
 * Порядок здесь — рабочий инструмент, а не украшение: в карточке заказа заготовки идут этим же
 * списком, и то, чем владелец отвечает каждый день, должно быть первым, иначе оператор листает.
 *
 * Выключенная заготовка остаётся в списке: сезонные тексты (пионы не в сезон, праздничная
 * загрузка) возвращаются через полгода, и удалять их ради «не мешает сейчас» жалко.
 */
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/Card";
import { deleteTemplate, moveTemplate, saveTemplate, setTemplateActive } from "./actions";

type Row = { id: string; title: string; text: string; active: boolean };

export function TemplatesEditor({ templates, variables }: { templates: Row[]; variables: { key: string; label: string }[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok?: true; error?: string }>, done?: () => void) =>
    start(async () => {
      const r = await fn();
      setError(r.error ?? null);
      if (!r.error) done?.();
    });

  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="space-y-2">
        {templates.map((t, i) => (
          <Card key={t.id} className={t.active ? undefined : "opacity-60"}>
            <CardBody className="space-y-2">
              {editing === t.id ? (
                <TemplateForm
                  initial={t}
                  variables={variables}
                  pending={pending}
                  submitLabel="Сохранить"
                  onCancel={() => setEditing(null)}
                  onSubmit={(v) => run(() => saveTemplate({ id: t.id, ...v }), () => setEditing(null))}
                />
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">
                        {t.title}
                        {!t.active && <span className="ml-2 text-xs font-normal text-slate-500">выключена</span>}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{t.text}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          disabled={pending || i === 0}
                          onClick={() => run(() => moveTemplate(t.id, "up"))}
                          className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 disabled:opacity-30"
                          aria-label="Выше"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={pending || i === templates.length - 1}
                          onClick={() => run(() => moveTemplate(t.id, "down"))}
                          className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 disabled:opacity-30"
                          aria-label="Ниже"
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <button type="button" className="text-slate-600 underline" onClick={() => setEditing(t.id)}>
                      Изменить
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      className="text-slate-600 underline disabled:opacity-40"
                      onClick={() => run(() => setTemplateActive(t.id, !t.active))}
                    >
                      {t.active ? "Выключить" : "Включить"}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      className="text-rose-600 underline disabled:opacity-40"
                      onClick={() => {
                        if (confirm(`Удалить заготовку «${t.title}»?`)) run(() => deleteTemplate(t.id));
                      }}
                    >
                      Удалить
                    </button>
                  </div>
                </>
              )}
            </CardBody>
          </Card>
        ))}
        {templates.length === 0 && <p className="text-sm text-slate-500">Заготовок пока нет.</p>}
      </div>

      <Card>
        <CardBody>
          <p className="mb-2 text-sm font-medium text-slate-800">Новая заготовка</p>
          <TemplateForm
            variables={variables}
            pending={pending}
            submitLabel="Добавить"
            onSubmit={(v, clear) => run(() => saveTemplate(v), clear)}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function TemplateForm({
  initial,
  variables,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: { title: string; text: string };
  variables: { key: string; label: string }[];
  pending: boolean;
  submitLabel: string;
  onSubmit: (v: { title: string; text: string }, onSaved: () => void) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [text, setText] = useState(initial?.text ?? "");

  return (
    <div className="space-y-2">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Подпись на кнопке — «Ваза закончилась»" />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Текст сообщения клиенту"
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none"
      />
      {/* Переменные вставляются кнопкой, а не вспоминаются: опечатка в {{recipient_name}}
          молча выкинет строку из текста уже у клиента. */}
      <div className="flex flex-wrap gap-1">
        {variables.map((v) => (
          <button
            key={v.key}
            type="button"
            title={v.label}
            onClick={() => setText((prev) => `${prev}{{${v.key}}}`)}
            className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50"
          >
            {`{{${v.key}}}`}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            // Поля чистятся только после успешного сохранения: на ошибке набранный текст
            // должен остаться на экране, а не начинаться заново.
            onSubmit({ title, text }, () => {
              setTitle("");
              setText("");
            })
          }
        >
          {pending ? "Сохраняю…" : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
        )}
      </div>
    </div>
  );
}

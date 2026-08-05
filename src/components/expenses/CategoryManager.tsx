"use client";
/**
 * Управление категориями и подкатегориями расходов.
 *
 * Правки применяются сразу, без кнопки «Сохранить»: здесь всё — переключатели и
 * переименования, а не форма, которую заполняют целиком.
 *
 * Категории не удаляются, а убираются из списка. На них ссылаются уже внесённые расходы,
 * и удаление либо порвало бы историю, либо потребовало каскада — а расход, потерявший
 * категорию, перестал бы попадать в итог дня.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Result = { error?: string; message?: string };

export type CategoryRow = {
  id: string;
  name: string;
  isBuiltin: boolean;
  subcategories: { id: string; name: string }[];
};

export type CategoryActions = {
  create: (fd: FormData) => Promise<Result>;
  rename: (fd: FormData) => Promise<Result>;
  archive: (fd: FormData) => Promise<Result>;
  createSub: (fd: FormData) => Promise<Result>;
  renameSub: (fd: FormData) => Promise<Result>;
  archiveSub: (fd: FormData) => Promise<Result>;
};

function useRunner() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      if (r.error) toast.error(r.error);
      else toast.success(r.message ?? "Готово");
    });
  return { pending, run };
}

/** Название, правящееся на месте: клик — поле, Enter или потеря фокуса — сохранение. */
function EditableName({
  value,
  onSave,
  pending,
  className = "",
}: {
  value: string;
  onSave: (next: string) => void;
  pending: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        type="button"
        className={`text-left hover:underline ${className}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
  };

  return (
    <Input
      autoFocus
      value={draft}
      disabled={pending}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      className="h-8 max-w-56"
    />
  );
}

export function CategoryManager({ categories, actions }: { categories: CategoryRow[]; actions: CategoryActions }) {
  const { pending, run } = useRunner();
  const [newName, setNewName] = useState("");
  const [newSubFor, setNewSubFor] = useState<string | null>(null);
  const [newSubName, setNewSubName] = useState("");

  const addCategory = () => {
    if (!newName.trim()) return;
    run(() => actions.create(fd({ name: newName })));
    setNewName("");
  };

  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white">
        <ul className="divide-y divide-slate-100">
          {categories.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <EditableName
                  value={c.name}
                  pending={pending}
                  className="font-medium text-slate-800"
                  onSave={(next) => run(() => actions.rename(fd({ id: c.id, name: next })))}
                />

                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setNewSubFor(newSubFor === c.id ? null : c.id);
                      setNewSubName("");
                    }}
                  >
                    + подкатегория
                  </Button>
                  {!c.isBuiltin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:bg-red-50 hover:text-red-700"
                      disabled={pending}
                      onClick={() => run(() => actions.archive(fd({ id: c.id })))}
                    >
                      Убрать
                    </Button>
                  )}
                </div>
              </div>

              {(c.subcategories.length > 0 || newSubFor === c.id) && (
                <ul className="mt-2 ml-6 space-y-1 border-l border-slate-100 pl-4">
                  {c.subcategories.map((sc) => (
                    <li key={sc.id} className="flex items-center gap-2 text-sm">
                      <EditableName
                        value={sc.name}
                        pending={pending}
                        className="text-slate-600"
                        onSave={(next) => run(() => actions.renameSub(fd({ id: sc.id, name: next })))}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-slate-400 hover:text-red-600"
                        disabled={pending}
                        onClick={() => run(() => actions.archiveSub(fd({ id: sc.id })))}
                      >
                        Убрать
                      </Button>
                    </li>
                  ))}

                  {newSubFor === c.id && (
                    <li className="flex items-center gap-2 pt-1">
                      <Input
                        autoFocus
                        placeholder="Например: OpenAI"
                        value={newSubName}
                        disabled={pending}
                        onChange={(e) => setNewSubName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setNewSubFor(null);
                          if (e.key === "Enter" && newSubName.trim()) {
                            run(() => actions.createSub(fd({ categoryId: c.id, name: newSubName })));
                            setNewSubName("");
                          }
                        }}
                        className="h-8 max-w-56"
                      />
                      <Button
                        size="sm"
                        disabled={pending || !newSubName.trim()}
                        onClick={() => {
                          run(() => actions.createSub(fd({ categoryId: c.id, name: newSubName })));
                          setNewSubName("");
                        }}
                      >
                        Добавить
                      </Button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-medium text-slate-700">Новая категория</div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Например: Бухгалтерия"
            value={newName}
            disabled={pending}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) addCategory();
            }}
            className="max-w-64"
          />
          <Button disabled={pending || !newName.trim()} onClick={addCategory}>
            Добавить
          </Button>
        </div>
      </div>

    </div>
  );
}

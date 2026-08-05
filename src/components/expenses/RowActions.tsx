"use client";
/**
 * Скрытые действия над записью — меню «…».
 *
 * Главный экран отвечает за обзор, а не за редактирование: карандаш и корзина у каждой
 * строки превращали список цифр в список иконок, и взгляд цеплялся за них, а не за суммы.
 * Поэтому кнопка появляется только при наведении, а сами действия — внутри меню.
 *
 * На тач-устройствах наведения нет, поэтому там кнопка видна всегда — иначе действия
 * стали бы недоступны вовсе.
 *
 * Диалоги живут ЗДЕСЬ и управляются состоянием, а не своими триггерами: триггер диалога
 * внутри Popover не работает — Popover закрывается при клике и уносит диалог с собой.
 */
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ExpenseDialog, DeleteExpenseDialog,
  type ExpenseActions, type ExpenseCategoryDto, type ExpenseEditValues,
} from "./ExpenseForms";

export function RowActions({
  actions,
  categories,
  edit,
  label,
}: {
  actions: ExpenseActions;
  categories: ExpenseCategoryDto[];
  edit: ExpenseEditValues;
  label: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Действия"
            title="Действия"
            // На мыши кнопка проявляется при наведении на строку и остаётся видимой, пока
            // меню открыто; на тач-экранах видна всегда.
            className={`text-slate-400 hover:text-slate-700 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${
              menuOpen ? "sm:opacity-100" : ""
            }`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-40 p-1">
          <button
            type="button"
            className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100"
            onClick={() => {
              setMenuOpen(false);
              setEditOpen(true);
            }}
          >
            Изменить
          </button>
          <button
            type="button"
            className="w-full rounded-md px-2 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
            onClick={() => {
              setMenuOpen(false);
              setDeleteOpen(true);
            }}
          >
            Удалить
          </button>
        </PopoverContent>
      </Popover>

      <ExpenseDialog
        actions={actions}
        categories={categories}
        edit={edit}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <DeleteExpenseDialog
        actions={actions}
        id={edit.id}
        label={label}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
}

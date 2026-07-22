import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import readline from "readline";

/**
 * Безопасное создание первого владельца системы.
 *
 * Использование (интерактивно, пароль вводится скрыто):
 *   npm run create-owner -- --email owner@floremart.com --name "Имя Фамилия"
 *
 * Неинтерактивно (например, в скрипте деплоя) — пароль ТОЛЬКО через переменную
 * окружения, никогда через аргумент командной строки (попадает в историю shell):
 *   OWNER_PASSWORD='...' npm run create-owner -- --email owner@floremart.com --name "Имя" --yes
 *
 * По умолчанию отказывает, если в системе уже есть хотя бы один OWNER.
 * Передайте --force, чтобы создать ещё одного владельца сознательно.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WritableStream };
    let muted = false;
    anyRl._writeToOutput = (s: string) => {
      anyRl.output.write(muted ? "" : s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const force = hasFlag("force");
  const nonInteractiveOk = hasFlag("yes");

  const existingOwner = await prisma.user.findFirst({ where: { role: "OWNER" } });
  if (existingOwner && !force) {
    console.error(
      `Владелец уже существует (${existingOwner.email}). Передайте --force, если действительно хотите создать ещё одного.`
    );
    process.exit(1);
  }

  let email = arg("email");
  let name = arg("name");
  let password = process.env.OWNER_PASSWORD ?? arg("password");

  if (!email) email = await prompt("Email владельца: ");
  if (!name) name = await prompt("Имя владельца: ");
  if (!password) password = await promptHidden("Пароль (мин. 8 символов, ввод скрыт): ");

  if (!email || !isValidEmail(email)) {
    console.error("Некорректный email.");
    process.exit(1);
  }
  if (!name || name.trim().length < 2) {
    console.error("Имя обязательно (минимум 2 символа).");
    process.exit(1);
  }
  if (!password || password.length < 8) {
    console.error("Пароль обязателен и должен быть не короче 8 символов.");
    process.exit(1);
  }

  const dup = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (dup) {
    console.error(`Пользователь с email ${email} уже существует.`);
    process.exit(1);
  }

  if (!nonInteractiveOk) {
    const confirm = await prompt(`Создать владельца ${email}? (yes/no): `);
    if (confirm.trim().toLowerCase() !== "yes") {
      console.log("Отменено.");
      process.exit(0);
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name: name.trim(), email: email.toLowerCase().trim(), role: "OWNER", passwordHash, active: true },
  });

  console.log(`Владелец создан: ${user.email} (id: ${user.id})`);
}

main()
  .catch((e) => {
    console.error("Ошибка:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

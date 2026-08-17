import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/server/db/client";
import { normalizeEmail } from "./email";
import { hashPassword, passwordSchema } from "./password";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export const registerUserSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: passwordSchema,
  name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => (value ? value : null)),
});

export type RegisterUserInput = z.input<typeof registerUserSchema>;

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with this email already exists");
    this.name = "EmailAlreadyRegisteredError";
  }
}

export async function registerUser(input: RegisterUserInput) {
  const parsed = registerUserSchema.parse(input);
  const email = normalizeEmail(parsed.email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new EmailAlreadyRegisteredError();

  const passwordHash = await hashPassword(parsed.password);

  try {
    const user = await prisma.user.create({
      data: { email, passwordHash, name: parsed.name },
    });
    return { id: user.id, email: user.email, name: user.name };
  } catch (error) {
    // Two concurrent signups for the same email can both pass the
    // findUnique check above; the database's unique constraint is the real
    // guarantee, so a race here still surfaces the same clean error.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      throw new EmailAlreadyRegisteredError();
    }
    throw error;
  }
}

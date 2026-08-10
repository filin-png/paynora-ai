import { z } from "zod";

/**
 * Business dates (invoice issue/due date, payment date) are calendar dates
 * with no time-of-day or timezone — stored as Postgres `date` via Prisma's
 * `@db.Date`. Comparing them as ISO "YYYY-MM-DD" strings (which sort
 * lexicographically in calendar order) avoids the classic bug where a
 * UTC/local offset pushes a date across midnight and flips an overdue
 * determination. See docs/accounts-receivable.md#date-semantics for the
 * full rationale, including the one accepted limitation (a single global
 * "today", not per-organization timezone).
 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const dateOnlySchema = z
  .string()
  .regex(DATE_ONLY_PATTERN, "Date must be in YYYY-MM-DD format");

/** Parses a "YYYY-MM-DD" form value into the UTC-midnight Date Prisma expects for a @db.Date column. */
export function parseDateOnly(value: string): Date {
  dateOnlySchema.parse(value);
  return new Date(`${value}T00:00:00.000Z`);
}

/** Inverse of parseDateOnly: extracts "YYYY-MM-DD" from a Date read back from a @db.Date column. */
export function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "Today" as a calendar date, computed from the server's UTC clock. */
export function getBusinessToday(): string {
  return toDateOnlyString(new Date());
}

/**
 * An invoice becomes overdue the day *after* its due date — the due date
 * itself is still on time, not overdue (see the "due today" case in
 * docs/accounts-receivable.md).
 */
export function isPastDue(dueDate: Date, today: string = getBusinessToday()): boolean {
  return toDateOnlyString(dueDate) < today;
}

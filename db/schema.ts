import { pgTable, uuid, text, integer, numeric, jsonb, timestamp, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
const identity = () => ({ id: uuid().primaryKey().defaultRandom(), created_at: timestamp({ withTimezone: true }).defaultNow().notNull() });
export const profiles = pgTable('profiles', {
  ...identity(), auth_id: text().unique(), email: text().notNull().unique(), full_name: text().notNull(), role: text().notNull(),
}, t => [check('profile_role', sql`${t.role} in ('trainer', 'client')`)]);
export const clients = pgTable('clients', {
  ...identity(), trainer_id: uuid().notNull().references(() => profiles.id), user_id: uuid().references(() => profiles.id),
  email: text().notNull(), full_name: text().notNull(), status: text().default('Active'), start_date: text(),
  phone: text(), age: integer(), goals: text(), injuries: text(), notes: text(),
});
export const exercises = pgTable('exercises', {
  ...identity(), trainer_id: uuid().notNull().references(() => profiles.id), name: text().notNull(), category: text(), description: text(),
});
export const programs = pgTable('programs', {
  ...identity(), trainer_id: uuid().notNull().references(() => profiles.id), name: text().notNull(), description: text(),
  days_per_week: integer().notNull().default(3), days: jsonb().$type<Array<{name: string}>>().notNull().default([]),
});
export const clientPrograms = pgTable('client_programs', {
  ...identity(), client_id: uuid().notNull().references(() => clients.id, { onDelete: 'cascade' }),
  program_id: uuid().notNull().references(() => programs.id, { onDelete: 'cascade' }),
}, t => [uniqueIndex('client_program_unique').on(t.client_id, t.program_id)]);
export const programExercises = pgTable('program_exercises', {
  ...identity(), program_id: uuid().notNull().references(() => programs.id, { onDelete: 'cascade' }),
  exercise_id: uuid().notNull().references(() => exercises.id), sets: integer().notNull(), reps: text().notNull(),
  weight: numeric({ precision: 10, scale: 2 }), rest_time: integer().notNull(), day_number: integer(), position: integer(),
}, t => [check('prescription_values', sql`${t.sets} > 0 and ${t.rest_time} >= 0 and (${t.weight} is null or ${t.weight} >= 0) and (${t.day_number} is null or ${t.day_number} > 0) and (${t.position} is null or ${t.position} >= 0)`)]);
export const imports = pgTable('legacy_imports', { trainer_id: uuid().primaryKey().references(() => profiles.id), completed_at: timestamp().defaultNow().notNull() });

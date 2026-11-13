CREATE TABLE "client_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_id" uuid NOT NULL,
	"program_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"status" text DEFAULT 'Active',
	"start_date" text,
	"phone" text,
	"age" integer,
	"goals" text,
	"injuries" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "legacy_imports" (
	"trainer_id" uuid PRIMARY KEY,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auth_id" text UNIQUE,
	"email" text NOT NULL UNIQUE,
	"full_name" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "profile_role" CHECK ("role" in ('trainer', 'client'))
);
--> statement-breakpoint
CREATE TABLE "program_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"program_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"sets" integer NOT NULL,
	"reps" text NOT NULL,
	"weight" numeric(10,2),
	"rest_time" integer NOT NULL,
	"day_number" integer,
	"position" integer,
	CONSTRAINT "prescription_values" CHECK ("sets" > 0 and "rest_time" >= 0 and ("weight" is null or "weight" >= 0) and ("day_number" is null or "day_number" > 0) and ("position" is null or "position" >= 0))
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"days_per_week" integer DEFAULT 3 NOT NULL,
	"days" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "client_program_unique" ON "client_programs" ("client_id","program_id");--> statement-breakpoint
ALTER TABLE "client_programs" ADD CONSTRAINT "client_programs_client_id_clients_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "client_programs" ADD CONSTRAINT "client_programs_program_id_programs_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_trainer_id_profiles_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_trainer_id_profiles_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "legacy_imports" ADD CONSTRAINT "legacy_imports_trainer_id_profiles_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "program_exercises" ADD CONSTRAINT "program_exercises_program_id_programs_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "program_exercises" ADD CONSTRAINT "program_exercises_exercise_id_exercises_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id");--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_trainer_id_profiles_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "profiles"("id");
# Click-program

Personal training programs with trainer editing and assigned-client viewing.

The static app lives in `public/`. Request handlers run in `netlify/server/index.mjs`, and application records live in Netlify Database. `db/schema.ts` defines the schema; generated migrations are in `netlify/database/migrations/` and are applied by Netlify during deployment.

Program saves update the program and replace its `program_exercises` rows in one transaction. Prescriptions use integer sets, a rep count or range, optional weight in kg, and integer rest in seconds. Training days and exercise order determine `day_number` (starting at 1) and `position` (starting at 0). Only day names remain in the program's day metadata. The same exercise may appear more than once.

Every API request requires a verified Netlify Identity account. Trainer ownership and client assignments are checked on the server; browser-supplied trainer IDs or roles do not grant access. Clients cannot write prescriptions or read private trainer notes.

## Existing accounts and records

Existing users create a Netlify Identity account with their existing email and confirm that email. Supabase passwords and sessions are not transferred. The server matches records only after verification.

The server-only `LEGACY_SUPABASE_SERVICE_ROLE_KEY` environment variable provides access to the existing Supabase source for migration. It must never be placed in frontend files. The importer reads source data without modifying it. A trainer's records are imported atomically on the first matching trainer or assigned-client login. Existing IDs, programs, exercise prescriptions, client assignments, and trainer notes are retained. Programs with no normalized prescriptions fall back to their embedded day data, converting legacy rest values such as `90s` to seconds. Completed imports are recorded so retries cannot overwrite edits made in the new app. Invalid references stop the import instead of silently dropping records.

Existing trainer status carries over from the source profile. New accounts default to client access; new trainer access requires the server-controlled `trainer` role in Netlify Identity. Profile counts and signup metadata cannot grant trainer access.

## Validation

Run `npm test` for prescription validation, atomic-save rollback, migration, ownership and assignment checks, and editor interactions. Run `npm run typecheck` to check the database schema and configuration. Tests use a disposable PostgreSQL-compatible engine; production storage uses Netlify Database.

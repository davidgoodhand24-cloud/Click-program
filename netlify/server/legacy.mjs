// The source is read only. Imported data is committed to Netlify Database atomically.
import { eq, sql } from 'drizzle-orm';
import { profiles, clients, exercises, programs, programExercises, clientPrograms, imports } from '../../db/schema.ts';
import { prescriptions } from './prescriptions.mjs';
const sourceUrl = 'https://ddnomuajxbgmvuwmemay.supabase.co';
export async function sourceRows(table, filters = {}) {
  const key = process.env.LEGACY_SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw Object.assign(new Error('The data migration connection is not configured yet.'), { status: 503 });
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`/rest/v1/${table}`, sourceUrl);
    url.searchParams.set('select', '*');
    url.searchParams.set('order', table === 'program_exercises' ? 'program_id,exercise_id,day_number,position' : 'id');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('offset', String(offset));
    for (const [field, value] of Object.entries(filters)) url.searchParams.set(field, value);
    const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error(`Could not read legacy ${table}. No data was changed.`), { status: 503 });
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
const pick = (row, fields) => Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k,row[k]]));
export async function importTrainer(db, trainerId, read = sourceRows) {
  if ((await db.select().from(imports).where(eq(imports.trainer_id, trainerId))).length) return;
  const [owners, oldClients, oldExercises, oldPrograms] = await Promise.all([
    read('profiles', { id: `eq.${trainerId}` }), read('clients', { trainer_id: `eq.${trainerId}` }),
    read('exercises', { trainer_id: `eq.${trainerId}` }), read('programs', { trainer_id: `eq.${trainerId}` }),
  ]);
  const owner = owners[0];
  if (!owner || owner.role !== 'trainer') throw Object.assign(new Error('Legacy trainer record is invalid.'), { status: 409 });
  // Batch related records to keep the first-login import within a short request.
  const entries = [], assignments = [];
  for (let offset = 0; offset < oldPrograms.length; offset += 100) {
    const ids = oldPrograms.slice(offset, offset + 100).map(p => p.id);
    const filter = { program_id: `in.(${ids.join(',')})` };
    const [batchEntries, batchAssignments] = await Promise.all([read('program_exercises', filter), read('client_programs', filter)]);
    entries.push(...batchEntries); assignments.push(...batchAssignments);
  }
  const clientIds = new Set(oldClients.map(c => c.id));
  if (assignments.some(a => !clientIds.has(a.client_id))) throw Object.assign(new Error('A legacy assignment references another trainer’s client. Migration was stopped.'), { status: 409 });
  const migratedEntries = [];
  for (const program of oldPrograms) {
    const existing = entries.filter(e => e.program_id === program.id);
    if (existing.length) {
      for (const entry of existing) {
        if ((entry.day_number != null && (!Number.isInteger(entry.day_number) || entry.day_number < 1 || entry.day_number > 31)) ||
            (entry.position != null && (!Number.isInteger(entry.position) || entry.position < 0))) {
          throw Object.assign(new Error('A legacy exercise has an invalid day or position.'), { status: 409 });
        }
        const normalized = prescriptions([{ exercises: [{ ...entry, weight: entry.weight, rest_time: entry.rest_time }] }])[0];
        migratedEntries.push({ ...normalized, ...pick(entry, ['id','program_id','exercise_id','day_number','position']) });
      }
    } else {
      const days = (program.days || []).map(d => ({ ...d, exercises: (d.exercises || []).map(e => {
        const rest = String(e.rest_time ?? e.rest ?? '90').trim();
        if (!/^\d+(?:s)?$/.test(rest)) throw Object.assign(new Error('A legacy rest value needs correction before migration.'), { status: 409 });
        return { ...e, sets: e.sets ?? 3, reps: e.reps ?? '8-10', rest_time: Number(rest.replace(/s$/, '')) };
      }) }));
      if (days.length) migratedEntries.push(...prescriptions(days).map(e => ({ ...e, program_id: program.id })));
    }
  }
  const exerciseIds = new Set(oldExercises.map(e => e.id));
  if (migratedEntries.some(e => !exerciseIds.has(e.exercise_id))) throw Object.assign(new Error('A legacy program references a missing exercise. Migration was stopped.'), { status: 409 });
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${trainerId}))`);
    if ((await tx.select().from(imports).where(eq(imports.trainer_id, trainerId))).length) return;
    await tx.insert(profiles).values({ ...pick(owner, ['id','full_name','role']), email: owner.email.trim().toLowerCase() }).onConflictDoNothing();
    if (oldClients.length) await tx.insert(clients).values(oldClients.map(c => ({ ...pick(c, ['id','trainer_id','full_name','status','start_date','phone','age','goals','injuries','notes']), email: c.email.trim().toLowerCase(), user_id: null })));
    if (oldExercises.length) await tx.insert(exercises).values(oldExercises.map(e => pick(e, ['id','trainer_id','name','category','description'])));
    if (oldPrograms.length) await tx.insert(programs).values(oldPrograms.map(p => ({ ...pick(p, ['id','trainer_id','name','description','days_per_week']), days: (p.days || []).map(d => ({ name: d.name || 'Day' })) })));
    if (migratedEntries.length) await tx.insert(programExercises).values(migratedEntries);
    if (assignments.length) await tx.insert(clientPrograms).values(assignments.map(a => pick(a, ['id','client_id','program_id'])));
    await tx.insert(imports).values({ trainer_id: trainerId });
  });
}
export async function migrateForEmail(db, email) {
  const found = await sourceRows('profiles', { email: `ilike.${email.replace(/[\\%_*]/g, '\\$&')}` });
  const legacy = found.find(p => p.email.trim().toLowerCase() === email);
  if (legacy?.role === 'trainer') await importTrainer(db, legacy.id);
  const matchingClients = await sourceRows('clients', { email: `ilike.${email.replace(/[\\%_*]/g, '\\$&')}` });
  for (const client of matchingClients.filter(c => c.email.trim().toLowerCase() === email)) await importTrainer(db, client.trainer_id);
  return legacy;
}

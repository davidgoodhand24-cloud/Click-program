import { and, eq, inArray, sql } from 'drizzle-orm';
import { verifyRequestOrigin } from '@netlify/identity';
import { db } from '../../db/index.ts';
import { profiles, clients, exercises, programs, programExercises, clientPrograms } from '../../db/schema.ts';
import { prescriptions, hydrateDays, InputError } from './prescriptions.mjs';
import { migrateForEmail } from './legacy.mjs';

function fail(message, status = 403) { throw Object.assign(new Error(message), { status }); }
const tableMap = { clients, exercises, programs, client_programs: clientPrograms };
const fields = {
  clients: ['full_name','email','status','start_date','phone','age','goals','injuries','notes'],
  exercises: ['name','category','description'],
};
const clean = (data, names) => Object.fromEntries(names.filter(k => data[k] !== undefined).map(k => [k,data[k]]));
async function authenticate(req) {
  const cookie = req.headers.get('cookie') || '';
  const jwt = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('nf_jwt='))?.slice(7);
  if (!jwt) fail('Please log in.', 401);
  // The Identity endpoint validates the JWT, expiry, and account status. Never trust decoded claims alone.
  const response = await fetch('https://beamish-cajeta-11771a.netlify.app/.netlify/identity/user', {
    headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) fail('Please log in again.', 401);
  const user = await response.json();
  if (!user.id || !user.email || !user.confirmed_at) fail('Confirm your email before continuing.', 401);
  return user;
}
async function profileFor(user) {
  let [profile] = await db.select().from(profiles).where(eq(profiles.auth_id, user.id));
  if (profile) {
    await db.update(clients).set({ user_id: profile.id }).where(and(eq(clients.email, profile.email), sql`${clients.user_id} is null`));
    return profile;
  }
  const email = user.email.trim().toLowerCase();
  // Match source records only after Identity has verified ownership of the email address.
  const legacy = await migrateForEmail(db, email);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${email}))`);
    let [p] = await tx.select().from(profiles).where(eq(profiles.email, email));
    if (p?.auth_id && p.auth_id !== user.id) fail('This email is already linked to another account.', 409);
    if (p) [p] = await tx.update(profiles).set({ auth_id: user.id }).where(eq(profiles.id, p.id)).returning();
    else [p] = await tx.insert(profiles).values({
      ...(legacy?.id ? { id: legacy.id } : {}), auth_id: user.id, email,
      full_name: legacy?.full_name || user.user_metadata?.full_name || email.split('@')[0],
      // New trainer access is controlled by trusted Identity roles, never signup metadata or record counts.
      role: user.app_metadata?.roles?.includes('trainer') ? 'trainer' : 'client',
    }).returning();
    await tx.update(clients).set({ user_id: p.id }).where(and(eq(clients.email, email), sql`${clients.user_id} is null`));
    return p;
  });
}
export async function accessiblePrograms(profile, database = db) {
  if (profile.role === 'trainer') return database.select().from(programs).where(eq(programs.trainer_id, profile.id));
  return (await database.select({ program: programs }).from(programs)
    .innerJoin(clientPrograms, eq(clientPrograms.program_id, programs.id))
    .innerJoin(clients, eq(clientPrograms.client_id, clients.id)).where(eq(clients.user_id, profile.id)))
    .map(r => r.program).filter((p,i,all) => all.findIndex(x => x.id === p.id) === i);
}
export async function enrichedPrograms(profile, database = db) {
  const list = await accessiblePrograms(profile, database);
  if (!list.length) return [];
  const entries = await database.select().from(programExercises).where(inArray(programExercises.program_id, list.map(p => p.id)));
  const ids = [...new Set(entries.map(e => e.exercise_id))];
  const library = ids.length ? await database.select().from(exercises).where(inArray(exercises.id, ids)) : [];
  return list.map(p => ({ ...p, days: hydrateDays(p, entries.filter(e => e.program_id === p.id), library) }));
}
function filterRows(rows, filters = []) {
  if (!Array.isArray(filters) || filters.length > 10) throw new InputError('Invalid filters.');
  return rows.filter(row => filters.every(({ field, op, value }) => {
    if (op === 'eq' || op === 'is') return row[field] === value;
    if (op === 'in' && Array.isArray(value)) return value.includes(row[field]);
    throw new InputError('Unsupported filter.');
  }));
}
export async function dataQuery(profile, body, database = db) {
  const { table, action = 'select', filters = [], data = {}, order, limit, single } = body;
  if (!Object.hasOwn(tableMap, table)) throw new InputError('Unknown collection.');
  const target = tableMap[table];
  let rows;
  if (table === 'programs') rows = await enrichedPrograms(profile, database);
  else if (table === 'clients') {
    rows = await database.select().from(clients).where(profile.role === 'trainer' ? eq(clients.trainer_id, profile.id) : eq(clients.user_id, profile.id));
    if (profile.role !== 'trainer') rows = rows.map(({ notes, ...c }) => c);
    const assignments = rows.length ? await database.select().from(clientPrograms).where(inArray(clientPrograms.client_id, rows.map(c => c.id))) : [];
    rows = rows.map(c => ({ ...c, client_programs: assignments.filter(a => a.client_id === c.id) }));
  } else if (table === 'exercises') {
    if (profile.role !== 'trainer') fail('Trainer access required.');
    rows = await database.select().from(exercises).where(eq(exercises.trainer_id, profile.id));
  } else {
    const ownedClients = await database.select().from(clients).where(profile.role === 'trainer' ? eq(clients.trainer_id, profile.id) : eq(clients.user_id, profile.id));
    rows = ownedClients.length ? await database.select().from(clientPrograms).where(inArray(clientPrograms.client_id, ownedClients.map(c => c.id))) : [];
    const available = await accessiblePrograms(profile, database);
    rows = rows.map(a => ({ ...a, programs: available.find(p => p.id === a.program_id) }));
  }
  rows = filterRows(rows, filters);
  if (action === 'select') {
    if (order) {
      if (!['created_at','name'].includes(order.field)) throw new InputError('Invalid sort.');
      rows.sort((a,b) => String(a[order.field] ?? '').localeCompare(String(b[order.field] ?? '')) * (order.ascending === false ? -1 : 1));
    }
    if (limit) rows = rows.slice(0, Math.min(1000, Number(limit)));
    return { data: single ? rows[0] || null : rows };
  }
  if (profile.role !== 'trainer') fail('Only trainers can change programs and prescriptions.');
  if (action === 'insert') {
    if (table === 'clients' || table === 'exercises') {
      const values = clean(data, fields[table]);
      if (table === 'clients') values.email = String(values.email || '').trim().toLowerCase();
      if (!String(values.full_name || values.name || '').trim()) throw new InputError('A name is required.');
      if (table === 'clients') {
        const [linked] = await database.select().from(profiles).where(eq(profiles.email, values.email));
        if (linked?.auth_id) values.user_id = linked.id;
      }
      return { data: await database.insert(target).values({ ...values, trainer_id: profile.id }).returning() };
    }
    if (table === 'client_programs') {
      const [c] = await database.select().from(clients).where(and(eq(clients.id, data.client_id), eq(clients.trainer_id, profile.id)));
      const [p] = await database.select().from(programs).where(and(eq(programs.id, data.program_id), eq(programs.trainer_id, profile.id)));
      if (!c || !p) fail('Select one of your clients and programs.');
      return { data: await database.insert(clientPrograms).values({ client_id: c.id, program_id: p.id }).returning() };
    }
  }
  // Updates and deletes require an explicit ID and an independently authorized row.
  const id = filters.find(f => f.field === 'id' && f.op === 'eq')?.value;
  if (!id || !rows.some(r => r.id === id)) fail('Record not found or access denied.', 404);
  if (action === 'delete' && ['programs','client_programs'].includes(table)) {
    await database.delete(target).where(eq(target.id, id)); return { data: null };
  }
  if (action === 'update' && fields[table]) {
    const values = clean(data, fields[table]);
    if (!Object.keys(values).length) throw new InputError('No supported fields to update.');
    await database.update(target).set(values).where(eq(target.id, id)); return { data: null };
  }
  throw new InputError('Unsupported operation.');
}
export async function saveProgram(profile, body, database = db) {
  if (profile.role !== 'trainer') fail('Trainer access required.');
  const entries = prescriptions(body.days);
  const name = String(body.name || '').trim();
  const daysPerWeek = Number(body.days_per_week);
  if (!name || name.length > 200 || !Number.isInteger(daysPerWeek) || daysPerWeek < 1 || daysPerWeek > 7) throw new InputError('Enter a program name and 1–7 days per week.');
  return database.transaction(async tx => {
    if (body.id) {
      const [owned] = await tx.select().from(programs).where(and(eq(programs.id, body.id), eq(programs.trainer_id, profile.id))).for('update');
      if (!owned) fail('Program not found.', 404);
    }
    const ids = [...new Set(entries.map(e => e.exercise_id))];
    if (ids.length) {
      const owned = await tx.select().from(exercises).where(and(eq(exercises.trainer_id, profile.id), inArray(exercises.id, ids)));
      if (owned.length !== ids.length) fail('Select exercises from your own library.');
    }
    const values = { name, description: String(body.description || ''), days_per_week: daysPerWeek, trainer_id: profile.id,
      days: body.days.map((d,i) => ({ name: String(d.name || `Day ${i + 1}`) })) };
    const [program] = body.id
      ? await tx.update(programs).set(values).where(eq(programs.id, body.id)).returning()
      : await tx.insert(programs).values(values).returning();
    await tx.delete(programExercises).where(eq(programExercises.program_id, program.id));
    if (entries.length) await tx.insert(programExercises).values(entries.map(e => ({ ...e, program_id: program.id })));
    return { data: program };
  });
}
export default async function handler(req) {
  try {
    const path = new URL(req.url).pathname;
    if (!['/api/me','/api/data','/api/programs'].includes(path)) return Response.json({ error: { message: 'Not found' } }, { status: 404 });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    verifyRequestOrigin(req);
    if (Number(req.headers.get('content-length')) > 2000000) throw new InputError('Request too large.');
    const text = await req.text();
    if (text.length > 2000000) throw new InputError('Request too large.');
    let body;
    try { body = JSON.parse(text || '{}'); } catch { throw new InputError('Invalid request.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Invalid request.');
    const user = await authenticate(req);
    const profile = await profileFor(user);
    const result = path === '/api/me' ? { data: profile } : path === '/api/programs' ? await saveProgram(profile, body) : await dataQuery(profile, body);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const duplicate = (error.code || error.cause?.code) === '23505';
    const status = error.status || (duplicate ? 409 : 500);
    return Response.json({ error: { message: duplicate ? 'This record or assignment already exists.' : status === 500 ? 'Unable to save or load data. Please try again.' : error.message, code: duplicate ? '23505' : undefined } }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
export const config = { path: '/api/*' };

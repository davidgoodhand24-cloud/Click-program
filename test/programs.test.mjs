import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import handler, { saveProgram, dataQuery, enrichedPrograms } from '../netlify/server/index.mjs';
import { prescriptions, hydrateDays } from '../netlify/server/prescriptions.mjs';
const engine = new PGlite(); // Disposable test database only; production uses Netlify Database.
const database = drizzle({ client: engine, schema });
const trainer = { id: '11111111-1111-4111-8111-111111111111', role: 'trainer', email: 'trainer@example.test' };
const other = { id: '22222222-2222-4222-8222-222222222222', role: 'trainer', email: 'other@example.test' };
const client = { id: '33333333-3333-4333-8333-333333333333', role: 'client', email: 'client@example.test' };
const stranger = { id: '44444444-4444-4444-8444-444444444444', role: 'client', email: 'stranger@example.test' };
const exerciseId = '55555555-5555-4555-8555-555555555555';
const otherExerciseId = '66666666-6666-4666-8666-666666666666';
let savedId, clientId;
const entry = (overrides = {}) => ({ exercise_id: exerciseId, sets: 3, reps: '8-10', weight: 22.5, rest_time: 90, ...overrides });
const program = (overrides = {}) => ({ name: 'Strength A', description: 'Controlled tempo', days_per_week: 2, days: [{ name: 'Lower', exercises: [entry()] }], ...overrides });
before(async () => {
  const migrations = await readdir(new URL('../netlify/database/migrations/', import.meta.url));
  for (const directory of migrations.sort()) {
    if (/^\d/.test(directory)) await engine.exec(await readFile(new URL(`../netlify/database/migrations/${directory}/migration.sql`, import.meta.url), 'utf8'));
  }
  for (const p of [trainer,other,client,stranger]) await database.insert(schema.profiles).values({ ...p, full_name: p.role });
  await database.insert(schema.exercises).values([{ id: exerciseId, trainer_id: trainer.id, name: 'Split squat' }, { id: otherExerciseId, trainer_id: other.id, name: 'Row' }]);
  const [c] = await database.insert(schema.clients).values({ trainer_id: trainer.id, user_id: client.id, email: client.email, full_name: 'Assigned athlete' }).returning();
  clientId = c.id;
});
after(() => engine.close());
test('prescriptions preserve zero weight/rest, null weight, repeated exercises and ordering', () => {
  const rows = prescriptions([{ exercises: [entry({ weight: 0, rest_time: 0 }), entry({ weight: '' })] }, { exercises: [entry()] }]);
  assert.deepEqual(rows.map(r => [r.day_number,r.position,r.weight,r.rest_time]), [[1,0,'0',0],[1,1,null,90],[2,0,'22.5',90]]);
});
test('invalid prescriptions fail with a useful input error', () => {
  for (const invalid of [{ sets: '' },{ sets: 1.5 },{ sets: -1 },{ reps: '10-8' },{ reps: '0' },{ rest_time: '90s' },{ rest_time: -1 },{ weight: -0.1 },{ weight: 1.234 },{ exercise_id: 'missing' }]) {
    assert.throws(() => prescriptions([{ exercises: [entry(invalid)] }]), error => error.status === 400);
  }
});
test('new program stores prescriptions against generated program ID, without embedded copies', async () => {
  const { data } = await saveProgram(trainer, program(), database);
  savedId = data.id;
  assert.deepEqual(data.days, [{ name: 'Lower' }]);
  const rows = await database.select().from(schema.programExercises).where(eq(schema.programExercises.program_id, savedId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exercise_id, exerciseId);
  assert.equal(rows[0].rest_time, 90);
  assert.equal(rows[0].day_number, 1);
});
test('trainer edits replace removed entries and keep the correct day/position', async () => {
  await saveProgram(trainer, program({ id: savedId, days: [{ name: 'Rest', exercises: [] }, { name: 'Upper', exercises: [entry({ weight: 0, rest_time: 0 }), entry({ reps: '12' })] }] }), database);
  const [p] = await enrichedPrograms(trainer, database);
  assert.equal(p.days[0].exercises.length, 0);
  assert.equal(p.days[1].exercises.length, 2);
  assert.equal(p.days[1].exercises[0].weight, '0.00');
  assert.equal(p.days[1].exercises[0].rest_time, 0);
  assert.equal(p.days[1].exercises[1].position, 1);
  assert.equal(p.days[1].exercises[0].name, 'Split squat');
});
test('foreign trainer and client cannot save the program', async () => {
  await assert.rejects(saveProgram(other, program({ id: savedId }), database), e => e.status === 404);
  await assert.rejects(saveProgram(client, program({ id: savedId }), database), e => e.status === 403);
  await assert.rejects(saveProgram(trainer, program({ days: [{ exercises: [entry({ exercise_id: otherExerciseId })] }] }), database), e => e.status === 403);
});
test('clients read only assigned prescriptions and cannot change data', async () => {
  assert.equal((await enrichedPrograms(client, database)).length, 0);
  await dataQuery(trainer, { table: 'client_programs', action: 'insert', data: { client_id: clientId, program_id: savedId } }, database);
  const visible = await enrichedPrograms(client, database);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].days[1].exercises[0].rest_time, 0);
  assert.equal((await enrichedPrograms(stranger, database)).length, 0);
  await assert.rejects(dataQuery(client, { table: 'programs', action: 'delete', filters: [{ field: 'id', op: 'eq', value: savedId }] }, database), e => e.status === 403);
  await assert.rejects(dataQuery(other, { table: 'client_programs', action: 'insert', data: { client_id: clientId, program_id: savedId } }, database), e => e.status === 403);
  const ownClients = await dataQuery(client, { table: 'clients' }, database);
  assert.equal('notes' in ownClients.data[0], false);
});
test('failed prescription insert rolls back metadata changes and prior deletion', async () => {
  const failingDatabase = {
    transaction: callback => database.transaction(tx => callback(new Proxy(tx, {
      get(target, key) {
        if (key === 'insert') return table => {
          if (table === schema.programExercises) throw new Error('Simulated storage failure');
          return target.insert(table);
        };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      },
    }))),
  };
  await assert.rejects(saveProgram(trainer, program({ id: savedId, name: 'Should roll back' }), failingDatabase), /Simulated storage failure/);
  const [p] = await enrichedPrograms(trainer, database);
  assert.equal(p.name, 'Strength A');
  assert.equal(p.days[1].exercises.length, 2);
});
test('unassignment immediately revokes access', async () => {
  const { data } = await dataQuery(trainer, { table: 'client_programs' }, database);
  await dataQuery(trainer, { table: 'client_programs', action: 'delete', filters: [{ field: 'id', op: 'eq', value: data[0].id }] }, database);
  assert.equal((await enrichedPrograms(client, database)).length, 0);
});
test('null optional day/position values are readable', () => {
  const days = hydrateDays({ days: [] }, [{ ...entry(), id: 'b', day_number: null, position: null }], [{ id: exerciseId, name: 'Split squat' }]);
  assert.equal(days[0].exercises[0].name, 'Split squat');
});
test('API rejects cross-origin writes and missing sessions before database access', async () => {
  const crossOrigin = await handler(new Request('https://site.example/api/programs', { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: '{}' }));
  assert.equal(crossOrigin.status, 403);
  const anonymous = await handler(new Request('https://site.example/api/programs', { method: 'POST', headers: { Origin: 'https://site.example' }, body: '{}' }));
  assert.equal(anonymous.status, 401);
});
test('program deletion cascades prescriptions and assignments', async () => {
  await dataQuery(trainer, { table: 'programs', action: 'delete', filters: [{ field: 'id', op: 'eq', value: savedId }] }, database);
  assert.equal((await database.select().from(schema.programExercises)).length, 0);
});
test('legacy import preserves IDs, prescriptions, assignments and legacy embedded days; retries are idempotent', async () => {
  const { importTrainer } = await import('../netlify/server/legacy.mjs');
  const ownerId = '88888888-8888-4888-8888-888888888888';
  const p1 = '99999999-9999-4999-8999-999999999991';
  const p2 = '99999999-9999-4999-8999-999999999992';
  const c1 = '99999999-9999-4999-8999-999999999993';
  const e1 = '99999999-9999-4999-8999-999999999994';
  const source = {
    profiles: [{ id: ownerId, email: 'legacy@example.test', full_name: 'Legacy trainer', role: 'trainer' }],
    clients: [{ id: c1, trainer_id: ownerId, email: 'athlete@example.test', full_name: 'Athlete', notes: 'Private' }],
    exercises: [{ id: e1, trainer_id: ownerId, name: 'Press' }],
    programs: [
      { id: p1, trainer_id: ownerId, name: 'Normalized', days: [{ name: 'Day 1' }], days_per_week: 2 },
      { id: p2, trainer_id: ownerId, name: 'Embedded', days: [{ name: 'Legacy day', exercises: [{ exercise_id: e1, sets: '4', reps: '8-10', rest: '90s' }] }], days_per_week: 2 },
    ],
    program_exercises: [{ program_id: p1, exercise_id: e1, sets: 3, reps: 8, weight: 0, rest_time: 0, day_number: null, position: null }],
    client_programs: [{ client_id: c1, program_id: p1 }],
  };
  await importTrainer(database, ownerId, async table => source[table]);
  const imported = await enrichedPrograms({ id: ownerId, role: 'trainer' }, database);
  assert.equal(imported.length, 2);
  assert.equal(imported.find(p => p.id === p1).days[0].exercises[0].rest_time, 0);
  assert.equal(imported.find(p => p.id === p2).days[0].exercises[0].sets, 4);
  assert.equal(imported.find(p => p.id === p2).days[0].exercises[0].rest_time, 90);
  assert.deepEqual((await database.select().from(schema.programs).where(eq(schema.programs.id, p2)))[0].days, [{ name: 'Legacy day' }]);
  await importTrainer(database, ownerId, async () => { throw new Error('Source should not be read again'); });
  assert.equal((await enrichedPrograms({ id: ownerId, role: 'trainer' }, database)).length, 2);
});

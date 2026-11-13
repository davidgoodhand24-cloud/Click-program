export class InputError extends Error { status = 400; }
export function prescriptions(days) {
  if (!Array.isArray(days) || !days.length || days.length > 31) throw new InputError('Add between 1 and 31 training days.');
  const rows = [];
  days.forEach((day, index) => {
    if (!Array.isArray(day.exercises) || day.exercises.length > 100) throw new InputError('Invalid exercise list.');
    day.exercises.forEach((ex, position) => {
      const sets = Number(ex.sets), rest = Number(ex.rest_time);
      const weight = ex.weight === '' || ex.weight == null ? null : Number(ex.weight);
      const reps = String(ex.reps ?? '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ex.exercise_id || '')) throw new InputError('Select an exercise from the library.');
      if (String(ex.sets ?? '').trim() === '' || !Number.isSafeInteger(sets) || sets < 1 || sets > 1000) throw new InputError('Sets must be a whole number between 1 and 1000.');
      if (!/^\d+(?:\s*-\s*\d+)?$/.test(reps) || reps.split('-').some(n => Number(n) < 1) || (reps.includes('-') && Number(reps.split('-')[0]) > Number(reps.split('-')[1]))) throw new InputError('Reps must be a positive number or range, such as 8-10.');
      if (String(ex.rest_time ?? '').trim() === '' || !Number.isSafeInteger(rest) || rest < 0 || rest > 86400) throw new InputError('Rest must be a whole number of seconds (0–86400).');
      if (weight !== null && (!Number.isFinite(weight) || weight < 0 || weight > 99999999.99 || Math.abs(weight * 100 - Math.round(weight * 100)) > 0.00001)) throw new InputError('Weight must be a non-negative kg value with up to two decimal places.');
      rows.push({ exercise_id: ex.exercise_id, sets, reps, weight: weight === null ? null : String(weight), rest_time: rest, day_number: index + 1, position });
    });
  });
  return rows;
}
export function hydrateDays(program, rows, library) {
  const days = (program.days || []).map(d => ({ name: d.name, exercises: [] }));
  const sorted = [...rows].sort((a,b) => (a.day_number ?? 1) - (b.day_number ?? 1) || (a.position ?? 0) - (b.position ?? 0) || String(a.id).localeCompare(String(b.id)));
  for (const row of sorted) {
    const day = Math.max(1, row.day_number ?? 1);
    while (days.length < day) days.push({ name: `Day ${days.length + 1}`, exercises: [] });
    days[day - 1].exercises.push({ ...row, name: library.find(e => e.id === row.exercise_id)?.name || 'Exercise' });
  }
  return days;
}

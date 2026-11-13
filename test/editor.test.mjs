import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/import \* as identity from [^;]+;/, 'const identity = window.testIdentity;')
  .replace(/import \{ api, store \} from [^;]+;/, 'const { api, store } = window.testData;');
async function editor(api) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://site.example', runScripts: 'dangerously' });
  const { window } = dom;
  window.testIdentity = { handleAuthCallback: async () => null, onAuthChange() {}, getUser: async () => null };
  const query = { select() { return this; }, eq() { return this; }, order() { return this; }, then(resolve) { return Promise.resolve({ data: [] }).then(resolve); } };
  window.testData = { api, store: { from: () => query } };
  new Script(code).runInContext(dom.getInternalVMContext());
  await new Promise(resolve => setImmediate(resolve));
  new Script(`currentUser = { id: 'trainer' }; currentProfile = { role: 'trainer' }; currentView = 'program-edit';
    exercises = [{id:'55555555-5555-4555-8555-555555555555',name:'Split squat'}];
    editingProgram = { id: '77777777-7777-4777-8777-777777777777', name:'Strength', description:'Tempo work', days_per_week:2,
      days:[{name:'Lower',exercises:[{exercise_id:exercises[0].id,sets:3,reps:'8-10',weight:0,rest_time:0}]}] }; render();`).runInContext(dom.getInternalVMContext());
  return dom;
}
function type(window, selector, value) {
  const input = window.document.querySelector(selector);
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
test('editor exposes prescription units and submits selected IDs with zero values intact', async () => {
  let submitted;
  const dom = await editor(async (path, body) => { submitted = { path, body }; return { data: { id: body.id } }; });
  const { window } = dom;
  assert.equal(window.document.querySelector('input[aria-label="Weight (kg) for Split squat"]').value, '0');
  assert.equal(window.document.querySelector('input[aria-label="Rest (seconds) for Split squat"]').value, '0');
  type(window, 'input[aria-label="Weight (kg) for Split squat"]', '32.25');
  type(window, 'input[aria-label="Reps for Split squat"]', '10-12');
  await window.saveProgram();
  assert.equal(submitted.path, '/api/programs');
  assert.equal(submitted.body.id, '77777777-7777-4777-8777-777777777777');
  const exercise = submitted.body.days[0].exercises[0];
  assert.equal(exercise.exercise_id, '55555555-5555-4555-8555-555555555555');
  assert.equal(exercise.weight, '32.25');
  assert.equal(exercise.reps, '10-12');
  assert.equal(exercise.rest_time, 0);
  dom.window.close();
});
test('re-rendering after an edit retains metadata and prescription values', async () => {
  const dom = await editor(async () => ({ data: {} }));
  const { window } = dom;
  type(window, '#prog-name', 'Updated strength');
  type(window, '#prog-desc', 'Updated tempo');
  type(window, 'input[aria-label="Sets for Split squat"]', '5');
  window.editingProgram.days.push({ name: 'Upper', exercises: [] });
  window.render();
  assert.equal(window.document.querySelector('#prog-name').value, 'Updated strength');
  assert.equal(window.document.querySelector('#prog-desc').value, 'Updated tempo');
  assert.equal(window.document.querySelector('input[aria-label="Sets for Split squat"]').value, '5');
  dom.window.close();
});
test('failed save keeps the draft and enables retry', async () => {
  const dom = await editor(async () => ({ error: { message: 'Connection failed' } }));
  await dom.window.saveProgram();
  assert.equal(dom.window.document.querySelector('#save-program').disabled, false);
  assert.equal(dom.window.document.querySelector('#prog-name').value, 'Strength');
  assert.match(dom.window.document.body.textContent, /Connection failed/);
  dom.window.close();
});
test('assigned client screen shows prescription units, including zeros', async () => {
  const dom = await editor(async () => ({ data: {} }));
  new Script(`currentProfile = {role:'client',full_name:'Athlete'};
    programs = [{id:'p',name:'Strength',days_per_week:2,days:[{name:'Lower',exercises:[{name:'Split squat',sets:3,reps:'8-10',weight:0,rest_time:0}]}]}];
    window.openClientProgram('p');`).runInContext(dom.getInternalVMContext());
  assert.match(dom.window.document.body.textContent, /3 × 8-10 · 0 kg · 0s rest/);
  assert.equal(dom.window.document.querySelector('input[aria-label*="Weight"]'), null);
  dom.window.close();
});

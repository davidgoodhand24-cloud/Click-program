export async function api(path, body = {}) {
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    return response.ok ? result : { error: result.error || { message: 'Request failed. Please try again.' } };
  } catch { return { error: { message: 'Connection failed. Your changes have not been saved. Please try again.' } }; }
}
// Small query adapter for the existing screens. Authorization always happens on the server.
class Query {
  constructor(table) { this.body = { table, filters: [] }; }
  select() { return this; }
  eq(field, value) { this.body.filters.push({ field, value, op: 'eq' }); return this; }
  in(field, value) { this.body.filters.push({ field, value, op: 'in' }); return this; }
  is(field, value) { this.body.filters.push({ field, value, op: 'is' }); return this; }
  order(field, options = {}) { this.body.order = { field, ...options }; return this; }
  limit(limit) { this.body.limit = limit; return this; }
  single() { this.body.single = true; return this; }
  maybeSingle() { return this.single(); }
  insert(data) { this.body.action = 'insert'; this.body.data = data; return this; }
  update(data) { this.body.action = 'update'; this.body.data = data; return this; }
  delete() { this.body.action = 'delete'; return this; }
  then(resolve, reject) { return api('/api/data', this.body).then(resolve, reject); }
}
export const store = { from: table => new Query(table) };

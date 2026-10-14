const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Database file location. Override with DATABASE_PATH in .env if needed.
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data', 'recipes.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema mirrors the original Supabase table. JSONB columns are stored as JSON text.
db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source TEXT,
    source_link TEXT,
    prep_time TEXT,
    cook_time TEXT,
    total_time TEXT,
    rise_time TEXT,
    cooling_time TEXT,
    bake_time TEXT,
    servings TEXT,
    yield TEXT,
    oven_temp TEXT,
    tin_size TEXT,
    dietary_info TEXT,
    ingredients TEXT NOT NULL,
    method TEXT NOT NULL,
    tips TEXT,
    notes TEXT,
    storage TEXT,
    equipment TEXT,
    variations TEXT,
    make_ahead TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS recipes_created_at_idx ON recipes(created_at DESC);
  CREATE INDEX IF NOT EXISTS recipes_name_idx ON recipes(name);
`);

// Fields the API accepts from clients. Everything else is dropped.
const ALLOWED_FIELDS = [
  'name', 'source', 'source_link', 'prep_time', 'cook_time', 'total_time',
  'rise_time', 'cooling_time', 'bake_time', 'servings', 'yield',
  'oven_temp', 'tin_size', 'dietary_info', 'ingredients', 'method',
  'tips', 'notes', 'storage', 'equipment', 'variations', 'make_ahead'
];

// Columns that hold JSON (arrays/objects) rather than plain text.
const JSON_FIELDS = [
  'dietary_info', 'ingredients', 'method', 'tips', 'notes',
  'storage', 'equipment', 'variations'
];

const TEXT_FIELDS = ALLOWED_FIELDS.filter(f => !JSON_FIELDS.includes(f));

function isJsonField(field) {
  return JSON_FIELDS.includes(field);
}

// Convert a JS value into what we store in a column.
function serialize(field, value) {
  if (value === undefined || value === null) return null;
  if (isJsonField(field)) {
    // Accept either already-parsed values or JSON strings.
    if (typeof value === 'string') {
      try { JSON.parse(value); return value; } catch { return JSON.stringify(value); }
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Convert a stored row back into the shape the API has always returned.
function deserialize(row) {
  if (!row) return null;
  const out = { ...row };
  for (const field of JSON_FIELDS) {
    if (out[field] === null || out[field] === undefined) continue;
    try { out[field] = JSON.parse(out[field]); } catch { /* leave as-is */ }
  }
  return out;
}

// Keep only allowed fields, serialised for storage.
function cleanInput(data) {
  const clean = {};
  for (const field of ALLOWED_FIELDS) {
    if (data[field] !== undefined) {
      clean[field] = serialize(field, data[field]);
    }
  }
  return clean;
}

const statements = {
  all: db.prepare('SELECT * FROM recipes ORDER BY created_at DESC, id DESC'),
  byId: db.prepare('SELECT * FROM recipes WHERE id = ?'),
  remove: db.prepare('DELETE FROM recipes WHERE id = ?')
};

function listRecipes() {
  return statements.all.all().map(deserialize);
}

function getRecipe(id) {
  return deserialize(statements.byId.get(id));
}

function createRecipe(data) {
  const clean = cleanInput(data);
  if (!clean.name) throw new Error('name is required');
  if (!clean.ingredients) throw new Error('ingredients is required');
  if (!clean.method) throw new Error('method is required');

  const now = new Date().toISOString();
  const row = { ...clean, created_at: now, updated_at: now };
  const cols = Object.keys(row);
  const sql = `INSERT INTO recipes (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`;
  const result = db.prepare(sql).run(row);
  return getRecipe(result.lastInsertRowid);
}

function updateRecipe(id, data) {
  const existing = statements.byId.get(id);
  if (!existing) return null;

  const clean = cleanInput(data);
  const row = { ...clean, updated_at: new Date().toISOString() };
  const sets = Object.keys(row).map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE recipes SET ${sets} WHERE id = @id`).run({ ...row, id });
  return getRecipe(id);
}

function deleteRecipe(id) {
  return statements.remove.run(id).changes > 0;
}

module.exports = {
  db,
  dbPath,
  ALLOWED_FIELDS,
  JSON_FIELDS,
  TEXT_FIELDS,
  serialize,
  deserialize,
  listRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  deleteRecipe
};

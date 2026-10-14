#!/usr/bin/env node
/**
 * Import a Supabase dump of the `recipes` table into the local SQLite database.
 *
 * Usage:
 *   node scripts/import-supabase.js <dump-file> [--replace] [--dry-run]
 *
 * Accepted dump formats (detected from the file extension, or sniffed if unknown):
 *   .json  An array of recipe objects, or {"recipes": [...]} as returned by GET /api/recipes
 *   .csv   Supabase Table Editor "Export to CSV"
 *   .sql   pg_dump output, either COPY ... FROM stdin blocks or INSERT INTO statements
 *
 * Options:
 *   --replace  Overwrite rows whose id already exists (default: skip them)
 *   --dry-run  Parse and report, but write nothing
 *
 * IDs and created_at / updated_at timestamps are preserved so existing /recipes/:id
 * links keep working.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const file = args.find(a => !a.startsWith('--'));

if (!file) {
  console.error('Usage: node scripts/import-supabase.js <dump-file> [--replace] [--dry-run]');
  process.exit(1);
}

const replace = flags.has('--replace');
const dryRun = flags.has('--dry-run');

let db, dbPath, ALLOWED_FIELDS, serialize, COLUMNS;
function loadDb() {
  ({ db, dbPath, ALLOWED_FIELDS, serialize } = require(path.join(__dirname, '..', 'db.js')));
  COLUMNS = ['id', ...ALLOWED_FIELDS, 'created_at', 'updated_at'];
}

// ---------- Parsers ----------

function parseJson(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.recipes)) return data.recipes;
  if (data && Array.isArray(data.data)) return data.data;
  throw new Error('JSON must be an array of recipes or an object with a "recipes" array');
}

// RFC 4180 CSV parser: handles quoted fields, doubled quotes and newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  if (text.charCodeAt(0) === 0xfeff) i = 1; // strip BOM

  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map(h => h.trim());
  return nonEmpty.slice(1).map(r => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx] === undefined || r[idx] === '' ? null : r[idx]; });
    return obj;
  });
}

// Decode a single value from a Postgres COPY text block.
function decodeCopyValue(raw) {
  if (raw === '\\N') return null;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case undefined: break;
      default: out += n;
    }
  }
  return out;
}

// Parse the VALUES (...) tuple list of an INSERT statement into arrays of JS values.
function parseInsertTuples(src) {
  const tuples = [];
  let i = 0;

  function skipWs() { while (i < src.length && /\s/.test(src[i])) i++; }

  function readValue() {
    skipWs();
    const c = src[i];
    if (c === "'" || ((c === 'E' || c === 'e') && src[i + 1] === "'")) {
      const escaped = c !== "'";
      if (escaped) i++;
      i++; // opening quote
      let out = '';
      while (i < src.length) {
        const ch = src[i];
        if (ch === "'") {
          if (src[i + 1] === "'") { out += "'"; i += 2; continue; }
          i++; break;
        }
        if (escaped && ch === '\\') {
          const n = src[++i];
          out += ({ n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'" })[n] ?? n;
          i++; continue;
        }
        out += ch; i++;
      }
      return out;
    }
    // Bare token: NULL, number, true/false, etc.
    let tok = '';
    while (i < src.length && src[i] !== ',' && src[i] !== ')') tok += src[i++];
    tok = tok.trim();
    if (/^null$/i.test(tok)) return null;
    if (/^true$/i.test(tok)) return true;
    if (/^false$/i.test(tok)) return false;
    // Strip casts like '...'::jsonb never reach here; numbers pass through as strings.
    return tok;
  }

  while (i < src.length) {
    skipWs();
    if (src[i] !== '(') { i++; continue; }
    i++;
    const tuple = [];
    while (i < src.length) {
      tuple.push(readValue());
      skipWs();
      // Skip any ::type cast after a value
      while (src.startsWith('::', i)) { i += 2; while (i < src.length && /[\w\[\]]/.test(src[i])) i++; skipWs(); }
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ')') { i++; break; }
      i++;
    }
    tuples.push(tuple);
    skipWs();
    if (src[i] === ';') { i++; break; }
  }
  return tuples;
}

function parseSql(text) {
  const rows = [];

  // COPY public.recipes (col, col, ...) FROM stdin;  ... \.
  const copyRe = /COPY\s+(?:"?[\w]+"?\.)?"?recipes"?\s*\(([^)]*)\)\s+FROM\s+stdin;\r?\n([\s\S]*?)\r?\n\\\.\s*$/gmi;
  let m;
  while ((m = copyRe.exec(text)) !== null) {
    const cols = m[1].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    for (const line of m[2].split(/\r?\n/)) {
      if (line === '') continue;
      const vals = line.split('\t').map(decodeCopyValue);
      const obj = {};
      cols.forEach((c, idx) => { obj[c] = vals[idx] ?? null; });
      rows.push(obj);
    }
  }

  // INSERT INTO public.recipes (cols) VALUES (...), (...);
  const insertRe = /INSERT\s+INTO\s+(?:"?[\w]+"?\.)?"?recipes"?\s*\(([^)]*)\)\s*VALUES\s*/gi;
  while ((m = insertRe.exec(text)) !== null) {
    const cols = m[1].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const rest = text.slice(m.index + m[0].length);
    const tuples = parseInsertTuples(rest);
    for (const t of tuples) {
      const obj = {};
      cols.forEach((c, idx) => { obj[c] = t[idx] ?? null; });
      rows.push(obj);
    }
  }

  // INSERT INTO recipes VALUES (...) with no column list: assume the Supabase column order.
  const bareInsertRe = /INSERT\s+INTO\s+(?:"?[\w]+"?\.)?"?recipes"?\s+VALUES\s*/gi;
  while ((m = bareInsertRe.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    for (const t of parseInsertTuples(rest)) {
      const obj = {};
      COLUMNS.forEach((c, idx) => { obj[c] = t[idx] ?? null; });
      rows.push(obj);
    }
  }

  return rows;
}

function detectAndParse(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return parseJson(text);
  if (ext === '.csv') return parseCsv(text);
  if (ext === '.sql') return parseSql(text);

  const head = text.trimStart().slice(0, 200);
  if (head.startsWith('[') || head.startsWith('{')) return parseJson(text);
  if (/^(--|COPY|INSERT|SET|CREATE|BEGIN)/i.test(head)) return parseSql(text);
  return parseCsv(text);
}

// ---------- Normalisation ----------

// Postgres timestamptz like "2025-12-07 10:22:33.123456+00" -> ISO 8601 in UTC.
function normaliseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  let s = String(value).trim();
  s = s.replace(' ', 'T');
  s = s.replace(/([+-]\d{2})$/, '$1:00');       // +00 -> +00:00
  s = s.replace(/(\.\d{3})\d+/, '$1');           // trim microseconds to ms
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

function normaliseRow(raw) {
  const row = {};
  for (const col of COLUMNS) {
    let v = raw[col];
    if (v === undefined) v = null;
    if (col === 'id') {
      row.id = v === null || v === '' ? null : Number(v);
      if (row.id !== null && !Number.isInteger(row.id)) {
        throw new Error(`Non-integer id "${v}" in dump; SQLite schema uses integer ids`);
      }
    } else if (col === 'created_at' || col === 'updated_at') {
      row[col] = normaliseTimestamp(v);
    } else {
      row[col] = serialize(col, v);
    }
  }
  const now = new Date().toISOString();
  if (!row.created_at) row.created_at = now;
  if (!row.updated_at) row.updated_at = row.created_at;
  return row;
}

// ---------- Main ----------

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  process.exit(1);
}
loadDb();
let rawRows;
try {
  rawRows = detectAndParse(file, text);
} catch (err) {
  console.error(`Could not parse ${file}: ${err.message}`);
  process.exit(1);
}

console.log(`Parsed ${rawRows.length} row(s) from ${file}`);
console.log(`Target database: ${dbPath}${dryRun ? ' (dry run, nothing will be written)' : ''}`);

const rows = [];
const problems = [];
rawRows.forEach((raw, idx) => {
  try {
    const row = normaliseRow(raw);
    if (!row.name) throw new Error('missing name');
    if (!row.ingredients) throw new Error('missing ingredients');
    if (!row.method) throw new Error('missing method');
    rows.push(row);
  } catch (err) {
    problems.push(`row ${idx + 1}: ${err.message}`);
  }
});

if (problems.length) {
  console.warn(`Skipping ${problems.length} invalid row(s):`);
  problems.forEach(p => console.warn('  ' + p));
}

if (dryRun) {
  rows.slice(0, 3).forEach(r => console.log(`  would import #${r.id ?? '(new)'} "${r.name}" created ${r.created_at}`));
  if (rows.length > 3) console.log(`  ... and ${rows.length - 3} more`);
  process.exit(0);
}

const verb = replace ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
const withId = db.prepare(`${verb} INTO recipes (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(c => '@' + c).join(', ')})`);
const withoutIdCols = COLUMNS.filter(c => c !== 'id');
const withoutId = db.prepare(`INSERT INTO recipes (${withoutIdCols.join(', ')}) VALUES (${withoutIdCols.map(c => '@' + c).join(', ')})`);

let inserted = 0;
let skipped = 0;
const run = db.transaction(() => {
  for (const row of rows) {
    const result = row.id === null ? withoutId.run(row) : withId.run(row);
    if (result.changes > 0) inserted++; else skipped++;
  }
});
run();

const total = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
console.log(`Imported ${inserted} row(s)${skipped ? `, skipped ${skipped} existing id(s)` : ''}. Database now holds ${total} recipe(s).`);
if (skipped && !replace) console.log('Re-run with --replace to overwrite rows that already exist.');

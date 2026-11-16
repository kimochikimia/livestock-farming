'use strict';
// Нэг удаагийн шилжүүлэлт: SQLite (data/farm.db) → MySQL.
// Ажиллуулах: node --env-file=.env server/migrate-sqlite-to-mysql.js [sqlite-файл]
// MySQL-д аль хэдийн хэрэглэгч байвал зогсоно (давхар оруулахаас сэргийлнэ).
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { db, init, CONFIG } = require('./db');

const SRC = process.argv[2] || process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'farm.db');

// Хамааралын дарааллаар (эцэг хүснэгт эхэнд)
const TABLES = [
  'users', 'sessions', 'settings', 'audit', 'farms', 'farm_settings',
  'animal_classes', 'feeds', 'expense_types', 'tag_colors', 'task_types', 'breeding', 'feed_plan', 'partners',
  'animals', 'weighings', 'expenses', 'slaughters', 'sales', 'market_prices', 'feed_recipes', 'tasks', 'photos'
];
// SQLite-ийн "key" багана MySQL-д "skey" болсон
const RENAME = { settings: { key: 'skey' }, farm_settings: { key: 'skey' } };
// SQLite datetime('now') нь UTC байсан → MySQL-д орон нутгийн цагаар (Улаанбаатар) хадгална
const DATETIME_COLS = new Set(['created_at', 'reviewed_at', 'last_login', 'at']);
const pad = n => String(n).padStart(2, '0');
function utcToLocal(s) {
  if (!s) return s;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

(async () => {
  const src = new DatabaseSync(SRC, { readOnly: true });
  await init();
  console.log(`SQLite: ${SRC}\nMySQL:  ${CONFIG.user}@${CONFIG.host}:${CONFIG.port}/${CONFIG.database}`);

  const { n: existing } = await db.one('SELECT COUNT(*) n FROM users');
  if (existing > 0) {
    console.error(`✖ MySQL-ийн "${CONFIG.database}" санд аль хэдийн ${existing} хэрэглэгч байна. Шилжүүлэлтийг зогсоолоо.`);
    process.exit(1);
  }

  const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  const result = {};
  await db.tx(async c => {
    await c.run('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) {
      if (!srcTables.has(t)) { result[t] = '—'; continue; }
      const destCols = new Set((await c.q(`SHOW COLUMNS FROM ${t}`)).map(r => r.Field));
      const rows = src.prepare(`SELECT * FROM ${t}`).all();
      if (!rows.length) { result[t] = 0; continue; }
      const map = RENAME[t] || {};
      const srcCols = Object.keys(rows[0]).filter(k => destCols.has(map[k] || k));
      const cols = srcCols.map(k => map[k] || k);
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const values = chunk.map(r => srcCols.map(k => (DATETIME_COLS.has(k) ? utcToLocal(r[k]) : r[k])));
        await c.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES ${chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`, values.flat());
      }
      result[t] = rows.length;
    }
    await c.run('SET FOREIGN_KEY_CHECKS = 1');
  });

  // Тулгалт: мөрийн тоо таарч байгаа эсэх
  let ok = true;
  for (const t of TABLES) {
    if (typeof result[t] !== 'number') continue;
    const { n } = await db.one(`SELECT COUNT(*) n FROM ${t}`);
    const match = n === result[t];
    if (!match) ok = false;
    console.log(`${match ? '✔' : '✖'} ${t.padEnd(15)} SQLite ${String(result[t]).padStart(5)}  →  MySQL ${String(n).padStart(5)}`);
  }
  console.log(ok ? '\n✔ Шилжүүлэлт амжилттай.' : '\n✖ Зарим хүснэгтийн тоо таарахгүй байна!');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('✖ Алдаа:', e.code || '', e.message); process.exit(1); });

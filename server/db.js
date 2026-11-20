'use strict';
// MySQL мэдээллийн сан (mysql2). Бүтэц: хэрэглэгч → олон ферм → фермийн бүх бүртгэл, тохиргоо (farm_id-аар тусгаарлагдана)
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Холболт: DB_* → (Railway) MYSQL_URL / DATABASE_URL → (Railway) MYSQLHOST… → анхдагч
const env = process.env;
let fromUrl = {};
const url = env.MYSQL_URL || env.DATABASE_URL;
if (!env.DB_HOST && url) {
  const u = new URL(url);
  fromUrl = { host: u.hostname, port: u.port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, '') };
}
const CONFIG = {
  host: env.DB_HOST || fromUrl.host || env.MYSQLHOST || '127.0.0.1',
  port: Number(env.DB_PORT || fromUrl.port || env.MYSQLPORT) || 3306,
  user: env.DB_USER || fromUrl.user || env.MYSQLUSER || 'root',
  password: env.DB_PASSWORD ?? fromUrl.password ?? env.MYSQLPASSWORD ?? '',
  database: env.DB_NAME || fromUrl.database || env.MYSQLDATABASE || 'tumen_sureg'
};
if (!/^[A-Za-z0-9_]+$/.test(CONFIG.database)) throw new Error('DB_NAME зөвхөн латин үсэг, тоо, _ агуулна');

let pool = null;

// q: олон мөр, one: эхний мөр, run: { insertId, changes }
const wrap = ex => ({
  q: async (sql, params = []) => (await ex.query(sql, params))[0],
  one: async (sql, params = []) => (await ex.query(sql, params))[0][0],
  run: async (sql, params = []) => { const [r] = await ex.query(sql, params); return { insertId: r.insertId, changes: r.affectedRows }; }
});
const db = {
  q: (...a) => wrap(pool).q(...a),
  one: (...a) => wrap(pool).one(...a),
  run: (...a) => wrap(pool).run(...a),
  // Гүйлгээ: fn(c) дотор c.q / c.one / c.run ашиглана
  async tx(fn) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const r = await fn(wrap(conn));
      await conn.commit();
      return r;
    } catch (e) {
      try { await conn.rollback(); } catch { /* */ }
      throw e;
    } finally { conn.release(); }
  }
};

// ---------- Бүтэц ----------
const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const FARM = 'farm_id INT NOT NULL, FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE';
const CREATED = 'created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    role VARCHAR(10) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
    status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','blocked')),
    perms TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME NULL,
    reviewed_by INT NULL,
    last_login DATETIME NULL
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    expires_at BIGINT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS settings (skey VARCHAR(100) PRIMARY KEY, value TEXT NULL) ${T}`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INT AUTO_INCREMENT PRIMARY KEY,
    at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id INT NULL, farm_id INT NULL,
    action VARCHAR(100) NOT NULL, entity VARCHAR(50) NULL, entity_id INT NULL, detail VARCHAR(500) NULL,
    INDEX (farm_id)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS news (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    body TEXT NOT NULL,
    published TINYINT NOT NULL DEFAULT 1,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX (published, created_at)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS farms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    note VARCHAR(500) NULL,
    owner_id INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS farm_members (
    ${FARM}, user_id INT NOT NULL, perms TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (farm_id, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS farm_settings (
    ${FARM}, skey VARCHAR(100) NOT NULL, value TEXT NULL, PRIMARY KEY (farm_id, skey)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS animal_classes (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    species VARCHAR(20) NOT NULL, age_name VARCHAR(100) NOT NULL, age VARCHAR(10) NOT NULL, sex VARCHAR(20) NOT NULL,
    target_weight DOUBLE NULL, UNIQUE KEY uq_class (farm_id, species, age_name, age, sex)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS feeds (id INT AUTO_INCREMENT PRIMARY KEY, ${FARM}, name VARCHAR(100) NOT NULL, price DOUBLE NULL, UNIQUE KEY uq_feed (farm_id, name)) ${T}`,
  `CREATE TABLE IF NOT EXISTS expense_types (id INT AUTO_INCREMENT PRIMARY KEY, ${FARM}, name VARCHAR(100) NOT NULL, UNIQUE KEY uq_et (farm_id, name)) ${T}`,
  `CREATE TABLE IF NOT EXISTS tag_colors (id INT AUTO_INCREMENT PRIMARY KEY, ${FARM}, name VARCHAR(50) NOT NULL, UNIQUE KEY uq_tc (farm_id, name)) ${T}`,
  `CREATE TABLE IF NOT EXISTS task_types (id INT AUTO_INCREMENT PRIMARY KEY, ${FARM}, name VARCHAR(100) NOT NULL,
    needs_animals TINYINT NOT NULL DEFAULT 0, UNIQUE KEY uq_tt (farm_id, name)) ${T}`,
  `CREATE TABLE IF NOT EXISTS breeding (id INT AUTO_INCREMENT PRIMARY KEY, ${FARM}, species VARCHAR(20) NOT NULL, dam_name VARCHAR(100) NOT NULL,
    births_per_year DOUBLE NULL, gestation VARCHAR(100) NULL, breeding_months VARCHAR(100) NULL, birthing_months VARCHAR(100) NULL) ${T}`,
  `CREATE TABLE IF NOT EXISTS feed_plan (id INT AUTO_INCREMENT PRIMARY KEY, ${FARM}, feed_name VARCHAR(200) NOT NULL,
    kg_1_14 DOUBLE NULL, kg_15_30 DOUBLE NULL, kg_31_90 DOUBLE NULL, price DOUBLE NULL) ${T}`,
  `CREATE TABLE IF NOT EXISTS partners (id INT AUTO_INCREMENT PRIMARY KEY, ${FARM}, name VARCHAR(100) NOT NULL, percent DOUBLE NOT NULL) ${T}`,
  `CREATE TABLE IF NOT EXISTS animals (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    purchase_date DATE NOT NULL, species VARCHAR(20) NOT NULL, age_name VARCHAR(100) NULL, age VARCHAR(10) NULL, sex VARCHAR(20) NULL,
    tag_id VARCHAR(50) NOT NULL, tag_color VARCHAR(50) NULL, initial_weight DOUBLE NULL, purchase_price DOUBLE NULL,
    transport_cost DOUBLE NULL, other_cost DOUBLE NULL, feed_cost DOUBLE NULL, note TEXT NULL,
    goal_weight DOUBLE NULL, goal_days INT NULL, to_sell TINYINT NOT NULL DEFAULT 0,
    source VARCHAR(20) NOT NULL DEFAULT 'Худалдаж авсан', mother_tag VARCHAR(50) NULL, market_value DOUBLE NULL,
    ${CREATED}, UNIQUE KEY uq_tag (farm_id, tag_id)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS weighings (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    date DATE NOT NULL, animal_id INT NOT NULL, weight DOUBLE NOT NULL, note VARCHAR(500) NULL, ${CREATED},
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE, INDEX (animal_id, date)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    date DATE NOT NULL, type VARCHAR(100) NOT NULL, description VARCHAR(500) NULL, qty DOUBLE NULL, unit_price DOUBLE NULL,
    supplier VARCHAR(200) NULL, feed_name VARCHAR(100) NULL, unit VARCHAR(10) NULL, ${CREATED}
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS feed_usage (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    date DATE NOT NULL, feed_name VARCHAR(100) NOT NULL, unit VARCHAR(10) NOT NULL DEFAULT 'кг', qty DOUBLE NOT NULL, note VARCHAR(500) NULL, ${CREATED},
    INDEX (farm_id, feed_name)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS slaughters (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    date DATE NOT NULL, animal_id INT NOT NULL UNIQUE, carcass_weight DOUBLE NULL, shipped_date DATE NULL, ${CREATED},
    FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS sales (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    shipped_date DATE NOT NULL, sold_date DATE NULL, sold_weight DOUBLE NULL, price DOUBLE NULL, note VARCHAR(500) NULL, ${CREATED}
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS market_prices (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    year INT NOT NULL, month INT NOT NULL, species VARCHAR(20) NOT NULL, price DOUBLE NOT NULL, ${CREATED}
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS feed_recipes (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    species VARCHAR(20) NOT NULL, recipe_no INT NOT NULL,
    hay DOUBLE NULL, alfalfa DOUBLE NULL, straw DOUBLE NULL, bran DOUBLE NULL, barley DOUBLE NULL, oats DOUBLE NULL,
    green DOUBLE NULL, mineral DOUBLE NULL, price_per_kg DOUBLE NULL, kg_per_gain DOUBLE NULL, note VARCHAR(500) NULL
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    date DATE NOT NULL, type VARCHAR(100) NOT NULL, tag_id TEXT NULL, assignee VARCHAR(100) NULL, note TEXT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Төлөвлөсөн', done_date DATE NULL, ${CREATED}, INDEX (farm_id, date)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS photos (
    id INT AUTO_INCREMENT PRIMARY KEY, ${FARM},
    entity VARCHAR(30) NOT NULL, entity_id INT NOT NULL, filename VARCHAR(100) NOT NULL UNIQUE,
    mime VARCHAR(30) NOT NULL, size INT NOT NULL, ${CREATED}, INDEX (entity, entity_id)
  ) ${T}`
];

async function ensureColumn(table, col, def) {
  const exists = await db.one('SELECT 1 x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [CONFIG.database, table, col]);
  if (exists) return false;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  return true;
}

async function init() {
  // Мэдээллийн сан байхгүй бол үүсгэнэ
  const c = await mysql.createConnection({ host: CONFIG.host, port: CONFIG.port, user: CONFIG.user, password: CONFIG.password });
  await c.query(`CREATE DATABASE IF NOT EXISTS \`${CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await c.end();
  pool = mysql.createPool({
    ...CONFIG,
    charset: 'utf8mb4',
    connectionLimit: 10,
    dateStrings: true,      // DATE / DATETIME-ийг 'YYYY-MM-DD[ HH:MM:SS]' мөр хэлбэрээр буцаана
    decimalNumbers: true,
    supportBigNumbers: true
  });
  for (const sql of SCHEMA) await pool.query(sql);
  // Шилжүүлэлт: хуучин санд шинэ багана нэмнэ (өгөгдөл устахгүй)
  await ensureColumn('animals', 'source', "VARCHAR(20) NOT NULL DEFAULT 'Худалдаж авсан'");
  await ensureColumn('animals', 'mother_tag', 'VARCHAR(50) NULL');
  await ensureColumn('animals', 'market_value', 'DOUBLE NULL');
  // Зардлын дэд төрөл: "Тэжээл" төрлийн зардалд тохиргооны тэжээлийн нэр
  await ensureColumn('expenses', 'feed_name', 'VARCHAR(100) NULL');
  // Тэжээлийн нэгж (кг / боодол), 1 боодлын жин
  await ensureColumn('expenses', 'unit', 'VARCHAR(10) NULL');
  await ensureColumn('feed_usage', 'unit', "VARCHAR(10) NOT NULL DEFAULT 'кг'");
  await ensureColumn('feeds', 'bale_kg', 'DOUBLE NULL');
  await pool.query("UPDATE expenses SET unit = 'кг' WHERE feed_name IS NOT NULL AND unit IS NULL");
  // Хөрөнгө оруулагч (partners): хөрөнгө, олгох давтамж, хугацаа
  await ensureColumn('partners', 'phone', 'VARCHAR(20) NULL');
  await ensureColumn('partners', 'invested', 'DOUBLE NULL');
  await ensureColumn('partners', 'payout_period', 'VARCHAR(40) NULL');
  await ensureColumn('partners', 'start_date', 'DATE NULL');
  await ensureColumn('partners', 'end_date', 'DATE NULL');
  await ensureColumn('partners', 'note', 'VARCHAR(500) NULL');
  // Фермийн байршил: аймаг/хот, сум/дүүрэг, баг/хороо
  await ensureColumn('farms', 'aimag', 'VARCHAR(50) NULL');
  await ensureColumn('farms', 'soum', 'VARCHAR(80) NULL');
  await ensureColumn('farms', 'bag', 'VARCHAR(80) NULL');
  // Борлуулалтын төрөл: "Мах" (ачилтаар) / "Амьд" (малыг амьдаар нь, нэг мал — animal_id, нийт үнэ — amount)
  await ensureColumn('sales', 'kind', "VARCHAR(10) NOT NULL DEFAULT 'Мах'");
  await ensureColumn('sales', 'animal_id', 'INT NULL');
  await ensureColumn('sales', 'amount', 'DOUBLE NULL');
  // Бой: бойнд орох (төлөвлөсөн) огноо ба бойнд орсон (бодит) огноо. date = бодит || төлөвлөсөн
  // Зардал: өөр зардалтай холбох (тэжээлийн тээвэр → тэжээл, малын тээвэр → "Мал авсан"): "16" эсвэл "animal-33"
  await ensureColumn('expenses', 'related_ref', 'VARCHAR(40) NULL');
  // Зардлыг аль хөрөнгө оруулагч төлсөн (partners.id) — ашиг хуваарилалтад ашиглана
  await ensureColumn('expenses', 'paid_by', 'INT NULL');
  await ensureColumn('animals', 'paid_by', 'INT NULL');
  // Хөрөнгө оруулагч = вэбд бүртгэлтэй хэрэглэгч (утасны дугаараар холбоно)
  await ensureColumn('partners', 'user_id', 'INT NULL');
  // Фермийн эзэмшигч = анхдагч хөрөнгө оруулагч (100%). Багана шинээр нэмэгдэх үед л нэг удаа:
  // хөрөнгө оруулагчгүй фермүүдэд эзэмшигчийг нэмнэ (дараа нь устгасан бол дахин нэмэгдэхгүй)
  if (await ensureColumn('partners', 'is_owner', 'TINYINT(1) NOT NULL DEFAULT 0')) {
    await pool.query(`INSERT INTO partners(farm_id, name, phone, percent, user_id, is_owner)
      SELECT f.id, u.name, u.phone, 100, u.id, 1 FROM farms f JOIN users u ON u.id = f.owner_id
      WHERE NOT EXISTS (SELECT 1 FROM partners p WHERE p.farm_id = f.id)`);
  }
  // Фермийн өнгө (фермүүдийг ялгаж харуулна), #rrggbb
  await ensureColumn('farms', 'color', 'VARCHAR(7) NULL');
  // Зургийн төрөл: NULL — үндсэн зураг, 'tag' — малын ээмгийн зураг
  await ensureColumn('photos', 'kind', 'VARCHAR(10) NULL');
  // Хэрэглэгчийн имэйл: давхцахгүй (өмнө бүртгүүлсэн хэрэглэгчид хоосон байж болно)
  await ensureColumn('users', 'email', 'VARCHAR(190) NULL');
  if (!await db.one('SELECT 1 x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?', [CONFIG.database, 'users', 'uq_users_email'])) {
    await pool.query('ALTER TABLE users ADD UNIQUE INDEX uq_users_email (email)').catch(e => { if (e.code !== 'ER_DUP_KEYNAME') throw e; });
  }
  await ensureColumn('slaughters', 'planned_date', 'DATE NULL');
  await ensureColumn('slaughters', 'slaughtered_date', 'DATE NULL');
  await pool.query('UPDATE slaughters SET planned_date = date WHERE planned_date IS NULL');
  await pool.query('UPDATE slaughters SET slaughtered_date = date WHERE slaughtered_date IS NULL AND carcass_weight IS NOT NULL');
  return db;
}

// Зургийн хавтас. Railway дээр контейнерийн диск redeploy бүрт цэвэрлэгддэг тул зураг заавал Volume дотор байх ёстой:
// Volume холбогдсон бол (RAILWAY_VOLUME_MOUNT_PATH) UPLOAD_DIR түүний дотор байхгүй бол Volume руу шилжүүлнэ.
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
let UPLOAD_DIR = process.env.UPLOAD_DIR || (VOLUME ? path.join(VOLUME, 'uploads') : path.join(__dirname, '..', 'data', 'uploads'));
if (VOLUME) {
  const rel = path.relative(path.resolve(VOLUME), path.resolve(UPLOAD_DIR));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    console.warn(`⚠ UPLOAD_DIR (${UPLOAD_DIR}) Volume (${VOLUME}) дотор биш тул ${path.join(VOLUME, 'uploads')} ашиглана`);
    UPLOAD_DIR = path.join(VOLUME, 'uploads');
  }
} else if (process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID) {
  console.warn('⚠ Railway Volume холбогдоогүй байна — зургийн файлууд redeploy бүрт устна. Вэб үйлчилгээнд /data замд Volume холбоно уу.');
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
console.log('Зургийн хавтас:', UPLOAD_DIR);

// ---------- Фермийн тохиргоо (key/value) ----------
const SETTING_DEFAULTS = {
  plan_days: '90',               // Тэжээлийн төлөвлөгөөний хоног
  plan_other_budget: '',         // Маллагаа, ус, мал эмнэлэг бусад зардлын төсөв (1 толгой)
  plan_species: 'Үхэр',          // Төлөвлөгөө аль төрлийн малд
  plan_head_count: '',           // Хоосон бол идэвхтэй малын тоогоор автоматаар
  profit_mode: 'percent',        // Ашиг хуваарилалт: percent — ашгаас шууд хувиар; refund — төлсөн зардлыг буцааж, үлдэгдлийг хувиар
  profit_tax: '0',               // 1 — ашгаас татвар хасна
  profit_tax_rate: '10'          // Татварын хувь (%)
};
const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

async function getSettings(farmId, ex = db) {
  const out = { ...SETTING_DEFAULTS };
  for (const r of await ex.q('SELECT skey, value FROM farm_settings WHERE farm_id = ?', [farmId])) {
    if (SETTING_KEYS.includes(r.skey)) out[r.skey] = r.value;
  }
  return out;
}
async function setSetting(farmId, key, value, ex = db) {
  await ex.run('INSERT INTO farm_settings(farm_id, skey, value) VALUES(?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [farmId, key, value == null ? '' : String(value)]);
}

async function audit(userId, action, entity = null, entityId = null, detail = null, farmId = null) {
  await db.run('INSERT INTO audit(user_id, farm_id, action, entity, entity_id, detail) VALUES(?, ?, ?, ?, ?, ?)',
    [userId ?? null, farmId ?? null, action, entity, entityId ?? null, detail == null ? null : String(detail).slice(0, 500)]);
}

// Шинэ ферм үүсгэхэд өөр фермийн тохиргоог хуулна
const COPYABLE = {
  animal_classes: ['species', 'age_name', 'age', 'sex', 'target_weight'],
  feeds: ['name', 'price', 'bale_kg'],
  expense_types: ['name'],
  tag_colors: ['name'],
  task_types: ['name', 'needs_animals'],
  breeding: ['species', 'dam_name', 'births_per_year', 'gestation', 'breeding_months', 'birthing_months'],
  feed_plan: ['feed_name', 'kg_1_14', 'kg_15_30', 'kg_31_90', 'price'],
};
async function copyFarmSettings(c, fromId, toId) {
  for (const [t, cols] of Object.entries(COPYABLE)) {
    await c.run(`INSERT INTO ${t} (farm_id, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM ${t} WHERE farm_id = ? ORDER BY id`, [toId, fromId]);
  }
  await c.run('REPLACE INTO farm_settings(farm_id, skey, value) SELECT ?, skey, value FROM farm_settings WHERE farm_id = ?', [toId, fromId]);
}

// Админыг .env-ээс үүсгэнэ. Аль хэдийн байгаа бол нууц үгийг нь өөрчлөхгүй.
async function ensureAdmin() {
  const phone = (process.env.ADMIN_PHONE || '').replace(/\D/g, '');
  const password = process.env.ADMIN_PASSWORD || '';
  if (!phone || !password) {
    if (!(await db.one("SELECT 1 x FROM users WHERE role = 'admin' AND status = 'approved'"))) {
      console.warn('⚠ ADMIN_PHONE / ADMIN_PASSWORD тохируулаагүй тул админ үүсгэсэнгүй.');
    }
    return;
  }
  const existing = await db.one('SELECT id, role, status FROM users WHERE phone = ?', [phone]);
  if (!existing) {
    const hash = bcrypt.hashSync(password, 12);
    const { insertId } = await db.run("INSERT INTO users(phone, name, password_hash, role, status, reviewed_at) VALUES(?, 'Админ', ?, 'admin', 'approved', NOW())", [phone, hash]);
    await audit(insertId, 'Админ үүсгэв', 'users', insertId, phone);
    console.log(`✔ Админ хэрэглэгч үүсгэлээ: ${phone}`);
  } else if (existing.role !== 'admin' || existing.status !== 'approved') {
    await db.run("UPDATE users SET role = 'admin', status = 'approved' WHERE id = ?", [existing.id]);
    console.log(`✔ ${phone} хэрэглэгчийг админ болголоо`);
  }
}

module.exports = { db, init, CONFIG, audit, getSettings, setSetting, SETTING_KEYS, ensureAdmin, UPLOAD_DIR, copyFarmSettings };

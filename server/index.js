'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { db, init, audit, getSettings, setSetting, SETTING_KEYS, ensureAdmin, UPLOAD_DIR, copyFarmSettings } = require('./db');
const { resources, validate, HttpError, mapDbError, SPECIES, SEXES, FEED_TYPE, animalPurchaseExpenses, meatStock } = require('./resources');
const { applyTemplate } = require('./template');

const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const SESSION_MS = 14 * 864e5;
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : PROD;
const LEVEL = { viewer: 1, editor: 2, admin: 3 };
const ROLES = Object.keys(LEVEL);
const STATUSES = ['pending', 'approved', 'rejected', 'blocked'];
const MODULES = ['dashboard', 'animals', 'feed', 'weighings', 'growth', 'sell', 'slaughter', 'expenses', 'sales', 'market', 'tasks'];

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: PROD ? [] : null
    }
  }
}));
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
app.use('/api/photos', express.raw({ type: PHOTO_TYPES, limit: '12mb' }));
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  if (!Buffer.isBuffer(req.body) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) req.body = {};
  next();
});
app.use(cookieParser());

// CSRF хамгаалалт: өөрчлөлт хийх хүсэлт заавал JSON (эсвэл зураг) байна — эдгээр нь өөр домэйноос
// CORS preflight-гүйгээр илгээгдэх боломжгүй (SameSite=Lax cookie-тэй хамт)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return next();
  if (req.is('application/json')) return next();
  if (req.path.startsWith('/photos/') && req.is(PHOTO_TYPES)) return next();
  return res.status(415).json({ error: 'Content-Type: application/json шаардлагатай' });
});

// ---------- Session ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?, ?, ?)', [sha(token), userId, Date.now() + SESSION_MS]);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: SESSION_MS, path: '/' });
}
async function clearSessions(userId, exceptToken) {
  if (exceptToken) await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, sha(exceptToken)]);
  else await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}
const cleanup = () => db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]).catch(e => console.error(e.message));

app.use(async (req, res, next) => {
  const t = req.cookies.sid;
  if (t) {
    const row = await db.one(`SELECT u.id, u.phone, u.name, u.email, u.role, u.status, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, [sha(t)]);
    if (row && Number(row.expires_at) > Date.now() && row.status === 'approved') req.user = row;
  }
  next();
});

function guard(req, min) {
  if (!req.user) throw new HttpError(401, 'Нэвтрэх шаардлагатай');
  if (LEVEL[req.user.role] < LEVEL[min]) throw new HttpError(403, 'Танд энэ үйлдлийг хийх эрх байхгүй');
}
const need = min => (req, res, next) => { guard(req, min); next(); };
const pubUser = u => ({ id: u.id, phone: u.phone, name: u.name, email: u.email ?? null, role: u.role, status: u.status });

// ---------- Ферм ба эрх ----------
// Фермийн эзэмшигч болон сайтын админ тухайн фермд бүрэн эрхтэй (canAccessFarm).
// Эзэмшигчийн нэмсэн гишүүд цэс бүрт олгосон эрхийн хүрээнд хандана (farm_members.perms).
const VIEW_ONLY = ['dashboard', 'growth'];
const PERM_LEVEL = { none: 0, view: 1, edit: 2, full: 3 };
const canAccessFarm = (user, farm) => !!user && !!farm && (user.role === 'admin' || farm.owner_id === user.id);
function parsePerms(json) {
  let saved = {};
  try { saved = JSON.parse(json || '{}') || {}; } catch { /* анхдагч */ }
  return Object.fromEntries(MODULES.map(m => [m, PERM_LEVEL[saved[m]] != null ? saved[m] : 'view']));
}
function cleanPerms(input) {
  const out = {};
  for (const m of MODULES) {
    let v = input?.[m] ?? 'view';
    if (PERM_LEVEL[v] == null) throw new HttpError(400, 'Эрхийн утга буруу байна');
    if (VIEW_ONLY.includes(m) && PERM_LEVEL[v] > 1) v = 'view';
    out[m] = v;
  }
  return out;
}
async function loadFarm(req) {
  if (!req.user) throw new HttpError(401, 'Нэвтрэх шаардлагатай');
  const id = Number(req.get('X-Farm-Id') || req.query.farm);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Ферм сонгоогүй байна');
  const farm = await db.one('SELECT * FROM farms WHERE id = ?', [id]);
  if (!farm) throw new HttpError(404, 'Ферм олдсонгүй');
  if (canAccessFarm(req.user, farm)) {
    req.farmRole = farm.owner_id === req.user.id ? 'owner' : 'admin';
  } else {
    const m = await db.one('SELECT perms FROM farm_members WHERE farm_id = ? AND user_id = ?', [id, req.user.id]);
    if (!m) throw new HttpError(403, 'Энэ фермд хандах эрх танд байхгүй');
    req.farmRole = 'member';
    req.memberPerms = parsePerms(m.perms);
  }
  req.farm = farm;
  return farm;
}
// Фермийн доторх хүсэлтүүд — сонгосон фермээр шүүгдэнэ
app.use(['/api/r', '/api/photos', '/api/animals', '/api/slaughters', '/api/meat-stock', '/api/lookups', '/api/dashboard', '/api/settings'], async (req, res, next) => { await loadFarm(req); next(); });
const farmFull = req => req.farmRole === 'owner' || req.farmRole === 'admin';
function permLevel(req, mod) {
  if (!req.farm) return 0;
  if (farmFull(req)) return 3;
  return PERM_LEVEL[req.memberPerms?.[mod]] || 0;
}
// mods: модуль (эсвэл жагсаалт). Модульгүй (тохиргооны хүснэгт): унших — бүх гишүүн, бичих — эзэмшигч/админ
function requirePerm(req, mods, lvl) {
  const list = mods == null ? [] : [].concat(mods);
  const allowed = list.length ? list.some(m => permLevel(req, m) >= lvl) : (lvl <= 1 || farmFull(req));
  if (!allowed) throw new HttpError(403, 'Танд энэ үйлдлийг хийх эрх байхгүй');
}
const farmAudit = (req, action, entity, id, detail) => audit(req.user.id, action, entity, id, detail, req.farm?.id);

const normPhone = p => String(p || '').replace(/\D/g, '').replace(/^976(?=\d{8}$)/, '');
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Нууц үг хамгийн багадаа 8 тэмдэгт байна');
  if (pw.length > 128) throw new HttpError(400, 'Нууц үг хэт урт байна');
}
function checkName(name, what = 'Нэрээ', max = 80) {
  const n = String(name || '').trim();
  if (!n) throw new HttpError(400, `${what} оруулна уу`);
  if (n.length > max) throw new HttpError(400, 'Нэр хэт урт байна');
  return n;
}
function checkEmail(e) {
  const email = String(e || '').trim().toLowerCase();
  if (email.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Имэйл хаягаа зөв оруулна уу');
  return email;
}
function checkPhone(p) {
  const phone = normPhone(p);
  if (!/^\d{8}$/.test(phone)) throw new HttpError(400, 'Утасны дугаар 8 оронтой байна');
  return phone;
}

const authLimiter = rateLimit({
  windowMs: 15 * 60e3, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Хэт олон оролдлого хийлээ. 15 минутын дараа дахин оролдоно уу.' }
});
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

// ---------- Auth ----------
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const name = checkName(req.body.name);
  const phone = checkPhone(req.body.phone);
  const email = checkEmail(req.body.email);
  checkPassword(req.body.password);
  if (await db.one('SELECT 1 x FROM users WHERE phone = ?', [phone])) throw new HttpError(409, 'Энэ утасны дугаар бүртгэлтэй байна');
  if (await db.one('SELECT 1 x FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Энэ имэйл бүртгэлтэй байна');
  const hash = await bcrypt.hash(req.body.password, 12);
  const { insertId } = await db.run('INSERT INTO users(phone, name, email, password_hash) VALUES(?, ?, ?, ?)', [phone, name, email, hash]);
  await audit(insertId, 'Бүртгүүлэв', 'users', insertId, `${name} (${phone})`);
  res.json({ ok: true, message: 'Бүртгэл амжилттай илгээгдлээ. Админ баталгаажуулсны дараа нэвтрэх боломжтой.' });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const phone = normPhone(req.body.phone);
  const pw = String(req.body.password || '');
  const u = await db.one('SELECT * FROM users WHERE phone = ?', [phone]);
  const ok = await bcrypt.compare(pw, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) throw new HttpError(401, 'Утасны дугаар эсвэл нууц үг буруу байна');
  if (u.status === 'pending') throw new HttpError(403, 'Таны бүртгэл админаар баталгаажаагүй байна. Түр хүлээнэ үү.');
  if (u.status === 'rejected') throw new HttpError(403, 'Таны бүртгэлийг админ татгалзсан байна.');
  if (u.status === 'blocked') throw new HttpError(403, 'Таны эрхийг хаасан байна. Админд хандана уу.');
  await createSession(res, u.id);
  await db.run('UPDATE users SET last_login = NOW() WHERE id = ?', [u.id]);
  await audit(u.id, 'Нэвтэрлээ', 'users', u.id);
  res.json({ user: pubUser(u) });
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.cookies.sid) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(req.cookies.sid)]);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? pubUser(req.user) : null }));

// Өөрийн имэйлийг нэмэх / солих
app.post('/api/auth/email', need('viewer'), async (req, res) => {
  const email = checkEmail(req.body.email);
  if (await db.one('SELECT 1 x FROM users WHERE email = ? AND id <> ?', [email, req.user.id])) throw new HttpError(409, 'Энэ имэйл бүртгэлтэй байна');
  await db.run('UPDATE users SET email = ? WHERE id = ?', [email, req.user.id]);
  await audit(req.user.id, 'Имэйлээ солив', 'users', req.user.id);
  res.json({ ok: true, email });
});

app.post('/api/auth/password', need('viewer'), async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash))) throw new HttpError(400, 'Одоогийн нууц үг буруу байна');
  checkPassword(req.body.next);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(req.body.next, 12), u.id]);
  await clearSessions(u.id, req.cookies.sid);
  await audit(u.id, 'Нууц үгээ солив', 'users', u.id);
  res.json({ ok: true });
});

// ---------- Нүүр хуудас (нэвтрээгүй хэрэглэгчид): нийт тоо, мэдээ ----------
// Зөвхөн нийт тоо — хэний ферм, ямар мал гэх мэт хувийн мэдээлэл гаргахгүй
app.get('/api/public/stats', async (req, res) => {
  const one = async sql => (await db.one(sql)).n;
  const bySpecies = await db.q(`SELECT a.species, COUNT(*) n FROM animals a
    WHERE NOT EXISTS (SELECT 1 FROM slaughters s WHERE s.animal_id = a.id AND s.date <= CURDATE()) AND NOT EXISTS (SELECT 1 FROM sales ls WHERE ls.animal_id = a.id AND ls.kind = 'Амьд')
    GROUP BY a.species ORDER BY n DESC`);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    farms: await one('SELECT COUNT(*) n FROM farms'),
    users: await one("SELECT COUNT(*) n FROM users WHERE status = 'approved'"),
    animals: await one('SELECT COUNT(*) n FROM animals'),
    activeAnimals: bySpecies.reduce((s, r) => s + r.n, 0),
    weighings: await one('SELECT COUNT(*) n FROM weighings'),
    tasksDone: await one("SELECT COUNT(*) n FROM tasks WHERE status = 'Хийгдсэн'"),
    bySpecies
  });
});
app.get('/api/public/news', async (req, res) => {
  res.json(await db.q('SELECT id, title, body, created_at FROM news WHERE published = 1 ORDER BY created_at DESC, id DESC LIMIT 12'));
});

// ---------- Admin: мэдээ ----------
function checkNews(body) {
  const title = String(body.title || '').trim();
  const text = String(body.body || '').trim();
  if (!title) throw new HttpError(400, 'Гарчгаа оруулна уу');
  if (title.length > 200) throw new HttpError(400, 'Гарчиг хэт урт байна');
  if (!text) throw new HttpError(400, 'Мэдээний агуулгаа оруулна уу');
  if (text.length > 20000) throw new HttpError(400, 'Мэдээ хэт урт байна');
  return { title, text, published: body.published === false || body.published === 0 || body.published === '0' ? 0 : 1 };
}
app.get('/api/admin/news', need('admin'), async (req, res) => {
  res.json(await db.q(`SELECT n.*, u.name AS author FROM news n LEFT JOIN users u ON u.id = n.created_by ORDER BY n.created_at DESC, n.id DESC`));
});
app.post('/api/admin/news', need('admin'), async (req, res) => {
  const v = checkNews(req.body);
  const { insertId } = await db.run('INSERT INTO news(title, body, published, created_by) VALUES(?, ?, ?, ?)', [v.title, v.text, v.published, req.user.id]);
  await audit(req.user.id, 'Мэдээ нэмэв', 'news', insertId, v.title);
  res.json({ id: insertId });
});
app.put('/api/admin/news/:id', need('admin'), async (req, res) => {
  const v = checkNews(req.body);
  const info = await db.run('UPDATE news SET title = ?, body = ?, published = ?, updated_at = NOW() WHERE id = ?', [v.title, v.text, v.published, Number(req.params.id)]);
  if (!info.changes) throw new HttpError(404, 'Мэдээ олдсонгүй');
  await audit(req.user.id, 'Мэдээ засав', 'news', Number(req.params.id), v.title);
  res.json({ ok: true });
});
app.delete('/api/admin/news/:id', need('admin'), async (req, res) => {
  const info = await db.run('DELETE FROM news WHERE id = ?', [Number(req.params.id)]);
  if (!info.changes) throw new HttpError(404, 'Мэдээ олдсонгүй');
  await audit(req.user.id, 'Мэдээ устгав', 'news', Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Фермүүд ----------
app.get('/api/farms', need('viewer'), async (req, res) => {
  const admin = req.user.role === 'admin';
  const rows = await db.q(`
    SELECT f.*, u.name AS owner_name, u.phone AS owner_phone,
      (SELECT COUNT(*) FROM animals a WHERE a.farm_id = f.id
        AND NOT EXISTS (SELECT 1 FROM slaughters s WHERE s.animal_id = a.id AND s.date <= CURDATE()) AND NOT EXISTS (SELECT 1 FROM sales ls WHERE ls.animal_id = a.id AND ls.kind = 'Амьд')) AS active_animals,
      (SELECT COUNT(*) FROM tasks t WHERE t.farm_id = f.id AND t.status = 'Төлөвлөсөн' AND t.date <= CURDATE()) AS tasks_due
    , (SELECT m.perms FROM farm_members m WHERE m.farm_id = f.id AND m.user_id = ?) AS member_perms
    , EXISTS (SELECT 1 FROM farm_members m WHERE m.farm_id = f.id AND m.user_id = ?) AS is_member
    , (SELECT COUNT(*) FROM farm_members m WHERE m.farm_id = f.id) AS member_count
    FROM farms f JOIN users u ON u.id = f.owner_id
    ${admin ? '' : 'WHERE f.owner_id = ? OR EXISTS (SELECT 1 FROM farm_members m WHERE m.farm_id = f.id AND m.user_id = ?)'}
    ORDER BY (f.owner_id = ?) DESC, f.name`,
  admin ? [req.user.id, req.user.id, req.user.id] : [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
  res.json(rows.map(({ member_perms, ...f }) => ({
    ...f, mine: f.owner_id === req.user.id, shared: !!f.is_member && f.owner_id !== req.user.id,
    can_manage: req.user.role === 'admin' || f.owner_id === req.user.id
  })));
});

// Фермийн байршил: аймаг (жагсаалтаас) ба сум заавал, баг — сонголттой
const AIMAGS = ['Архангай', 'Баян-Өлгий', 'Баянхонгор', 'Булган', 'Говь-Алтай', 'Говьсүмбэр', 'Дархан-Уул', 'Дорноговь', 'Дорнод', 'Дундговь',
  'Завхан', 'Орхон', 'Өвөрхангай', 'Өмнөговь', 'Сүхбаатар', 'Сэлэнгэ', 'Төв', 'Увс', 'Ховд', 'Хөвсгөл', 'Хэнтий', 'Улаанбаатар'];
function checkLocation(body) {
  const t = (v, max) => String(v ?? '').trim().slice(0, max) || null;
  const loc = { aimag: t(body.aimag, 50), soum: t(body.soum, 80), bag: t(body.bag, 80) };
  if (!loc.aimag) throw new HttpError(400, 'Аймаг / хотыг сонгоно уу');
  if (!AIMAGS.includes(loc.aimag)) throw new HttpError(400, 'Аймаг / хот буруу байна');
  if (!loc.soum) throw new HttpError(400, 'Сум / дүүргийг оруулна уу');
  return loc;
}

// Фермийн өнгө: #rrggbb эсвэл хоосон
const checkColor = c => {
  if (c == null || c === '') return null;
  if (!/^#[0-9a-f]{6}$/i.test(String(c))) throw new HttpError(400, 'Фермийн өнгө буруу байна');
  return String(c).toLowerCase();
};
app.post('/api/farms', need('viewer'), async (req, res) => {
  const name = checkName(req.body.name, 'Фермийн нэрийг', 100);
  const color = checkColor(req.body.color);
  const note = req.body.note ? String(req.body.note).trim().slice(0, 500) : null;
  const loc = checkLocation(req.body);
  let copyFrom = null;
  const useTemplate = req.body.copy_from === 'template';
  if (req.body.copy_from && !useTemplate) {
    copyFrom = await db.one('SELECT * FROM farms WHERE id = ?', [Number(req.body.copy_from)]);
    const member = copyFrom && await db.one('SELECT 1 x FROM farm_members WHERE farm_id = ? AND user_id = ?', [copyFrom.id, req.user.id]);
    if (!canAccessFarm(req.user, copyFrom) && !member) throw new HttpError(400, 'Тохиргоо хуулах ферм олдсонгүй');
  }
  const id = await db.tx(async c => {
    const { insertId } = await c.run('INSERT INTO farms(name, note, aimag, soum, bag, color, owner_id) VALUES(?, ?, ?, ?, ?, ?, ?)',
      [name, note, loc.aimag, loc.soum, loc.bag, color, req.user.id]);
    if (copyFrom) await copyFarmSettings(c, copyFrom.id, insertId);
    if (useTemplate) await applyTemplate(c, insertId);
    return insertId;
  });
  await audit(req.user.id, 'Ферм үүсгэв', 'farms', id, name + (copyFrom ? ` (тохиргоог "${copyFrom.name}"-аас хуулсан)` : useTemplate ? ' (загвар тохиргоотой)' : ''), id);
  res.json({ id });
});

async function farmById(req) {
  const farm = await db.one('SELECT * FROM farms WHERE id = ?', [Number(req.params.id)]);
  if (!farm) throw new HttpError(404, 'Ферм олдсонгүй');
  if (!canAccessFarm(req.user, farm)) throw new HttpError(403, 'Энэ фермд хандах эрх танд байхгүй');
  return farm;
}

app.patch('/api/farms/:id', need('viewer'), async (req, res) => {
  const farm = await farmById(req);
  const name = req.body.name !== undefined ? checkName(req.body.name, 'Фермийн нэрийг', 100) : farm.name;
  const note = req.body.note !== undefined ? (String(req.body.note || '').trim().slice(0, 500) || null) : farm.note;
  // Байршлыг илгээсэн үед л шалгаж шинэчилнэ
  const loc = req.body.aimag !== undefined ? checkLocation(req.body) : { aimag: farm.aimag, soum: farm.soum, bag: farm.bag };
  const color = req.body.color !== undefined ? checkColor(req.body.color) : farm.color;
  await db.run('UPDATE farms SET name = ?, note = ?, aimag = ?, soum = ?, bag = ?, color = ? WHERE id = ?', [name, note, loc.aimag, loc.soum, loc.bag, color, farm.id]);
  await audit(req.user.id, 'Ферм засав', 'farms', farm.id, [name, loc.aimag, loc.soum, loc.bag].filter(Boolean).join(' · '), farm.id);
  res.json({ ok: true });
});

app.delete('/api/farms/:id', need('viewer'), async (req, res) => {
  const farm = await farmById(req);
  const photos = await db.q('SELECT filename FROM photos WHERE farm_id = ?', [farm.id]);
  await db.run('DELETE FROM farms WHERE id = ?', [farm.id]); // бүх бүртгэл ON DELETE CASCADE-аар устна
  removePhotoFiles(photos);
  await audit(req.user.id, 'Ферм устгав', 'farms', farm.id, farm.name);
  res.json({ ok: true });
});

// ---------- Фермийн гишүүд (эзэмшигч / админ удирдана) ----------
app.get('/api/farms/:id/members', need('viewer'), async (req, res) => {
  const farm = await farmById(req);
  const rows = await db.q(`SELECT m.user_id, m.perms, m.created_at, u.name, u.phone, u.status
    FROM farm_members m JOIN users u ON u.id = m.user_id WHERE m.farm_id = ? ORDER BY u.name`, [farm.id]);
  res.json(rows.map(r => ({ ...r, perms: parsePerms(r.perms) })));
});
// Утасны дугаараар хэрэглэгч хайх (нэмэхээс өмнө нэр, дугаарыг нь харуулна)
app.get('/api/farms/:id/lookup-user', need('viewer'), async (req, res) => {
  const farm = await farmById(req);
  const phone = checkPhone(req.query.phone);
  const u = await db.one("SELECT id, name, phone FROM users WHERE phone = ? AND status = 'approved'", [phone]);
  if (!u) throw new HttpError(404, 'Энэ дугаартай баталгаажсан хэрэглэгч олдсонгүй');
  if (u.id === farm.owner_id) throw new HttpError(400, 'Энэ бол фермийн эзэмшигч');
  if (await db.one('SELECT 1 x FROM farm_members WHERE farm_id = ? AND user_id = ?', [farm.id, u.id])) {
    throw new HttpError(409, `${u.name} энэ фермд аль хэдийн нэмэгдсэн байна`);
  }
  res.json(u);
});
app.post('/api/farms/:id/members', need('viewer'), async (req, res) => {
  const farm = await farmById(req);
  const phone = checkPhone(req.body.phone);
  const u = await db.one("SELECT id, name, phone FROM users WHERE phone = ? AND status = 'approved'", [phone]);
  if (!u) throw new HttpError(404, 'Энэ дугаартай баталгаажсан хэрэглэгч олдсонгүй');
  if (u.id === farm.owner_id) throw new HttpError(400, 'Фермийн эзэмшигчийг гишүүнээр нэмэх шаардлагагүй');
  const perms = JSON.stringify(cleanPerms(req.body.perms));
  await db.run('INSERT INTO farm_members(farm_id, user_id, perms) VALUES(?, ?, ?)', [farm.id, u.id, perms]);
  await audit(req.user.id, 'Гишүүн нэмэв', 'farm_members', u.id, `${u.name} (${u.phone})`, farm.id);
  res.json({ ok: true, user: { id: u.id, name: u.name, phone: u.phone } });
});
app.patch('/api/farms/:id/members/:userId', need('viewer'), async (req, res) => {
  const farm = await farmById(req);
  const uid = Number(req.params.userId);
  const info = await db.run('UPDATE farm_members SET perms = ? WHERE farm_id = ? AND user_id = ?', [JSON.stringify(cleanPerms(req.body.perms)), farm.id, uid]);
  if (!info.changes) throw new HttpError(404, 'Гишүүн олдсонгүй');
  await audit(req.user.id, 'Гишүүний эрх засав', 'farm_members', uid, null, farm.id);
  res.json({ ok: true });
});
app.delete('/api/farms/:id/members/:userId', need('viewer'), async (req, res) => {
  const farm = await farmById(req);
  const uid = Number(req.params.userId);
  const info = await db.run('DELETE FROM farm_members WHERE farm_id = ? AND user_id = ?', [farm.id, uid]);
  if (!info.changes) throw new HttpError(404, 'Гишүүн олдсонгүй');
  await audit(req.user.id, 'Гишүүн хасав', 'farm_members', uid, null, farm.id);
  res.json({ ok: true });
});

// ---------- Admin: хэрэглэгчид ----------
app.get('/api/admin/users', need('admin'), async (req, res) => {
  res.json(await db.q(`SELECT u.id, u.phone, u.name, u.email, u.role, u.status, u.created_at, u.reviewed_at, u.last_login, r.name AS reviewed_by_name,
      (SELECT COUNT(*) FROM farms f WHERE f.owner_id = u.id) AS farm_count
    FROM users u LEFT JOIN users r ON r.id = u.reviewed_by
    ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.created_at DESC`));
});

app.post('/api/admin/users', need('admin'), async (req, res) => {
  const name = checkName(req.body.name);
  const phone = checkPhone(req.body.phone);
  checkPassword(req.body.password);
  const role = ROLES.includes(req.body.role) ? req.body.role : 'viewer';
  if (await db.one('SELECT 1 x FROM users WHERE phone = ?', [phone])) throw new HttpError(409, 'Энэ утасны дугаар бүртгэлтэй байна');
  const hash = await bcrypt.hash(req.body.password, 12);
  const { insertId } = await db.run("INSERT INTO users(phone, name, password_hash, role, status, reviewed_at, reviewed_by) VALUES(?, ?, ?, ?, 'approved', NOW(), ?)",
    [phone, name, hash, role, req.user.id]);
  await audit(req.user.id, 'Хэрэглэгч нэмэв', 'users', insertId, `${name} (${phone}) · ${role}`);
  res.json({ id: insertId });
});

app.patch('/api/admin/users/:id', need('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw new HttpError(404, 'Хэрэглэгч олдсонгүй');
  const name = req.body.name !== undefined ? checkName(req.body.name) : u.name;
  const role = req.body.role !== undefined ? req.body.role : u.role;
  const status = req.body.status !== undefined ? req.body.status : u.status;
  if (!ROLES.includes(role)) throw new HttpError(400, 'Эрх буруу байна');
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Төлөв буруу байна');
  if (id === req.user.id && (role !== 'admin' || status !== 'approved')) throw new HttpError(400, 'Өөрийн админ эрх, төлөвийг өөрчлөх боломжгүй');
  const reviewed = status !== u.status;
  await db.run(`UPDATE users SET name = ?, role = ?, status = ?${reviewed ? ', reviewed_at = NOW(), reviewed_by = ?' : ''} WHERE id = ?`,
    reviewed ? [name, role, status, req.user.id, id] : [name, role, status, id]);
  if (status !== 'approved') await clearSessions(id);
  const what = [];
  if (status !== u.status) what.push(`төлөв: ${u.status} → ${status}`);
  if (role !== u.role) what.push(`эрх: ${u.role} → ${role}`);
  if (name !== u.name) what.push(`нэр: ${name}`);
  await audit(req.user.id, 'Хэрэглэгч засав', 'users', id, `${u.name} (${u.phone}) ${what.join(', ')}`);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/password', need('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw new HttpError(404, 'Хэрэглэгч олдсонгүй');
  checkPassword(req.body.password);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(req.body.password, 12), id]);
  await clearSessions(id, id === req.user.id ? req.cookies.sid : null);
  await audit(req.user.id, 'Нууц үг шинэчлэв', 'users', id, `${u.name} (${u.phone})`);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', need('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Өөрийгөө устгах боломжгүй');
  const u = await db.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw new HttpError(404, 'Хэрэглэгч олдсонгүй');
  // Хэрэглэгчийг устгавал түүний фермүүд бүх бүртгэлтэйгээ устах тул урьдчилан хамгаална
  const { n: farms } = await db.one('SELECT COUNT(*) n FROM farms WHERE owner_id = ?', [id]);
  if (farms) throw new HttpError(400, `${u.name} ${farms} фермтэй тул устгах боломжгүй. Хэрэглэгчийг "Хаагдсан" төлөвт оруулна уу.`);
  await db.run('DELETE FROM users WHERE id = ?', [id]);
  await audit(req.user.id, 'Хэрэглэгч устгав', 'users', id, `${u.name} (${u.phone})`);
  res.json({ ok: true });
});

app.get('/api/admin/audit', need('admin'), async (req, res) => {
  res.json(await db.q(`SELECT a.*, u.name AS user_name, u.phone AS user_phone, f.name AS farm_name
    FROM audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN farms f ON f.id = a.farm_id
    ORDER BY a.id DESC LIMIT 1000`));
});

// ---------- Фермийн ерөнхий тохиргоо ----------
app.get('/api/settings', async (req, res) => res.json(await getSettings(req.farm.id)));
// Хөрөнгө оруулагч нэмэх: утасны дугаараар бүртгэлтэй (баталгаажсан) хэрэглэгчийн нэрийг харуулна
app.get('/api/settings/lookup-user', async (req, res) => {
  if (!farmFull(req)) throw new HttpError(403, 'Танд энэ үйлдлийг хийх эрх байхгүй');
  const phone = checkPhone(req.query.phone);
  const u = await db.one("SELECT name, phone FROM users WHERE phone = ? AND status = 'approved'", [phone]);
  if (!u) throw new HttpError(404, 'Энэ дугаараар бүртгүүлсэн (баталгаажсан) хэрэглэгч олдсонгүй');
  res.json(u);
});
app.put('/api/settings', async (req, res) => {
  requirePerm(req, null, 3);
  const changed = [];
  const updates = [];
  for (const k of SETTING_KEYS) {
    if (req.body[k] === undefined) continue;
    const v = String(req.body[k] ?? '').trim().slice(0, 200);
    if (['plan_days', 'plan_other_budget', 'plan_head_count'].includes(k) && v !== '' && !(Number(v) >= 0)) {
      throw new HttpError(400, 'Тоон утга буруу байна');
    }
    if (k === 'plan_days' && !(Number(v) > 0)) throw new HttpError(400, 'Хоног 0-ээс их байх ёстой');
    updates.push([k, v]);
    changed.push(`${k}=${v}`);
  }
  await db.tx(async c => { for (const [k, v] of updates) await setSetting(req.farm.id, k, v, c); });
  await farmAudit(req, 'Тохиргоо засав', 'settings', null, changed.join(', '));
  res.json(await getSettings(req.farm.id));
});

// Загвар тохиргоо (Excel) — байгаа тохиргоог дарж бичихгүй, дутууг нь нэмнэ
app.post('/api/settings/template', async (req, res) => {
  requirePerm(req, null, 3);
  const added = await db.tx(c => applyTemplate(c, req.farm.id));
  const total = Object.values(added).reduce((s, n) => s + n, 0);
  await farmAudit(req, 'Загвар тохиргоо оруулав', 'settings', null, JSON.stringify(added));
  res.json({ ok: true, added, total });
});

// ---------- Сонголтын жагсаалтууд ----------
app.get('/api/lookups', async (req, res) => {
  const fid = req.farm.id;
  const activeBySpecies = Object.fromEntries(SPECIES.map(s => [s, 0]));
  for (const r of await db.q(`SELECT a.species, COUNT(*) n FROM animals a WHERE a.farm_id = ?
    AND NOT EXISTS (SELECT 1 FROM slaughters s WHERE s.animal_id = a.id AND s.date <= CURDATE()) AND NOT EXISTS (SELECT 1 FROM sales ls WHERE ls.animal_id = a.id AND ls.kind = 'Амьд') GROUP BY a.species`, [fid])) activeBySpecies[r.species] = r.n;
  const col = async (sql, params) => (await db.q(sql, params)).map(r => r.v);
  const owner = await db.one('SELECT name FROM users WHERE id = ?', [req.farm.owner_id]);
  res.json({
    farm: { id: req.farm.id, name: req.farm.name, color: req.farm.color, note: req.farm.note, aimag: req.farm.aimag, soum: req.farm.soum, bag: req.farm.bag, owner_name: owner?.name, mine: req.farm.owner_id === req.user.id, role: req.farmRole, full: farmFull(req) },
    species: SPECIES,
    sexes: SEXES,
    classes: await db.q('SELECT species, age_name, age, sex, target_weight FROM animal_classes WHERE farm_id = ? ORDER BY id', [fid]),
    // Гараар бичих талбаруудад санал болгох утгууд (зөвхөн тухайн фермийнх)
    suggest: {
      expenseType: [...new Set([FEED_TYPE, ...await col('SELECT name AS v FROM expense_types WHERE farm_id = ? UNION SELECT DISTINCT type FROM expenses WHERE farm_id = ? ORDER BY 1', [fid, fid])])],
      // Зардлын "Тэжээл" төрлийн дэд төрөл (Тохиргоо → Тэжээл)
      feeds: await db.q('SELECT name, price, bale_kg FROM feeds WHERE farm_id = ? ORDER BY id', [fid]),
      ageName: await col('SELECT age_name AS v FROM animal_classes WHERE farm_id = ? UNION SELECT DISTINCT age_name FROM animals WHERE farm_id = ? AND age_name IS NOT NULL ORDER BY 1', [fid, fid]),
      age: await col('SELECT age AS v FROM animal_classes WHERE farm_id = ? UNION SELECT DISTINCT age FROM animals WHERE farm_id = ? AND age IS NOT NULL ORDER BY 1', [fid, fid]),
      tagColor: await col('SELECT name AS v FROM tag_colors WHERE farm_id = ? ORDER BY id', [fid]),
      taskType: await col('SELECT name AS v FROM task_types WHERE farm_id = ? ORDER BY id', [fid]),
      taskTypes: await db.q('SELECT name, needs_animals FROM task_types WHERE farm_id = ? ORDER BY id', [fid]),
      // Хариуцагч: фермийн эзэмшигч + өмнө бичсэн нэрс (бусад хэрэглэгчийн нэрийг ил гаргахгүй)
      assignee: [...new Set([owner?.name, ...await col('SELECT DISTINCT assignee AS v FROM tasks WHERE farm_id = ? AND assignee IS NOT NULL ORDER BY 1', [fid])].filter(Boolean))],
      supplier: await col('SELECT DISTINCT supplier AS v FROM expenses WHERE farm_id = ? AND supplier IS NOT NULL ORDER BY 1', [fid]),
      feedName: await col('SELECT name AS v FROM feeds WHERE farm_id = ? UNION SELECT DISTINCT feed_name FROM feed_plan WHERE farm_id = ? ORDER BY 1', [fid, fid])
    },
    animals: await db.q(`SELECT a.id, a.tag_id, a.tag_color, a.species, a.age_name, a.sex,
      (EXISTS (SELECT 1 FROM slaughters s WHERE s.animal_id = a.id AND s.date <= CURDATE()) OR EXISTS (SELECT 1 FROM sales ls WHERE ls.animal_id = a.id AND ls.kind = 'Амьд')) AS slaughtered
      FROM animals a WHERE a.farm_id = ? ORDER BY a.tag_id`, [fid]),
    tasksDue: (await db.one("SELECT COUNT(*) n FROM tasks WHERE farm_id = ? AND status = 'Төлөвлөсөн' AND date <= CURDATE()", [fid])).n,
    shipDates: await col('SELECT DISTINCT shipped_date AS v FROM slaughters WHERE farm_id = ? AND shipped_date IS NOT NULL ORDER BY v DESC', [fid]),
    activeBySpecies,
    settings: await getSettings(fid),
    perms: Object.fromEntries(MODULES.map(m => [m, permLevel(req, m)])),
    pendingUsers: req.user.role === 'admin' ? (await db.one("SELECT COUNT(*) n FROM users WHERE status = 'pending'")).n : 0
  });
});

// ---------- Хянах самбар (Тооцоолол) ----------
app.get('/api/dashboard', async (req, res) => {
  requirePerm(req, 'dashboard', 1);
  const fid = req.farm.id;
  // Зардал = гараар бүртгэсэн + худалдаж авсан малын үнэ ("Мал авсан")
  const animalExp = await animalPurchaseExpenses(db, fid);
  const { t: ownExpense } = await db.one('SELECT COALESCE(SUM(COALESCE(qty,0) * COALESCE(unit_price,0)), 0) t FROM expenses WHERE farm_id = ?', [fid]);
  const expenseTotal = ownExpense + animalExp.reduce((s, r) => s + r.total, 0);
  const byType = await db.q(`SELECT type, COUNT(*) n, SUM(COALESCE(qty,0) * COALESCE(unit_price,0)) total
    FROM expenses WHERE farm_id = ? GROUP BY type`, [fid]);
  for (const r of animalExp) {
    const t = byType.find(x => x.type === r.type) || (byType.push({ type: r.type, n: 0, total: 0 }), byType[byType.length - 1]);
    t.n += 1; t.total += r.total;
  }
  byType.sort((a, b) => b.total - a.total);
  // Борлуулалт: борлуулсан жин оруулаагүй бол ачигдсан жингээр (sales.list-ийн тооцоо)
  const saleRows = (await resources.sales.list(db, fid)).filter(r => !r.auto);
  const sales = {
    t: saleRows.reduce((s, r) => s + (r.revenue || 0), 0),
    kg: saleRows.reduce((s, r) => s + (r.price != null ? (r.sold_weight ?? r.shipped_weight) : (r.sold_weight || 0)), 0)
  };
  const profit = sales.t - expenseTotal;
  const partners = (await db.q('SELECT * FROM partners WHERE farm_id = ? ORDER BY id', [fid])).map(p => ({ ...p, amount: profit * p.percent / 100 }));
  const animals = await resources.animals.list(db, fid);
  const stats = { total: animals.length, active: 0, slaughtered: 0, sold: 0, ready: 0, costTotal: 0 };
  const bySpecies = {};
  for (const a of animals) {
    stats.costTotal += a.total_cost;
    if (a.state === 'Идэвхтэй' || a.state === 'Бой товлогдсон') {
      stats.active++;
      bySpecies[a.species] = (bySpecies[a.species] || 0) + 1;
      if (a.target_status === 'Борлуулах') stats.ready++;
    } else if (a.state === 'Бойлсон') stats.slaughtered++;
    else stats.sold++;
  }
  const ready = animals.filter(a => (a.state === 'Идэвхтэй' || a.state === 'Бой товлогдсон') && a.target_status === 'Борлуулах')
    .map(a => ({ id: a.id, tag_id: a.tag_id, species: a.species, age_name: a.current_age_name, last_weight: a.last_weight, target_weight: a.target_weight }));
  const recentWeighings = await db.q(`SELECT w.date, w.weight, a.tag_id FROM weighings w JOIN animals a ON a.id = w.animal_id
    WHERE w.farm_id = ? ORDER BY w.date DESC, w.id DESC LIMIT 8`, [fid]);
  const upcomingTasks = await db.q(`SELECT * FROM tasks WHERE farm_id = ? AND status = 'Төлөвлөсөн' AND date <= CURDATE() + INTERVAL 7 DAY
    ORDER BY date, id LIMIT 15`, [fid]);

  // --- Сүргийн үзүүлэлт (идэвхтэй мал) ---
  const today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  const todayIso = today.toISOString().slice(0, 10);
  const daysSince = iso => Math.round((Date.parse(todayIso) - Date.parse(iso)) / 864e5);
  const active = animals.filter(a => a.state === 'Идэвхтэй' || a.state === 'Бой товлогдсон');
  const adgs = active.map(a => a.adg).filter(v => v != null && v > 0);
  const herd = {
    liveWeight: active.reduce((s, a) => s + (a.last_weight ?? a.initial_weight ?? 0), 0),
    avgAdg: adgs.length ? adgs.reduce((s, v) => s + v, 0) / adgs.length : null,
    // Малын хөрөнгө: худалдаж авсан үнэ, бэлгийн зах зээлийн үнэ
    assetValue: active.reduce((s, a) => s + (a.purchase_price ?? 0) + (a.market_value ?? 0), 0),
    bySource: active.reduce((m, a) => { m[a.source || 'Худалдаж авсан'] = (m[a.source || 'Худалдаж авсан'] || 0) + 1; return m; }, {})
  };

  // --- Анхаарах зүйлс ---
  const pick = a => ({ id: a.id, tag_id: a.tag_id, species: a.species, age_name: a.current_age_name });
  const needWeigh = active.filter(a => !a.last_weigh_date || daysSince(a.last_weigh_date) > 30)
    .map(a => ({ ...pick(a), last: a.last_weigh_date, days: a.last_weigh_date ? daysSince(a.last_weigh_date) : null }));
  const behind = active.filter(a => a.goal_adg != null && a.adg != null && a.target_status !== 'Борлуулах' && a.adg < a.goal_adg)
    .map(a => ({ ...pick(a), adg: a.adg, goal_adg: a.goal_adg }));
  const slaughterSoon = animals.filter(a => a.slaughter_date && a.slaughter_date >= todayIso && daysSince(a.slaughter_date) >= -14)
    .map(a => ({ ...pick(a), date: a.slaughter_date })).sort((x, y) => x.date.localeCompare(y.date));
  const noCarcass = animals.filter(a => a.slaughter_date && a.slaughter_date < todayIso && a.carcass_weight == null).map(pick);
  const { n: tasksOverdue } = await db.one("SELECT COUNT(*) n FROM tasks WHERE farm_id = ? AND status = 'Төлөвлөсөн' AND date < CURDATE()", [fid]);

  // --- Сар бүрийн орлого, зарлага (сүүлийн 12 сар) ---
  const months = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(today.getFullYear(), today.getMonth() - i, 1); months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
  const expM = await db.q(`SELECT DATE_FORMAT(date, '%Y-%m') m, SUM(COALESCE(qty,0) * COALESCE(unit_price,0)) v FROM expenses
    WHERE farm_id = ? AND date >= ? GROUP BY m`, [fid, months[0] + '-01']);
  const revM = [];
  for (const r of saleRows) {
    const m = (r.sold_date || r.shipped_date).slice(0, 7);
    const x = revM.find(y => y.m === m) || (revM.push({ m, v: 0 }), revM[revM.length - 1]);
    x.v += r.revenue || 0;
  }
  const animalM = {};
  for (const r of animalExp) { const m = r.date.slice(0, 7); animalM[m] = (animalM[m] || 0) + r.total; }
  const monthly = months.map(m => ({ month: m, expense: (expM.find(r => r.m === m)?.v || 0) + (animalM[m] || 0), revenue: revM.find(r => r.m === m)?.v || 0 }));

  res.json({
    expenseTotal, byType, salesTotal: sales.t, salesKg: sales.kg, profit, partners, stats, bySpecies, ready, recentWeighings, upcomingTasks,
    herd, monthly, attention: { needWeigh, behind, slaughterSoon, noCarcass, tasksOverdue }
  });
});

// ---------- Ерөнхий CRUD (сонгосон ферм дотор) ----------
function getRes(name, write) {
  const r = Object.hasOwn(resources, name) ? resources[name] : null;
  if (!r || (write && r.readonly)) throw new HttpError(404, 'Олдсонгүй');
  return r;
}
const idParam = req => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID буруу');
  return id;
};
const describe = (r, v) => {
  const d = r.describe ? r.describe(v) : null;
  return d == null || d === '' ? r.title : `${r.title}: ${d}`;
};
const listRows = (r, fid) => (r.list ? r.list(db, fid) : db.q(`SELECT * FROM ${r.table} WHERE farm_id = ? ORDER BY id`, [fid]));

app.get('/api/r/:res', async (req, res) => {
  const r = getRes(req.params.res);
  requirePerm(req, r.readers, 1);
  let rows = await listRows(r, req.farm.id);
  if (r.photos) {
    const ph = new Map((await db.q('SELECT entity_id, COUNT(*) n, MIN(id) first FROM photos WHERE farm_id = ? AND entity = ? AND kind IS NULL GROUP BY entity_id',
      [req.farm.id, r.table])).map(p => [p.entity_id, p]));
    rows = rows.map(row => ({ ...row, photo_count: ph.get(row.id)?.n || 0, photo_first: ph.get(row.id)?.first || null }));
    // Малын бүртгэлээс орсон "Мал авсан" зардалд тухайн малын зургийг харуулна
    if (rows.some(row => row.auto === 'animal')) {
      const ap = new Map((await db.q("SELECT entity_id, COUNT(*) n, MIN(id) first FROM photos WHERE farm_id = ? AND entity = 'animals' AND kind IS NULL GROUP BY entity_id",
        [req.farm.id])).map(p => [p.entity_id, p]));
      rows = rows.map(row => (row.auto === 'animal'
        ? { ...row, photo_res: 'animals', photo_id: row.animal_id, photo_count: ap.get(row.animal_id)?.n || 0, photo_first: ap.get(row.animal_id)?.first || null }
        : row));
    }
  }
  res.json(rows);
});

app.post('/api/r/:res', async (req, res) => {
  const r = getRes(req.params.res, true);
  requirePerm(req, r.createModules?.(req.body) || r.module, r.settings ? 3 : 2);
  const v = validate(r.fields, req.body || {});
  const desc = describe(r, v);
  if (r.prepare) await r.prepare(v, db, req.farm.id);
  v.farm_id = req.farm.id;
  if (r.track) v.created_by = req.user.id;
  const list = r.expand ? r.expand(v, req.body || {}) : [v];
  const keys = Object.keys(v);
  const sql = `INSERT INTO ${r.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const ids = await db.tx(async c => {
    const out = [];
    for (const row of list) out.push((await c.run(sql, keys.map(k => row[k]))).insertId);
    return out;
  });
  await farmAudit(req, 'Нэмэв', r.table, ids[0], desc + (ids.length > 1 ? ` (${ids.length} удаа)` : ''));
  res.json({ id: ids[0], ids });
});

app.put('/api/r/:res/:id', async (req, res) => {
  const r = getRes(req.params.res, true);
  requirePerm(req, r.module, r.settings ? 3 : 2);
  const id = idParam(req);
  const v = validate(r.fields, req.body || {});
  const desc = describe(r, v);
  if (r.prepare) await r.prepare(v, db, req.farm.id, id);
  const keys = Object.keys(v);
  const info = await db.run(`UPDATE ${r.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND farm_id = ?`,
    [...keys.map(k => v[k]), id, req.farm.id]);
  if (!info.changes) throw new HttpError(404, 'Бичлэг олдсонгүй');
  await farmAudit(req, 'Засав', r.table, id, desc);
  res.json({ ok: true });
});

function removePhotoFiles(rows) {
  for (const p of rows) fs.rm(path.join(UPLOAD_DIR, p.filename), { force: true }, () => {});
}

app.delete('/api/r/:res/:id', async (req, res) => {
  const r = getRes(req.params.res, true);
  requirePerm(req, r.module, 3);
  const id = idParam(req);
  const fid = req.farm.id;
  const old = (await listRows(r, fid)).find(x => x.id === id);
  if (!old) throw new HttpError(404, 'Бичлэг олдсонгүй');
  if (r.beforeDelete) await r.beforeDelete(old, db, fid);
  // Холбоотой зургуудыг (малыг устгавал түүний жинлэлт, бойн зургийг ч) хамт устгана
  const linked = [[r.table, [id]]];
  if (r.table === 'animals') {
    linked.push(['weighings', (await db.q('SELECT id FROM weighings WHERE animal_id = ?', [id])).map(x => x.id)]);
    linked.push(['slaughters', (await db.q('SELECT id FROM slaughters WHERE animal_id = ?', [id])).map(x => x.id)]);
    linked.push(['sales', (await db.q("SELECT id FROM sales WHERE animal_id = ? AND kind = 'Амьд'", [id])).map(x => x.id)]);
  }
  const photos = await db.tx(async c => {
    const out = [];
    for (const [entity, ids] of linked) for (const eid of ids) {
      out.push(...await c.q('SELECT filename FROM photos WHERE farm_id = ? AND entity = ? AND entity_id = ?', [fid, entity, eid]));
      await c.run('DELETE FROM photos WHERE farm_id = ? AND entity = ? AND entity_id = ?', [fid, entity, eid]);
    }
    // Амьдаар зарсан борлуулалт малтайгаа хамт устна
    if (r.table === 'animals') await c.run("DELETE FROM sales WHERE animal_id = ? AND kind = 'Амьд' AND farm_id = ?", [id, fid]);
    await c.run(`DELETE FROM ${r.table} WHERE id = ? AND farm_id = ?`, [id, fid]);
    return out;
  });
  removePhotoFiles(photos);
  await farmAudit(req, 'Устгав', r.table, id, describe(r, old));
  res.json({ ok: true });
});

// ---------- Малыг "Зарах малын жагсаалт" руу гараар шилжүүлэх / хасах ----------
app.post('/api/animals/:id/to-sell', async (req, res) => {
  requirePerm(req, 'sell', 2);
  const id = idParam(req);
  const a = await db.one('SELECT id, tag_id FROM animals WHERE id = ? AND farm_id = ?', [id, req.farm.id]);
  if (!a) throw new HttpError(404, 'Мал олдсонгүй');
  const on = req.body.value !== false;
  // Буцаах: бойнд орж гулууз нь бүртгэгдсэн бол болохгүй; зөвхөн товлосон бол хуваарийг хамт цуцална
  const s = on ? null : await db.one('SELECT id, carcass_weight FROM slaughters WHERE animal_id = ?', [id]);
  if (s && s.carcass_weight != null) {
    throw new HttpError(400, `${a.tag_id}: бойнд орж гулуузны жин нь бүртгэгдсэн тул буцаах боломжгүй`);
  }
  if (s) requirePerm(req, 'sell', 3);
  const photos = await db.tx(async c => {
    let out = [];
    if (s) {
      out = await c.q('SELECT filename FROM photos WHERE farm_id = ? AND entity = ? AND entity_id = ?', [req.farm.id, 'slaughters', s.id]);
      await c.run('DELETE FROM photos WHERE farm_id = ? AND entity = ? AND entity_id = ?', [req.farm.id, 'slaughters', s.id]);
      await c.run('DELETE FROM slaughters WHERE id = ?', [s.id]);
    }
    await c.run('UPDATE animals SET to_sell = ? WHERE id = ?', [on ? 1 : 0, id]);
    return out;
  });
  removePhotoFiles(photos);
  await farmAudit(req, on ? 'Зарах мал руу шилжүүлэв' : 'Зарах малаас буцаав', 'animals', id, a.tag_id + (s ? ' (бойн хуваарь цуцлагдсан)' : ''));
  res.json({ ok: true, scheduleCancelled: !!s });
});

// ---------- Махны үлдэгдэл: бойноос гарсан нийт мах − махлаж зарсан ----------
app.get('/api/meat-stock', async (req, res) => {
  requirePerm(req, 'sales', 1);
  res.json(await meatStock(db, req.farm.id, Number(req.query.except) || 0));
});

// ---------- Мах ачилт: бойлсон гулуузны ачилтын огноог (олноор нь) бүртгэх / цуцлах ----------
app.post('/api/slaughters/ship', async (req, res) => {
  requirePerm(req, ['sell', 'slaughter'], 2);
  const fid = req.farm.id;
  const ids = [...new Set([].concat(req.body.ids || []).map(Number))].filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new HttpError(400, 'Гулууз сонгоно уу');
  if (ids.length > 500) throw new HttpError(400, 'Хэт олон гулууз');
  const date = req.body.shipped_date == null || req.body.shipped_date === '' ? null : validate({ d: { t: 'date', req: true, label: 'Ачилтын огноо' } }, { d: req.body.shipped_date }).d;
  const rows = await db.q(`SELECT s.id, s.date, s.shipped_date, a.tag_id FROM slaughters s JOIN animals a ON a.id = s.animal_id
    WHERE s.farm_id = ? AND s.id IN (${ids.map(() => '?').join(',')})`, [fid, ...ids]);
  if (rows.length !== ids.length) throw new HttpError(404, 'Гулууз олдсонгүй');
  const today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  const todayIso = today.toISOString().slice(0, 10);
  for (const s of rows) {
    if (s.date > todayIso) throw new HttpError(400, `${s.tag_id}: бойлох өдөр (${s.date}) болоогүй байна`);
    if (date && date < s.date) throw new HttpError(400, `${s.tag_id}: ачилтын огноо (${date}) бойлох өдрөөс (${s.date}) өмнө байж болохгүй`);
    // Зарагдсан ачилтаас гулуузыг гаргаж/шилжүүлж болохгүй
    if (s.shipped_date && s.shipped_date !== date
      && await db.one("SELECT 1 x FROM sales WHERE farm_id = ? AND kind = 'Мах' AND shipped_date = ? AND sold_date IS NOT NULL", [fid, s.shipped_date])) {
      throw new HttpError(400, `${s.tag_id}: ${s.shipped_date}-ний ачилт зарагдсан тул өөрчлөх боломжгүй`);
    }
  }
  await db.run(`UPDATE slaughters SET shipped_date = ? WHERE farm_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [date, fid, ...ids]);
  await farmAudit(req, date ? 'Мах ачилт бүртгэв' : 'Мах ачилт цуцлав', 'slaughters', ids[0],
    `${date || ''} ${rows.map(r => r.tag_id).join(', ')}`.trim());
  res.json({ ok: true, count: ids.length });
});

// ---------- Зураг ----------
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ['image/jpeg', '.jpg'];
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', '.png'];
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return ['image/webp', '.webp'];
  return null;
}
async function photoTarget(req) {
  const r = getRes(req.params.res);
  if (!r.photos) throw new HttpError(404, 'Олдсонгүй');
  const id = idParam(req);
  if (!(await db.one(`SELECT 1 x FROM ${r.table} WHERE id = ? AND farm_id = ?`, [id, req.farm.id]))) throw new HttpError(404, 'Бичлэг олдсонгүй');
  return { r, id };
}

// ?kind=tag — ээмгийн зураг; өгөөгүй бол үндсэн зураг
const photoKind = req => (req.query.kind === 'tag' ? 'tag' : null);
app.get('/api/photos/:res/:id', async (req, res) => {
  const { r, id } = await photoTarget(req);
  requirePerm(req, r.readers, 1);
  res.json(await db.q(`SELECT p.id, p.size, p.created_at, p.created_by, u.name AS created_by_name
    FROM photos p LEFT JOIN users u ON u.id = p.created_by WHERE p.farm_id = ? AND p.entity = ? AND p.entity_id = ? AND p.kind <=> ? ORDER BY p.id`,
  [req.farm.id, r.table, id, photoKind(req)]));
});

app.post('/api/photos/:res/:id', async (req, res) => {
  const { r, id } = await photoTarget(req);
  requirePerm(req, r.module, 2);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'Зураг хоосон байна');
  const kind = sniffImage(buf);
  if (!kind) throw new HttpError(415, 'Зөвхөн JPG, PNG, WEBP зураг оруулна');
  const { n } = await db.one('SELECT COUNT(*) n FROM photos WHERE farm_id = ? AND entity = ? AND entity_id = ?', [req.farm.id, r.table, id]);
  if (n >= 30) throw new HttpError(400, 'Нэг бүртгэлд хамгийн ихдээ 30 зураг');
  const filename = crypto.randomBytes(16).toString('hex') + kind[1];
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  const { insertId } = await db.run('INSERT INTO photos(farm_id, entity, entity_id, filename, mime, size, created_by, kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    [req.farm.id, r.table, id, filename, kind[0], buf.length, req.user.id, photoKind(req)]);
  await farmAudit(req, 'Зураг нэмэв', r.table, id, r.title);
  res.json({ id: insertId });
});

// <img src>-ээр дуудагддаг тул толгой (X-Farm-Id) дамжихгүй — зургийн фермээр эрхийг шалгана
async function photoById(req) {
  const p = await db.one(`SELECT p.*, f.owner_id, m.perms AS member_perms, (m.user_id IS NOT NULL) AS is_member
    FROM photos p JOIN farms f ON f.id = p.farm_id
    LEFT JOIN farm_members m ON m.farm_id = p.farm_id AND m.user_id = ? WHERE p.id = ?`, [req.user.id, idParam(req)]);
  if (!p) throw new HttpError(404, 'Зураг олдсонгүй');
  const full = canAccessFarm(req.user, { owner_id: p.owner_id });
  if (!full && !p.is_member) throw new HttpError(404, 'Зураг олдсонгүй');
  const mod = [].concat(Object.values(resources).find(x => x.table === p.entity)?.module || []);
  const perms = parsePerms(p.member_perms);
  p.level = full ? 3 : Math.max(0, ...mod.map(m => PERM_LEVEL[perms[m]] || 0));
  if (p.level < 1) throw new HttpError(404, 'Зураг олдсонгүй');
  return p;
}
app.get('/api/photo/:id', need('viewer'), async (req, res) => {
  const p = await photoById(req);
  const file = path.join(UPLOAD_DIR, p.filename);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Зургийн файл олдсонгүй');
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(p.mime);
  res.sendFile(file);
});

app.delete('/api/photo/:id', need('viewer'), async (req, res) => {
  const p = await photoById(req);
  if (!(p.level >= 3 || (p.level >= 2 && p.created_by === req.user.id))) throw new HttpError(403, 'Танд энэ зургийг устгах эрх байхгүй');
  await db.run('DELETE FROM photos WHERE id = ?', [p.id]);
  removePhotoFiles([p]);
  await audit(req.user.id, 'Зураг устгав', p.entity, p.entity_id, null, p.farm_id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Олдсонгүй' }));

// ---------- Static ----------
// index.html-д app.js / style.css-ийн өөрчлөгдсөн цагийг (?v=) залгаж, хөтөч хуучин хувилбарыг ачаалахаас сэргийлнэ
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.get(['/', '/index.html'], (req, res) => {
  const ver = f => Math.floor(fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs).toString(36);
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('/style.css"', `/style.css?v=${ver('style.css')}"`)
    .replace('/app.js"', `/app.js?v=${ver('app.js')}"`);
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: PROD ? '30d' : 0 }));

// ---------- Алдаа ----------
app.use((err, req, res, next) => {
  const mapped = mapDbError(err);
  if (mapped) err = mapped;
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Хүсэлт буруу байна' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Хүсэлт хэт том байна' });
  console.error(err);
  res.status(500).json({ error: 'Серверийн алдаа гарлаа' });
});

// ---------- Эхлүүлэх ----------
(async () => {
  await init();
  await ensureAdmin();
  await cleanup();
  setInterval(cleanup, 3600e3).unref();
  // Оношлогоо: мэдээллийн санд бүртгэлтэй боловч файл нь дискэнд алга болсон зураг
  const photoRows = await db.q('SELECT filename FROM photos');
  const missing = photoRows.filter(p => !fs.existsSync(path.join(UPLOAD_DIR, p.filename))).length;
  console.log(`Зураг: ${photoRows.length} бүртгэл, ${missing} файл олдсонгүй`);
  app.listen(PORT, () => console.log(`Livestock Farming: http://localhost:${PORT} (MySQL)`));
})().catch(e => {
  console.error('Сервер эхэлж чадсангүй:', e.code || '', e.message);
  process.exit(1);
});

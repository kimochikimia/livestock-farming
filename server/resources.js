'use strict';
// Өгөгдлийн хүснэгт бүрийн талбар, эрх, тооцооллын тодорхойлолт.
// Бүх хүснэгт фермээр (farm_id) тусгаарлагдана: async list(db, farmId), async prepare(v, db, farmId).

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SPECIES = ['Үхэр', 'Хонь', 'Ямаа', 'Адуу', 'Тэмээ'];
const SEXES = ['Эр', 'Эм', 'Зассан эр'];
const TASK_STATUSES = ['Төлөвлөсөн', 'Хийгдсэн', 'Цуцалсан'];
const SOURCES = ['Худалдаж авсан', 'Төл', 'Бэлэг']; // Малын орлогын төрөл
const SALE_KINDS = ['Мах', 'Амьд']; // Борлуулалт: махлаж (ачилтаар) / амьдаар
const PAYOUT_PERIODS = ['Сар бүр', 'Улирал бүр', 'Хагас жил бүр', 'Жил бүр', 'Борлуулалт бүрийн дараа', 'Гэрээний төгсгөлд'];
// Тэжээлийн жорын багана ↔ тэжээлийн нэр
const RECIPE_FEEDS = {
  hay: 'Өвс (хадлан)', alfalfa: 'Царгас', straw: 'Сүрэл', bran: 'Хивэг',
  barley: 'Арвай', oats: 'Овъёос', green: 'Ногоон тэжээл', mineral: 'Эрдэс нэмэлт'
};

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function coerce(f, v) {
  const label = f.label;
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (f.req) throw new HttpError(400, `"${label}" талбарыг бөглөнө үү`);
    return null;
  }
  switch (f.t) {
    case 'text': {
      const s = String(v).trim();
      if (s.length > (f.max || 500)) throw new HttpError(400, `"${label}" хэт урт байна`);
      if (f.options && !f.options.includes(s)) throw new HttpError(400, `"${label}" утга буруу байна`);
      return s;
    }
    case 'date': {
      const s = String(v).trim();
      if (!isValidDate(s)) throw new HttpError(400, `"${label}" огноо буруу байна`);
      return s;
    }
    case 'num': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new HttpError(400, `"${label}" тоо байх ёстой`);
      if (n < (f.min ?? 0)) throw new HttpError(400, `"${label}" ${f.min ?? 0}-оос бага байж болохгүй`);
      if (f.max != null && n > f.max) throw new HttpError(400, `"${label}" ${f.max}-аас их байж болохгүй`);
      return n;
    }
    case 'int': {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new HttpError(400, `"${label}" бүхэл тоо байх ёстой`);
      if (f.min != null && n < f.min) throw new HttpError(400, `"${label}" ${f.min}-оос бага байж болохгүй`);
      if (f.max != null && n > f.max) throw new HttpError(400, `"${label}" ${f.max}-аас их байж болохгүй`);
      return n;
    }
    default: throw new Error('Unknown field type ' + f.t);
  }
}

function validate(fields, body) {
  const out = {};
  for (const [k, f] of Object.entries(fields)) out[k] = coerce(f, body[k]);
  return out;
}

const n0 = v => (v == null ? 0 : Number(v));
const addDaysStr = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

// ---------- Нас автоматаар ахих (А хувилбар: төллөх улирлаар) ----------
// Мал бүр төрлийнхөө төллөх улирал эхлэхэд (Тохиргоо → Төллөлт → "Төллөх сар"-ын эхний сар, байхгүй бол 3-р сар)
// нэг нас ахина. Нас = төрсөн улирлаас хойш эхэлсэн төллөх улирлын тоо (төрсөн жилдээ 1 настай — Тугал = 1).
// Төрсөн улирлыг "авсан өдөр" + "авах үеийн нас"-аар тооцно.
const pad2 = n => String(n).padStart(2, '0');
async function ageContext(db, farmId) {
  const breeding = await db.q('SELECT species, birthing_months FROM breeding WHERE farm_id = ? ORDER BY id', [farmId]);
  const classes = await db.q('SELECT species, age_name, age, sex, target_weight FROM animal_classes WHERE farm_id = ? ORDER BY id', [farmId]);
  const birthMonth = {};
  for (const b of breeding) {
    const m = Number(String(b.birthing_months || '').match(/\d+/)?.[0]);
    if (!(b.species in birthMonth) && m >= 1 && m <= 12) birthMonth[b.species] = m;
  }
  return { classes, birthMonth };
}
// Тухайн огноо аль "улирлын онд" хамаарах вэ (төллөх сараас өмнө бол өмнөх он)
const seasonYear = (iso, bm) => { const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)); return m >= bm ? y : y - 1; };
function currentAge(a, ctx) {
  const bm = ctx.birthMonth[a.species] || 3;
  const ageAtPurchase = parseInt(a.age, 10);
  if (!Number.isFinite(ageAtPurchase) || !a.purchase_date) return { age: null, name: a.age_name, cls: null, next: null };
  // Бойлсон/зарагдсан малын нас тэр өдрөөр зогсоно
  const end = a.live_sold_date || a.slaughter_date;
  const ref = end && end <= todayStr() ? end : todayStr();
  const born = seasonYear(a.purchase_date, bm) - ageAtPurchase + 1;
  const age = Math.max(ageAtPurchase, seasonYear(ref, bm) - born + 1);
  // Ангилал: ижил төрөл (+ хүйс) ба яг тэр нас, эсвэл "N+" ангиллын хамгийн их тохирох нь
  const cand = ctx.classes.filter(c => c.species === a.species && (!a.sex || c.sex === a.sex));
  const exact = cand.find(c => !String(c.age).includes('+') && Number(c.age) === age);
  const plus = cand.filter(c => String(c.age).includes('+') && age >= parseInt(c.age, 10))
    .sort((x, y) => parseInt(y.age, 10) - parseInt(x.age, 10))[0];
  const cls = exact || plus || null;
  const next = ref === todayStr() ? `${seasonYear(ref, bm) + 1}-${pad2(bm)}-01` : null;
  return { age, name: cls?.age_name ?? a.age_name, cls, next };
}

// Жинлэлт, бойн жагсаалтад малын ОДООГИЙН насны нэршлийг тавина (animal_id-аар)
async function withCurrentAgeName(db, farmId, rows) {
  if (!rows.length) return rows;
  const ctx = await ageContext(db, farmId);
  const animals = new Map((await db.q(`SELECT a.id, a.species, a.age, a.age_name, a.sex, a.purchase_date, s.date AS slaughter_date
    FROM animals a LEFT JOIN slaughters s ON s.animal_id = a.id WHERE a.farm_id = ?`, [farmId])).map(a => [a.id, a]));
  return rows.map(r => {
    const a = animals.get(r.animal_id);
    return a ? { ...r, age_name: currentAge(a, ctx).name } : r;
  });
}

// Гараар бичсэн "Малын ID"-г тухайн фермийн малын бүртгэлтэй холбоно
async function resolveTag(v, db, farmId) {
  const a = await db.one('SELECT id, tag_id, purchase_date FROM animals WHERE farm_id = ? AND tag_id = ?', [farmId, v.tag_id]);
  if (!a) throw new HttpError(400, `"${v.tag_id}" ID-тай мал бүртгэлд алга`);
  delete v.tag_id;
  v.animal_id = a.id;
  return a;
}

// Огнооны дараалал шалгана: авсан өдөр ≤ жинлэлт ≤ бойлох өдөр ≤ ачигдсан огноо
async function checkWeighing(v, db, farmId, id) {
  const a = await resolveTag(v, db, farmId);
  if (v.date < a.purchase_date) throw new HttpError(400, `${a.tag_id}: жинлэлтийн огноо (${v.date}) малыг авсан өдрөөс (${a.purchase_date}) өмнө байж болохгүй`);
  // Шинэ жинлэлт сүүлийн жинлэлтээс өмнө байж болохгүй (хуучин жинлэлтийг засахад хамаарахгүй)
  if (!id) {
    const prev = (await db.one('SELECT MAX(date) d FROM weighings WHERE animal_id = ?', [a.id])).d;
    if (prev && v.date < prev) throw new HttpError(400, `${a.tag_id}: жинлэлтийн огноо (${v.date}) сүүлийн жинлэлтээс (${prev}) өмнө байж болохгүй`);
  }
  const s = await db.one('SELECT date FROM slaughters WHERE animal_id = ?', [a.id]);
  if (s && v.date > s.date) throw new HttpError(400, `${a.tag_id}: жинлэлтийн огноо (${v.date}) бойлох өдрөөс (${s.date}) хойш байж болохгүй`);
  const ls = await liveSale(db, a.id);
  if (ls && v.date > ls.sold_date) throw new HttpError(400, `${a.tag_id}: жинлэлтийн огноо (${v.date}) амьдаар зарсан өдрөөс (${ls.sold_date}) хойш байж болохгүй`);
}
// Махны үлдэгдэл: бүртгэсэн гулуузны нийт жин − махлаж зарсан жин (хуучин ачилтын мөр жингүй бол ачигдсан жин)
async function meatStock(db, farmId, exceptId = 0) {
  const total = Number((await db.one('SELECT COALESCE(SUM(carcass_weight), 0) t FROM slaughters WHERE farm_id = ?', [farmId])).t) || 0;
  const sold = Number((await db.one(`SELECT COALESCE(SUM(COALESCE(s.sold_weight,
      (SELECT SUM(x.carcass_weight) FROM slaughters x WHERE x.farm_id = s.farm_id AND x.shipped_date = s.shipped_date))), 0) t
    FROM sales s WHERE s.farm_id = ? AND s.kind = 'Мах' AND s.id <> ?`, [farmId, exceptId || 0])).t) || 0;
  return { total, sold, available: Math.max(0, total - sold) };
}
// Амьдаар зарсан борлуулалт (байвал)
const liveSale = (db, animalId, exceptId = 0) =>
  db.one("SELECT id, sold_date FROM sales WHERE animal_id = ? AND kind = 'Амьд' AND id <> ?", [animalId, exceptId]);
async function checkSlaughter(v, db, farmId) {
  // Хуучин хэлбэр (зөвхөн date): төлөвлөсөн огноо; гулуузтай бол бодит огноо ч мөн
  if (!v.planned_date && !v.slaughtered_date) {
    if (!v.date) throw new HttpError(400, '"Бойнд орох огноо" талбарыг бөглөнө үү');
    v.planned_date = v.date;
    if (v.carcass_weight != null) v.slaughtered_date = v.date;
  }
  if (v.carcass_weight != null && !v.slaughtered_date) throw new HttpError(400, 'Гулуузны жин оруулахын тулд "Бойнд орсон огноо"-г оруулна уу');
  v.planned_date = v.planned_date || v.slaughtered_date;
  v.date = v.slaughtered_date || v.planned_date;
  if (v.slaughtered_date && v.slaughtered_date > todayStr()) throw new HttpError(400, `"Бойнд орсон огноо" (${v.slaughtered_date}) ирээдүйд байж болохгүй`);
  const a = await resolveTag(v, db, farmId);
  if (await liveSale(db, a.id)) throw new HttpError(400, `${a.tag_id} амьдаар зарагдсан тул бойлох боломжгүй`);
  if (v.planned_date < a.purchase_date) throw new HttpError(400, `${a.tag_id}: бойнд орох огноо (${v.planned_date}) малыг авсан өдрөөс (${a.purchase_date}) өмнө байж болохгүй`);
  if (v.date < a.purchase_date) throw new HttpError(400, `${a.tag_id}: бойлох өдөр (${v.date}) малыг авсан өдрөөс (${a.purchase_date}) өмнө байж болохгүй`);
  // Гулуузны жинг зөвхөн бойлсон (өнгөрсөн/өнөөдрийн) өдөртэй бүртгэнэ
  if (v.carcass_weight != null && v.date > todayStr()) {
    throw new HttpError(400, `${a.tag_id}: бойлох өдөр (${v.date}) болоогүй тул гулуузны жин оруулах боломжгүй — бойлсон өдрийг оруулна уу`);
  }
  const last = (await db.one('SELECT MAX(date) d FROM weighings WHERE animal_id = ?', [a.id])).d;
  if (last && v.date < last) {
    // Ирээдүйн огноотой (алдаатай) жинлэлт байвал түүнийг засахыг заана
    throw new HttpError(400, last > todayStr()
      ? `${a.tag_id}: сүүлийн жинлэлт ирээдүйн огноотой (${last}) бүртгэгдсэн байна. Жинлэлт цэснээс ${a.tag_id} дээр дарж тэр жинлэлтийн огноог засна уу`
      : `${a.tag_id}: бойлох өдөр (${v.date}) сүүлийн жинлэлтийн огнооноос (${last}) өмнө байж болохгүй`);
  }
  // Ачилтын огноог "Мах ачилт"-аас бүртгэнэ — бойлох өдрийг ачилтаас хойш болгож болохгүй
  const s = await db.one('SELECT shipped_date FROM slaughters WHERE animal_id = ?', [a.id]);
  if (s?.shipped_date && s.shipped_date < v.date) throw new HttpError(400, `${a.tag_id}: бойлох өдөр (${v.date}) ачигдсан огнооноос (${s.shipped_date}) хойш байж болохгүй`);
}

// ---------- Тэжээлийн нөөц: "Тэжээл" төрлийн зардал = орлого, feed_usage = зарцуулалт ----------
const FEED_TYPE = 'Тэжээл';
const FEED_UNITS = ['кг', 'боодол'];
const fmtQ = n => Math.round(n * 100) / 100;
// Тэжээлийн нөөцийг нэгжээр (bucket) бүлэглэнэ. Тохиргоонд "1 боодлын жин" байвал бүгдийг кг руу хөрвүүлж
// нэг үлдэгдлээр, байхгүй бол кг ба боодлыг тусад нь хянана. Засварлаж буй бичлэгийг тооцоонд оруулахгүй.
async function feedBuckets(db, farmId, name, { expenseId = 0, usageId = 0, baleKg } = {}) {
  const bk = baleKg !== undefined ? baleKg
    : (await db.one('SELECT bale_kg FROM feeds WHERE farm_id = ? AND name = ?', [farmId, name]))?.bale_kg || null;
  const toBucket = (u, q) => (bk ? ['кг', u === 'боодол' ? q * bk : q] : [u || 'кг', q]);
  const inc = await db.q(`SELECT COALESCE(unit, 'кг') u, SUM(COALESCE(qty, 0)) q, SUM(COALESCE(qty, 0) * COALESCE(unit_price, 0)) cost, MAX(date) d
    FROM expenses WHERE farm_id = ? AND type = ? AND feed_name = ? AND id <> ? GROUP BY u`, [farmId, FEED_TYPE, name, expenseId || 0]);
  const use = await db.q('SELECT unit u, SUM(qty) q, MAX(date) d FROM feed_usage WHERE farm_id = ? AND feed_name = ? AND id <> ? GROUP BY u',
    [farmId, name, usageId || 0]);
  const buckets = new Map();
  const get = k => buckets.get(k) || buckets.set(k, { in: 0, cost: 0, used: 0, last_in: null, last_use: null }).get(k);
  for (const r of inc) {
    const [k, q] = toBucket(r.u, n0(r.q)); const x = get(k);
    x.in += q; x.cost += n0(r.cost); if (!x.last_in || r.d > x.last_in) x.last_in = r.d;
  }
  for (const r of use) {
    const [k, q] = toBucket(r.u, n0(r.q)); const x = get(k);
    x.used += q; if (!x.last_use || r.d > x.last_use) x.last_use = r.d;
  }
  return { bk, buckets, toBucket };
}
// Аль ч нэгжийн үлдэгдэл хасах руу орвол алдаа
function assertFeedBalance(name, buckets, msg) {
  for (const [k, x] of buckets) {
    const left = x.in - x.used;
    if (left < -1e-9) throw new HttpError(400, `${name}: ${msg} (${fmtQ(-left)} ${k} дутна)`);
  }
}

// ---------- Худалдаж авсан мал = "Мал авсан" зардал (малын бүртгэлээс автоматаар, давхар бичлэггүй) ----------
const ANIMAL_EXPENSE_TYPE = 'Мал авсан';
async function animalPurchaseExpenses(db, farmId) {
  const rows = await db.q(`SELECT id, tag_id, species, age_name, purchase_date, purchase_price, transport_cost, other_cost, paid_by
    FROM animals WHERE farm_id = ? AND source = 'Худалдаж авсан'
      AND (purchase_price IS NOT NULL OR transport_cost IS NOT NULL OR other_cost IS NOT NULL)`, [farmId]);
  return rows.map(a => {
    const total = n0(a.purchase_price) + n0(a.transport_cost) + n0(a.other_cost);
    return {
      id: 'animal-' + a.id, auto: 'animal', animal_id: a.id, date: a.purchase_date, type: ANIMAL_EXPENSE_TYPE, feed_name: null,
      description: [a.tag_id, a.species, a.age_name].filter(Boolean).join(' · '),
      qty: 1, unit: 'толгой', unit_price: total, total, supplier: null, paid_by: a.paid_by
    };
  });
}

// Төлсөн хөрөнгө оруулагч (partners.id) тухайн фермийнх эсэхийг шалгана
async function checkPaidBy(v, db, farmId) {
  if (v.paid_by == null) return;
  if (!await db.one('SELECT 1 x FROM partners WHERE id = ? AND farm_id = ?', [v.paid_by, farmId])) throw new HttpError(400, 'Төлсөн хөрөнгө оруулагч олдсонгүй');
}

// Эзэмшигчээс бусад хөрөнгө оруулагчдын нийт хувь (exceptId мөрийг оруулахгүй)
const otherInvestorsPercent = async (db, farmId, exceptId) => Number((await db.one(
  'SELECT COALESCE(SUM(percent), 0) s FROM partners WHERE farm_id = ? AND is_owner = 0 AND id <> ?', [farmId, exceptId || 0])).s) || 0;
const roundPct = n => Math.round(Math.max(0, n) * 1e6) / 1e6;

const resources = {
  animals: {
    table: 'animals', title: 'Мал', track: true, photos: true, describe: v => v.tag_id,
    fields: {
      source: { t: 'text', req: true, options: SOURCES, label: 'Орлогын төрөл' },
      purchase_date: { t: 'date', req: true, label: 'Орлогын огноо' },
      mother_tag: { t: 'text', max: 50, label: 'Эх мал (ID)' },
      market_value: { t: 'num', label: 'Зах зээлийн үнэ' },
      species: { t: 'text', req: true, options: SPECIES, label: 'Малын төрөл' },
      age_name: { t: 'text', max: 100, label: 'Насны нэршил' },
      age: { t: 'text', max: 10, label: 'Нас' },
      sex: { t: 'text', options: SEXES, label: 'Хүйс' },
      tag_id: { t: 'text', req: true, max: 50, label: 'Малын ID' },
      tag_color: { t: 'text', max: 50, label: 'ID өнгө' },
      initial_weight: { t: 'num', max: 5000, label: 'Анхны жин' },
      purchase_price: { t: 'num', label: 'Авсан үнэ' },
      paid_by: { t: 'int', min: 1, label: 'Төлсөн' },
      note: { t: 'text', max: 1000, label: 'Тэмдэглэл' },
      goal_weight: { t: 'num', max: 5000, label: 'Зорилтот жин' },
      goal_days: { t: 'int', min: 1, max: 3650, label: 'Хугацаа (хоног)' }
    },
    // Орлогын төрлөөс хамаарах талбарууд: Төл → эх мал; Бэлэг → зах зээлийн үнэ; Худалдаж авсан → авсан үнэ
    async prepare(v, db, farmId) {
      if (v.source !== 'Төл') v.mother_tag = null;
      if (v.source !== 'Бэлэг') v.market_value = null;
      if (v.source !== 'Худалдаж авсан') { v.purchase_price = null; v.paid_by = null; }
      await checkPaidBy(v, db, farmId);
      if (v.source === 'Төл') {
        if (!v.mother_tag) throw new HttpError(400, 'Төлийн эх малын ID-г оруулна уу');
        if (v.tag_id && v.mother_tag.toLowerCase() === String(v.tag_id).toLowerCase()) throw new HttpError(400, 'Мал өөрөө өөрийнхөө эх байж болохгүй');
        const m = await db.one('SELECT tag_id, species FROM animals WHERE farm_id = ? AND tag_id = ?', [farmId, v.mother_tag]);
        if (!m) throw new HttpError(400, `"${v.mother_tag}" ID-тай эх мал бүртгэлд алга`);
        if (m.species !== v.species) throw new HttpError(400, `Эх мал ${m.tag_id} нь ${m.species} тул ${v.species} төрлийн төлийн эх байж болохгүй`);
        v.mother_tag = m.tag_id;
      }
    },
    async list(db, farmId) {
      // Зорилтот жинг тухайн фермийн "Тохиргоо → Малын ангилал"-аас төрөл + насны нэршил + хүйсээр нь хайна
      const rows = await db.q(`
        SELECT a.*,
          (SELECT c.target_weight FROM animal_classes c
            WHERE c.farm_id = a.farm_id AND c.species = a.species AND c.age_name = a.age_name AND c.sex = a.sex
            ORDER BY (c.age = a.age) DESC, c.id LIMIT 1) AS class_target,
          (SELECT w.date FROM weighings w WHERE w.animal_id = a.id ORDER BY w.date DESC, w.id DESC LIMIT 1) AS last_weigh_date,
          (SELECT w.weight FROM weighings w WHERE w.animal_id = a.id ORDER BY w.date DESC, w.id DESC LIMIT 1) AS last_weight,
          (SELECT COUNT(*) FROM weighings w WHERE w.animal_id = a.id) AS weigh_count,
          s.id AS slaughter_id, s.date AS slaughter_date, s.planned_date AS slaughter_planned, s.slaughtered_date, s.carcass_weight, s.shipped_date,
          (SELECT MAX(x.sold_date) FROM sales x WHERE x.farm_id = a.farm_id AND x.kind = 'Мах' AND x.shipped_date = s.shipped_date) AS carcass_sold_date,
          (SELECT MAX(x.sold_date) FROM sales x WHERE x.animal_id = a.id AND x.kind = 'Амьд') AS live_sold_date
        FROM animals a
        LEFT JOIN slaughters s ON s.animal_id = a.id
        WHERE a.farm_id = ?
        ORDER BY a.purchase_date DESC, a.id DESC`, [farmId]);
      const ctx = await ageContext(db, farmId);
      return rows.map(r => {
        // Зарагдсан өдөр: амьдаар зарсан, эсвэл гулуузны ачилт нь зарагдсан
        const a = { ...r, sold_date: r.live_sold_date || r.carcass_sold_date, sale_kind: r.live_sold_date ? 'Амьд' : r.carcass_sold_date ? 'Мах' : null };
        // Одоогийн нас, насны нэршил (төллөх улирал бүрт нэг нас ахина)
        const ag = currentAge(a, ctx);
        // Мал дээр бүртгэсэн зорилтот жин байвал түүнийг, үгүй бол одоогийн ангиллын зорилтот жинг ашиглана
        const target_weight = a.goal_weight ?? ag.cls?.target_weight ?? a.class_target;
        const goal_date = a.goal_days ? addDaysStr(a.purchase_date, a.goal_days) : null;
        const goal_adg = a.goal_weight != null && a.initial_weight != null && a.goal_days ? (a.goal_weight - a.initial_weight) / a.goal_days : null;
        const total_price = n0(a.purchase_price) + n0(a.transport_cost) + n0(a.other_cost);
        const days = a.last_weigh_date ? Math.max(0, dayDiff(a.purchase_date, a.last_weigh_date)) : null;
        const gain = a.last_weight != null && a.initial_weight != null ? a.last_weight - a.initial_weight : null;
        const adg = gain != null && days > 0 ? gain / days : null;
        let target_status = '';
        if (a.last_weight != null) {
          target_status = target_weight == null ? 'Тохиргоо олдсонгүй'
            : a.last_weight >= target_weight ? 'Борлуулах' : 'Хүрээгүй';
        }
        // Бойлох өдөр ирээгүй бол "Бой товлогдсон" (хуваарьт орсон), өнгөрсөн бол "Бойлсон"
        const state = a.sold_date ? 'Зарагдсан' : !a.slaughter_date ? 'Идэвхтэй' : a.slaughter_date > todayStr() ? 'Бой товлогдсон' : 'Бойлсон';
        return {
          ...a, target_weight, goal_date, goal_adg, total_price, days, gain, adg, target_status, state, total_cost: total_price + n0(a.feed_cost),
          current_age: ag.age, current_age_name: ag.name, next_age_date: ag.next
        };
      });
    }
  },

  weighings: {
    table: 'weighings', title: 'Жинлэлт', track: true, photos: true, describe: v => v.tag_id,
    fields: {
      date: { t: 'date', req: true, label: 'Огноо' },
      tag_id: { t: 'text', req: true, max: 50, label: 'Малын ID' },
      weight: { t: 'num', req: true, max: 5000, label: 'Жин (кг)' },
      note: { t: 'text', max: 500, label: 'Тэмдэглэл' }
    },
    prepare: checkWeighing,
    list: async (db, farmId) => withCurrentAgeName(db, farmId, await db.q(`
      SELECT w.*, a.tag_id, a.species, a.age_name
      FROM weighings w JOIN animals a ON a.id = w.animal_id
      WHERE w.farm_id = ?
      ORDER BY w.date DESC, w.id DESC`, [farmId]))
  },

  // Эмчилгээ, вакцин: мал тус бүрт (дараагийн тунгийн огноо — сануулга)
  treatments: {
    table: 'treatments', title: 'Эмчилгээ', track: true, describe: v => `${v.kind} · ${v.name}`,
    fields: {
      date: { t: 'date', req: true, label: 'Огноо' },
      tag_id: { t: 'text', req: true, max: 50, label: 'Малын ID' },
      kind: { t: 'text', req: true, max: 100, label: 'Төрөл' },
      name: { t: 'text', req: true, max: 200, label: 'Өвчин / вакцин' },
      medicine: { t: 'text', max: 200, label: 'Эм, тариа' },
      dose: { t: 'text', max: 100, label: 'Тун' },
      vet: { t: 'text', max: 100, label: 'Мал эмч' },
      next_date: { t: 'date', label: 'Дараагийн тун' },
      note: { t: 'text', max: 500, label: 'Тэмдэглэл' }
    },
    async prepare(v, db, farmId, id) {
      // Төрөл нь Тохиргоо → Эмчилгээний төрөл-д байх ёстой (засахад хуучин утгыг хэвээр үлдээж болно)
      const tt = await db.one('SELECT name FROM treatment_types WHERE farm_id = ? AND name = ?', [farmId, v.kind]);
      const old = id ? await db.one('SELECT kind FROM treatments WHERE id = ? AND farm_id = ?', [id, farmId]) : null;
      if (tt) v.kind = tt.name;
      else if (!old || old.kind !== v.kind) throw new HttpError(400, `"${v.kind}" төрөл Тохиргоо → Эмчилгээний төрөл-д бүртгэлгүй байна`);
      const a = await resolveTag(v, db, farmId);
      if (v.date < a.purchase_date) throw new HttpError(400, `${a.tag_id}: огноо (${v.date}) малыг авсан өдрөөс (${a.purchase_date}) өмнө байж болохгүй`);
      if (v.next_date && v.next_date < v.date) throw new HttpError(400, 'Дараагийн тунгийн огноо эмчилгээний огнооноос өмнө байж болохгүй');
    },
    list: async (db, farmId) => withCurrentAgeName(db, farmId, await db.q(`
      SELECT t.*, a.tag_id, a.species, a.age_name, a.sex
      FROM treatments t JOIN animals a ON a.id = t.animal_id
      WHERE t.farm_id = ?
      ORDER BY t.date DESC, t.id DESC`, [farmId]))
  },

  expenses: {
    table: 'expenses', title: 'Зардал', track: true, photos: true, describe: v => (v.feed_name ? `${v.type} · ${v.feed_name}` : v.type),
    // Худалдаж авсан тэжээлийг "Тэжээлийн бүртгэл"-ээс бүртгэнэ — тэжээлийн эрхтэй хэрэглэгч ч нэмж чадна
    createModules: body => (body?.type === FEED_TYPE ? ['expenses', 'feed'] : null),
    fields: {
      date: { t: 'date', req: true, label: 'Огноо' },
      type: { t: 'text', req: true, max: 100, label: 'Төрөл' },
      feed_name: { t: 'text', max: 100, label: 'Тэжээл' },
      unit: { t: 'text', options: FEED_UNITS, label: 'Нэгж' },
      description: { t: 'text', max: 500, label: 'Тайлбар' },
      qty: { t: 'num', label: 'Тоо' },
      unit_price: { t: 'num', label: 'Нэгж үнэ' },
      supplier: { t: 'text', max: 200, label: 'Нийлүүлэгч' },
      paid_by: { t: 'int', min: 1, label: 'Төлсөн' },
      related_ref: { t: 'text', max: 40, label: 'Холбогдох зардал' }
    },
    // "Тэжээл" төрөл → дэд төрөл нь Тохиргоо → Тэжээл-ийн нэр, хэмжээ (кг) заавал; бусад төрөлд дэд төрөлгүй.
    // Засварлахад тэжээлийн үлдэгдэл хасах руу орохгүй байхыг шалгана.
    async prepare(v, db, farmId, id) {
      await checkPaidBy(v, db, farmId);
      if (v.type !== FEED_TYPE) { v.feed_name = null; v.unit = null; }
      else {
        if (!v.feed_name) throw new HttpError(400, 'Тэжээлийн төрлийг сонгоно уу');
        const f = await db.one('SELECT name FROM feeds WHERE farm_id = ? AND name = ?', [farmId, v.feed_name]);
        if (!f) throw new HttpError(400, `"${v.feed_name}" тэжээл Тохиргоо → Тэжээл-д бүртгэлгүй байна`);
        v.feed_name = f.name;
        v.unit = v.unit || 'кг';
        if (!(v.qty > 0)) throw new HttpError(400, `Тэжээлийн хэмжээг (${v.unit}) оруулна уу`);
      }
      // Холбогдох зардал: "16" (гараар бүртгэсэн, холбоосгүй үндсэн зардал) эсвэл "animal-33" (Мал авсан)
      if (v.related_ref) {
        const ref = v.related_ref;
        if (/^\d+$/.test(ref)) {
          if (id && Number(ref) === Number(id)) throw new HttpError(400, 'Зардлыг өөрт нь холбох боломжгүй');
          const rel = await db.one('SELECT id, related_ref FROM expenses WHERE id = ? AND farm_id = ?', [Number(ref), farmId]);
          if (!rel) throw new HttpError(400, 'Холбогдох зардал олдсонгүй');
          if (rel.related_ref) throw new HttpError(400, 'Сонгосон зардал өөрөө өөр зардалд холбогдсон байна — үндсэн зардлыг сонгоно уу');
        } else if (/^animal-\d+$/.test(ref)) {
          if (!await db.one("SELECT 1 x FROM animals WHERE id = ? AND farm_id = ? AND source = 'Худалдаж авсан'", [Number(ref.slice(7)), farmId])) {
            throw new HttpError(400, 'Холбогдох "Мал авсан" зардал олдсонгүй');
          }
        } else throw new HttpError(400, 'Холбогдох зардал буруу байна');
        if (id && await db.one('SELECT 1 x FROM expenses WHERE farm_id = ? AND related_ref = ? LIMIT 1', [farmId, String(id)])) {
          throw new HttpError(400, 'Энэ зардалд өөр зардлууд холбогдсон тул түүнийг өөр зардалд холбох боломжгүй');
        }
      }
      if (!id) return;
      const old = await db.one('SELECT type, feed_name FROM expenses WHERE id = ? AND farm_id = ?', [id, farmId]);
      if (old?.type === FEED_TYPE && old.feed_name) {
        const { buckets, toBucket } = await feedBuckets(db, farmId, old.feed_name, { expenseId: id });
        if (v.type === FEED_TYPE && v.feed_name === old.feed_name) {
          const [k, q] = toBucket(v.unit, v.qty);
          const x = buckets.get(k); if (x) x.in += q;
        }
        assertFeedBalance(old.feed_name, buckets, 'зарцуулсан хэмжээ орлогоос их болно');
      }
    },
    async beforeDelete(old, db, farmId) {
      if (old.type === FEED_TYPE && old.feed_name) {
        const { buckets } = await feedBuckets(db, farmId, old.feed_name, { expenseId: old.id });
        assertFeedBalance(old.feed_name, buckets, 'энэ орлогыг устгавал зарцуулалт орлогоос их болно');
      }
      // Холбогдсон зардлууд (тээвэр г.м.) үлдэнэ, зөвхөн холбоос нь арилна
      await db.run('UPDATE expenses SET related_ref = NULL WHERE farm_id = ? AND related_ref = ?', [farmId, String(old.id)]);
    },
    // Гараар бүртгэсэн зардал + малын бүртгэлээс автоматаар орох "Мал авсан" зардал (зөвхөн харах).
    // related_label — холбогдсон үндсэн зардал; linked_total — энэ зардалд холбогдсон нэмэлт зардлын нийлбэр
    async list(db, farmId) {
      const own = await db.q('SELECT *, COALESCE(qty, 0) * COALESCE(unit_price, 0) AS total FROM expenses WHERE farm_id = ? ORDER BY date DESC, id DESC', [farmId]);
      const all = [...own, ...await animalPurchaseExpenses(db, farmId)];
      const payer = new Map((await db.q('SELECT id, name FROM partners WHERE farm_id = ?', [farmId])).map(p => [p.id, p.name]));
      for (const e of all) e.paid_by_name = payer.get(e.paid_by) || null;
      const byRef = new Map(all.map(e => [String(e.id), e]));
      for (const e of own) {
        const p = e.related_ref ? byRef.get(e.related_ref) : null;
        if (p) {
          e.related_label = [p.date, p.type, p.feed_name, p.description, p.supplier].filter(Boolean).join(' · ');
          p.linked_total = (p.linked_total || 0) + (Number(e.total) || 0);
          p.linked_count = (p.linked_count || 0) + 1;
        }
      }
      return all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
  },

  // Тэжээлийн зарцуулалт — зардлаар орж ирсэн тэжээлээс хасагдана
  feed_usage: {
    table: 'feed_usage', title: 'Тэжээлийн зарцуулалт', track: true, describe: v => `${v.feed_name} ${v.qty} ${v.unit}`,
    fields: {
      date: { t: 'date', req: true, label: 'Огноо' },
      feed_name: { t: 'text', req: true, max: 100, label: 'Тэжээл' },
      unit: { t: 'text', req: true, options: FEED_UNITS, label: 'Нэгж' },
      qty: { t: 'num', req: true, label: 'Хэмжээ' },
      note: { t: 'text', max: 500, label: 'Тэмдэглэл' }
    },
    async prepare(v, db, farmId, id) {
      if (!(v.qty > 0)) throw new HttpError(400, '"Хэмжээ" 0-ээс их байх ёстой');
      const f = await db.one('SELECT feed_name FROM expenses WHERE farm_id = ? AND type = ? AND feed_name = ? LIMIT 1', [farmId, FEED_TYPE, v.feed_name]);
      if (!f) throw new HttpError(400, `"${v.feed_name}" тэжээлийн орлого (зардал) бүртгэгдээгүй байна`);
      v.feed_name = f.feed_name;
      const { bk, buckets, toBucket } = await feedBuckets(db, farmId, v.feed_name, { usageId: id });
      const [k, q] = toBucket(v.unit, v.qty);
      const x = buckets.get(k);
      const left = x ? x.in - x.used : 0;
      if (q > left + 1e-9) {
        const alt = bk ? ` (≈ ${fmtQ(Math.max(0, left) / bk)} боодол)` : '';
        throw new HttpError(400, `${v.feed_name}: үлдэгдэл ${fmtQ(Math.max(0, left))} ${k}${alt} байна`);
      }
    },
    // Өртөг = зарцуулсан хэмжээ × тухайн нэгжийн жигнэсэн дундаж үнэ
    async list(db, farmId) {
      const rows = await db.q('SELECT * FROM feed_usage WHERE farm_id = ? ORDER BY date DESC, id DESC', [farmId]);
      const cache = new Map();
      for (const name of new Set(rows.map(r => r.feed_name))) cache.set(name, await feedBuckets(db, farmId, name));
      return rows.map(r => {
        const { buckets, toBucket } = cache.get(r.feed_name);
        const [k, q] = toBucket(r.unit, r.qty);
        const x = buckets.get(k);
        return { ...r, cost: x && x.in > 0 ? q * x.cost / x.in : null };
      });
    }
  },

  // Тэжээлийн үлдэгдэл (зөвхөн харах): орлого − зарцуулалт
  feed_stock: {
    table: 'feed_usage', title: 'Тэжээлийн үлдэгдэл', readonly: true,
    // Тэжээл × нэгж тус бүр нэг мөр; боодлын жин мэдэгдэж байвал кг-аар нэг мөр + боодлоор шилжүүлсэн үлдэгдэл
    async list(db, farmId) {
      const used = (await db.q(`SELECT DISTINCT feed_name n FROM expenses WHERE farm_id = ? AND type = ? AND feed_name IS NOT NULL
        UNION SELECT DISTINCT feed_name FROM feed_usage WHERE farm_id = ?`, [farmId, FEED_TYPE, farmId])).map(r => r.n);
      const order = (await db.q('SELECT name FROM feeds WHERE farm_id = ? ORDER BY id', [farmId])).map(r => r.name);
      const names = [...new Set([...order.filter(n => used.includes(n)), ...used])];
      const out = [];
      for (const name of names) {
        const { bk, buckets } = await feedBuckets(db, farmId, name);
        for (const unit of FEED_UNITS) {
          const x = buckets.get(unit);
          if (!x) continue;
          const left = x.in - x.used;
          const avg_price = x.in > 0 ? x.cost / x.in : null;
          out.push({
            id: out.length + 1, feed_name: name, unit, bale_kg: bk, in_qty: x.in, used_qty: x.used, left_qty: left,
            left_bale: bk ? left / bk : null, avg_price, left_value: avg_price != null ? left * avg_price : null,
            last_in: x.last_in, last_use: x.last_use
          });
        }
      }
      return out;
    }
  },

  slaughters: {
    table: 'slaughters', title: 'Бой', track: true, photos: true, describe: v => v.tag_id,
    fields: {
      date: { t: 'date', label: 'Бойлох өдөр' },
      planned_date: { t: 'date', label: 'Бойнд орох огноо' },
      slaughtered_date: { t: 'date', label: 'Бойнд орсон огноо' },
      tag_id: { t: 'text', req: true, max: 50, label: 'Малын ID' },
      carcass_weight: { t: 'num', max: 3000, label: 'Гулуузны жин' }
      // shipped_date — зөвхөн "Мах ачилт"-аар (POST /api/slaughters/ship) бүртгэнэ
    },
    prepare: checkSlaughter,
    list: async (db, farmId) => (await withCurrentAgeName(db, farmId, await db.q(`
      SELECT s.*, a.tag_id, a.tag_color, a.species, a.age_name, a.sex,
        (SELECT w.weight FROM weighings w WHERE w.animal_id = a.id ORDER BY w.date DESC, w.id DESC LIMIT 1) AS last_weight
      FROM slaughters s JOIN animals a ON a.id = s.animal_id
      WHERE s.farm_id = ?
      ORDER BY s.date DESC, s.id DESC`, [farmId])))
      .map(s => ({
        ...s,
        yield_pct: s.carcass_weight != null && s.last_weight ? s.carcass_weight / s.last_weight * 100 : null,
        carcass_status: s.carcass_weight != null ? 'Бүртгэсэн' : 'Хүлээгдэж буй'
      }))
  },

  sales: {
    table: 'sales', title: 'Борлуулалт', track: true, photos: true,
    describe: v => (v.kind === 'Амьд' ? `Амьдаар ${v.sold_date}` : v.shipped_date),
    fields: {
      kind: { t: 'text', options: SALE_KINDS, label: 'Борлуулалтын төрөл' },
      tag_id: { t: 'text', max: 50, label: 'Малын ID' },
      shipped_date: { t: 'date', label: 'Ачигдсан огноо' },
      sold_date: { t: 'date', label: 'Зарсан өдөр' },
      sold_weight: { t: 'num', label: 'Борлуулсан жин' },
      price: { t: 'num', label: 'Зарсан үнэ (₮/кг)' },
      amount: { t: 'num', label: 'Нийт үнэ' },
      note: { t: 'text', max: 500, label: 'Тэмдэглэл' }
    },
    // Мах: ачилт бүрт (огноогоор) нэг борлуулалт, огноо нь "Мах ачилт"-д бүртгэгдсэн байх ёстой.
    // Амьд: нэг мал (Малын ID), зарсан өдөр, амьд жин, нийт үнэ. Засахад төрөл өөрчлөгдөхгүй.
    async prepare(v, db, farmId, id) {
      const old = id ? await db.one('SELECT kind, shipped_date, animal_id FROM sales WHERE id = ? AND farm_id = ?', [id, farmId]) : null;
      v.kind = old?.kind || v.kind || 'Мах';
      if (v.kind === 'Амьд') {
        if (!v.tag_id && old?.animal_id) v.tag_id = (await db.one('SELECT tag_id FROM animals WHERE id = ?', [old.animal_id]))?.tag_id;
        if (!v.tag_id) throw new HttpError(400, 'Малын ID-г оруулна уу');
        const a = await resolveTag(v, db, farmId);
        if (!v.sold_date) throw new HttpError(400, '"Зарсан өдөр"-ийг оруулна уу');
        if (v.sold_date < a.purchase_date) throw new HttpError(400, `${a.tag_id}: зарсан өдөр (${v.sold_date}) малыг авсан өдрөөс (${a.purchase_date}) өмнө байж болохгүй`);
        const last = (await db.one('SELECT MAX(date) d FROM weighings WHERE animal_id = ?', [a.id])).d;
        if (last && v.sold_date < last) throw new HttpError(400, `${a.tag_id}: зарсан өдөр (${v.sold_date}) сүүлийн жинлэлтээс (${last}) өмнө байж болохгүй`);
        if (!(v.amount > 0)) throw new HttpError(400, '"Нийт үнэ"-ийг оруулна уу');
        if (await liveSale(db, a.id, id)) throw new HttpError(409, `${a.tag_id} аль хэдийн зарагдсан байна`);
        // Бойн хуваарьтай (товлосон) мал: гулууз/ачилт бүртгэгдээгүй бол хуваарийг цуцалж амьдаар зарна
        const s = await db.one('SELECT id, carcass_weight, shipped_date FROM slaughters WHERE animal_id = ?', [a.id]);
        if (s && (s.carcass_weight != null || s.shipped_date)) {
          throw new HttpError(400, `${a.tag_id}: гулуузны жин эсвэл ачилт бүртгэгдсэн тул амьдаар зарах боломжгүй`);
        }
        if (s) {
          await db.run('DELETE FROM photos WHERE farm_id = ? AND entity = ? AND entity_id = ?', [farmId, 'slaughters', s.id]);
          await db.run('DELETE FROM slaughters WHERE id = ?', [s.id]);
        }
        v.shipped_date = v.sold_date; v.price = null;
        return;
      }
      // Мах: бойноос гарсан махны үлдэгдлээс кг + ₮/кг үнээр зарна
      delete v.tag_id; v.animal_id = null; v.amount = null;
      if (!v.sold_date) throw new HttpError(400, '"Зарсан өдөр"-ийг оруулна уу');
      if (!(v.sold_weight > 0)) throw new HttpError(400, '"Зарах жин"-г оруулна уу');
      if (!(v.price > 0)) throw new HttpError(400, '"1 кг-ийн үнэ"-ийг оруулна уу');
      const stock = await meatStock(db, farmId, id);
      if (v.sold_weight > stock.available + 1e-9) {
        throw new HttpError(400, `Зарах боломжтой мах ${Math.round(stock.available * 100) / 100} кг байна`);
      }
      v.shipped_date = v.sold_date;
    },
    // Орлого = борлуулсан жин (хуучин ачилтын мөрөнд оруулаагүй бол ачигдсан жин) × үнэ
    async list(db, farmId) {
      const ships = await db.q(`SELECT shipped_date, COUNT(*) heads, COALESCE(SUM(carcass_weight), 0) shipped_weight
        FROM slaughters WHERE farm_id = ? AND shipped_date IS NOT NULL GROUP BY shipped_date`, [farmId]);
      const byDate = new Map(ships.map(s => [s.shipped_date, s]));
      const sales = (await db.q(`SELECT s.*, a.tag_id, a.tag_color, a.species FROM sales s LEFT JOIN animals a ON a.id = s.animal_id
        WHERE s.farm_id = ? ORDER BY s.shipped_date DESC, s.id DESC`, [farmId])).map(s => {
        if (s.kind === 'Амьд') {
          // Амьдаар: нэг мал, жин = амьд жин, орлого = нийт үнэ
          return { ...s, heads: 1, shipped_weight: s.sold_weight, revenue: s.amount,
            price_kg: s.amount != null && s.sold_weight ? s.amount / s.sold_weight : null };
        }
        const kg = s.sold_weight ?? byDate.get(s.shipped_date)?.shipped_weight ?? 0;
        return { ...s, sold_weight: kg, revenue: s.price != null ? kg * s.price : null, price_kg: s.price };
      });
      const d = s => s.sold_date || s.shipped_date;
      return sales.sort((a, b) => (d(a) < d(b) ? 1 : d(a) > d(b) ? -1 : b.id - a.id));
    }
  },

  market_prices: {
    table: 'market_prices', title: 'Зах зээлийн үнэ', track: true,
    fields: {
      year: { t: 'int', req: true, min: 1990, max: 2100, label: 'Он' },
      month: { t: 'int', req: true, min: 1, max: 12, label: 'Сар' },
      species: { t: 'text', req: true, options: SPECIES, label: 'Төрөл' },
      price: { t: 'num', req: true, label: 'Махны үнэ (₮/кг)' }
    },
    list: async (db, farmId) => (await db.q('SELECT * FROM market_prices WHERE farm_id = ? ORDER BY year DESC, month DESC, id DESC', [farmId]))
      .map(r => ({ ...r, quarter: Math.ceil(r.month / 3) }))
  },

  feed_recipes: {
    table: 'feed_recipes', title: 'Тэжээлийн жор',
    fields: {
      species: { t: 'text', req: true, options: SPECIES, label: 'Төрөл' },
      recipe_no: { t: 'int', req: true, min: 1, max: 999, label: 'Орцын №' },
      ...Object.fromEntries(Object.entries(RECIPE_FEEDS).map(([k, name]) => [k, { t: 'num', max: 100, label: name + ' %' }])),
      price_per_kg: { t: 'num', label: 'Үнэ ₮/кг' },
      kg_per_gain: { t: 'num', label: 'Идүүлэх кг / 1кг ХБ' },
      note: { t: 'text', max: 500, label: 'Тэмдэглэл' }
    },
    async list(db, farmId) {
      return (await db.q('SELECT * FROM feed_recipes WHERE farm_id = ? ORDER BY species, recipe_no', [farmId])).map(r => {
        const pct = Object.keys(RECIPE_FEEDS).reduce((s, k) => s + n0(r[k]), 0);
        return { ...r, pct_total: pct, cost_per_gain: r.price_per_kg != null && r.kg_per_gain != null ? r.price_per_kg * r.kg_per_gain : null };
      });
    }
  },

  feed_plan: {
    table: 'feed_plan', title: 'Тэжээлийн төлөвлөгөө', describe: v => [v.species, v.age_name, v.sex, v.feed_name].filter(Boolean).join(' · '),
    fields: {
      species: { t: 'text', req: true, options: SPECIES, label: 'Малын төрөл' },
      age_name: { t: 'text', max: 100, label: 'Насны нэршил' },
      sex: { t: 'text', options: SEXES, label: 'Хүйс' },
      feed_name: { t: 'text', req: true, max: 200, label: 'Тэжээлийн төрөл' },
      kg_1_14: { t: 'num', label: '1–14 хоног (кг/өдөр)' },
      kg_15_30: { t: 'num', label: '15–30 хоног (кг/өдөр)' },
      kg_31_90: { t: 'num', label: '31–90 хоног (кг/өдөр)' }
    },
    // Тэжээлийг Тохиргоо → Тэжээл-ээс сонгоно (үнэ нь тэндээс). Нэг төлөвлөгөөнд нэг тэжээл нэг удаа
    async prepare(v, db, farmId, id) {
      const old = id ? await db.one('SELECT feed_name, price FROM feed_plan WHERE id = ? AND farm_id = ?', [id, farmId]) : null;
      const f = await db.one('SELECT name FROM feeds WHERE farm_id = ? AND name = ?', [farmId, v.feed_name]);
      if (f) { v.feed_name = f.name; v.price = null; }
      else if (old && old.feed_name === v.feed_name) v.price = old.price; // хуучин (тохиргоонд байхгүй) тэжээл
      else throw new HttpError(400, `"${v.feed_name}" тэжээл Тохиргоо → Тэжээл-д бүртгэлгүй байна`);
      if (await db.one(`SELECT 1 x FROM feed_plan WHERE farm_id = ? AND species = ? AND COALESCE(age_name, '') = ? AND COALESCE(sex, '') = ?
        AND feed_name = ? AND id <> ?`, [farmId, v.species, v.age_name || '', v.sex || '', v.feed_name, id || 0])) {
        throw new HttpError(409, `${v.feed_name} энэ төлөвлөгөөнд аль хэдийн байна`);
      }
    },
    list: async (db, farmId) => (await db.q(`SELECT p.*, COALESCE(f.price, p.price) AS price FROM feed_plan p
      LEFT JOIN feeds f ON f.farm_id = p.farm_id AND f.name = p.feed_name WHERE p.farm_id = ? ORDER BY p.id`, [farmId])).map(r => {
      const total_kg = n0(r.kg_1_14) * 14 + n0(r.kg_15_30) * 16 + n0(r.kg_31_90) * 60;
      return { ...r, total_kg, cost: total_kg * n0(r.price) };
    })
  },

  tasks: {
    table: 'tasks', title: 'Хуваарьт ажил', track: true, describe: v => `${v.date} ${v.type}`,
    fields: {
      date: { t: 'date', req: true, label: 'Огноо' },
      type: { t: 'text', req: true, max: 100, label: 'Ажил' },
      tag_id: { t: 'text', max: 5000, label: 'Мал' },
      assignee: { t: 'text', max: 100, label: 'Хариуцагч' },
      note: { t: 'text', max: 1000, label: 'Тэмдэглэл' },
      status: { t: 'text', req: true, options: TASK_STATUSES, label: 'Төлөв' },
      done_date: { t: 'date', label: 'Хийсэн огноо' }
    },
    // Ажлын төрөл мал шаарддаг бол ID-уудыг шалгана, шаардахгүй бол хоосолно
    async prepare(v, db, farmId) {
      const t = await db.one('SELECT needs_animals FROM task_types WHERE farm_id = ? AND name = ?', [farmId, v.type]);
      if (!t) return;
      if (!t.needs_animals) { v.tag_id = null; return; }
      const tags = [...new Set(String(v.tag_id || '').split(',').map(x => x.trim()).filter(Boolean))];
      if (!tags.length) throw new HttpError(400, `"${v.type}" ажилд малын ID сонгоно уу`);
      const found = [];
      for (const tag of tags) {
        const a = await db.one('SELECT tag_id FROM animals WHERE farm_id = ? AND tag_id = ?', [farmId, tag]);
        if (!a) throw new HttpError(400, `"${tag}" ID-тай мал бүртгэлд алга`);
        if (!found.includes(a.tag_id)) found.push(a.tag_id);
      }
      v.tag_id = found.join(', ');
    },
    // Шинээр нэмэхдээ "N хоног тутам, M удаа" гэвэл олон ажил үүсгэнэ
    expand(v, body) {
      const every = body.repeat_every == null || body.repeat_every === '' ? 0 : Number(body.repeat_every);
      const times = body.repeat_count == null || body.repeat_count === '' ? 1 : Number(body.repeat_count);
      if (!every) return [v];
      if (!Number.isInteger(every) || every < 1 || every > 365) throw new HttpError(400, '"Давтамж" 1–365 хоног байна');
      if (!Number.isInteger(times) || times < 1 || times > 100) throw new HttpError(400, '"Давтах тоо" 1–100 байна');
      return Array.from({ length: times }, (_, i) => ({ ...v, date: addDaysStr(v.date, i * every) }));
    },
    list: async (db, farmId) => (await db.q('SELECT * FROM tasks WHERE farm_id = ? ORDER BY date, id', [farmId]))
  },

  // ----- Тохиргооны хүснэгтүүд (фермийн эзэмшигч / админ засна) -----
  animal_classes: {
    table: 'animal_classes', title: 'Малын ангилал', settings: true, describe: v => `${v.species} ${v.age_name} ${v.sex}`,
    fields: {
      species: { t: 'text', req: true, options: SPECIES, label: 'Малын төрөл' },
      age_name: { t: 'text', req: true, max: 100, label: 'Насны нэршил' },
      age: { t: 'text', req: true, max: 10, label: 'Нас' },
      sex: { t: 'text', req: true, options: SEXES, label: 'Хүйс' },
      target_weight: { t: 'num', max: 5000, label: 'Зорилтот жин' }
    }
  },
  feeds: {
    table: 'feeds', title: 'Тэжээл', settings: true, describe: v => v.name,
    fields: {
      name: { t: 'text', req: true, max: 100, label: 'Тэжээл' },
      price: { t: 'num', label: 'Үнэ ₮/кг' },
      bale_kg: { t: 'num', max: 10000, label: '1 боодлын жин (кг)' }
    },
    // Боодлын жинг өөрчлөхөд үлдэгдэл хасах руу орохгүйг шалгана;
    // нэрийг солиход зардал, зарцуулалтын бүртгэл дэх нэрийг хамт шинэчилнэ
    async prepare(v, db, farmId, id) {
      if (!v.bale_kg) v.bale_kg = null;
      if (!id) return;
      const old = await db.one('SELECT name, bale_kg FROM feeds WHERE id = ? AND farm_id = ?', [id, farmId]);
      if (!old) return;
      if ((old.bale_kg || null) !== v.bale_kg) {
        const { buckets } = await feedBuckets(db, farmId, old.name, { baleKg: v.bale_kg });
        assertFeedBalance(old.name, buckets, 'боодлын жинг ингэж өөрчилвөл зарцуулалт орлогоос их болно');
      }
      if (old.name === v.name) return;
      if (await db.one('SELECT 1 x FROM feeds WHERE farm_id = ? AND name = ? AND id <> ?', [farmId, v.name, id])) {
        throw new HttpError(409, `"${v.name}" тэжээл аль хэдийн бүртгэгдсэн байна`);
      }
      await db.run('UPDATE expenses SET feed_name = ? WHERE farm_id = ? AND feed_name = ?', [v.name, farmId, old.name]);
      await db.run('UPDATE feed_usage SET feed_name = ? WHERE farm_id = ? AND feed_name = ?', [v.name, farmId, old.name]);
    },
    async beforeDelete(old, db, farmId) {
      const used = await db.one('SELECT 1 x FROM expenses WHERE farm_id = ? AND feed_name = ? UNION SELECT 1 FROM feed_usage WHERE farm_id = ? AND feed_name = ? LIMIT 1',
        [farmId, old.name, farmId, old.name]);
      if (used) throw new HttpError(409, `"${old.name}" тэжээлээр зардал/зарцуулалт бүртгэгдсэн тул устгах боломжгүй`);
    }
  },
  // Эмчилгээний төрөл: нэрийг солиход бүртгэлийн төрлийг хамт шинэчилнэ, ашигласан төрлийг устгахгүй
  treatment_types: {
    table: 'treatment_types', title: 'Эмчилгээний төрөл', settings: true, describe: v => v.name,
    fields: { name: { t: 'text', req: true, max: 100, label: 'Эмчилгээний төрөл' } },
    async prepare(v, db, farmId, id) {
      if (!id) return;
      const old = await db.one('SELECT name FROM treatment_types WHERE id = ? AND farm_id = ?', [id, farmId]);
      if (!old || old.name === v.name) return;
      if (await db.one('SELECT 1 x FROM treatment_types WHERE farm_id = ? AND name = ? AND id <> ?', [farmId, v.name, id])) {
        throw new HttpError(409, `"${v.name}" төрөл аль хэдийн бүртгэгдсэн байна`);
      }
      return c => c.run('UPDATE treatments SET kind = ? WHERE farm_id = ? AND kind = ?', [v.name, farmId, old.name]);
    },
    async beforeDelete(old, db, farmId) {
      if (await db.one('SELECT 1 x FROM treatments WHERE farm_id = ? AND kind = ? LIMIT 1', [farmId, old.name])) {
        throw new HttpError(409, `"${old.name}" төрлөөр эмчилгээ бүртгэгдсэн тул устгах боломжгүй`);
      }
    }
  },
  expense_types: {
    table: 'expense_types', title: 'Зардлын төрөл', settings: true, describe: v => v.name,
    fields: { name: { t: 'text', req: true, max: 100, label: 'Зардлын төрөл' } }
  },
  task_types: {
    table: 'task_types', title: 'Ажлын төрөл', settings: true, describe: v => v.name,
    fields: {
      name: { t: 'text', req: true, max: 100, label: 'Ажлын төрөл' },
      needs_animals: { t: 'int', min: 0, max: 1, label: 'Мал сонгох' }
    }
  },
  tag_colors: {
    table: 'tag_colors', title: 'ID өнгө', settings: true, describe: v => v.name,
    fields: { name: { t: 'text', req: true, max: 50, label: 'ID өнгө' } }
  },
  breeding: {
    table: 'breeding', title: 'Төллөлт', settings: true, describe: v => v.dam_name,
    fields: {
      species: { t: 'text', req: true, options: SPECIES, label: 'Малын төрөл' },
      dam_name: { t: 'text', req: true, max: 100, label: 'Эх малын нэр' },
      births_per_year: { t: 'num', max: 10, label: 'Жилд төллөх давтамж' },
      gestation: { t: 'text', max: 100, label: 'Хээлтэй байх хугацаа' },
      breeding_months: { t: 'text', max: 100, label: 'Хээлтүүлэх сар' },
      birthing_months: { t: 'text', max: 100, label: 'Төллөх сар' }
    }
  },
  partners: {
    table: 'partners', title: 'Хөрөнгө оруулагч', settings: true, describe: v => `${v.name} ${v.percent}%`,
    fields: {
      name: { t: 'text', max: 100, label: 'Нэр' },
      phone: { t: 'text', req: true, max: 20, label: 'Утас' },
      invested: { t: 'num', label: 'Оруулсан хөрөнгө' },
      percent: { t: 'num', req: true, max: 100, label: 'Ашгийн хувь (%)' },
      sources: { t: 'text', max: 2000, label: 'Хувийг хэнээс хасах' }, // JSON { partnerId: хувь } — хүснэгтэд хадгалагдахгүй
      payout_period: { t: 'text', options: PAYOUT_PERIODS, label: 'Олгох давтамж' },
      start_date: { t: 'date', label: 'Эхлэх огноо' },
      end_date: { t: 'date', label: 'Дуусах огноо' },
      note: { t: 'text', max: 500, label: 'Тэмдэглэл' }
    },
    // Нийт ашгийн хувь 100%-иас хэтрэхгүй; дуусах огноо эхлэхээс өмнө байж болохгүй
    async prepare(v, db, farmId, id) {
      const rawSources = v.sources; delete v.sources;
      // Хөрөнгө оруулагч вэбд бүртгүүлсэн (баталгаажсан) хэрэглэгч байх ёстой — нэрийг бүртгэлээс авна
      const phone = String(v.phone || '').replace(/\D/g, '').replace(/^976(?=\d{8}$)/, '');
      // Эзэмшигчийн мөр үргэлж фермийн эзэмшигчтэй холбоотой (хувь, хөрөнгө зэргийг л засна)
      const owner = id ? await db.one(`SELECT u.id, u.name, u.phone FROM partners p JOIN farms f ON f.id = p.farm_id JOIN users u ON u.id = f.owner_id
        WHERE p.id = ? AND p.farm_id = ? AND p.is_owner = 1`, [id, farmId]) : null;
      const u = owner || (/^\d{8}$/.test(phone) ? await db.one("SELECT id, name, phone FROM users WHERE phone = ? AND status = 'approved'", [phone]) : null);
      if (!u) throw new HttpError(400, `${v.phone} дугаараар бүртгүүлсэн (баталгаажсан) хэрэглэгч олдсонгүй. Хөрөнгө оруулагч эхлээд энэ вэбд бүртгүүлсэн байх ёстой`);
      if (await db.one('SELECT 1 x FROM partners WHERE farm_id = ? AND user_id = ? AND id <> ?', [farmId, u.id, id || 0])) {
        throw new HttpError(409, `${u.name} энэ фермийн хөрөнгө оруулагчаар аль хэдийн бүртгэгдсэн байна`);
      }
      v.user_id = u.id; v.name = u.name; v.phone = u.phone;
      if (v.start_date && v.end_date && v.end_date < v.start_date) throw new HttpError(400, 'Дуусах огноо эхлэх огнооноос өмнө байж болохгүй');
      const rows = await db.q('SELECT id, name, percent, is_owner FROM partners WHERE farm_id = ?', [farmId]);
      const me = rows.find(r => r.id === Number(id));
      const others = rows.filter(r => r !== me);
      const before = me?.percent || 0;
      const need = v.percent - before;
      // Хувь багассан: эзэмшигч биш бол чөлөөлөгдсөн хувь эзэмшигчид буцна
      if (need <= 1e-9) {
        const ownerRow = others.find(r => r.is_owner);
        if (!ownerRow || me?.is_owner || need > -1e-9) return undefined;
        const room = 100 - others.filter(r => !r.is_owner).reduce((s, r) => s + r.percent, 0) - v.percent;
        return c => c.run('UPDATE partners SET percent = ? WHERE id = ?', [roundPct(Math.min(ownerRow.percent - need, room)), ownerRow.id]);
      }
      // Хувь нэмэгдсэн: эхлээд хуваарилагдаагүй хувь, үлдсэнийг сонгосон хөрөнгө оруулагчдаас хасна.
      // Хувьтай ганц хөрөнгө оруулагч байвал түүнээс автоматаар хасна
      const free = Math.max(0, 100 - others.reduce((s, r) => s + r.percent, 0) - before);
      let picks = {};
      if (rawSources) { try { picks = JSON.parse(rawSources) || {}; } catch { throw new HttpError(400, 'Хувь хасах мэдээлэл буруу байна'); } }
      const holders = others.filter(r => r.percent > 0);
      if (!Object.keys(picks).length && holders.length === 1) picks = { [holders[0].id]: Math.max(0, need - free) };
      const take = [];
      for (const [pid, raw] of Object.entries(picks)) {
        const amount = Number(raw), from = others.find(r => r.id === Number(pid));
        if (!from || !Number.isFinite(amount) || amount < 0) throw new HttpError(400, 'Хувь хасах мэдээлэл буруу байна');
        if (amount > from.percent + 1e-9) throw new HttpError(400, `${from.name}-д ${from.percent}% л байна`);
        if (amount > 0) take.push({ from, amount });
      }
      const taken = take.reduce((s, t) => s + t.amount, 0);
      if (taken > need + 1e-9) throw new HttpError(400, `Хасах хувь (${roundPct(taken)}%) шаардлагатай хувиас (${roundPct(need)}%) их байна`);
      if (need - taken > free + 1e-9) throw new HttpError(400, `${roundPct(need - taken - free)}% дутуу байна. Аль хөрөнгө оруулагчаас хасахаа оруулна уу`);
      return async c => { for (const t of take) await c.run('UPDATE partners SET percent = ? WHERE id = ?', [roundPct(t.from.percent - t.amount), t.from.id]); };
    },
    // Хөрөнгө оруулагчийг устгахад түүний хувь эзэмшигчид буцна
    async beforeDelete(old, db, farmId) {
      if (await db.one('SELECT 1 x FROM expenses WHERE farm_id = ? AND paid_by = ? UNION SELECT 1 FROM animals WHERE farm_id = ? AND paid_by = ? LIMIT 1', [farmId, old.id, farmId, old.id])) {
        throw new HttpError(409, `${old.name} зардал төлсөн бүртгэлтэй тул устгах боломжгүй`);
      }
      if (old.is_owner) return;
      const ownerRow = await db.one('SELECT id, percent FROM partners WHERE farm_id = ? AND is_owner = 1', [farmId]);
      if (!ownerRow) return;
      const room = 100 - await otherInvestorsPercent(db, farmId, old.id);
      await db.run('UPDATE partners SET percent = ? WHERE id = ?', [roundPct(Math.min(ownerRow.percent + old.percent, room)), ownerRow.id]);
    }
  }
};

// Эрхийн модуль: [бичих эрх шалгах модуль(ууд), унших боломжтой модулиуд]
const RESOURCE_MODULES = {
  animals: ['animals', ['animals', 'growth', 'sell', 'weighings', 'slaughter']],
  weighings: ['weighings'],
  treatments: ['treatments'],
  expenses: ['expenses'],
  slaughters: [['sell', 'slaughter'], ['sell', 'slaughter']],
  sales: ['sales'],
  market_prices: ['market'],
  feed_plan: ['feed'],
  feed_recipes: ['feed'],
  feed_usage: ['feed'],
  feed_stock: ['feed', ['feed', 'expenses']],
  tasks: ['tasks']
};
for (const [k, [mod, readers]] of Object.entries(RESOURCE_MODULES)) {
  resources[k].module = mod;
  resources[k].readers = readers || [mod];
}

// MySQL алдааг хэрэглэгчид ойлгомжтой мессеж болгох
function mapDbError(err) {
  const code = err && err.code;
  if (code === 'ER_DUP_ENTRY') return new HttpError(409, 'Ийм бичлэг аль хэдийн бүртгэгдсэн байна (давхардсан утга)');
  if (code === 'ER_ROW_IS_REFERENCED_2' || code === 'ER_NO_REFERENCED_ROW_2') return new HttpError(409, 'Энэ бичлэг өөр бүртгэлтэй холбоотой тул устгах/өөрчлөх боломжгүй');
  if (code === 'ER_DATA_TOO_LONG') return new HttpError(400, 'Оруулсан утга хэт урт байна');
  return null;
}

module.exports = { resources, validate, HttpError, mapDbError, SPECIES, SEXES, TASK_STATUSES, FEED_TYPE, animalPurchaseExpenses, meatStock, withCurrentAgeName };

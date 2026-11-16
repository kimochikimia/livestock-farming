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
  const ref = a.slaughter_date && a.slaughter_date <= todayStr() ? a.slaughter_date : todayStr();
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
async function checkWeighing(v, db, farmId) {
  const a = await resolveTag(v, db, farmId);
  if (v.date < a.purchase_date) throw new HttpError(400, `${a.tag_id}: жинлэлтийн огноо (${v.date}) малыг авсан өдрөөс (${a.purchase_date}) өмнө байж болохгүй`);
  const s = await db.one('SELECT date FROM slaughters WHERE animal_id = ?', [a.id]);
  if (s && v.date > s.date) throw new HttpError(400, `${a.tag_id}: жинлэлтийн огноо (${v.date}) бойлох өдрөөс (${s.date}) хойш байж болохгүй`);
}
async function checkSlaughter(v, db, farmId) {
  const a = await resolveTag(v, db, farmId);
  if (v.date < a.purchase_date) throw new HttpError(400, `${a.tag_id}: бойлох өдөр (${v.date}) малыг авсан өдрөөс (${a.purchase_date}) өмнө байж болохгүй`);
  const last = (await db.one('SELECT MAX(date) d FROM weighings WHERE animal_id = ?', [a.id])).d;
  if (last && v.date < last) throw new HttpError(400, `${a.tag_id}: бойлох өдөр (${v.date}) сүүлийн жинлэлтийн огнооноос (${last}) өмнө байж болохгүй`);
  if (v.shipped_date && v.shipped_date < v.date) throw new HttpError(400, `${a.tag_id}: ачигдсан огноо (${v.shipped_date}) бойлох өдрөөс (${v.date}) өмнө байж болохгүй`);
}

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
      note: { t: 'text', max: 1000, label: 'Тэмдэглэл' },
      goal_weight: { t: 'num', max: 5000, label: 'Зорилтот жин' },
      goal_days: { t: 'int', min: 1, max: 3650, label: 'Хугацаа (хоног)' }
    },
    // Орлогын төрлөөс хамаарах талбарууд: Төл → эх мал; Бэлэг → зах зээлийн үнэ; Худалдаж авсан → авсан үнэ
    async prepare(v, db, farmId) {
      if (v.source !== 'Төл') v.mother_tag = null;
      if (v.source !== 'Бэлэг') v.market_value = null;
      if (v.source !== 'Худалдаж авсан') v.purchase_price = null;
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
          s.date AS slaughter_date, s.carcass_weight, s.shipped_date,
          (SELECT MAX(x.sold_date) FROM sales x WHERE x.farm_id = a.farm_id AND x.shipped_date = s.shipped_date) AS sold_date
        FROM animals a
        LEFT JOIN slaughters s ON s.animal_id = a.id
        WHERE a.farm_id = ?
        ORDER BY a.purchase_date DESC, a.id DESC`, [farmId]);
      const ctx = await ageContext(db, farmId);
      return rows.map(a => {
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
        // Бойлох өдөр ирээгүй бол "Товлосон" (хуваарьт орсон), өнгөрсөн бол "Бойлсон"
        const state = a.sold_date ? 'Зарагдсан' : !a.slaughter_date ? 'Идэвхтэй' : a.slaughter_date > todayStr() ? 'Товлосон' : 'Бойлсон';
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

  expenses: {
    table: 'expenses', title: 'Зардал', track: true, photos: true, describe: v => v.type,
    fields: {
      date: { t: 'date', req: true, label: 'Огноо' },
      type: { t: 'text', req: true, max: 100, label: 'Төрөл' },
      description: { t: 'text', max: 500, label: 'Тайлбар' },
      qty: { t: 'num', label: 'Тоо' },
      unit_price: { t: 'num', label: 'Нэгж үнэ' },
      supplier: { t: 'text', max: 200, label: 'Нийлүүлэгч' }
    },
    list: async (db, farmId) => (await db.q('SELECT *, COALESCE(qty, 0) * COALESCE(unit_price, 0) AS total FROM expenses WHERE farm_id = ? ORDER BY date DESC, id DESC', [farmId]))
  },

  slaughters: {
    table: 'slaughters', title: 'Бой', track: true, photos: true, describe: v => v.tag_id,
    fields: {
      date: { t: 'date', req: true, label: 'Бойлох өдөр' },
      tag_id: { t: 'text', req: true, max: 50, label: 'Малын ID' },
      carcass_weight: { t: 'num', max: 3000, label: 'Гулуузны жин' },
      shipped_date: { t: 'date', label: 'Худалдахаар ачигдсан огноо' }
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
    table: 'sales', title: 'Борлуулалт', track: true, photos: true, describe: v => v.shipped_date,
    fields: {
      shipped_date: { t: 'date', req: true, label: 'Ачигдсан огноо' },
      sold_date: { t: 'date', label: 'Зарсан өдөр' },
      sold_weight: { t: 'num', label: 'Борлуулсан жин' },
      price: { t: 'num', label: 'Зарсан үнэ (₮/кг)' },
      note: { t: 'text', max: 500, label: 'Тэмдэглэл' }
    },
    list: async (db, farmId) => (await db.q(`
      SELECT s.*,
        (SELECT COALESCE(SUM(x.carcass_weight), 0) FROM slaughters x WHERE x.farm_id = s.farm_id AND x.shipped_date = s.shipped_date) AS shipped_weight,
        (SELECT COUNT(*) FROM slaughters x WHERE x.farm_id = s.farm_id AND x.shipped_date = s.shipped_date) AS heads,
        COALESCE(s.sold_weight, 0) * COALESCE(s.price, 0) AS revenue
      FROM sales s WHERE s.farm_id = ? ORDER BY s.shipped_date DESC, s.id DESC`, [farmId]))
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
    table: 'feed_plan', title: 'Тэжээлийн төлөвлөгөө', describe: v => v.feed_name,
    fields: {
      feed_name: { t: 'text', req: true, max: 200, label: 'Тэжээлийн төрөл' },
      kg_1_14: { t: 'num', label: '1–14 хоног (кг/өдөр)' },
      kg_15_30: { t: 'num', label: '15–30 хоног (кг/өдөр)' },
      kg_31_90: { t: 'num', label: '31–90 хоног (кг/өдөр)' },
      price: { t: 'num', label: 'Нэг кг үнэ' }
    },
    list: async (db, farmId) => (await db.q('SELECT * FROM feed_plan WHERE farm_id = ? ORDER BY id', [farmId])).map(r => {
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
      price: { t: 'num', label: 'Үнэ ₮/кг' }
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
      name: { t: 'text', req: true, max: 100, label: 'Нэр' },
      phone: { t: 'text', max: 20, label: 'Утас' },
      invested: { t: 'num', label: 'Оруулсан хөрөнгө' },
      percent: { t: 'num', req: true, max: 100, label: 'Ашгийн хувь (%)' },
      payout_period: { t: 'text', options: PAYOUT_PERIODS, label: 'Олгох давтамж' },
      start_date: { t: 'date', label: 'Эхлэх огноо' },
      end_date: { t: 'date', label: 'Дуусах огноо' },
      note: { t: 'text', max: 500, label: 'Тэмдэглэл' }
    },
    // Нийт ашгийн хувь 100%-иас хэтрэхгүй; дуусах огноо эхлэхээс өмнө байж болохгүй
    async prepare(v, db, farmId, id) {
      if (v.start_date && v.end_date && v.end_date < v.start_date) throw new HttpError(400, 'Дуусах огноо эхлэх огнооноос өмнө байж болохгүй');
      const { s } = await db.one('SELECT COALESCE(SUM(percent), 0) s FROM partners WHERE farm_id = ? AND id <> ?', [farmId, id || 0]);
      if (s + v.percent > 100 + 1e-9) throw new HttpError(400, `Нийт ашгийн хувь 100%-иас хэтэрнэ (бусад: ${s}%, энэ: ${v.percent}%)`);
    }
  }
};

// Эрхийн модуль: [бичих эрх шалгах модуль(ууд), унших боломжтой модулиуд]
const RESOURCE_MODULES = {
  animals: ['animals', ['animals', 'growth', 'sell']],
  weighings: ['weighings'],
  expenses: ['expenses'],
  slaughters: [['sell', 'slaughter'], ['sell', 'slaughter']],
  sales: ['sales'],
  market_prices: ['market'],
  feed_plan: ['feed'],
  feed_recipes: ['feed'],
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

module.exports = { resources, validate, HttpError, mapDbError, SPECIES, SEXES, TASK_STATUSES };

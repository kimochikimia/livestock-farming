'use strict';
/* Түмэн Сүрэг Фарм — клиент тал (vanilla JS SPA) */

// ---------- Туслах функцууд ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// null / false утгыг алгасаж хүүхэд элементүүдийг солино (replaceChildren нь null-ийг "null" гэж хэвлэдэг)
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

// farmId: сонгосон ферм (энэ хөтөч дээр санагдана)
const FARM_KEY = 'tsf.farm';
const readFarm = () => { try { return Number(localStorage.getItem(FARM_KEY)) || null; } catch { return null; } };
const state = { user: null, lk: null, farmId: readFarm() };
function setFarm(id) {
  state.farmId = id || null;
  state.lk = null;
  try { if (id) localStorage.setItem(FARM_KEY, String(id)); else localStorage.removeItem(FARM_KEY); } catch { /* хувийн цонх */ }
}
// Фермийн эзэмшигч эсвэл админ — тухайн фермийн тохиргоог удирдана
const farmFull = () => state.user?.role === 'admin' || !!state.lk?.farm?.full;
const LEVEL = { viewer: 1, editor: 2, admin: 3 };
const can = min => !!state.user && LEVEL[state.user.role] >= LEVEL[min];
const ROLE_LABEL = { admin: 'Админ', editor: 'Дэд админ', viewer: 'Хэрэглэгч' };
// Цэс бүрийн эрх: 0 харахгүй, 1 харах, 2 нэмэх/засах, 3 бүрэн (устгах). Админ үргэлж 3.
const modLevel = mod => (state.lk?.perms?.[mod] ?? (state.user?.role === 'admin' ? 3 : 0));
const canMod = (mod, lvl = 1) => modLevel(mod) >= lvl;
const PERM_OPTIONS = [['none', 'Харахгүй'], ['view', 'Харах'], ['edit', 'Нэмэх, засах'], ['full', 'Бүрэн (устгах)']];
const STATUS_LABEL = { pending: 'Хүлээгдэж буй', approved: 'Баталгаажсан', rejected: 'Татгалзсан', blocked: 'Хаагдсан' };

async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (state.farmId) opt.headers['X-Farm-Id'] = String(state.farmId);
  if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body ?? {}); }
  let r;
  try { r = await fetch(url, opt); } catch { throw new Error('Сервертэй холбогдож чадсангүй'); }
  let data = null;
  try { data = await r.json(); } catch { /* хоосон */ }
  if (!r.ok) {
    if (r.status === 401 && state.user && !url.startsWith('/api/auth/')) { state.user = null; render(); }
    throw new Error(data?.error || `Алдаа гарлаа (${r.status})`);
  }
  return data;
}

function toast(msg, type = 'ok') {
  const t = h('div', { class: 'toast ' + type }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.classList.add('hide'), 3200);
  setTimeout(() => t.remove(), 3700);
}

// Гэнэтийн алдааг чимээгүй өнгөрөөхгүй — дэлгэцэнд мэдэгдэнэ
window.addEventListener('error', e => { if (e.message) toast('Алдаа гарлаа: ' + e.message, 'err'); });
window.addEventListener('unhandledrejection', e => { const m = e.reason?.message || String(e.reason || ''); if (m) toast('Алдаа гарлаа: ' + m, 'err'); });

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const FMT = {
  text: v => v ?? '',
  money: v => (v == null || v === '' ? '' : nf0.format(v) + ' ₮'),
  num: v => (v == null || v === '' ? '' : nf2.format(v)),
  kg: v => (v == null || v === '' ? '' : nf2.format(v) + ' кг'),
  pct: v => (v == null || v === '' ? '' : nf2.format(v) + '%'),
  date: v => v ?? '',
  dt: v => (v ? v.replace('T', ' ').slice(0, 16) : '')
};
const NUMERIC = new Set(['money', 'num', 'kg', 'pct']);

// ---------- Оронтой тоо оруулах талбар (1600000 → 1,600,000) ----------
const NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
function groupDigits(s) {
  s = String(s ?? '').replace(/[^\d.]/g, '');
  const i = s.indexOf('.');
  let int = i < 0 ? s : s.slice(0, i);
  const frac = i < 0 ? null : s.slice(i + 1).replace(/\./g, '');
  int = int.replace(/^0+(?=\d)/, '');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === null ? g : (g || '0') + '.' + frac;
}
// Дэлгэц дээр таслалтай харагдана, .value нь таслалгүй цэвэр тоо буцаана
function numberInput(attrs = {}, initial) {
  const el = h('input', { ...attrs, type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'num-input' });
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return NATIVE_VALUE.get.call(el).replace(/,/g, ''); },
    set(v) { NATIVE_VALUE.set.call(el, v == null || v === '' ? '' : groupDigits(v)); }
  });
  el.value = initial ?? '';
  el.addEventListener('input', () => {
    const raw = NATIVE_VALUE.get.call(el);
    const pos = el.selectionStart ?? raw.length;
    const before = raw.slice(0, pos).replace(/[^\d.]/g, '').length;
    const out = groupDigits(raw);
    NATIVE_VALUE.set.call(el, out);
    let p = 0, n = 0;
    while (p < out.length && n < before) { if (/[\d.]/.test(out[p])) n++; p++; }
    try { el.setSelectionRange(p, p); } catch { /* */ }
  });
  return el;
}

const BADGE = {
  'Борлуулах': 'green', 'Хүрээгүй': 'amber', 'Тохиргоо олдсонгүй': 'gray',
  'Төлөвлөсөн': 'blue', 'Хийгдсэн': 'green', 'Цуцалсан': 'gray', 'Хүлээгдэж буй': 'amber', 'Бүртгэсэн': 'green', 'Хүчинтэй': 'green', 'Эхлээгүй': 'blue', 'Дууссан': 'gray', 'Зарах малд': 'blue', 'Гараар нэмсэн': 'gray',
  'Идэвхтэй': 'blue', 'Товлосон': 'amber', 'Бойлсон': 'gray', 'Зарагдсан': 'green',
  pending: 'amber', approved: 'green', rejected: 'red', blocked: 'red'
};
const badge = (v, label) => (v ? h('span', { class: 'badge ' + (BADGE[v] || 'gray') }, label ?? v) : '');

// ---------- Навигаци ----------
const NAV = [
  { path: 'dashboard', farm: true, module: 'dashboard', label: 'Хянах самбар', icon: '▦' },
  { path: 'animals', farm: true, module: 'animals', label: 'Малын бүртгэл', icon: '◉' },
  { path: 'weighings', farm: true, module: 'weighings', label: 'Жинлэлт', icon: '⚖' },
  { path: 'growth', farm: true, module: 'growth', label: 'Өсөлтийн мэдээлэл', icon: '↑' },
  // "Борлуулалт" бүлэг — доторх цэсүүд дэд цэс болж харагдана
  { group: 'sales', farm: true, label: 'Борлуулалт', icon: '↗' },
  { path: 'sell', farm: true, parent: 'sales', module: 'sell', label: 'Зарах малын жагсаалт', icon: '✓' },
  { path: 'slaughter', farm: true, parent: 'sales', module: 'slaughter', label: 'Бойны жагсаалт', icon: '▤' },
  { path: 'sales', farm: true, parent: 'sales', module: 'sales', label: 'Борлуулалтын бүртгэл', icon: '₮' },
  { path: 'expenses', farm: true, module: 'expenses', label: 'Зардлын бүртгэл', icon: '₮' },
  { path: 'tasks', farm: true, module: 'tasks', label: 'Хуваарьт ажил', icon: '☑', badge: () => state.lk?.tasksDue },
  { path: 'feed', farm: true, module: 'feed', label: 'Тэжээл', icon: '❦' },
  { path: 'market', farm: true, module: 'market', label: 'Зах зээл', icon: '∿' },
  { path: 'settings', farm: true, full: true, label: 'Тохиргоо', icon: '⚙' },
  { section: 'Админ', min: 'admin' },
  { path: 'users', label: 'Хэрэглэгчид', icon: '☺', min: 'admin', badge: () => state.pendingUsers },
  { path: 'news', label: 'Мэдээ', icon: '✎', min: 'admin' },
  { path: 'audit', label: 'Үйлдлийн түүх', icon: '☰', min: 'admin' },
  { section: 'Миний' },
  { path: 'farms', label: 'Миний фермүүд', icon: '⌂' },
  { path: 'profile', label: 'Миний бүртгэл', icon: '◎' }
];
const currentPath = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || '');
const navAllowed = n => (n.farm && !state.lk ? false : n.full && !farmFull() ? false : n.module ? canMod(n.module, 1) : (!n.min || can(n.min)));

window.addEventListener('hashchange', () => { if (!state.user && location.hash.startsWith('#lp-')) return; render(); });
document.addEventListener('click', e => {
  if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar, .menu-btn')) document.body.classList.remove('nav-open');
});

async function loadLookups() { state.lk = await api('GET', '/api/lookups'); }

async function render() {
  const root = document.getElementById('app');
  if (!state.user) return renderLanding(root);
  const path = currentPath();
  const target = NAV.find(n => n.path === path);
  // "Миний фермүүд" = фермээс гарч, шинээр сонгох хуудас — фермийн цэсийг "Орох" дарсны дараа л харуулна
  if (path === 'farms' && state.farmId) setFarm(null);
  // Фермийн хуудас бол сонгосон фермийн мэдээллийг ачаална; ферм сонгоогүй/хандах эрхгүй бол фермийн жагсаалт руу
  if (!target || target.farm) {
    if (!state.farmId) { location.hash = '#/farms'; return; }
    try { await loadLookups(); }
    catch (e) {
      if (!state.user) return;
      setFarm(null); toast(e.message, 'err'); location.hash = '#/farms'; return;
    }
  }
  else if (state.farmId && !state.lk) {
    try { await loadLookups(); } catch { if (!state.user) return; setFarm(null); }
  }
  state.pendingUsers = state.lk?.pendingUsers ?? state.pendingUsers;
  const allowed = NAV.filter(n => n.path && navAllowed(n));
  const item = allowed.find(n => n.path === path);
  if (!item) { location.hash = '#/' + (allowed[0]?.path || 'farms'); return; }

  const main = h('main', { class: 'main' }, h('div', { class: 'loading' }, 'Ачаалж байна…'));
  const shell = h('div', { class: 'shell' }, sidebar(path), h('div', { class: 'content' }, topbar(item), main));
  root.replaceChildren(shell);
  try {
    await PAGES[path](main);
  } catch (e) {
    main.replaceChildren(h('div', { class: 'card error-card' }, e.message));
  }
}

function sidebar(path) {
  const farm = state.lk?.farm;
  return h('aside', { class: 'sidebar' },
    farm ? h('a', { class: 'farm-switch', href: '#/farms', title: 'Ферм солих' },
      h('span', { class: 'farm-switch-label' }, 'Ферм'),
      h('strong', {}, farm.name),
      !farm.mine && farm.owner_name ? h('span', { class: 'muted small' }, farm.owner_name) : null,
      h('span', { class: 'farm-switch-action' }, 'Солих ⇄')) : null,
    h('nav', {}, NAV.filter(n => !n.parent && (n.section ? (!n.min || can(n.min)) : n.group ? !(n.farm && !state.lk) : navAllowed(n))).map(n => {
      if (n.section) return h('div', { class: 'nav-section' }, n.section);
      if (n.group) return navGroup(n, path);
      return navLink(n, path);
    })),
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'who' }, h('strong', {}, state.user.name), h('span', {}, state.user.phone + ' · ' + ROLE_LABEL[state.user.role])),
      h('button', { class: 'btn ghost small', onclick: logout }, 'Гарах'))
  );
}

function navLink(n, path, sub) {
  const b = n.badge?.();
  return h('a', { href: '#/' + n.path, class: 'nav-link' + (sub ? ' sub' : '') + (n.path === path ? ' active' : ''), onclick: () => document.body.classList.remove('nav-open') },
    h('span', { class: 'nav-icon' }, n.icon), h('span', {}, n.label), b ? h('span', { class: 'nav-badge' }, b) : null);
}
// Дэд цэстэй бүлэг: дарахад нээгдэж/хаагдана; доторх хуудсан дээр байвал нээлттэй
const navOpen = {};
function navGroup(g, path) {
  const kids = NAV.filter(n => n.parent === g.group && navAllowed(n));
  if (!kids.length) return null;
  const activeInside = kids.some(n => n.path === path);
  const open = navOpen[g.group] ?? activeInside;
  const list = h('div', { class: 'nav-sub' }, kids.map(n => navLink(n, path, true)));
  list.hidden = !open;
  const btn = h('button', { type: 'button', class: 'nav-link nav-group' + (activeInside ? ' has-active' : ''), 'aria-expanded': String(open) },
    h('span', { class: 'nav-icon' }, g.icon), h('span', {}, g.label), h('span', { class: 'nav-caret' }, '▸'));
  btn.addEventListener('click', () => {
    navOpen[g.group] = list.hidden;
    list.hidden = !list.hidden;
    btn.setAttribute('aria-expanded', String(!list.hidden));
  });
  return h('div', { class: 'nav-group-wrap' }, btn, list);
}

function topbar(item) {
  return h('header', { class: 'topbar' },
    h('button', { class: 'menu-btn', 'aria-label': 'Цэс', onclick: () => document.body.classList.toggle('nav-open') }, '☰'),
    h('h1', {}, item.label),
    // Утсан дээр (цэс хаалттай үед) аль ферм дээр ажиллаж байгааг харуулна
    item.farm && state.lk?.farm ? h('a', { class: 'topbar-farm', href: '#/farms' }, state.lk.farm.name) : null);
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
  state.user = null; state.lk = null; location.hash = '#/'; render();
}

// ---------- Нүүр хуудас (нэвтрээгүй үед) ----------
const SITE_NAME = 'Livestock Farming';
const logoMark = (cls = '') => h('span', { class: 'logo ' + cls }, 'LF');

// Нэвтрэх / Бүртгүүлэх цонх
function openAuth(startMode = 'login') {
  let mode = startMode;
  const box = h('div', { class: 'auth-modal-body' });
  const draw = (notice) => {
    const msg = h('div', { class: 'form-msg' + (notice ? ' ok' : '') }, notice || '');
    const tabs = h('div', { class: 'tabs' },
      h('button', { type: 'button', class: 'tab' + (mode === 'login' ? ' active' : ''), onclick: () => { mode = 'login'; draw(); } }, 'Нэвтрэх'),
      h('button', { type: 'button', class: 'tab' + (mode === 'register' ? ' active' : ''), onclick: () => { mode = 'register'; draw(); } }, 'Бүртгүүлэх'));
    const phone = h('input', { name: 'phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', required: true, maxlength: 12 });
    const pw = h('input', { name: 'password', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'login' ? null : 8 });
    const name = h('input', { name: 'name', autocomplete: 'name', required: true, maxlength: 80 });
    const pw2 = h('input', { name: 'password2', type: 'password', autocomplete: 'new-password', required: true });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, mode === 'login' ? 'Нэвтрэх' : 'Бүртгүүлэх');
    const form = h('form', {
      onsubmit: async e => {
        e.preventDefault(); msg.className = 'form-msg'; msg.textContent = '';
        btn.disabled = true;
        try {
          if (mode === 'login') {
            const r = await api('POST', '/api/auth/login', { phone: phone.value, password: pw.value });
            state.user = r.user; dlg.close();
            if (!location.hash || location.hash === '#/') location.hash = '#/farms'; else render();
          } else {
            if (pw.value !== pw2.value) throw new Error('Нууц үг таарахгүй байна');
            const r = await api('POST', '/api/auth/register', { name: name.value, phone: phone.value, password: pw.value });
            mode = 'login'; draw(r.message);
          }
        } catch (err) { msg.className = 'form-msg err'; msg.textContent = err.message; }
        finally { btn.disabled = false; }
      }
    },
      mode === 'register' ? field('Нэр', name) : null,
      field('Утасны дугаар', phone),
      field('Нууц үг', pw),
      mode === 'register' ? field('Нууц үг давтах', pw2) : null,
      msg, btn);
    box.replaceChildren(tabs, form);
    (mode === 'register' ? name : phone).focus();
  };
  const dlg = modal(SITE_NAME, box);
  dlg.classList.add('auth-dialog');
  draw();
}

function renderLanding(root) {
  const nf = new Intl.NumberFormat('en-US');
  const statsBox = h('div', { class: 'lp-stats' }, h('div', { class: 'loading' }, 'Ачаалж байна…'));
  const speciesBox = h('div', { class: 'lp-species' });
  const newsBox = h('div', { class: 'lp-news' }, h('div', { class: 'loading' }, 'Ачаалж байна…'));
  const feature = (icon, title, text) => h('div', { class: 'lp-feature' }, h('span', { class: 'lp-feature-icon' }, icon), h('h3', {}, title), h('p', {}, text));

  root.replaceChildren(h('div', { class: 'landing' },
    h('header', { class: 'lp-top' },
      h('a', { class: 'lp-brand', href: '#/' }, logoMark(), h('span', {}, SITE_NAME)),
      h('nav', { class: 'lp-top-links' },
        h('a', { href: '#lp-about' }, 'Бидний тухай'),
        h('a', { href: '#lp-stats' }, 'Тоон мэдээлэл'),
        h('a', { href: '#lp-news' }, 'Мэдээ')),
      h('div', { class: 'lp-auth' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => openAuth('login') }, 'Нэвтрэх'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openAuth('register') }, 'Бүртгүүлэх'))),

    h('section', { class: 'lp-hero' },
      h('div', { class: 'lp-hero-text' },
        h('h1', {}, 'Малын аж ахуйгаа нэг дороос удирд'),
        h('p', {}, 'Livestock Farming нь мал бордох, маллах ферм эрхлэгчдэд зориулсан бүртгэл, хяналтын систем юм. Мал бүрийн жин, өсөлт, зардал, борлуулалт, бой, хуваарьт ажлаа нэг дороос хөтөлж, ашиг орлогоо тооцоолно.'),
        h('div', { class: 'lp-hero-cta' },
          h('button', { class: 'btn primary lg', type: 'button', onclick: () => openAuth('register') }, 'Үнэгүй бүртгүүлэх'),
          h('button', { class: 'btn ghost lg', type: 'button', onclick: () => openAuth('login') }, 'Нэвтрэх'))),
      h('div', { class: 'lp-hero-art', 'aria-hidden': 'true' },
        h('span', { class: 'lp-art-tag' }, 'Жишээ дэлгэц'),
        h('div', { class: 'lp-art-card' }, h('span', {}, 'Сүүлийн жин'), h('strong', {}, '256 кг'), h('em', {}, '+94 кг · 0.85 кг/өдөр')),
        h('div', { class: 'lp-art-card' }, h('span', {}, 'Зорилтын төлөв'), h('strong', { class: 'ok' }, 'Борлуулах')),
        h('div', { class: 'lp-art-card' }, h('span', {}, 'Ашиг'), h('strong', {}, '2,477,500 ₮')))),

    h('section', { class: 'lp-section', id: 'lp-stats' },
      h('h2', {}, 'Системд бүртгэгдсэн'),
      statsBox, speciesBox),

    h('section', { class: 'lp-section', id: 'lp-about' },
      h('h2', {}, 'Сайтын тухай'),
      h('p', { class: 'lp-lead' }, 'Хэрэглэгч бүртгүүлж, админаар баталгаажсаны дараа хүссэн тооны ферм үүсгэнэ. Ферм бүрийн бүртгэл тусдаа хадгалагдах ба фермээ ажилчидтайгаа эрх тохируулан хуваалцаж болно.'),
      h('div', { class: 'lp-features' },
        feature('◉', 'Малын бүртгэл', 'Мал бүрийн ID, төрөл, нас, хүйс, авсан үнэ, зорилтот жин, зураг.'),
        feature('⚖', 'Жинлэлт ба өсөлт', 'Жинлэлт бүрээс өсөлт, өдрийн өсөлт, зорилтод хүрэх хугацаа автоматаар тооцогдоно.'),
        feature('✓', 'Зарах мал ба бой', 'Зорилтот жинд хүрсэн мал, бойн хуваарь, гулуузны жин, гарцын хувь.'),
        feature('₮', 'Зардал ба борлуулалт', 'Зардал, борлуулалтын орлого, ашиг, хувьцаа эзэмшигчдийн ашиг хуваарилалт.'),
        feature('☑', 'Хуваарьт ажил', 'Жинлэх өдөр, вакцин гэх мэт ажлыг давтамжтайгаар төлөвлөж, сануулга авна.'),
        feature('⌂', 'Олон ферм, хамтын ажиллагаа', 'Олон ферм үүсгэж, хэрэглэгч бүрт цэс тус бүрээр эрх олгоно.'))),

    h('section', { class: 'lp-section', id: 'lp-news' },
      h('h2', {}, 'Мэдээ мэдээлэл'),
      newsBox),

    h('footer', { class: 'lp-footer' },
      h('span', {}, '© ' + new Date().getFullYear() + ' ' + SITE_NAME),
      h('button', { class: 'linkish', type: 'button', onclick: () => openAuth('login') }, 'Нэвтрэх'))));

  // Тоон мэдээлэл
  api('GET', '/api/public/stats').then(st => {
    const stat = (n, label) => h('div', { class: 'lp-stat' }, h('strong', {}, nf.format(n)), h('span', {}, label));
    statsBox.replaceChildren(
      stat(st.farms, 'ферм'),
      stat(st.users, 'хэрэглэгч'),
      stat(st.activeAnimals, 'идэвхтэй мал'),
      stat(st.animals, 'нийт бүртгэсэн мал'),
      stat(st.weighings, 'жинлэлт'),
      stat(st.tasksDone, 'гүйцэтгэсэн ажил'));
    speciesBox.replaceChildren(...st.bySpecies.map(r => h('span', { class: 'lp-chip' }, `${r.species} ${nf.format(r.n)}`)));
  }).catch(() => statsBox.replaceChildren(h('p', { class: 'muted' }, 'Мэдээлэл ачаалж чадсангүй')));

  // Мэдээ
  api('GET', '/api/public/news').then(list => {
    if (!list.length) return newsBox.replaceChildren(h('p', { class: 'muted' }, 'Одоогоор мэдээ алга'));
    newsBox.replaceChildren(...list.map(n => {
      const long = n.body.length > 260;
      const body = h('p', { class: 'lp-news-body' }, long ? n.body.slice(0, 260) + '…' : n.body);
      return h('article', { class: 'lp-news-item' },
        h('time', {}, String(n.created_at).slice(0, 10)),
        h('h3', {}, n.title),
        body,
        long ? h('button', { class: 'linkish', type: 'button', onclick: e => { body.textContent = n.body; e.target.remove(); } }, 'Дэлгэрэнгүй') : null);
    }));
  }).catch(() => newsBox.replaceChildren(h('p', { class: 'muted' }, 'Мэдээ ачаалж чадсангүй')));
}

function field(label, control, help) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, help ? h('span', { class: 'help' }, help) : null);
}

// ---------- Хүснэгтийн эрэмбэлэлт, баганаар хайх ----------
// Хоосон утга үргэлж сүүлд; тоо бол тоогоор, бусад нь монгол цагаан толгойгоор
function compareValues(a, b) {
  const ea = a == null || a === '', eb = b == null || b === '';
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
  const na = typeof a === 'number' ? a : Number(a), nb = typeof b === 'number' ? b : Number(b);
  if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb;
  return String(a).localeCompare(String(b), 'mn', { numeric: true });
}
// Тусгай (crudSection-ээс бусад) хүснэгтэд DOM түвшинд эрэмбэлэлт + баганы хайлт нэмнэ.
// tbody-г дахин зурахад (MutationObserver) шүүлт, эрэмбэлэлтийг автоматаар дахин хэрэглэнэ.
function enhanceTable(table) {
  const head = table.tHead?.rows[0];
  const tbody = table.tBodies[0];
  if (!head || !tbody) return table;
  const ths = [...head.cells];
  const sortState = { i: -1, dir: 1 };
  const filters = ths.map(() => '');
  const textOf = (tr, i) => {
    const td = tr.cells[i];
    if (!td) return '';
    const inp = td.querySelector('input, select');
    return (inp ? inp.value : td.textContent).trim();
  };
  const sortKey = t => { const n = Number(t.replace(/[^\d.-]/g, '')); return /\d/.test(t) && /^[\d\s,.\-₮%кг/]+$/i.test(t.replace(/\s+/g, ' ')) && !isNaN(n) ? n : t; };
  let busy = false;
  const headLabels = ths.map(th => th.textContent.replace(/[▲▼]/g, '').trim());
  function apply() {
    busy = true;
    const rows = [...tbody.rows].filter(tr => !tr.querySelector('td.empty'));
    // Утсан дээр карт хэлбэрээр харуулахад нүд бүрт баганын нэр
    for (const tr of rows) [...tr.cells].forEach((td, i) => { if (!td.hasAttribute('data-label') && headLabels[i]) td.setAttribute('data-label', headLabels[i]); });
    if (sortState.i >= 0) {
      rows.sort((a, b) => sortState.dir * compareValues(sortKey(textOf(a, sortState.i)), sortKey(textOf(b, sortState.i))));
      for (const tr of rows) tbody.append(tr);
    }
    for (const tr of rows) tr.hidden = !filters.every((q, i) => !q || textOf(tr, i).toLowerCase().includes(q));
    obs.takeRecords();
    busy = false;
  }
  const obs = new MutationObserver(() => { if (!busy) apply(); });
  obs.observe(tbody, { childList: true });
  ths.forEach((th, i) => {
    const label = th.textContent.trim();
    if (!label) return;
    th.classList.add('sortable');
    th.title = 'Эрэмбэлэх';
    const arrow = h('span', { class: 'sort-arrow' });
    th.append(arrow);
    th.addEventListener('click', () => {
      if (sortState.i === i) { if (sortState.dir === 1) sortState.dir = -1; else sortState.i = -1; }
      else { sortState.i = i; sortState.dir = 1; }
      head.querySelectorAll('.sort-arrow').forEach(x => { x.textContent = ''; });
      if (sortState.i === i) arrow.textContent = sortState.dir === 1 ? '▲' : '▼';
      apply();
    });
  });
  table.tHead.append(h('tr', { class: 'filter-row' }, ths.map((th, i) => h('th', {},
    th.textContent.replace(/[▲▼]/g, '').trim()
      ? h('input', { type: 'search', class: 'col-filter', 'aria-label': 'Хайх', oninput: e => { filters[i] = e.target.value.trim().toLowerCase(); apply(); } })
      : null))));
  apply();
  return table;
}

// ---------- Ерөнхий хүснэгт + маягт ----------
/*
 cfg: { res, title, columns:[{k,label,f,render,cls}], fields:[{k,label,type,req,options(values),dependsOn,def,help,full}],
        write, filters:[{k,label,options}], totals:[k], onChange, addLabel, empty }
*/
async function crudSection(container, cfg) {
  const rows = await api('GET', '/api/r/' + cfg.res);
  if (cfg.photos && !cfg._photoCol) { cfg.columns = [photoColumn(cfg.res), ...cfg.columns]; cfg._photoCol = true; }
  const canWrite = !cfg.readonly && (cfg.module ? canMod(cfg.module, 2) : farmFull());
  const canDel = cfg.module ? canMod(cfg.module, 3) : farmFull();
  const st = cfg._st || (cfg._st = { q: '', filters: {}, colf: {}, sort: null });
  const refresh = cfg.onChange || (() => crudSection(container, cfg));
  // Мөр бүрт "Засах / Устгах" товч (тохиргооны хүснэгтүүдэд)
  // Гараар оруулдаг бүх хүснэгтэд мөр бүрт "Засах / Устгах" (тооцоолсон, зөвхөн харах хүснэгтэд — үгүй)
  const showActions = cfg.rowActions !== false && canWrite;
  async function removeRow(r) {
    if (!confirm('Энэ бичлэгийг устгах уу? Буцаах боломжгүй.')) return;
    try { await api('DELETE', `/api/r/${cfg.res}/${r.id}`); toast('Устгалаа'); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  }
  const actionCell = r => h('td', { class: 'row-actions' },
    h('button', { type: 'button', class: 'btn ghost small', onclick: e => { e.stopPropagation(); openForm(cfg, r, refresh, canDel); } }, 'Засах'),
    canDel ? h('button', { type: 'button', class: 'btn danger small', onclick: e => { e.stopPropagation(); removeRow(r); } }, 'Устгах') : null);

  const tbody = h('tbody'); const tfoot = h('tfoot'); const count = h('span', { class: 'muted small' });
  let thead = null;
  // Нүдэнд харагдаж буй текст (хайлтад ашиглана): түүхий утга + форматласан утга
  const cellText = (c, r) => {
    const raw = r[c.k] ?? '';
    const shown = c.csv ? c.csv(r) : (c.f ? FMT[c.f](r[c.k]) : raw);
    return (String(raw) + ' ' + String(shown ?? '')).toLowerCase();
  };
  const filtered = () => {
    const list = rows.filter(r =>
      (!st.q || cfg.columns.some(c => String(r[c.k] ?? '').toLowerCase().includes(st.q))) &&
      Object.entries(st.filters).every(([k, v]) => !v || String(r[k] ?? '') === v) &&
      Object.entries(st.colf).every(([k, q]) => { const c = cfg.columns.find(x => x.k === k); return !q || !c || cellText(c, r).includes(q); }));
    if (st.sort) {
      const { k, dir } = st.sort;
      list.sort((a, b) => dir * compareValues(a[k], b[k]));
    }
    return list;
  };

  function draw() {
    const list = filtered();
    tbody.replaceChildren(...list.map(r => h('tr', {
      class: canWrite ? 'clickable' : null,
      onclick: canWrite ? () => openForm(cfg, r, refresh, canDel) : null
    }, cfg.columns.map(c => h('td', { class: (c.cls || '') + (NUMERIC.has(c.f) ? ' num' : ''), 'data-label': c.label },
      c.render ? c.render(r) : FMT[c.f || 'text'](r[c.k]))), showActions ? actionCell(r) : null)));
    if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: cfg.columns.length + (showActions ? 1 : 0), class: 'empty' }, cfg.empty || 'Бичлэг алга')));
    tfoot.replaceChildren();
    if (cfg.totals && list.length) {
      tfoot.append(h('tr', {}, cfg.columns.map((c, i) => {
        if (cfg.totals.includes(c.k)) return h('td', { class: 'num', 'data-label': c.label }, FMT[c.f || 'num'](list.reduce((s, r) => s + (Number(r[c.k]) || 0), 0)));
        return h('td', {}, i === 0 ? 'Нийт' : '');
      }), showActions ? h('td') : null));
    }
    count.textContent = list.length + ' бичлэг';
  }

  const search = h('input', { type: 'search', class: 'search', placeholder: 'Хайх…', value: st.q, oninput: e => { st.q = e.target.value.trim().toLowerCase(); draw(); } });
  const filterEls = (cfg.filters || []).map(f => {
    const opts = typeof f.options === 'function' ? f.options(rows) : f.options;
    return h('select', { class: 'filter', onchange: e => { st.filters[f.k] = e.target.value; draw(); } },
      h('option', { value: '' }, f.label + ': бүгд'),
      opts.map(o => h('option', { value: o, selected: st.filters[f.k] === String(o) }, o)));
  });

  const toolbar = h('div', { class: 'toolbar' },
    cfg.title ? h('h2', {}, cfg.title) : null,
    h('div', { class: 'toolbar-right' },
      search, filterEls,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => exportCsv(cfg, filtered()) }, 'CSV татах'),
      canWrite && !cfg.noAdd ? h('button', { class: 'btn primary small', type: 'button', onclick: () => openForm(cfg, null, refresh, canDel) }, cfg.addLabel || '+ Нэмэх') : null));

  container.replaceChildren(
    h('section', { class: 'card' },
      toolbar,
      h('div', { class: 'table-wrap' },
        h('table', { class: 'data' }, thead = h('thead', {},
          h('tr', {}, cfg.columns.map(c => {
            if (!c.label) return h('th', {});
            const arrow = h('span', { class: 'sort-arrow' });
            const th = h('th', { class: 'sortable' + (NUMERIC.has(c.f) ? ' num' : ''), title: 'Эрэмбэлэх', onclick: () => {
              st.sort = st.sort?.k === c.k ? (st.sort.dir === 1 ? { k: c.k, dir: -1 } : null) : { k: c.k, dir: 1 };
              thead.querySelectorAll('.sort-arrow').forEach(x => { x.textContent = ''; });
              arrow.textContent = st.sort?.k === c.k ? (st.sort.dir === 1 ? '▲' : '▼') : '';
              draw();
            } }, h('span', { class: 'th-label' }, c.label), arrow);
            if (st.sort?.k === c.k) arrow.textContent = st.sort.dir === 1 ? '▲' : '▼';
            return th;
          }), showActions ? h('th', { class: 'row-actions' }, '') : null),
          h('tr', { class: 'filter-row' }, cfg.columns.map(c => h('th', {}, c.label
            ? h('input', { type: 'search', class: 'col-filter', 'aria-label': c.label + ' хайх', value: st.colf[c.k] || '',
                oninput: e => { st.colf[c.k] = e.target.value.trim().toLowerCase(); draw(); } })
            : null)), showActions ? h('th', {}) : null)), tbody, tfoot)),
      h('div', { class: 'table-foot' }, count)));
  draw();
}

function exportCsv(cfg, rows) {
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cfg.columns.map(c => esc(c.label)).join(',')];
  for (const r of rows) lines.push(cfg.columns.map(c => esc(c.csv ? c.csv(r) : r[c.k])).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${cfg.res}-${today()}.csv` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function modal(title, body, actions) {
  const dlg = h('dialog', { class: 'modal' });
  const close = () => dlg.close();
  dlg.append(h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Хаах', onclick: close }, '×')), body);
  if (actions) dlg.append(actions);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// Санал болгох жагсаалт (хөтчийн datalist-ийн оронд): талбарын доор (зай хүрэхгүй бол дээр) нээгдэнэ,
// бичсэн текстээр шүүнэ, сумаар шилжиж Enter-ээр сонгоно. Сонгоход input + change үзэгдэл үүсгэнэ.
function combo(input, getItems) {
  let list = null, items = [], active = -1;
  // Гүйлгэх, гар (keyboard) гарч дэлгэц өөрчлөгдөхөд хаахгүй — талбарыг дагаж байрлалаа шинэчилнэ
  const follow = () => { if (list) place(); };
  const close = () => {
    list?.remove(); list = null; active = -1;
    window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true);
    window.visualViewport?.removeEventListener('resize', follow);
  };
  const pick = s => { input.value = s; close(); input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); };
  const place = () => {
    const r = input.getBoundingClientRect();
    // Утсан дээр гар гарсан үед харагдах өндөр нь visualViewport
    const vh = window.visualViewport?.height || window.innerHeight;
    if (r.bottom < 0 || r.top > vh) { close(); return; }
    const below = vh - r.bottom - 8, above = r.top - 8;
    const up = below < 160 && above > below;
    Object.assign(list.style, { left: r.left + 'px', width: r.width + 'px', maxHeight: Math.max(120, Math.min(260, up ? above : below)) + 'px',
      top: up ? '' : r.bottom + 4 + 'px', bottom: up ? window.innerHeight - r.top + 4 + 'px' : '' });
  };
  const highlight = () => [...(list?.children || [])].forEach((li, i) => {
    li.classList.toggle('active', i === active);
    if (i === active) li.scrollIntoView({ block: 'nearest' });
  });
  function open(filter) {
    const q = filter ? input.value.trim().toLowerCase() : '';
    items = getItems().filter(s => !q || String(s).toLowerCase().includes(q));
    if (!items.length) { close(); return; }
    if (!list) {
      list = h('ul', { class: 'combo-list', role: 'listbox' });
      (input.closest('dialog') || document.body).append(list);
      window.addEventListener('resize', follow); window.addEventListener('scroll', follow, true);
      window.visualViewport?.addEventListener('resize', follow);
    }
    active = -1;
    list.replaceChildren(...items.map(s => h('li', {
      role: 'option', class: s === input.value ? 'selected' : null,
      onmousedown: e => { e.preventDefault(); pick(s); }
    }, s)));
    place();
  }
  input.addEventListener('click', () => (list ? close() : open(false)));
  input.addEventListener('input', e => { if (e.isTrusted) open(true); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list) { open(false); return; }
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      highlight();
    } else if (e.key === 'Enter' && list && active >= 0) { e.preventDefault(); pick(items[active]); }
    else if (e.key === 'Escape' && list) { e.preventDefault(); e.stopPropagation(); close(); }
  });
}

function openForm(cfg, row, onDone, canDel) {
  const isEdit = !!row;
  if (isEdit && cfg.fields.some(f => f.createOnly)) cfg = { ...cfg, fields: cfg.fields.filter(f => !f.createOnly) };
  // "section" = гарчиг, "info" = автоматаар тооцоолсон утга (илгээгдэхгүй)
  const DISPLAY = new Set(['section', 'info']);
  const inputs = cfg.fields.filter(f => !DISPLAY.has(f.type));
  const values = {};
  for (const f of inputs) {
    if (isEdit) values[f.k] = row[f.k] ?? '';
    else values[f.k] = typeof f.def === 'function' ? f.def() : (f.def ?? '');
  }
  const ctrls = {};
  const infos = [];
  const wrappers = {};
  const refreshInfo = () => {
    for (const { f, el } of infos) el.textContent = f.compute(values) ?? '—';
    for (const f of cfg.fields) if (f.showIf && wrappers[f.k]) wrappers[f.k].hidden = !f.showIf(values);
  };
  const err = h('div', { class: 'form-msg' });

  function buildControl(f) {
    let el;
    const v = values[f.k];
    if (f.type === 'select') {
      const opts = f.options(values);
      el = h('select', { name: f.k, required: f.req },
        h('option', { value: '' }, '— сонгох —'),
        opts.map(([val, label]) => h('option', { value: val, selected: String(val) === String(v) }, label)));
      if (v !== '' && v != null && !opts.some(([val]) => String(val) === String(v))) {
        el.append(h('option', { value: v, selected: true }, String(v)));
      }
      // Сонголт байхгүй бол шалтгааныг жагсаалт дотор харуулна
      if (!opts.length && f.emptyText) el.append(h('option', { value: '', disabled: true }, f.emptyText(values)));
    } else if (f.type === 'textarea') {
      el = h('textarea', { name: f.k, rows: 2, maxlength: 1000 }); el.value = v ?? '';
    } else if (f.type === 'multi') {
      // Олон утга чагтлан сонгох (утга нь таслалаар тусгаарлагдсан мөр)
      const selected = new Set(String(v ?? '').split(',').map(x => x.trim()).filter(Boolean));
      const opts = [...new Set([...f.options(values), ...selected])];
      const boxes = opts.map(o => { const cb = h('input', { type: 'checkbox', value: o }); cb.checked = selected.has(o); return h('label', { class: 'chip' }, cb, o); });
      const all = h('input', { type: 'checkbox' });
      all.checked = opts.length > 0 && boxes.every(l => l.firstChild.checked);
      all.addEventListener('change', () => boxes.forEach(l => { l.firstChild.checked = all.checked; }));
      el = h('div', { class: 'multi' },
        opts.length ? h('label', { class: 'chip all' }, all, 'Бүгд') : h('span', { class: 'muted small' }, 'Идэвхтэй мал алга'),
        boxes);
      Object.defineProperty(el, 'value', {
        get: () => boxes.filter(l => l.firstChild.checked).map(l => l.firstChild.value).join(', '),
        set: x => { const s2 = new Set(String(x ?? '').split(',').map(y => y.trim())); boxes.forEach(l => { l.firstChild.checked = s2.has(l.firstChild.value); }); }
      });
    } else if (f.type === 'number' && !f.plain) {
      el = numberInput({ name: f.k, required: f.req }, v);
    } else {
      el = h('input', {
        name: f.k, type: f.type || 'text', required: f.req, step: f.type === 'number' ? 'any' : null,
        min: f.min ?? (f.type === 'number' ? 0 : null), max: f.max, maxlength: f.maxlength,
        inputmode: f.type === 'number' ? 'decimal' : null, autocomplete: f.suggest ? 'off' : null,
        class: f.suggest ? 'combo-input' : null, readonly: f.readonly
      });
      el.value = v ?? '';
      if (f.suggest) {
        // Сонгох жагсаалт шиг: дарахад санал болгох утгууд талбарын доор нээгдэнэ (гараар бичих боломжтой хэвээр)
        combo(el, () => [...new Set(f.suggest(values).filter(Boolean))]);
        const wrap = h('div', { class: 'with-list' }, el);
        Object.defineProperty(wrap, 'value', { get: () => el.value, set: x => { el.value = x; } });
        // Жагсаалтаас сонгомогц (input) шууд холбогдох талбаруудыг бөглөнө
        el.addEventListener('input', () => { values[f.k] = el.value; f.onPick?.(values, ctrls); refreshInfo(); });
        el.addEventListener('change', () => { values[f.k] = el.value; f.onPick?.(values, ctrls); refreshInfo(); });
        return wrap;
      }
    }
    el.addEventListener('input', () => { values[f.k] = el.value; refreshInfo(); });
    el.addEventListener('change', () => {
      values[f.k] = el.value;
      for (const d of cfg.fields.filter(x => x.dependsOn === f.k)) {
        if (!d.keepOnChange) values[d.k] = '';
        const n = buildControl(d); ctrls[d.k].replaceWith(n); ctrls[d.k] = n;
      }
      f.onChange?.(values, ctrls);
      refreshInfo();
    });
    return el;
  }

  const grid = h('div', { class: 'form-grid' });
  for (const f of cfg.fields) {
    if (f.type === 'section') { grid.append(h('div', { class: 'form-section full' }, f.label)); continue; }
    if (f.type === 'info') {
      const el = h('span', { class: 'info-value' });
      infos.push({ f, el });
      grid.append(h('div', { class: 'field info' }, h('span', { class: 'field-label' }, f.label), el));
      continue;
    }
    ctrls[f.k] = buildControl(f);
    // Олон сонголттой талбарыг <label>-д хийвэл хоосон зай дарахад чагт солигдоно — div ашиглана
    const lab = f.type === 'multi'
      ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, f.label + (f.req ? ' *' : '')), ctrls[f.k])
      : field(f.label + (f.req ? ' *' : ''), ctrls[f.k], f.help);
    wrappers[f.k] = lab;
    if (f.full) lab.classList.add('full');
    grid.append(lab);
  }
  refreshInfo();

  const photos = cfg.photos ? photoPanel(cfg.res, row?.id) : null;
  if (photos) grid.append(photos.el);
  let saved = false;

  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Хадгалах');
  const form = h('form', { class: 'modal-body' }, grid, err);
  const actions = h('div', { class: 'modal-actions' },
    isEdit && canDel ? h('button', { class: 'btn danger', type: 'button', onclick: del }, 'Устгах') : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Болих'),
    save);
  form.append(actions);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    for (const f of inputs) values[f.k] = ctrls[f.k].value;
    const body = {};
    for (const f of inputs) if (!f.virtual) body[f.k] = values[f.k] === '' || (f.showIf && !f.showIf(values)) ? null : values[f.k];
    save.disabled = true; err.className = 'form-msg'; err.textContent = '';
    try {
      if (isEdit) await api('PUT', `/api/r/${cfg.res}/${row.id}`, body);
      else {
        const r = await api('POST', `/api/r/${cfg.res}`, body);
        if (photos) { save.textContent = 'Зураг хуулж байна…'; await photos.flush(r.id); }
      }
      saved = true; dlg.close(); toast('Хадгаллаа'); onDone();
    } catch (ex) { err.className = 'form-msg err'; err.textContent = ex.message; save.disabled = false; save.textContent = 'Хадгалах'; }
  });
  async function del() {
    if (!confirm('Энэ бичлэгийг устгах уу? Буцаах боломжгүй.')) return;
    try { await api('DELETE', `/api/r/${cfg.res}/${row.id}`); dlg.close(); toast('Устгалаа'); onDone(); }
    catch (ex) { err.className = 'form-msg err'; err.textContent = ex.message; }
  }
  const dlg = modal((isEdit ? 'Засах: ' : 'Шинэ: ') + (cfg.itemName || cfg.title || ''), form);
  dlg.addEventListener('close', () => { photos?.dispose(); if (!saved && photos?.changed) onDone(); });
}

// ---------- Зураг ----------
// Утасны том зургийг илгээхээс өмнө 1600px хүртэл багасгаж JPEG болгоно
async function compressImage(file, max = 1600, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
    if (blob) return blob;
  } catch { /* доорх нөөц арга */ }
  if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
  throw new Error('Энэ зургийн төрлийг уншиж чадсангүй');
}

async function uploadPhoto(res, id, file) {
  const blob = await compressImage(file);
  let r;
  try { r = await fetch(`/api/photos/${res}/${id}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg', 'X-Farm-Id': String(state.farmId) }, body: blob, credentials: 'same-origin' }); }
  catch { throw new Error('Зураг илгээж чадсангүй'); }
  if (!r.ok) { let d = null; try { d = await r.json(); } catch { /* */ } throw new Error(d?.error || 'Зураг илгээж чадсангүй'); }
}

function thumb(src, onOpen, onDel) {
  return h('div', { class: 'thumb' },
    h('img', { src, loading: 'lazy', alt: '', onclick: onOpen }),
    onDel ? h('button', { type: 'button', class: 'thumb-del', 'aria-label': 'Устгах', onclick: e => { e.stopPropagation(); onDel(); } }, '×') : null);
}

function lightbox(urls, start = 0) {
  let i = start;
  const img = h('img', { class: 'lightbox-img', alt: '' });
  const counter = h('span', { class: 'lightbox-count' });
  const show = () => { img.src = urls[i]; counter.textContent = urls.length > 1 ? `${i + 1} / ${urls.length}` : ''; };
  const step = d => { i = (i + d + urls.length) % urls.length; show(); };
  const dlg = h('dialog', { class: 'lightbox' },
    img,
    urls.length > 1 ? h('button', { type: 'button', class: 'lb-btn lb-prev', 'aria-label': 'Өмнөх', onclick: () => step(-1) }, '‹') : null,
    urls.length > 1 ? h('button', { type: 'button', class: 'lb-btn lb-next', 'aria-label': 'Дараах', onclick: () => step(1) }, '›') : null,
    h('button', { type: 'button', class: 'lb-btn lb-close', 'aria-label': 'Хаах', onclick: () => dlg.close() }, '×'),
    counter);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); show(); dlg.showModal();
}

async function openRecordPhotos(res, id) {
  try {
    const list = await api('GET', `/api/photos/${res}/${id}`);
    if (list.length) lightbox(list.map(p => `/api/photo/${p.id}`));
  } catch (e) { toast(e.message, 'err'); }
}

function photoPanel(res, recordId) {
  let currentId = recordId || null;
  let existing = [];
  let changed = false;
  const pending = [];
  const grid = h('div', { class: 'photo-grid' });
  const status = h('span', { class: 'photo-status' });
  const mkInput = capture => {
    const inp = h('input', { type: 'file', accept: 'image/*', multiple: capture ? null : true, capture: capture ? 'environment' : null, class: 'visually-hidden', tabindex: '-1' });
    inp.addEventListener('change', () => { const files = [...inp.files]; inp.value = ''; add(files); });
    return inp;
  };
  const pick = mkInput(false), cam = mkInput(true);

  async function load() {
    if (currentId) existing = await api('GET', `/api/photos/${res}/${currentId}`);
    draw();
  }
  async function add(files) {
    const imgs = files.filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (imgs.length < files.length) toast('Зөвхөн зураг оруулна', 'err');
    if (!currentId) {
      for (const f of imgs) pending.push({ file: f, url: URL.createObjectURL(f) });
      return draw();
    }
    for (const [n, f] of imgs.entries()) {
      status.textContent = `Хуулж байна… ${n + 1}/${imgs.length}`;
      try { await uploadPhoto(res, currentId, f); changed = true; } catch (e) { toast(e.message, 'err'); }
    }
    status.textContent = '';
    await load();
  }
  const mod = { animals: 'animals', weighings: 'weighings', expenses: 'expenses', slaughters: 'slaughter', sales: 'sales' }[res];
  const canDel = p => canMod(mod, 3) || (canMod(mod, 2) && p.created_by === state.user.id);
  function draw() {
    const urls = existing.map(p => `/api/photo/${p.id}`);
    const purls = pending.map(p => p.url);
    grid.replaceChildren(
      ...existing.map((p, i) => thumb(urls[i], () => lightbox(urls, i), canDel(p) ? async () => {
        if (!confirm('Энэ зургийг устгах уу?')) return;
        try { await api('DELETE', `/api/photo/${p.id}`); changed = true; await load(); } catch (e) { toast(e.message, 'err'); }
      } : null)),
      ...pending.map((p, i) => thumb(p.url, () => lightbox(purls, i), () => { URL.revokeObjectURL(p.url); pending.splice(i, 1); draw(); })));
  }

  const el = h('div', { class: 'photo-panel full' },
    h('span', { class: 'field-label' }, 'Зураг'),
    grid,
    h('div', { class: 'photo-actions' },
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => pick.click() }, '🖼 Зураг оруулах'),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => cam.click() }, '📷 Зураг авах'),
      status),
    pick, cam);
  load().catch(e => toast(e.message, 'err'));

  return {
    el,
    get changed() { return changed; },
    async flush(newId) {
      currentId = newId;
      for (const p of pending) await uploadPhoto(res, newId, p.file);
    },
    dispose() { for (const p of pending) URL.revokeObjectURL(p.url); }
  };
}

const photoColumn = res => ({
  k: 'photo_count', label: 'Зураг', csv: r => r.photo_count,
  render: r => r.photo_first
    ? h('button', { type: 'button', class: 'cell-thumb', onclick: e => { e.stopPropagation(); openRecordPhotos(res, r.id); } },
        h('img', { src: `/api/photo/${r.photo_first}`, loading: 'lazy', alt: '' }),
        r.photo_count > 1 ? h('span', {}, r.photo_count) : null)
    : ''
});

const opt = arr => arr.map(v => [v, v]);
const uniq = (rows, k) => [...new Set(rows.map(r => r[k]).filter(v => v != null && v !== ''))].sort();
const activeTags = () => state.lk.animals.filter(a => !a.slaughtered).map(a => a.tag_id);

// ---------- Хуудаснууд ----------
const PAGES = {};

// ---------- Хянах самбарын график, жагсаалт ----------
// Мөнгөн дүнг товчлох: 1,250,000 → 1.3 сая
const abbrMoney = v => {
  const a = Math.abs(v);
  if (a >= 1e9) return nf2.format(v / 1e9) + ' тэрбум';
  if (a >= 1e6) return nf2.format(Math.round(v / 1e5) / 10) + ' сая';
  if (a >= 1e3) return nf0.format(Math.round(v / 1e3)) + ' мян';
  return nf0.format(v);
};
const niceMax = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
const MONTHS_MN = ['1-р', '2-р', '3-р', '4-р', '5-р', '6-р', '7-р', '8-р', '9-р', '10-р', '11-р', '12-р'];
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
// Дээд талдаа 4px бөөрөнхий, суурьтаа шулуун багана
const barPath = (x, y, w, hgt) => { const r = Math.min(4, w / 2, hgt); return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`; };

// Сарын орлого ба зарлага — бүлэглэсэн багана, нэг тэнхлэг, hover тайлбар
function monthlyChart(data) {
  const W = 760, H = 250, L = 58, R = 8, T = 14, B = 30;
  const max = niceMax(Math.max(1, ...data.flatMap(d => [d.revenue, d.expense])));
  const pw = W - L - R, ph = H - T - B, gw = pw / data.length;
  const bw = Math.max(4, Math.min(16, (gw - 10) / 2));
  const y = v => T + ph - (v / max) * ph;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mchart', role: 'img', 'aria-label': 'Сарын орлого ба зарлага' });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    root.append(svg('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: i === 0 ? 'axis' : 'grid' }));
    const t = svg('text', { x: L - 8, y: yy + 4, class: 'tick', 'text-anchor': 'end' }); t.textContent = abbrMoney(v); root.append(t);
  }
  const wrap = h('div', { class: 'mchart-wrap' });
  const tip = h('div', { class: 'mchart-tip', hidden: true });
  data.forEach((d, i) => {
    const cx = L + gw * i + gw / 2;
    const [yy, mm] = d.month.split('-');
    const lbl = svg('text', { x: cx, y: H - 10, class: 'tick', 'text-anchor': 'middle' });
    lbl.textContent = mm === '01' || i === 0 ? `${yy}.${mm}` : MONTHS_MN[Number(mm) - 1]; root.append(lbl);
    const g = svg('g', { class: 'mgroup' });
    if (d.revenue > 0) g.append(svg('path', { d: barPath(cx - bw - 1, y(d.revenue), bw, T + ph - y(d.revenue)), class: 's1' }));
    if (d.expense > 0) g.append(svg('path', { d: barPath(cx + 1, y(d.expense), bw, T + ph - y(d.expense)), class: 's2' }));
    // Баганаас өргөн hover талбар
    const hit = svg('rect', { x: L + gw * i, y: T, width: gw, height: ph, class: 'hit' });
    const show = () => {
      g.classList.add('on');
      tip.replaceChildren(h('strong', {}, `${yy} оны ${MONTHS_MN[Number(mm) - 1]} сар`),
        h('div', {}, h('i', { class: 'sw s1' }), 'Орлого', h('b', {}, FMT.money(d.revenue))),
        h('div', {}, h('i', { class: 'sw s2' }), 'Зарлага', h('b', {}, FMT.money(d.expense))),
        h('div', { class: 'tip-total' }, 'Ашиг', h('b', {}, FMT.money(d.revenue - d.expense))));
      tip.hidden = false;
      const left = ((L + gw * i + gw / 2) / W) * 100;
      tip.style.left = `clamp(0px, calc(${left}% - 90px), calc(100% - 180px))`;
    };
    const hide = () => { g.classList.remove('on'); tip.hidden = true; };
    hit.addEventListener('mouseenter', show); hit.addEventListener('mouseleave', hide);
    hit.addEventListener('click', show);
    root.append(g, hit);
  });
  wrap.append(root, tip);
  return h('div', {},
    h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'sw s1' }), 'Орлого'), h('span', {}, h('i', { class: 'sw s2' }), 'Зарлага')),
    wrap,
    h('details', { class: 'mchart-table' }, h('summary', {}, 'Хүснэгтээр харах'),
      h('table', { class: 'data compact' },
        h('thead', {}, h('tr', {}, ['Сар', 'Орлого', 'Зарлага', 'Ашиг'].map((t, i) => h('th', { class: i ? 'num' : null }, t)))),
        h('tbody', {}, data.map(d => h('tr', {}, h('td', {}, d.month), h('td', { class: 'num' }, FMT.money(d.revenue)),
          h('td', { class: 'num' }, FMT.money(d.expense)), h('td', { class: 'num' }, FMT.money(d.revenue - d.expense))))))));
}

// Эрэмбэлсэн хэвтээ багана (нэр · багана · дүн) — нэг өнгө
function meterList(rows, fmt, cls) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return h('div', { class: 'meter-list' }, rows.map(r => h('div', { class: 'meter-row', title: `${r.label}: ${fmt(r.value)}` },
    h('span', { class: 'meter-name' }, r.label),
    h('span', { class: 'meter-track' }, h('span', { class: 'meter-bar ' + (cls || ''), style: `width:${Math.max(2, (r.value / max) * 100)}%` })),
    h('span', { class: 'meter-val' }, fmt(r.value), r.share != null ? h('small', {}, ` ${nf0.format(r.share)}%`) : null))));
}

PAGES.dashboard = async main => {
  const d = await api('GET', '/api/dashboard');
  const kpi = (label, value, cls, sub) => h('div', { class: 'kpi ' + (cls || '') }, h('span', { class: 'kpi-label' }, label), h('span', { class: 'kpi-value' }, value), sub ? h('span', { class: 'kpi-sub' }, sub) : null);
  const pendingNote = can('admin') && state.lk.pendingUsers
    ? h('a', { class: 'notice', href: '#/users' }, `Баталгаажуулалт хүлээж буй ${state.lk.pendingUsers} хэрэглэгч байна →`) : null;
  const tday = today();
  const A = d.attention;
  const empty = !d.stats.total && !d.expenseTotal && !d.salesTotal;

  // Хоосон ферм: шууд эхлэх товчнууд
  if (empty) {
    return fill(main, pendingNote, h('section', { class: 'card start-card' },
      h('h2', {}, state.lk.farm.name),
      h('p', { class: 'muted' }, 'Энэ фермд бүртгэл алга байна.'),
      h('div', { class: 'start-actions' },
        canMod('animals', 2) ? h('a', { class: 'btn primary', href: '#/animals' }, '+ Мал бүртгэх') : null,
        canMod('expenses', 2) ? h('a', { class: 'btn ghost', href: '#/expenses' }, '+ Зардал бүртгэх') : null,
        farmFull() ? h('a', { class: 'btn ghost', href: '#/settings' }, 'Тохиргоо') : null)));
  }

  // Анхаарах зүйлс — зөвхөн тоо нь 0-ээс их
  const item = (cls, icon, label, n, href, tags) => n ? h('a', { class: 'att-item ' + cls, href },
    h('span', { class: 'att-icon', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'att-text' }, h('strong', {}, label), tags?.length ? h('small', {}, tags.slice(0, 6).join(', ') + (tags.length > 6 ? ` +${tags.length - 6}` : '')) : null),
    h('span', { class: 'att-count' }, n)) : null;
  const attItems = [
    canMod('tasks') ? item('critical', '!', 'Хоцорсон ажил', A.tasksOverdue, '#/tasks') : null,
    canMod('slaughter') ? item('warning', '⚑', 'Гулуузны жин бүртгээгүй', A.noCarcass.length, '#/slaughter', A.noCarcass.map(a => a.tag_id)) : null,
    canMod('weighings') ? item('warning', '⚖', '30+ хоног жинлээгүй мал', A.needWeigh.length, '#/weighings', A.needWeigh.map(a => a.tag_id)) : null,
    canMod('growth') ? item('serious', '↘', 'Зорилтоос хоцорч буй өсөлт', A.behind.length, '#/growth', A.behind.map(a => a.tag_id)) : null,
    canMod('slaughter') ? item('info', '▤', '14 хоногт бойлох мал', A.slaughterSoon.length, '#/slaughter', A.slaughterSoon.map(a => `${a.tag_id} (${a.date.slice(5)})`)) : null,
    canMod('sell') ? item('good', '✓', 'Борлуулахад бэлэн мал', d.stats.ready, '#/sell', d.ready.map(a => a.tag_id)) : null
  ].filter(Boolean);

  const hasMoney = d.monthly.some(m => m.revenue || m.expense);
  const margin = d.salesTotal > 0 ? (d.profit / d.salesTotal) * 100 : null;
  const speciesRows = Object.entries(d.bySpecies).map(([k, v]) => ({ label: k, value: v })).sort((a, b) => b.value - a.value);
  const typeRows = d.byType.filter(t => t.total > 0).map(t => ({ label: t.type, value: t.total, share: d.expenseTotal ? (t.total / d.expenseTotal) * 100 : null }));

  const tasksCard = canMod('tasks') && d.upcomingTasks.length ? h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Ойрын ажил'), h('a', { class: 'btn ghost small', href: '#/tasks' }, 'Бүгдийг харах')),
    // Утсан дээр мөр бүр карт болж харагдана (data-label)
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Огноо', 'Ажил', 'Мал', 'Хариуцагч'].map(x => h('th', {}, x)))),
      h('tbody', {}, d.upcomingTasks.map(r => h('tr', { class: r.date < tday ? 'overdue-row' : r.date === tday ? 'today-row' : null },
        h('td', { 'data-label': 'Огноо' }, `${r.date} (${weekday(r.date)})`), h('td', { 'data-label': 'Ажил' }, r.type),
        h('td', { class: 'note-cell', 'data-label': 'Мал' }, r.tag_id ?? ''), h('td', { 'data-label': 'Хариуцагч' }, r.assignee ?? ''))))))) : null;

  fill(main,
    pendingNote,
    // Санхүү
    h('div', { class: 'kpis' },
      kpi('Борлуулалтын орлого', FMT.money(d.salesTotal), 'pos', d.salesKg ? `${FMT.kg(d.salesKg)} борлуулсан` : null),
      kpi('Нийт зарлага', FMT.money(d.expenseTotal), 'neg'),
      kpi('Ашиг', FMT.money(d.profit), d.profit >= 0 ? 'pos' : 'neg', margin != null ? `Ашгийн хувь ${nf0.format(margin)}%` : null),
      kpi('Малын хөрөнгө', FMT.money(d.herd.assetValue))),
    // Сүрэг
    h('div', { class: 'kpis' },
      kpi('Идэвхтэй мал', nf0.format(d.stats.active), '', speciesRows.map(r => `${r.label} ${r.value}`).join(' · ') || null),
      kpi('Нийт амьд жин', FMT.kg(d.herd.liveWeight)),
      kpi('Дундаж өдрийн өсөлт', d.herd.avgAdg != null ? FMT.kg(d.herd.avgAdg) : '—'),
      kpi('Бойлсон · Зарагдсан', `${d.stats.slaughtered} · ${d.stats.sold}`)),
    h('div', { class: 'grid2 dash-main' },
      attItems.length ? h('section', { class: 'card' }, h('h2', {}, 'Анхаарах'), h('div', { class: 'att-list' }, attItems)) : null,
      hasMoney ? h('section', { class: 'card' }, h('h2', {}, 'Сарын орлого ба зарлага'), monthlyChart(d.monthly)) : null),
    h('div', { class: 'grid2' },
      typeRows.length ? h('section', { class: 'card' }, h('h2', {}, 'Зардал төрлөөр'), meterList(typeRows, FMT.money, 's2')) : null,
      speciesRows.length ? h('section', { class: 'card' }, h('h2', {}, 'Идэвхтэй мал төрлөөр'), meterList(speciesRows, v => `${v} толгой`, 'brand'),
        Object.keys(d.herd.bySource).length > 1 ? h('div', { class: 'chips' }, Object.entries(d.herd.bySource).map(([k, v]) => h('span', { class: 'lp-chip' }, `${k} ${v}`))) : null) : null),
    tasksCard,
    h('div', { class: 'grid2' },
      d.ready.length ? h('section', { class: 'card' }, h('div', { class: 'toolbar' }, h('h2', {}, 'Борлуулахад бэлэн мал'), canMod('sell') ? h('a', { class: 'btn ghost small', href: '#/sell' }, 'Жагсаалт') : null),
        h('table', { class: 'data compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Төрөл'), h('th', { class: 'num' }, 'Сүүлийн жин'), h('th', { class: 'num' }, 'Зорилт'))),
          h('tbody', {}, d.ready.map(a => h('tr', {}, h('td', {}, a.tag_id), h('td', {}, `${a.species} ${a.age_name ?? ''}`), h('td', { class: 'num' }, FMT.kg(a.last_weight)), h('td', { class: 'num' }, FMT.kg(a.target_weight))))))) : null,
      d.recentWeighings.length ? h('section', { class: 'card' }, h('div', { class: 'toolbar' }, h('h2', {}, 'Сүүлийн жинлэлтүүд'), canMod('weighings') ? h('a', { class: 'btn ghost small', href: '#/weighings' }, 'Бүгд') : null),
        h('table', { class: 'data compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Огноо'), h('th', {}, 'ID'), h('th', { class: 'num' }, 'Жин'))),
          h('tbody', {}, d.recentWeighings.map(w => h('tr', {}, h('td', {}, w.date), h('td', {}, w.tag_id), h('td', { class: 'num' }, FMT.kg(w.weight))))))) : null),
    d.partners.length ? h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', {}, 'Хөрөнгө оруулагчдын ашиг'), farmFull() ? h('a', { class: 'btn ghost small', href: '#/settings?tab=general' }, 'Удирдах') : null),
      h('table', { class: 'data compact' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Нэр'), h('th', {}, 'Олгох давтамж'), h('th', { class: 'num' }, 'Хувь'), h('th', { class: 'num' }, 'Ашгийн дүн'))),
        h('tbody', {}, d.partners.map(p => h('tr', {}, h('td', {}, p.name, investorState(p) !== 'Хүчинтэй' ? h('span', {}, ' ', badge(investorState(p))) : null),
          h('td', {}, p.payout_period || ''), h('td', { class: 'num' }, FMT.pct(p.percent)), h('td', { class: 'num' }, FMT.money(p.amount))))))) : null);
};

PAGES.animals = main => crudSection(main, {
  res: 'animals', module: 'animals', photos: true, title: 'Малын бүртгэл', itemName: 'мал', addLabel: '+ Мал бүртгэх',
  columns: [
    { k: 'tag_id', label: 'Малын ID', render: r => h('span', { class: 'tag' }, r.tag_id, r.tag_color ? h('small', {}, ' ' + r.tag_color) : null), csv: r => r.tag_id },
    { k: 'tag_color', label: 'ID өнгө' },
    { k: 'source', label: 'Орлогын төрөл', render: r => h('span', {}, r.source,
      r.source === 'Төл' && r.mother_tag ? h('small', { class: 'muted' }, ` · эх ${r.mother_tag}`) : null,
      r.source === 'Бэлэг' && r.market_value != null ? h('small', { class: 'muted' }, ` · ${FMT.money(r.market_value)}`) : null),
      csv: r => r.source + (r.mother_tag ? ` (эх ${r.mother_tag})` : '') },
    { k: 'purchase_date', label: 'Орлогын огноо' },
    { k: 'species', label: 'Төрөл' },
    // Одоогийн нас, нэршил — төллөх улирал бүрт автоматаар ахина; хулгана аваачихад авах үеийнх харагдана
    { k: 'current_age_name', label: 'Насны нэршил', render: r => h('span', { title: r.age_name ? `Авахдаа: ${r.age_name}${r.age ? ', ' + r.age + ' нас' : ''}` : null }, r.current_age_name ?? '') },
    { k: 'current_age', label: 'Нас', f: 'num', render: r => h('span', { title: r.next_age_date ? `Дараа нас ахих: ${r.next_age_date}` : null }, r.current_age ?? r.age ?? '') },
    { k: 'sex', label: 'Хүйс' },
    { k: 'initial_weight', label: 'Анхны жин', f: 'kg' },
    { k: 'state', label: 'Төлөв', render: r => badge(r.state), csv: r => r.state }
  ],
  totals: ['initial_weight'],
  filters: [
    { k: 'source', label: 'Орлогын төрөл', options: () => ANIMAL_SOURCES },
    { k: 'species', label: 'Төрөл', options: () => state.lk.species },
    { k: 'state', label: 'Төлөв', options: ['Идэвхтэй', 'Товлосон', 'Бойлсон', 'Зарагдсан'] }
  ],
  fields: [
    // Эхлээд орлогын төрөл: Худалдаж авсан / Төл / Бэлэг — доорх талбарууд үүнээс хамаарна
    { k: 'source', label: 'Орлогын төрөл', type: 'select', req: true, full: true, def: 'Худалдаж авсан',
      options: () => opt(ANIMAL_SOURCES), onChange: fillCalf },
    { k: 'purchase_date', label: 'Орлогын огноо', type: 'date', req: true, def: today },
    { k: 'tag_id', label: 'Малын ID', req: true, maxlength: 50 },
    { k: 'tag_color', label: 'ID өнгө', type: 'select', options: () => opt(state.lk.suggest.tagColor) },
    { k: 'species', label: 'Малын төрөл', type: 'select', req: true, options: () => opt(state.lk.species), onChange: fillCalf },
    // Эх мал: эм (эсвэл хүйс бүртгээгүй) мал; төрөл сонгосон бол тэр төрлийнх. Сонгоход малын төрлийг бөглөнө
    { k: 'mother_tag', label: 'Эх мал (ID) *', type: 'select', dependsOn: 'species', keepOnChange: true,
      options: v => state.lk.animals.filter(a => (!v.species || a.species === v.species) && a.sex !== 'Эр' && a.sex !== 'Зассан эр')
        .map(a => [a.tag_id, a.tag_id + (a.tag_color ? ` (${a.tag_color})` : '') + ` · ${a.species}` + (a.age_name ? ` ${a.age_name}` : '')]),
      emptyText: v => (v.species ? `${v.species} төрлийн эм мал бүртгэлд алга` : 'Эм мал бүртгэлд алга'),
      onChange: pickMother,
      showIf: v => v.source === 'Төл' },
    { k: 'age_name', label: 'Насны нэршил (авах үед)', maxlength: 100, dependsOn: 'species',
      suggest: v => state.lk.classes.filter(c => c.species === v.species).map(c => c.age_name),
      onPick: fillFromClass },
    { k: 'age', label: 'Нас (авах үед)', maxlength: 10, suggest: v => state.lk.classes.filter(c => c.species === v.species).map(c => c.age) },
    { k: 'sex', label: 'Хүйс', type: 'select', options: () => opt(state.lk.sexes), onChange: (v, c) => { fillCalf(v, c); fillGoalWeight(v, c); } },
    { k: 'initial_weight', label: 'Анхны жин (кг)', type: 'number' },
    { k: 'purchase_price', label: 'Авсан үнэ ₮', type: 'number', showIf: v => v.source === 'Худалдаж авсан' },
    { k: 'market_value', label: 'Зах зээлийн үнэ ₮', type: 'number', showIf: v => v.source === 'Бэлэг' },
    { k: 'note', label: 'Тэмдэглэл', type: 'textarea', full: true },
    { k: '_goal', type: 'section', label: 'Зорилт' },
    { k: 'goal_weight', label: 'Зорилтот жин (кг)', type: 'number' },
    { k: 'goal_days', label: 'Хугацаа (хоног)', type: 'number', min: 1 },
    { k: '_goal_date', type: 'info', label: 'Зорилтот огноо',
      compute: v => (v.purchase_date && Number(v.goal_days) > 0 ? addDays(v.purchase_date, Number(v.goal_days)) : null) },
    { k: '_goal_gain', type: 'info', label: 'Нэмэх жин',
      compute: v => (v.goal_weight !== '' && v.initial_weight !== '' ? FMT.kg(v.goal_weight - v.initial_weight) : null) },
    { k: '_goal_adg', type: 'info', label: 'Өдөрт шаардлагатай өсөлт',
      compute: v => (v.goal_weight !== '' && v.initial_weight !== '' && Number(v.goal_days) > 0
        ? FMT.kg((v.goal_weight - v.initial_weight) / Number(v.goal_days)) + ' / өдөр' : null) }
  ]
});

const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Насны нэршлийг сонгоход "Тохиргоо → Малын ангилал"-аас нас, хүйс, зорилтот жинг бөглөнө (гараар солих боломжтой)
function setFormValue(values, ctrls, k, v) {
  if (!ctrls[k]) return;
  ctrls[k].value = v ?? '';
  values[k] = ctrls[k].value;
}
const ANIMAL_SOURCES = ['Худалдаж авсан', 'Төл', 'Бэлэг'];
// Эх малыг сонгоход малын төрөл хоосон бол эхийнхээр бөглөж, төлийн нас/нэршлийг тохируулна
function pickMother(values, ctrls) {
  const m = state.lk.animals.find(a => a.tag_id === values.mother_tag);
  if (m && !values.species && ctrls.species) {
    // Гараар сонгосонтой адил: хамааралтай талбарууд (насны нэршлийн жагсаалт) шинэчлэгдэнэ
    ctrls.species.value = m.species;
    ctrls.species.dispatchEvent(new Event('change'));
    return;
  }
  fillCalf(values, ctrls);
}
// Төл бол 1 настай: насыг 1 болгож, ангиллаас тухайн төрөл/хүйсийн 1 насны нэршлийг (Тугал, Хурга…) бөглөнө
function fillCalf(values, ctrls) {
  if (values.source !== 'Төл' || !values.species) return;
  setFormValue(values, ctrls, 'age', '1');
  const c = state.lk.classes.find(x => x.species === values.species && String(x.age) === '1' && (!values.sex || x.sex === values.sex));
  if (c) { setFormValue(values, ctrls, 'age_name', c.age_name); fillGoalWeight(values, ctrls); }
}
function fillFromClass(values, ctrls) {
  const matches = state.lk.classes.filter(c => c.species === values.species && c.age_name === values.age_name);
  if (!matches.length) return;
  setFormValue(values, ctrls, 'age', matches[0].age);
  const sexes = [...new Set(matches.map(m => m.sex))];
  if (sexes.length === 1) setFormValue(values, ctrls, 'sex', sexes[0]);
  else if (!sexes.includes(values.sex)) setFormValue(values, ctrls, 'sex', '');
  fillGoalWeight(values, ctrls);
}
function fillGoalWeight(values, ctrls) {
  const m = state.lk.classes.find(c => c.species === values.species && c.age_name === values.age_name && (!values.sex || c.sex === values.sex));
  if (!m || m.target_weight == null) return;
  // Хэрэглэгч өөрөө бичсэн зорилтыг дарж бичихгүй
  if (values.goal_weight === '' || values.goal_weight == null || String(values.goal_weight) === String(values._autoGoal)) {
    setFormValue(values, ctrls, 'goal_weight', m.target_weight);
    values._autoGoal = ctrls.goal_weight.value;
  }
}

// Малын бүртгэл + жинлэлтээс автоматаар тооцсон өсөлт, өртгийн мэдээлэл (зөвхөн харах)
PAGES.growth = main => crudSection(main, {
  res: 'animals', title: 'Өсөлтийн мэдээлэл', readonly: true, photos: true,
  columns: [
    { k: 'tag_id', label: 'Малын ID', render: r => h('span', { class: 'tag' }, r.tag_id, r.tag_color ? h('small', {}, ' ' + r.tag_color) : null), csv: r => r.tag_id },
    { k: 'species', label: 'Төрөл' },
    { k: 'current_age_name', label: 'Насны нэршил' },
    { k: 'initial_weight', label: 'Анхны жин', f: 'kg' },
    { k: 'target_weight', label: 'Зорилтот жин', f: 'kg' },
    { k: 'goal_days', label: 'Зорилтот хоног', f: 'num' },
    { k: 'goal_date', label: 'Зорилтот огноо' },
    { k: 'target_status', label: 'Зорилтын төлөв', render: r => badge(r.target_status), csv: r => r.target_status },
    { k: 'last_weigh_date', label: 'Сүүлд жинлэсэн' },
    { k: 'last_weight', label: 'Сүүлийн жин', f: 'kg' },
    { k: 'days', label: 'Хоног', f: 'num' },
    { k: 'gain', label: 'Өсөлт', f: 'kg' },
    { k: 'adg', label: 'Өдрийн өсөлт', f: 'kg' },
    { k: 'goal_adg', label: 'Шаардлагатай өдрийн өсөлт', f: 'kg' },
    { k: 'to_sell', label: '', csv: r => (r.to_sell ? 'Зарах малд' : ''), render: r => {
      if (r.target_status === 'Борлуулах' || r.state === 'Зарагдсан') return '';
      // Гараар "Зарах малд" шилжүүлсэн: гулууз бүртгэгдээгүй бол буцааж болно (бойн хуваарь хамт цуцлагдана)
      if (r.to_sell) {
        const locked = r.carcass_weight != null;
        const canBack = !locked && canMod('sell', r.slaughter_date ? 3 : 2);
        return h('span', { class: 'to-sell-cell' }, badge('Зарах малд'),
          canBack ? h('button', { type: 'button', class: 'btn ghost xs', title: 'Зарах малын жагсаалтаас буцаах', onclick: async e => {
            e.stopPropagation();
            const extra = r.slaughter_date ? `\nБойн хуваарь (${r.slaughter_date}) мөн цуцлагдана.` : '';
            if (!confirm(`${r.tag_id}-г "Зарах малын жагсаалт"-аас буцаах уу?${extra}`)) return;
            try { await api('POST', `/api/animals/${r.id}/to-sell`, { value: false }); toast(`${r.tag_id}: буцаагдлаа`); render(); }
            catch (ex) { toast(ex.message, 'err'); }
          } }, '← Буцаах') : locked ? h('small', { class: 'muted', title: 'Гулуузны жин бүртгэгдсэн тул буцаах боломжгүй' }, ' гулууз') : null);
      }
      if (r.state !== 'Идэвхтэй' || !canMod('sell', 2)) return '';
      return h('button', { type: 'button', class: 'btn ghost xs', title: 'Зарах малын жагсаалт руу шилжүүлэх', onclick: async e => {
        e.stopPropagation();
        if (!confirm(`${r.tag_id} зорилтот жиндээ хүрээгүй байна. "Зарах малын жагсаалт" руу шилжүүлэх үү?`)) return;
        try { await api('POST', `/api/animals/${r.id}/to-sell`, { value: true }); toast(`${r.tag_id}: Зарах малын жагсаалт руу шилжлээ`); render(); }
        catch (ex) { toast(ex.message, 'err'); }
      } }, 'Зарах →');
    } }
  ],
  totals: ['initial_weight', 'last_weight', 'gain'],
  filters: [
    { k: 'species', label: 'Төрөл', options: () => state.lk.species },
    { k: 'target_status', label: 'Зорилт', options: ['Борлуулах', 'Хүрээгүй', 'Тохиргоо олдсонгүй'] }
  ],
  fields: []
});

PAGES.weighings = main => crudSection(main, {
  res: 'weighings', module: 'weighings', photos: true, title: 'Жинлэлтүүд', itemName: 'жинлэлт', addLabel: '+ Жинлэлт нэмэх',
  columns: [
    { k: 'date', label: 'Огноо' }, { k: 'tag_id', label: 'Малын ID' }, { k: 'species', label: 'Төрөл' },
    { k: 'age_name', label: 'Насны нэршил' }, { k: 'weight', label: 'Жин', f: 'kg' }, { k: 'note', label: 'Тэмдэглэл' }
  ],
  filters: [{ k: 'tag_id', label: 'Малын ID', options: rows => uniq(rows, 'tag_id') }, { k: 'species', label: 'Төрөл', options: () => state.lk.species }],
  fields: [
    { k: 'date', label: 'Огноо', type: 'date', req: true, def: today },
    { k: 'tag_id', label: 'Малын ID', req: true, maxlength: 50, suggest: () => activeTags() },
    { k: 'weight', label: 'Жин (кг)', type: 'number', req: true },
    { k: 'note', label: 'Тэмдэглэл', full: true }
  ]
});

const FEED_TYPE = 'Тэжээл';
const FEED_UNITS = ['кг', 'боодол'];
const qtyUnit = (q, u) => (q == null || q === '' ? '' : FMT.num(q) + (u ? ' ' + u : ''));
// Тэжээл / нэгж сонгоход нэгж үнийг тохиргооны үнээр (₮/кг, боодол бол × боодлын жин) бөглөнө
function fillFeedPrice(values, ctrls) {
  const f = state.lk.suggest.feeds.find(x => x.name === values.feed_name);
  if (f?.price == null) return;
  if (values.unit === 'боодол') { if (f.bale_kg) setFormValue(values, ctrls, 'unit_price', f.price * f.bale_kg); }
  else setFormValue(values, ctrls, 'unit_price', f.price);
}
PAGES.expenses = main => crudSection(main, {
  res: 'expenses', module: 'expenses', photos: true, title: 'Зардлын бүртгэл', itemName: 'зардал', addLabel: '+ Зардал нэмэх',
  columns: [
    { k: 'date', label: 'Огноо' }, { k: 'type', label: 'Төрөл' }, { k: 'feed_name', label: 'Дэд төрөл' }, { k: 'description', label: 'Тайлбар' },
    { k: 'qty', label: 'Тоо', f: 'num', render: r => qtyUnit(r.qty, r.unit), csv: r => qtyUnit(r.qty, r.unit) },
    { k: 'unit_price', label: 'Нэгж үнэ', f: 'money' },
    { k: 'total', label: 'Нийт', f: 'money' }, { k: 'supplier', label: 'Нийлүүлэгч' }
  ],
  totals: ['total'],
  filters: [{ k: 'type', label: 'Төрөл', options: rows => uniq(rows, 'type') }],
  fields: [
    { k: 'date', label: 'Огноо', type: 'date', req: true, def: today },
    { k: 'type', label: 'Зардлын төрөл', req: true, maxlength: 100, suggest: () => state.lk.suggest.expenseType },
    // "Тэжээл" төрөлд: дэд төрөл = Тохиргоо → Тэжээл; сонгоход нэгж үнийг тохиргооны үнээр бөглөнө
    { k: 'feed_name', label: 'Тэжээлийн төрөл *', type: 'select', showIf: v => v.type === FEED_TYPE,
      options: () => state.lk.suggest.feeds.map(f => [f.name, f.name]),
      emptyText: () => 'Тохиргоо → Тэжээл хоосон байна',
      onChange: fillFeedPrice },
    { k: 'unit', label: 'Нэгж', type: 'select', showIf: v => v.type === FEED_TYPE, def: 'кг',
      options: () => opt(FEED_UNITS), onChange: fillFeedPrice },
    { k: 'description', label: 'Зардлын тайлбар', full: true },
    { k: 'qty', label: 'Тоо', type: 'number' },
    { k: 'unit_price', label: 'Нэгж үнэ ₮', type: 'number' },
    { k: 'supplier', label: 'Нийлүүлэгч', full: true, suggest: () => state.lk.suggest.supplier }
  ]
});

// ----- Зарах мал: зорилтот жинд хүрсэн мал + мөр бүрт гараар оруулах бойн хуваарь -----
PAGES.sell = async main => {
  const [animals, slaughters] = await Promise.all([api('GET', '/api/r/animals'), api('GET', '/api/r/slaughters')]);
  const byAnimal = new Map(slaughters.map(s => [s.animal_id, s]));
  // Зорилтот жинд хүрсэн, эсвэл гараар шилжүүлсэн мал
  const rows = animals.filter(a => (a.target_status === 'Борлуулах' || a.to_sell) && a.state !== 'Зарагдсан');
  const canWrite = canMod('sell', 2);
  const canDel = canMod('sell', 3);
  const cols = 11;
  let q = '';
  const tbody = h('tbody');
  const count = h('span', { class: 'muted small' });

  // Мөр дээр дарахад нээгдэх цонх: бойлох өдрийг бүртгэх / засах / цуцлах
  function openSchedule(a) {
    const s = byAnimal.get(a.id);
    const manual = a.to_sell && a.target_status !== 'Борлуулах';
    const minDate = [a.purchase_date, a.last_weigh_date].filter(Boolean).sort().pop();
    const date = h('input', { type: 'date', value: s?.date || '', min: minDate, required: true });
    const msg = h('div', { class: 'form-msg' });
    const info = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, v ?? '—'));
    const form = h('form', { class: 'modal-body' },
      h('div', { class: 'kv-grid sched-info' },
        info('Малын ID', a.tag_id + (a.tag_color ? ` (${a.tag_color})` : '')),
        info('Төрөл · нэршил', `${a.species} · ${a.current_age_name ?? ''}`),
        info('Сүүлийн жин', a.last_weight != null ? `${FMT.kg(a.last_weight)} (${a.last_weigh_date})` : null),
        info('Зорилтот жин', FMT.kg(a.target_weight))),
      h('div', { class: 'form-grid' }, h('label', { class: 'field full' }, h('span', { class: 'field-label' }, 'Бойлох өдөр *'), date)),
      msg,
      h('div', { class: 'modal-actions' },
        s && canDel ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!confirm(`${a.tag_id}-ийн бойн хуваарийг цуцлах уу?`)) return;
          try { await api('DELETE', `/api/r/slaughters/${s.id}`); dlg.close(); toast('Хуваарь цуцлагдлаа'); render(); }
          catch (e) { msg.className = 'form-msg err'; msg.textContent = e.message; }
        } }, 'Хуваарь цуцлах') : null,
        manual && s?.carcass_weight == null && (!s || canDel) ? h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
          if (!confirm(`${a.tag_id}-г "Зарах малын жагсаалт"-аас буцаах уу?${s ? `\nБойн хуваарь (${s.date}) мөн цуцлагдана.` : ''}`)) return;
          try { await api('POST', `/api/animals/${a.id}/to-sell`, { value: false }); dlg.close(); toast('Хаслаа'); render(); }
          catch (e) { msg.className = 'form-msg err'; msg.textContent = e.message; }
        } }, 'Жагсаалтаас буцаах') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Болих'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Хадгалах')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      msg.className = 'form-msg'; msg.textContent = '';
      if (a.last_weigh_date && date.value < a.last_weigh_date) {
        msg.className = 'form-msg err'; msg.textContent = `Бойлох өдөр сүүлийн жинлэлтийн огнооноос (${a.last_weigh_date}) өмнө байж болохгүй`; return;
      }
      // Гулуузны жин, ачигдсан огноог "Бойны жагсаалт"-аас оруулдаг тул байгаа утгыг нь хадгална
      const body = { date: date.value, tag_id: a.tag_id, carcass_weight: s?.carcass_weight ?? null, shipped_date: s?.shipped_date ?? null };
      try {
        if (s) await api('PUT', `/api/r/slaughters/${s.id}`, body);
        else await api('POST', '/api/r/slaughters', body);
        dlg.close(); toast(`${a.tag_id}: бойлох өдөр хадгалагдлаа`); render();
      } catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
    });
    const dlg = modal(`Бойн хуваарь — ${a.tag_id}`, form);
    date.focus();
  }

  function rowEl(a) {
    const s = byAnimal.get(a.id);
    const manual = a.to_sell && a.target_status !== 'Борлуулах';
    return h('tr', { class: canWrite ? 'clickable' : null, title: canWrite ? 'Бойлох өдөр бүртгэх' : null, onclick: canWrite ? () => openSchedule(a) : null },
      h('td', {}, h('span', { class: 'tag' }, a.tag_id, a.tag_color ? h('small', {}, ' ' + a.tag_color) : null)),
      h('td', {}, a.species), h('td', {}, a.current_age_name ?? ''), h('td', {}, a.sex ?? ''),
      h('td', {}, a.last_weigh_date ?? ''),
      h('td', { class: 'num' }, FMT.kg(a.last_weight)), h('td', { class: 'num' }, FMT.kg(a.target_weight)),
      h('td', { class: 'num' }, FMT.kg(a.gain)), h('td', { class: 'num' }, FMT.money(a.total_cost)),
      h('td', {}, badge(a.state), manual ? h('div', {}, badge('Гараар нэмсэн')) : null),
      h('td', {}, s?.date ? h('strong', {}, `${s.date} (${weekday(s.date)})`) : h('span', { class: 'muted' }, '—')));
  }

  const els = rows.map(a => ({ a, el: rowEl(a) }));
  function draw() {
    const list = els.filter(({ a }) => !q || [a.tag_id, a.tag_color, a.species, a.age_name].some(v => String(v ?? '').toLowerCase().includes(q)));
    tbody.replaceChildren(...list.map(x => x.el));
    if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: cols, class: 'empty' }, 'Зарах мал алга')));
    count.textContent = list.length + ' мал';
  }
  main.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Зарах малын жагсаалт'),
      h('div', { class: 'toolbar-right' }, h('input', { type: 'search', class: 'search', placeholder: 'Хайх…', oninput: e => { q = e.target.value.trim().toLowerCase(); draw(); } }))),
    h('div', { class: 'table-wrap' }, enhanceTable(h('table', { class: 'data sell-table' },
      h('thead', {}, h('tr', {},
        ['Малын ID', 'Төрөл', 'Насны нэршил', 'Хүйс', 'Сүүлд жинлэсэн'].map(t => h('th', {}, t)),
        ['Сүүлийн жин', 'Зорилтот жин', 'Өсөлт', 'Нийт өртөг'].map(t => h('th', { class: 'num' }, t)),
        h('th', {}, 'Төлөв'),
        h('th', {}, 'Бойлох өдөр'))),
      tbody))),
    h('div', { class: 'table-foot' }, count)));
  draw();
};

// ----- Хуваарьт ажил: жинлэх огноо болон бусад ажлын төлөвлөгөө -----
const TASK_STATUSES = ['Төлөвлөсөн', 'Хийгдсэн', 'Цуцалсан'];
const WEEKDAYS = ['Ня', 'Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя'];
const weekday = iso => WEEKDAYS[new Date(iso + 'T00:00:00Z').getUTCDay()];
const dayDiffDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

const TASK_FIELDS = [
  { k: 'date', label: 'Огноо', type: 'date', req: true, def: today },
  { k: 'type', label: 'Ажил', type: 'select', req: true, options: () => opt(state.lk.suggest.taskType) },
  { k: 'tag_id', label: 'Мал', type: 'multi', full: true, options: () => activeTags(),
    showIf: v => !!(state.lk.suggest.taskTypes || []).find(t => t.name === v.type)?.needs_animals },
  { k: 'assignee', label: 'Хариуцагч', maxlength: 100, suggest: () => state.lk.suggest.assignee },
  { k: 'status', label: 'Төлөв', type: 'select', req: true, options: () => opt(TASK_STATUSES), def: 'Төлөвлөсөн' },
  { k: 'done_date', label: 'Хийсэн огноо', type: 'date' },
  { k: 'note', label: 'Тэмдэглэл', type: 'textarea', full: true },
  { k: '_repeat', type: 'section', label: 'Давтах', createOnly: true },
  { k: 'repeat_every', label: 'Хэдэн хоног тутам', type: 'number', plain: true, createOnly: true },
  { k: 'repeat_count', label: 'Хэдэн удаа', type: 'number', plain: true, createOnly: true }
];
const TASK_CFG = { res: 'tasks', itemName: 'ажил', fields: TASK_FIELDS };
const taskBody = (r, extra) => ({ date: r.date, type: r.type, tag_id: r.tag_id, assignee: r.assignee, note: r.note, status: r.status, done_date: r.done_date, ...extra });

PAGES.tasks = async main => {
  const rows = await api('GET', '/api/r/tasks');
  const canWrite = canMod('tasks', 2);
  const canDel = canMod('tasks', 3);
  const t = today();
  const in7 = addDays(t, 7);
  const savedView = (() => { try { return localStorage.getItem('tsf.taskView'); } catch { return null; } })();
  const st = PAGES.tasks._st || (PAGES.tasks._st = { q: '', type: '', view: savedView === 'calendar' ? 'calendar' : 'list', month: t.slice(0, 7), day: t });
  const reload = () => render();
  // Тухайн өдрийг урьдчилан бөглөсөн шинэ ажлын маягт
  const cfgForDay = day => ({ ...TASK_CFG, fields: TASK_FIELDS.map(f => (f.k === 'date' ? { ...f, def: () => day } : f)) });

  async function markDone(r) {
    try { await api('PUT', `/api/r/tasks/${r.id}`, taskBody(r, { status: 'Хийгдсэн', done_date: today() })); toast(`${r.type}: хийгдсэн`); reload(); }
    catch (e) { toast(e.message, 'err'); }
  }

  const when = r => {
    if (r.status !== 'Төлөвлөсөн') return '';
    const d = dayDiffDays(t, r.date);
    if (d < 0) return h('span', { class: 'warn' }, `${-d} хоног хоцорсон`);
    if (d === 0) return 'Өнөөдөр';
    if (d === 1) return 'Маргааш';
    return `${d} хоногийн дараа`;
  };

  function table(list) {
    return h('div', { class: 'table-wrap' }, enhanceTable(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Огноо', 'Хугацаа', 'Ажил', 'Мал', 'Хариуцагч', 'Тэмдэглэл', 'Төлөв'].map(x => h('th', {}, x)), canWrite ? h('th', { class: 'row-actions' }, '') : null)),
      h('tbody', {}, list.map(r => h('tr', { class: canWrite ? 'clickable' : null, onclick: canWrite ? () => openForm(TASK_CFG, r, reload, canDel) : null },
        h('td', {}, `${r.date} (${weekday(r.date)})`),
        h('td', {}, when(r)),
        h('td', {}, h('strong', {}, r.type)),
        h('td', { class: 'note-cell' }, r.tag_id ?? ''),
        h('td', {}, r.assignee ?? ''),
        h('td', { class: 'note-cell' }, r.note ?? ''),
        h('td', {}, badge(r.status), r.status === 'Хийгдсэн' && r.done_date ? h('small', { class: 'muted' }, ' ' + r.done_date) : null),
        canWrite ? h('td', { class: 'row-actions' },
          r.status === 'Төлөвлөсөн' ? h('button', { type: 'button', class: 'btn primary small', onclick: e => { e.stopPropagation(); markDone(r); } }, '✓ Хийгдсэн') : null,
          h('button', { type: 'button', class: 'btn ghost small', onclick: e => { e.stopPropagation(); openForm(TASK_CFG, r, reload, canDel); } }, 'Засах'),
          canDel ? h('button', { type: 'button', class: 'btn danger small', onclick: e => { e.stopPropagation(); removeTask(r); } }, 'Устгах') : null) : null))))));
  }

  async function removeTask(r) {
    if (!confirm(`"${r.type}" (${r.date}) ажлыг устгах уу?`)) return;
    try { await api('DELETE', `/api/r/tasks/${r.id}`); toast('Устгалаа'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  }

  const body = h('div', { class: 'task-groups' });

  // ----- Календарь (сараар) -----
  const MON_FIRST = ['Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя', 'Ня'];
  const chipClass = r => (r.status === 'Хийгдсэн' ? 'done' : r.status === 'Цуцалсан' ? 'cancelled' : r.date < t ? 'overdue' : 'planned');
  function drawCalendar(list) {
    const [Y, M] = st.month.split('-').map(Number);
    const first = `${st.month}-01`;
    const startDow = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7; // Даваа = 0
    const daysInMonth = new Date(Date.UTC(Y, M, 0)).getUTCDate();
    const cellCount = Math.ceil((startDow + daysInMonth) / 7) * 7;
    const start = addDays(first, -startDow);
    const byDate = new Map();
    for (const r of list) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
    const shift = n => { const d = new Date(Date.UTC(Y, M - 1 + n, 1)); st.month = d.toISOString().slice(0, 7); draw(); };

    const grid = h('div', { class: 'cal-grid' }, MON_FIRST.map(w => h('div', { class: 'cal-wd' }, w)));
    for (let i = 0; i < cellCount; i++) {
      const day = addDays(start, i);
      const items = byDate.get(day) || [];
      const cls = ['cal-day', day.slice(0, 7) !== st.month && 'other', day === t && 'today', day === st.day && 'selected',
        items.some(r => chipClass(r) === 'overdue') && 'has-overdue'].filter(Boolean).join(' ');
      grid.append(h('div', { class: cls, role: 'button', tabindex: '0', 'aria-label': `${day}: ${items.length} ажил`,
        onclick: () => { st.day = day; draw(); },
        onkeydown: e => { if (e.key === 'Enter') { st.day = day; draw(); } } },
        h('span', { class: 'cal-num' }, Number(day.slice(8))),
        h('div', { class: 'cal-chips' },
          items.slice(0, 3).map(r => h('span', { class: 'cal-chip ' + chipClass(r), title: `${r.type}${r.tag_id ? ' · ' + r.tag_id : ''}${r.assignee ? ' · ' + r.assignee : ''}`,
            onclick: canWrite ? e => { e.stopPropagation(); openForm(TASK_CFG, r, reload, canDel); } : null }, r.type)),
          items.length > 3 ? h('span', { class: 'cal-more' }, `+${items.length - 3}`) : null),
        items.length ? h('span', { class: 'cal-dot' }, items.length) : null));
    }
    const dayList = (byDate.get(st.day) || []).sort((a, b) => a.id - b.id);
    fill(body,
      h('section', { class: 'card cal-card' },
        h('div', { class: 'cal-head' },
          h('button', { type: 'button', class: 'btn ghost small', 'aria-label': 'Өмнөх сар', onclick: () => shift(-1) }, '‹'),
          h('h2', {}, `${Y} оны ${MONTHS_MN[M - 1]} сар`),
          h('button', { type: 'button', class: 'btn ghost small', 'aria-label': 'Дараах сар', onclick: () => shift(1) }, '›'),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => { st.month = t.slice(0, 7); st.day = t; draw(); } }, 'Өнөөдөр')),
        grid,
        h('div', { class: 'legend cal-legend' },
          [['planned', 'Төлөвлөсөн'], ['overdue', 'Хоцорсон'], ['done', 'Хийгдсэн'], ['cancelled', 'Цуцалсан']]
            .map(([c, l]) => h('span', {}, h('i', { class: 'sw cal-sw ' + c }), l)))),
      h('section', { class: 'card task-group' },
        h('div', { class: 'toolbar' },
          h('h2', {}, `${st.day} (${weekday(st.day)})`, h('span', { class: 'count-pill' }, dayList.length)),
          canWrite ? h('div', { class: 'toolbar-right' }, h('button', { type: 'button', class: 'btn primary small', onclick: () => openForm(cfgForDay(st.day), null, reload, canDel) }, '+ Энэ өдөр ажил нэмэх')) : null),
        dayList.length ? table(dayList) : h('p', { class: 'muted center' }, 'Энэ өдөр ажил алга')));
  }

  function draw() {
    const match = r => (!st.type || r.type === st.type) &&
      (!st.q || [r.type, r.tag_id, r.assignee, r.note].some(v => String(v ?? '').toLowerCase().includes(st.q)));
    const list = rows.filter(match);
    if (st.view === 'calendar') return drawCalendar(list);
    const planned = list.filter(r => r.status === 'Төлөвлөсөн');
    const groups = [
      { title: 'Хоцорсон', cls: 'overdue', items: planned.filter(r => r.date < t) },
      { title: 'Өнөөдөр', cls: 'today', items: planned.filter(r => r.date === t) },
      { title: 'Ойрын 7 хоног', items: planned.filter(r => r.date > t && r.date <= in7) },
      { title: 'Дараа нь', items: planned.filter(r => r.date > in7) }
    ];
    const done = list.filter(r => r.status !== 'Төлөвлөсөн').sort((a, b) => (b.done_date || b.date).localeCompare(a.done_date || a.date));
    fill(body, 
      ...groups.filter(g => g.items.length).map(g => h('section', { class: 'card task-group ' + (g.cls || '') },
        h('h2', {}, g.title, h('span', { class: 'count-pill' }, g.items.length)), table(g.items))),
      !planned.length ? h('section', { class: 'card' }, h('p', { class: 'muted center' }, 'Төлөвлөсөн ажил алга')) : null,
      done.length ? h('details', { class: 'card task-done' },
        h('summary', {}, h('h2', {}, 'Хийгдсэн / Цуцалсан', h('span', { class: 'count-pill' }, done.length))), table(done)) : null);
  }

  const types = [...new Set(rows.map(r => r.type))].sort();
  // Жагсаалт / Календарь сэлгэгч (сонголт энэ хөтөч дээр санагдана)
  const viewBtn = (v, label) => h('button', { type: 'button', class: 'seg' + (st.view === v ? ' active' : ''), 'aria-pressed': String(st.view === v),
    onclick: e => {
      st.view = v;
      try { localStorage.setItem('tsf.taskView', v); } catch { /* */ }
      e.currentTarget.parentNode.querySelectorAll('.seg').forEach(b => { const on = b === e.currentTarget; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
      draw();
    } }, label);
  main.replaceChildren(
    h('section', { class: 'card' }, h('div', { class: 'toolbar' }, h('h2', {}, 'Хуваарьт ажил'),
      h('div', { class: 'toolbar-right' },
        h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Харагдац' }, viewBtn('list', 'Жагсаалт'), viewBtn('calendar', 'Календарь')),
        h('input', { type: 'search', class: 'search', placeholder: 'Хайх…', value: st.q, oninput: e => { st.q = e.target.value.trim().toLowerCase(); draw(); } }),
        h('select', { class: 'filter', onchange: e => { st.type = e.target.value; draw(); } },
          h('option', { value: '' }, 'Ажил: бүгд'), types.map(x => h('option', { value: x, selected: st.type === x }, x))),
        canWrite ? h('button', { class: 'btn primary small', type: 'button', onclick: () => openForm(TASK_CFG, null, reload, canDel) }, '+ Ажил нэмэх') : null))),
    body);
  draw();
};

// ----- Бойны жагсаалт: бой хийх огноо товлогдсон мал, гулуузны жин бүртгэх -----
PAGES.slaughter = main => crudSection(main, {
  res: 'slaughters', module: 'slaughter', photos: true, noAdd: true, title: 'Бойны жагсаалт', itemName: 'бой',
  columns: [
    { k: 'date', label: 'Бойлох өдөр', render: r => `${r.date} (${weekday(r.date)})`, csv: r => r.date },
    { k: 'tag_id', label: 'Малын ID', render: r => h('span', { class: 'tag' }, r.tag_id, r.tag_color ? h('small', {}, ' ' + r.tag_color) : null), csv: r => r.tag_id },
    { k: 'species', label: 'Төрөл' },
    { k: 'age_name', label: 'Насны нэршил' },
    { k: 'sex', label: 'Хүйс' },
    { k: 'last_weight', label: 'Амьд жин', f: 'kg' },
    { k: 'carcass_weight', label: 'Гулуузны жин', f: 'kg' },
    { k: 'yield_pct', label: 'Гарц', f: 'pct' },
    { k: 'shipped_date', label: 'Ачигдсан огноо' },
    { k: 'carcass_status', label: 'Төлөв', render: r => badge(r.carcass_status), csv: r => r.carcass_status }
  ],
  totals: ['last_weight', 'carcass_weight'],
  filters: [
    { k: 'carcass_status', label: 'Төлөв', options: ['Хүлээгдэж буй', 'Бүртгэсэн'] },
    { k: 'species', label: 'Төрөл', options: () => state.lk.species }
  ],
  fields: [
    { k: 'tag_id', label: 'Малын ID', req: true, readonly: true },
    { k: 'date', label: 'Бойлох өдөр', type: 'date', req: true },
    { k: 'carcass_weight', label: 'Гулуузны жин (кг)', type: 'number' },
    { k: 'shipped_date', label: 'Ачигдсан огноо', type: 'date' }
  ]
});

PAGES.sales = main => crudSection(main, {
  res: 'sales', module: 'sales', photos: true, title: 'Борлуулалт', itemName: 'борлуулалт', addLabel: '+ Борлуулалт нэмэх',
  columns: [
    { k: 'shipped_date', label: 'Ачигдсан огноо' }, { k: 'heads', label: 'Толгой', f: 'num' },
    { k: 'shipped_weight', label: 'Ачигдсан жин', f: 'kg' }, { k: 'sold_date', label: 'Зарсан өдөр' },
    { k: 'sold_weight', label: 'Борлуулсан жин', f: 'kg' }, { k: 'price', label: 'Үнэ ₮/кг', f: 'money' },
    { k: 'revenue', label: 'Нийт орлого', f: 'money' }, { k: 'note', label: 'Тэмдэглэл' }
  ],
  totals: ['heads', 'shipped_weight', 'sold_weight', 'revenue'],
  fields: [
    { k: 'shipped_date', label: 'Худалдахаар ачигдсан огноо', type: 'date', req: true },
    { k: 'sold_date', label: 'Зарсан өдөр', type: 'date' },
    { k: 'sold_weight', label: 'Борлуулсан жин (кг)', type: 'number' },
    { k: 'price', label: 'Зарсан үнэ ₮/кг', type: 'number' },
    { k: 'note', label: 'Тэмдэглэл', full: true }
  ]
});

PAGES.market = main => crudSection(main, {
  res: 'market_prices', module: 'market', title: 'Зах зээлийн махны үнийн судалгаа', itemName: 'үнэ', addLabel: '+ Үнэ нэмэх',
  columns: [
    { k: 'year', label: 'Он' }, { k: 'month', label: 'Сар' }, { k: 'quarter', label: 'Улирал' },
    { k: 'species', label: 'Төрөл' }, { k: 'price', label: 'Махны үнэ ₮/кг', f: 'money' }
  ],
  filters: [{ k: 'species', label: 'Төрөл', options: () => state.lk.species }, { k: 'year', label: 'Он', options: rows => uniq(rows, 'year').reverse() }],
  fields: [
    { k: 'year', label: 'Он', type: 'number', plain: true, req: true, min: 1990, max: 2100, def: () => new Date().getFullYear() },
    { k: 'month', label: 'Сар', type: 'select', req: true, options: () => [...Array(12)].map((_, i) => [i + 1, (i + 1) + '-р сар']), def: () => new Date().getMonth() + 1 },
    { k: 'species', label: 'Төрөл', type: 'select', req: true, options: () => opt(state.lk.species) },
    { k: 'price', label: 'Махны үнэ ₮/кг', type: 'number', req: true }
  ]
});

PAGES.feed = async main => {
  const s = state.lk.settings;
  const planBox = h('div'); const summaryBox = h('div'); const recipeBox = h('div');
  const stockBox = h('div'); const usageBox = h('div');
  main.replaceChildren(stockBox, usageBox, summaryBox, planBox, recipeBox);
  const rerender = async () => { await loadLookups(); await PAGES.feed(main); };

  // Тэжээлийн үлдэгдэл: Зардлын бүртгэлийн "Тэжээл" төрлөөр орж ирсэн − зарцуулалт
  await crudSection(stockBox, {
    res: 'feed_stock', title: 'Тэжээлийн үлдэгдэл', readonly: true, rowActions: false, noAdd: true,
    empty: 'Зардлын бүртгэлд "Тэжээл" төрлийн зардал алга',
    columns: [
      { k: 'feed_name', label: 'Тэжээл' }, { k: 'unit', label: 'Нэгж' },
      { k: 'in_qty', label: 'Орлого', f: 'num' }, { k: 'used_qty', label: 'Зарцуулсан', f: 'num' },
      { k: 'left_qty', label: 'Үлдэгдэл', f: 'num', render: r => h('b', { class: r.left_qty <= 0 ? 'warn' : '' }, qtyUnit(r.left_qty, r.unit)), csv: r => r.left_qty },
      { k: 'left_bale', label: 'Үлдэгдэл (боодол)', f: 'num' },
      { k: 'avg_price', label: 'Дундаж үнэ ₮/нэгж', f: 'money' }, { k: 'left_value', label: 'Үлдэгдлийн өртөг', f: 'money' },
      { k: 'last_in', label: 'Сүүлд орсон' }, { k: 'last_use', label: 'Сүүлд зарцуулсан' }
    ],
    totals: ['left_value']
  });
  const stock = await api('GET', '/api/r/feed_stock');
  const stockOf = name => stock.filter(r => r.feed_name === name);
  // Зарцуулалтын нэгж: боодлын жин мэдэгдэж байвал кг/боодол аль аль нь, үгүй бол үлдэгдэлтэй нэгжүүд
  const unitsOf = name => {
    const rows = stockOf(name);
    if (rows.some(r => r.bale_kg)) return FEED_UNITS;
    return rows.filter(r => r.left_qty > 0).map(r => r.unit);
  };
  const leftText = name => stockOf(name).map(r => qtyUnit(r.left_qty, r.unit) + (r.left_bale != null ? ` (≈ ${FMT.num(r.left_bale)} боодол)` : '')).join(' · ');
  await crudSection(usageBox, {
    res: 'feed_usage', title: 'Тэжээлийн зарцуулалт', itemName: 'зарцуулалт', module: 'feed', addLabel: '+ Зарцуулалт бүртгэх', onChange: rerender,
    columns: [
      { k: 'date', label: 'Огноо' }, { k: 'feed_name', label: 'Тэжээл' },
      { k: 'qty', label: 'Хэмжээ', f: 'num', render: r => qtyUnit(r.qty, r.unit), csv: r => qtyUnit(r.qty, r.unit) },
      { k: 'cost', label: 'Өртөг', f: 'money' }, { k: 'note', label: 'Тэмдэглэл' }
    ],
    totals: ['cost'],
    filters: [{ k: 'feed_name', label: 'Тэжээл', options: rows => uniq(rows, 'feed_name') }, { k: 'unit', label: 'Нэгж', options: FEED_UNITS }],
    fields: [
      { k: 'date', label: 'Огноо', type: 'date', req: true, def: today },
      { k: 'feed_name', label: 'Тэжээл', type: 'select', req: true,
        options: () => [...new Set(stock.filter(r => r.left_qty > 0).map(r => r.feed_name))].map(n => [n, n]),
        emptyText: () => 'Үлдэгдэлтэй тэжээл алга',
        onChange: (values, ctrls) => setFormValue(values, ctrls, 'unit', unitsOf(values.feed_name)[0] || '') },
      { k: 'left', label: 'Үлдэгдэл', type: 'info', compute: v => (v.feed_name ? leftText(v.feed_name) || '0' : null) },
      { k: 'unit', label: 'Нэгж', type: 'select', req: true, dependsOn: 'feed_name', options: v => opt(unitsOf(v.feed_name)) },
      { k: 'qty', label: 'Хэмжээ', type: 'number', req: true },
      { k: 'note', label: 'Тэмдэглэл', full: true }
    ]
  });
  await crudSection(planBox, {
    res: 'feed_plan', title: `Тэжээлийн төлөвлөгөө (1 толгой, ${s.plan_days} хоног)`, itemName: 'тэжээл', module: 'feed', rowActions: true, onChange: rerender,
    columns: [
      { k: 'feed_name', label: 'Тэжээлийн төрөл' }, { k: 'kg_1_14', label: '1–14 хоног', f: 'kg' },
      { k: 'kg_15_30', label: '15–30 хоног', f: 'kg' }, { k: 'kg_31_90', label: '31–90 хоног', f: 'kg' },
      { k: 'total_kg', label: 'Нийт хэмжээ', f: 'kg' }, { k: 'price', label: 'Нэг кг үнэ', f: 'money' }, { k: 'cost', label: 'Нийт өртөг', f: 'money' }
    ],
    totals: ['kg_1_14', 'kg_15_30', 'kg_31_90', 'total_kg', 'cost'],
    fields: [
      { k: 'feed_name', label: 'Тэжээлийн төрөл', req: true, full: true, suggest: () => state.lk.suggest.feedName },
      { k: 'kg_1_14', label: '1–14 хоног (кг/өдөр)', type: 'number' },
      { k: 'kg_15_30', label: '15–30 хоног (кг/өдөр)', type: 'number' },
      { k: 'kg_31_90', label: '31–90 хоног (кг/өдөр)', type: 'number' },
      { k: 'price', label: 'Нэг кг үнэ ₮', type: 'number' }
    ]
  });
  const plan = await api('GET', '/api/r/feed_plan');
  const days = Number(s.plan_days) || 90;
  const perHead = plan.reduce((a, r) => a + r.cost, 0) + (Number(s.plan_other_budget) || 0);
  const autoHeads = state.lk.activeBySpecies[s.plan_species] || 0;
  const heads = s.plan_head_count !== '' && s.plan_head_count != null ? Number(s.plan_head_count) : autoHeads;
  const perDayHead = perHead / days;
  const kv = (k, v, strong) => h('div', { class: 'kv' + (strong ? ' strong' : '') }, h('span', {}, k), h('span', {}, v));
  summaryBox.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Тэжээлийн өртгийн тооцоо'),
      farmFull() ? h('div', { class: 'toolbar-right' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => openFeedPlanSettings(rerender) }, 'Засах')) : null),
    h('div', { class: 'kv-grid' },
      kv('Тэжээлийн нийт өртөг (1 толгой)', FMT.money(perHead - (Number(s.plan_other_budget) || 0))),
      kv('Маллагаа, ус, мал эмнэлэг бусад төсөв', FMT.money(Number(s.plan_other_budget) || 0)),
      kv(`1 толгойн ${days} хоногийн нийт`, FMT.money(perHead), true),
      kv('1 толгойн өдрийн зардал', FMT.money(perDayHead)),
      kv(`${s.plan_species}ний тоо`, String(heads)),
      kv('Бүх малын өдрийн зардал', FMT.money(perDayHead * heads)),
      kv(`Бүх малын ${days} хоногийн зардал`, FMT.money(perDayHead * heads * days), true))));

  await crudSection(recipeBox, {
    res: 'feed_recipes', title: 'Тэжээлийн жор (орц, %)', itemName: 'жор', module: 'feed', rowActions: true, onChange: rerender,
    columns: [
      { k: 'species', label: 'Төрөл' }, { k: 'recipe_no', label: 'Орцын №' },
      { k: 'hay', label: 'Өвс', f: 'pct' }, { k: 'alfalfa', label: 'Царгас', f: 'pct' }, { k: 'straw', label: 'Сүрэл', f: 'pct' },
      { k: 'bran', label: 'Хивэг', f: 'pct' }, { k: 'barley', label: 'Арвай', f: 'pct' }, { k: 'oats', label: 'Овъёос', f: 'pct' },
      { k: 'green', label: 'Ногоон', f: 'pct' }, { k: 'mineral', label: 'Эрдэс', f: 'pct' },
      { k: 'pct_total', label: 'Нийт %', f: 'pct', render: r => h('span', { class: r.pct_total && Math.abs(r.pct_total - 100) > 0.01 ? 'warn' : '' }, FMT.pct(r.pct_total || null)) },
      { k: 'price_per_kg', label: 'Үнэ ₮/кг', f: 'money' }, { k: 'kg_per_gain', label: 'Идүүлэх кг / 1кг ХБ', f: 'num' },
      { k: 'cost_per_gain', label: 'Өртөг ₮ / 1кг ХБ', f: 'money' }, { k: 'note', label: 'Тэмдэглэл' }
    ],
    filters: [{ k: 'species', label: 'Төрөл', options: () => state.lk.species }],
    fields: [
      { k: 'species', label: 'Төрөл', type: 'select', req: true, options: () => opt(state.lk.species) },
      { k: 'recipe_no', label: 'Орцын №', type: 'number', plain: true, req: true, min: 1 },
      ...[['hay', 'Өвс (хадлан)'], ['alfalfa', 'Царгас'], ['straw', 'Сүрэл'], ['bran', 'Хивэг'], ['barley', 'Арвай'], ['oats', 'Овъёос'], ['green', 'Ногоон тэжээл'], ['mineral', 'Эрдэс нэмэлт']]
        .map(([k, l]) => ({ k, label: l + ' %', type: 'number', max: 100 })),
      { k: 'price_per_kg', label: 'Үнэ ₮/кг', type: 'number' },
      { k: 'kg_per_gain', label: 'Идүүлэх кг / 1кг ХБ', type: 'number' },
      { k: 'note', label: 'Тэмдэглэл', full: true }
    ]
  });
};

// ----- Тохиргоо (админ) -----
const SETTING_TABS = [
  { id: 'members', label: 'Хэрэглэгчид' },
  { id: 'classes', label: 'Малын ангилал', cfg: () => ({
    res: 'animal_classes', title: 'Малын төрөл, насны нэршил, зорилтот жин', itemName: 'ангилал', write: 'admin', rowActions: true,
    columns: [{ k: 'species', label: 'Малын төрөл' }, { k: 'age_name', label: 'Насны нэршил' }, { k: 'age', label: 'Нас' }, { k: 'sex', label: 'Хүйс' }, { k: 'target_weight', label: 'Зорилтот жин', f: 'kg' }],
    filters: [{ k: 'species', label: 'Төрөл', options: () => state.lk.species }, { k: 'sex', label: 'Хүйс', options: () => state.lk.sexes }],
    fields: [
      { k: 'species', label: 'Малын төрөл', type: 'select', req: true, options: () => opt(state.lk.species) },
      { k: 'age_name', label: 'Насны нэршил', req: true },
      { k: 'age', label: 'Нас', req: true },
      { k: 'sex', label: 'Хүйс', type: 'select', req: true, options: () => opt(state.lk.sexes) },
      { k: 'target_weight', label: 'Зорилтот жин (кг)', type: 'number' }
    ] }) },
  { id: 'tag_colors', label: 'ID өнгө', cfg: () => ({
    res: 'tag_colors', title: 'ID өнгө', itemName: 'ID өнгө', write: 'admin', rowActions: true,
    columns: [{ k: 'name', label: 'ID өнгө' }],
    fields: [{ k: 'name', label: 'ID өнгө', req: true, maxlength: 50 }] }) },
  { id: 'task_types', label: 'Ажлын төрөл', cfg: () => ({
    res: 'task_types', title: 'Ажлын төрөл', itemName: 'ажлын төрөл', write: 'admin', rowActions: true,
    columns: [{ k: 'name', label: 'Ажлын төрөл' },
      { k: 'needs_animals', label: 'Мал сонгох', render: r => (r.needs_animals ? badge('Бүртгэсэн', 'Тийм') : badge('Цуцалсан', 'Үгүй')), csv: r => (r.needs_animals ? 'Тийм' : 'Үгүй') }],
    fields: [{ k: 'name', label: 'Ажлын төрөл', req: true, maxlength: 100 },
      { k: 'needs_animals', label: 'Мал сонгох', type: 'select', req: true, options: () => [[1, 'Тийм'], [0, 'Үгүй']], def: 0 }] }) },
  { id: 'feeds', label: 'Тэжээл', cfg: () => ({
    res: 'feeds', title: 'Тэжээл ба үнэ', itemName: 'тэжээл', write: 'admin', rowActions: true,
    columns: [{ k: 'name', label: 'Тэжээл' }, { k: 'price', label: 'Үнэ ₮/кг', f: 'money' }, { k: 'bale_kg', label: '1 боодлын жин', f: 'kg' }],
    fields: [{ k: 'name', label: 'Тэжээл', req: true }, { k: 'price', label: 'Үнэ ₮/кг', type: 'number' },
      { k: 'bale_kg', label: '1 боодлын жин (кг)', type: 'number' }] }) },
  { id: 'expense_types', label: 'Зардлын төрөл', cfg: () => ({
    res: 'expense_types', title: 'Зардлын төрөл', itemName: 'зардлын төрөл', write: 'admin', rowActions: true,
    columns: [{ k: 'name', label: 'Зардлын төрөл' }],
    fields: [{ k: 'name', label: 'Зардлын төрөл', req: true }] }) },
  { id: 'breeding', label: 'Төллөлт', cfg: () => ({
    res: 'breeding', title: 'Эх мал, хээлтүүлэг, төллөлт', itemName: 'мэдээлэл', write: 'admin', rowActions: true,
    columns: [{ k: 'species', label: 'Малын төрөл' }, { k: 'dam_name', label: 'Эх малын нэр' }, { k: 'births_per_year', label: 'Жилд төллөх', f: 'num' },
      { k: 'gestation', label: 'Хээлтэй байх хугацаа' }, { k: 'breeding_months', label: 'Хээлтүүлэх сар' }, { k: 'birthing_months', label: 'Төллөх сар' }],
    fields: [
      { k: 'species', label: 'Малын төрөл', type: 'select', req: true, options: () => opt(state.lk.species) },
      { k: 'dam_name', label: 'Эх малын нэр', req: true },
      { k: 'births_per_year', label: 'Жилд төллөх давтамж', type: 'number' },
      { k: 'gestation', label: 'Хээлтэй байх хугацаа' },
      { k: 'breeding_months', label: 'Хээлтүүлэх сар' },
      { k: 'birthing_months', label: 'Төллөх сар' }
    ] }) },
  { id: 'general', label: 'Ерөнхий' }
];

// Хөрөнгө оруулагчид — ашгийн хувь, олгох давтамж, хугацаа (Тохиргоо → Ерөнхий)
const PAYOUT_PERIODS = ['Сар бүр', 'Улирал бүр', 'Хагас жил бүр', 'Жил бүр', 'Борлуулалт бүрийн дараа', 'Гэрээний төгсгөлд'];
const INVESTOR_CFG = () => ({
  res: 'partners', title: 'Хөрөнгө оруулагчид', itemName: 'хөрөнгө оруулагч', addLabel: '+ Хөрөнгө оруулагч нэмэх', write: 'admin',
  columns: [
    { k: 'name', label: 'Нэр' },
    { k: 'phone', label: 'Утас' },
    { k: 'invested', label: 'Оруулсан хөрөнгө', f: 'money' },
    { k: 'percent', label: 'Ашгийн хувь', f: 'pct' },
    { k: 'payout_period', label: 'Олгох давтамж' },
    { k: 'period', label: 'Хугацаа', render: r => (r.start_date || r.end_date ? `${r.start_date || '…'} – ${r.end_date || '…'}` : ''),
      csv: r => `${r.start_date || ''} – ${r.end_date || ''}` },
    { k: 'term_state', label: 'Төлөв', render: r => badge(investorState(r)), csv: r => investorState(r) },
    { k: 'note', label: 'Тэмдэглэл', cls: 'note-cell' }
  ],
  totals: ['invested', 'percent'],
  fields: [
    { k: 'name', label: 'Нэр', req: true, maxlength: 100 },
    { k: 'phone', label: 'Утас', type: 'tel', maxlength: 20 },
    { k: 'invested', label: 'Оруулсан хөрөнгө ₮', type: 'number' },
    { k: 'percent', label: 'Ашгийн хувь (%)', type: 'number', req: true, max: 100 },
    { k: 'payout_period', label: 'Олгох давтамж', type: 'select', options: () => opt(PAYOUT_PERIODS), full: true },
    { k: 'start_date', label: 'Эхлэх огноо', type: 'date' },
    { k: 'end_date', label: 'Дуусах огноо', type: 'date' },
    { k: 'note', label: 'Тэмдэглэл', type: 'textarea', full: true }
  ]
});
// Гэрээний хугацааны төлөв
function investorState(r) {
  const t = today();
  if (r.start_date && t < r.start_date) return 'Эхлээгүй';
  if (r.end_date && t > r.end_date) return 'Дууссан';
  return 'Хүчинтэй';
}

PAGES.settings = async main => {
  const tabId = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'members';
  const box = h('div');
  // Excel-ийн загвар тохиргоог (ангилал, тэжээл, төрлүүд, төллөлт, тэжээлийн төлөвлөгөө) нэг дор оруулна
  const templateBtn = h('button', { type: 'button', class: 'btn ghost small', onclick: async () => {
    if (!confirm('Excel-ийн загвар тохиргоог энэ фермд оруулах уу?\nОдоо байгаа тохиргоо өөрчлөгдөхгүй, зөвхөн дутуу зүйлс нэмэгдэнэ.')) return;
    templateBtn.disabled = true;
    try {
      const r = await api('POST', '/api/settings/template');
      toast(r.total ? `${r.total} тохиргоо нэмэгдлээ` : 'Бүх загвар тохиргоо аль хэдийн байна');
      await loadLookups(); render();
    } catch (e) { toast(e.message, 'err'); templateBtn.disabled = false; }
  } }, 'Загвар тохиргоо оруулах');
  main.replaceChildren(
    h('div', { class: 'settings-head' },
      h('div', { class: 'tabs page-tabs' }, SETTING_TABS.map(t => h('a', { class: 'tab' + (t.id === tabId ? ' active' : ''), href: '#/settings?tab=' + t.id }, t.label))),
      templateBtn),
    box);
  const tab = SETTING_TABS.find(t => t.id === tabId) || SETTING_TABS[0];
  if (tab.id === 'general') return generalSettings(box);
  if (tab.id === 'members') return membersSettings(box);
  const cfg = tab.cfg();
  cfg.onChange = async () => { await loadLookups(); await crudSection(box, cfg); };
  await crudSection(box, cfg);
};

// ----- Фермийн хэрэглэгчид (гишүүд): утасны дугаараар нэмж, цэс бүрт эрх олгоно -----
const VIEW_ONLY_MODS = ['dashboard', 'growth'];
function permEditor(perms) {
  const selects = {};
  const rows = NAV.filter(n => n.module).map(n => {
    selects[n.module] = h('select', { class: 'perm-select' },
      PERM_OPTIONS.filter(([v]) => !VIEW_ONLY_MODS.includes(n.module) || v === 'none' || v === 'view')
        .map(([v, l]) => h('option', { value: v, selected: (perms[n.module] || 'view') === v }, l)));
    return h('tr', {}, h('td', {}, n.label), h('td', {}, selects[n.module]));
  });
  const setAll = lvl => { for (const [m, sel] of Object.entries(selects)) sel.value = VIEW_ONLY_MODS.includes(m) && lvl !== 'none' ? 'view' : lvl; };
  const el = h('div', { class: 'perm-box full' },
    h('div', { class: 'perm-head' }, h('span', { class: 'field-label' }, 'Цэсийн эрх'),
      h('span', { class: 'perm-presets' },
        h('button', { type: 'button', class: 'btn ghost xs', onclick: () => setAll('view') }, 'Бүгд харах'),
        h('button', { type: 'button', class: 'btn ghost xs', onclick: () => setAll('edit') }, 'Бүгд засах'),
        h('button', { type: 'button', class: 'btn ghost xs', onclick: () => setAll('full') }, 'Бүгд бүрэн'))),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data compact perm-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Цэс'), h('th', {}, 'Эрх'))), h('tbody', {}, rows))));
  return { el, get: () => Object.fromEntries(Object.entries(selects).map(([m, sel]) => [m, sel.value])) };
}
const permSummary = p => {
  const n = lvl => Object.values(p || {}).filter(v => v === lvl).length;
  return [n('full') && `${n('full')} бүрэн`, n('edit') && `${n('edit')} засах`, n('view') && `${n('view')} харах`, n('none') && `${n('none')} хаалттай`].filter(Boolean).join(' · ');
};

async function membersSettings(box) {
  const fid = state.farmId;
  const members = await api('GET', `/api/farms/${fid}/members`);
  const reload = () => membersSettings(box);

  function openMember(m) {
    const phone = h('input', { type: 'tel', inputmode: 'numeric', maxlength: 12, value: m?.phone || '', disabled: !!m });
    const pe = permEditor(m?.perms || {});
    const msg = h('div', { class: 'form-msg' });
    // Шинээр нэмэх үед: эхлээд утасны дугаараар хэрэглэгчийг татна, олдсоны дараа эрх олгоно
    let found = m ? { id: m.user_id, name: m.name, phone: m.phone } : null;
    const foundBox = h('div', { class: 'found-user full' });
    const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, m ? 'Хадгалах' : 'Нэмэх');
    const showFound = () => {
      foundBox.replaceChildren(found ? h('div', { class: 'found-card' },
        h('span', { class: 'found-avatar' }, (found.name || '?').slice(0, 1).toUpperCase()),
        h('div', {}, h('strong', {}, found.name), h('div', { class: 'muted small' }, found.phone))) : '');
      pe.el.hidden = !found;
      submitBtn.hidden = !found;
    };
    const fetchBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Хэрэглэгч татах');
    async function fetchUser() {
      msg.className = 'form-msg'; msg.textContent = '';
      found = null; showFound();
      if (!phone.value.trim()) { msg.className = 'form-msg err'; msg.textContent = 'Утасны дугаараа оруулна уу'; phone.focus(); return; }
      fetchBtn.disabled = true;
      try { found = await api('GET', `/api/farms/${fid}/lookup-user?phone=${encodeURIComponent(phone.value)}`); showFound(); }
      catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
      finally { fetchBtn.disabled = false; }
    }
    fetchBtn.addEventListener('click', fetchUser);
    phone.addEventListener('input', () => { if (found && !m) { found = null; showFound(); } });
    phone.addEventListener('keydown', e => { if (e.key === 'Enter' && !m) { e.preventDefault(); fetchUser(); } });
    const form = h('form', { class: 'modal-body' },
      h('div', { class: 'form-grid' },
        m ? null : h('div', { class: 'field full' }, h('span', { class: 'field-label' }, 'Хэрэглэгчийн утасны дугаар *'),
          h('div', { class: 'phone-fetch' }, phone, fetchBtn)),
        foundBox,
        pe.el),
      msg,
      h('div', { class: 'modal-actions' },
        m ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!confirm(`${m.name}-г энэ фермээс хасах уу?`)) return;
          try { await api('DELETE', `/api/farms/${fid}/members/${m.user_id}`); dlg.close(); toast('Хаслаа'); reload(); }
          catch (e) { msg.className = 'form-msg err'; msg.textContent = e.message; }
        } }, 'Фермээс хасах') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Болих'),
        submitBtn));
    showFound();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!found) return fetchUser();
      try {
        if (m) await api('PATCH', `/api/farms/${fid}/members/${m.user_id}`, { perms: pe.get() });
        else { const r = await api('POST', `/api/farms/${fid}/members`, { phone: found.phone, perms: pe.get() }); toast(`${r.user.name} нэмэгдлээ`); }
        dlg.close(); if (m) toast('Хадгаллаа'); reload();
      } catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
    });
    const dlg = modal(m ? 'Хэрэглэгчийн эрх' : 'Ферм рүү хэрэглэгч нэмэх', form);
  }

  box.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Фермийн хэрэглэгчид'),
      h('div', { class: 'toolbar-right' }, h('button', { class: 'btn primary small', type: 'button', onclick: () => openMember(null) }, '+ Хэрэглэгч нэмэх'))),
    h('div', { class: 'table-wrap' }, enhanceTable(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Нэр', 'Утас', 'Эрх', 'Нэмсэн', ''].map(t => h('th', {}, t)))),
      h('tbody', {},
        h('tr', { class: 'owner-row' },
          h('td', {}, h('strong', {}, state.lk.farm.owner_name || '')), h('td', {}, ''), h('td', {}, badge('approved', 'Эзэмшигч · бүрэн эрх')), h('td', {}, ''), h('td', {})),
        members.map(m => h('tr', { class: 'clickable', onclick: () => openMember(m) },
          h('td', {}, m.name, m.status !== 'approved' ? h('span', {}, ' ', badge(m.status, STATUS_LABEL[m.status])) : null),
          h('td', {}, m.phone), h('td', {}, permSummary(m.perms)), h('td', {}, FMT.dt(m.created_at)),
          h('td', { class: 'row-actions' },
            h('button', { type: 'button', class: 'btn ghost small', onclick: e => { e.stopPropagation(); openMember(m); } }, 'Засах'),
            h('button', { type: 'button', class: 'btn danger small', onclick: async e => {
              e.stopPropagation();
              if (!confirm(`${m.name}-г энэ фермээс хасах уу?`)) return;
              try { await api('DELETE', `/api/farms/${fid}/members/${m.user_id}`); toast('Хаслаа'); reload(); } catch (ex) { toast(ex.message, 'err'); }
            } }, 'Устгах')))))))),
    h('div', { class: 'table-foot' }, h('span', { class: 'muted small' }, members.length + ' гишүүн'))));
}

// Ерөнхий: фермийн нэр, тэмдэглэл (тэжээлийн төлөвлөгөөний тохиргоо "Тэжээл" хуудсанд байна)
function generalSettings(box) {
  const farm = state.lk.farm;
  const name = h('input', { maxlength: 100, required: true, value: farm.name || '' });
  const note = h('textarea', { rows: 3, maxlength: 500 }); note.value = farm.note || '';
  const msg = h('div', { class: 'form-msg' });
  const investorsBox = h('div', { class: 'investors-box' });
  box.replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'Ерөнхий'),
    h('form', {
      onsubmit: async e => {
        e.preventDefault();
        try {
          await api('PATCH', `/api/farms/${farm.id}`, { name: name.value, note: note.value });
          await loadLookups(); toast('Хадгаллаа');
          document.querySelector('.sidebar').replaceWith(sidebar('settings'));
          msg.className = 'form-msg'; msg.textContent = '';
        } catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
      }
    },
    h('div', { class: 'form-grid' },
      h('label', { class: 'field full' }, h('span', { class: 'field-label' }, 'Фермийн нэр *'), name),
      h('label', { class: 'field full' }, h('span', { class: 'field-label' }, 'Тэмдэглэл'), note)),
    msg, h('div', { class: 'form-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Хадгалах')))),
    investorsBox);
  crudSection(investorsBox, INVESTOR_CFG()).catch(e => investorsBox.replaceChildren(h('div', { class: 'card error-card' }, e.message)));
}

// Тэжээлийн өртгийн тооцооны тохиргоо (хоног, бусад төсөв, малын төрөл, тоо) — "Тэжээл" хуудаснаас засна
function openFeedPlanSettings(onDone) {
  const s = state.lk.settings;
  const days = numberInput({ required: true }, s.plan_days);
  const other = numberInput({}, s.plan_other_budget);
  const species = h('select', {}, state.lk.species.map(sp => h('option', { value: sp, selected: s.plan_species === sp }, sp)));
  const heads = numberInput({}, s.plan_head_count);
  const msg = h('div', { class: 'form-msg' });
  const form = h('form', { class: 'modal-body' },
    h('div', { class: 'form-grid' },
      field('Төлөвлөгөөний хоног *', days),
      field('Маллагаа, ус, мал эмнэлэг бусад төсөв (1 толгой) ₮', other),
      field('Малын төрөл', species),
      field('Малын тоо', heads)),
    msg,
    h('div', { class: 'modal-actions' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Болих'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Хадгалах')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', { plan_days: days.value, plan_other_budget: other.value, plan_species: species.value, plan_head_count: heads.value });
      dlg.close(); toast('Хадгаллаа'); onDone();
    } catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
  });
  const dlg = modal('Тэжээлийн өртгийн тооцоо', form);
}

// ----- Хэрэглэгчид (админ) -----
PAGES.users = async main => {
  const users = await api('GET', '/api/admin/users');
  const reload = () => render();
  const roleSelect = (val) => h('select', {}, Object.entries(ROLE_LABEL).map(([k, l]) => h('option', { value: k, selected: k === val }, l)));
  const pending = users.filter(u => u.status === 'pending');

  async function patch(u, body, okMsg) {
    try { await api('PATCH', `/api/admin/users/${u.id}`, body); toast(okMsg); reload(); } catch (e) { toast(e.message, 'err'); }
  }

  function editUser(u) {
    const name = h('input', { value: u.name, maxlength: 80, required: true });
    const role = roleSelect(u.role);
    const status = h('select', {}, Object.entries(STATUS_LABEL).map(([k, l]) => h('option', { value: k, selected: k === u.status }, l)));
    const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    const msg = h('div', { class: 'form-msg' });
    const self = u.id === state.user.id;
    if (self) { role.disabled = true; status.disabled = true; }
    const form = h('form', { class: 'modal-body' },
      h('div', { class: 'form-grid' },
        field('Нэр', name), field('Утас', h('input', { value: u.phone, disabled: true })),
        field('Эрх', role), field('Төлөв', status),
        field('Шинэ нууц үг', pw)),
      msg,
      h('div', { class: 'modal-actions' },
        !self ? h('button', {
          class: 'btn danger', type: 'button', onclick: async () => {
            if (!confirm(`${u.name} (${u.phone}) хэрэглэгчийг бүр мөсөн устгах уу?`)) return;
            try { await api('DELETE', `/api/admin/users/${u.id}`); dlg.close(); toast('Устгалаа'); reload(); } catch (e) { msg.className = 'form-msg err'; msg.textContent = e.message; }
          }
        }, 'Устгах') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Болих'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Хадгалах')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const body = { name: name.value };
        if (!self) { body.role = role.value; body.status = status.value; }
        await api('PATCH', `/api/admin/users/${u.id}`, body);
        if (pw.value) await api('POST', `/api/admin/users/${u.id}/password`, { password: pw.value });
        dlg.close(); toast('Хадгаллаа'); reload();
      } catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
    });
    const dlg = modal('Хэрэглэгч засах', form);
  }

  function addUser() {
    const name = h('input', { maxlength: 80, required: true });
    const phone = h('input', { type: 'tel', inputmode: 'numeric', maxlength: 12, required: true });
    const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const role = roleSelect('viewer');
    const msg = h('div', { class: 'form-msg' });
    const form = h('form', { class: 'modal-body' },
      h('div', { class: 'form-grid' }, field('Нэр', name), field('Утасны дугаар', phone), field('Нууц үг', pw), field('Эрх', role)),
      msg,
      h('div', { class: 'modal-actions' }, h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Болих'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Нэмэх')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      try { await api('POST', '/api/admin/users', { name: name.value, phone: phone.value, password: pw.value, role: role.value }); dlg.close(); toast('Хэрэглэгч нэмэгдлээ'); reload(); }
      catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
    });
    const dlg = modal('Шинэ хэрэглэгч', form);
  }



  // Хүлээгдэж буй хэрэглэгчийн мөрийн төгсгөлд: эрх сонгох + Батлах / Татгалзах
  const approveCell = u => {
    if (u.status !== 'pending') {
      const self = u.id === state.user.id;
      return h('td', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: e => { e.stopPropagation(); editUser(u); } }, 'Засах'),
        !self ? h('button', { type: 'button', class: 'btn danger small', onclick: async e => {
          e.stopPropagation();
          if (!confirm(`${u.name} (${u.phone}) хэрэглэгчийг бүр мөсөн устгах уу?`)) return;
          try { await api('DELETE', `/api/admin/users/${u.id}`); toast('Устгалаа'); reload(); } catch (ex) { toast(ex.message, 'err'); }
        } }, 'Устгах') : null);
    }
    const role = roleSelect('viewer');
    const stop = e => e.stopPropagation();
    role.addEventListener('click', stop);
    return h('td', { class: 'row-actions approve-cell', onclick: stop },
      h('label', { class: 'inline' }, 'Эрх: ', role),
      h('button', { class: 'btn primary small', type: 'button', onclick: () => patch(u, { status: 'approved', role: role.value }, `${u.name} баталгаажлаа`) }, 'Батлах'),
      h('button', { class: 'btn danger small', type: 'button', onclick: () => { if (confirm(`${u.name}-ийн бүртгэлийг татгалзах уу?`)) patch(u, { status: 'rejected' }, 'Татгалзлаа'); } }, 'Татгалзах'));
  };

  fill(main,
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', {}, 'Бүх хэрэглэгч'),
        h('div', { class: 'toolbar-right' }, h('button', { class: 'btn primary small', onclick: addUser }, '+ Хэрэглэгч нэмэх'))),
      h('div', { class: 'table-wrap' }, enhanceTable(h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Нэр', 'Утас', 'Эрх', 'Төлөв', 'Ферм', 'Бүртгүүлсэн', 'Шийдвэрлэсэн', 'Сүүлд нэвтэрсэн', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, users.map(u => h('tr', { class: 'clickable' + (u.status === 'pending' ? ' pending-row' : ''), onclick: () => editUser(u) },
          h('td', {}, u.name, u.id === state.user.id ? h('span', { class: 'muted small' }, ' (та)') : null),
          h('td', {}, u.phone), h('td', {}, ROLE_LABEL[u.role]),
          h('td', {}, badge(u.status, STATUS_LABEL[u.status])),
          h('td', { class: 'num' }, u.farm_count),
          h('td', {}, FMT.dt(u.created_at)),
          h('td', {}, u.reviewed_at ? `${FMT.dt(u.reviewed_at)}${u.reviewed_by_name ? ' · ' + u.reviewed_by_name : ''}` : ''),
          h('td', {}, FMT.dt(u.last_login)),
          approveCell(u)))))))));
};

// ----- Миний фермүүд: ферм үүсгэх, сонгож орох, засах, устгах -----
PAGES.farms = async main => {
  const farms = await api('GET', '/api/farms');
  const reload = () => render();
  const enter = f => { setFarm(f.id); location.hash = '#/dashboard'; };

  function farmForm(f) {
    const name = h('input', { maxlength: 100, required: true, value: f?.name || '' });
    const note = h('textarea', { rows: 2, maxlength: 500 }); note.value = f?.note || '';
    // Анхдагч: Excel-ийн загвар тохиргоо; эсвэл өөр фермээс хуулах; эсвэл хоосон
    const copy = h('select', {},
      h('option', { value: 'template', selected: true }, 'Загвар тохиргоо (Excel)'),
      h('option', { value: '' }, 'Хоосон эхлэх'),
      farms.map(x => h('option', { value: x.id }, `"${x.name}" фермээс хуулах` + (x.mine ? '' : ` (${x.owner_name})`))));
    const msg = h('div', { class: 'form-msg' });
    const form = h('form', { class: 'modal-body' },
      h('div', { class: 'form-grid' },
        h('label', { class: 'field full' }, h('span', { class: 'field-label' }, 'Фермийн нэр *'), name),
        h('label', { class: 'field full' }, h('span', { class: 'field-label' }, 'Тэмдэглэл'), note),
        !f ? h('label', { class: 'field full' }, h('span', { class: 'field-label' }, 'Тохиргоо'), copy) : null),
      msg,
      h('div', { class: 'modal-actions' }, h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Болих'),
        h('button', { class: 'btn primary', type: 'submit' }, f ? 'Хадгалах' : 'Үүсгэх')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        if (f) { await api('PATCH', `/api/farms/${f.id}`, { name: name.value, note: note.value }); dlg.close(); toast('Хадгаллаа'); reload(); }
        else {
          const r = await api('POST', '/api/farms', { name: name.value, note: note.value, copy_from: copy.value || null });
          dlg.close(); toast('Ферм үүслээ'); enter({ id: r.id });
        }
      } catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
    });
    const dlg = modal(f ? 'Ферм засах' : 'Шинэ ферм', form);
    name.focus();
  }

  async function removeFarm(f) {
    const typed = prompt(`"${f.name}" фермийг түүний БҮХ бүртгэл (мал, жинлэлт, зардал, зураг…)-тэй нь хамт устгана. Буцаах боломжгүй.\n\nБаталгаажуулахын тулд фермийн нэрийг бичнэ үү:`);
    if (typed == null) return;
    if (typed.trim() !== f.name) { toast('Фермийн нэр таарсангүй', 'err'); return; }
    try {
      await api('DELETE', `/api/farms/${f.id}`);
      if (state.farmId === f.id) setFarm(null);
      toast('Ферм устгагдлаа'); reload();
    } catch (e) { toast(e.message, 'err'); }
  }

  const card = f => h('div', { class: 'farm-card' + (f.id === state.farmId ? ' current' : '') },
    h('div', { class: 'farm-card-head' },
      h('h3', {}, f.name),
      f.id === state.farmId ? badge('approved', 'Сонгосон') : null),
    !f.mine ? h('div', { class: 'muted small' }, `Эзэмшигч: ${f.owner_name}${f.can_manage ? ` (${f.owner_phone})` : ''}`) : null,
    f.note ? h('p', { class: 'farm-note' }, f.note) : null,
    h('div', { class: 'farm-stats' },
      h('span', {}, h('strong', {}, f.active_animals), ' идэвхтэй мал'),
      f.can_manage && f.member_count ? h('span', {}, h('strong', {}, f.member_count), ' гишүүн') : null,
      f.tasks_due ? h('span', { class: 'warn' }, h('strong', {}, f.tasks_due), ' ажил хүлээгдэж байна') : null),
    h('div', { class: 'farm-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => enter(f) }, 'Орох →'),
      h('span', { class: 'spacer' }),
      f.can_manage ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => farmForm(f) }, 'Засах') : null,
      f.can_manage ? h('button', { class: 'btn danger small', type: 'button', onclick: () => removeFarm(f) }, 'Устгах') : null));

  const mine = farms.filter(f => f.mine), shared = farms.filter(f => f.shared), others = farms.filter(f => !f.mine && !f.shared);
  fill(main,
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', {}, 'Миний фермүүд'),
        h('div', { class: 'toolbar-right' }, h('button', { class: 'btn primary small', type: 'button', onclick: () => farmForm(null) }, '+ Ферм үүсгэх'))),
      mine.length ? h('div', { class: 'farm-grid' }, mine.map(card))
        : h('div', { class: 'empty-farms' }, h('p', {}, 'Танд ферм алга байна.'),
            h('button', { class: 'btn primary', type: 'button', onclick: () => farmForm(null) }, '+ Анхны фермээ үүсгэх'))),
    shared.length ? h('section', { class: 'card' }, h('h2', {}, `Надад хуваалцсан фермүүд (${shared.length})`),
      h('div', { class: 'farm-grid' }, shared.map(card))) : null,
    others.length ? h('section', { class: 'card' }, h('h2', {}, `Бусад хэрэглэгчийн фермүүд (${others.length})`),
      h('div', { class: 'farm-grid' }, others.map(card))) : null);
};

// ----- Мэдээ (админ): нүүр хуудсанд гарах мэдээ нийтлэх -----
PAGES.news = async main => {
  const list = await api('GET', '/api/admin/news');
  const reload = () => render();
  function openNews(n) {
    const title = h('input', { maxlength: 200, required: true, value: n?.title || '' });
    const body = h('textarea', { rows: 10, maxlength: 20000, required: true }); body.value = n?.body || '';
    const pub = h('select', {}, h('option', { value: '1', selected: !n || n.published === 1 }, 'Нийтэлсэн'), h('option', { value: '0', selected: !!n && n.published === 0 }, 'Ноорог'));
    const msg = h('div', { class: 'form-msg' });
    const form = h('form', { class: 'modal-body' },
      h('div', { class: 'form-grid' },
        h('label', { class: 'field full' }, h('span', { class: 'field-label' }, 'Гарчиг *'), title),
        h('label', { class: 'field full' }, h('span', { class: 'field-label' }, 'Агуулга *'), body),
        field('Төлөв', pub)),
      msg,
      h('div', { class: 'modal-actions' },
        n ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!confirm('Энэ мэдээг устгах уу?')) return;
          try { await api('DELETE', `/api/admin/news/${n.id}`); dlg.close(); toast('Устгалаа'); reload(); } catch (e) { msg.className = 'form-msg err'; msg.textContent = e.message; }
        } }, 'Устгах') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Болих'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Хадгалах')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const payload = { title: title.value, body: body.value, published: pub.value === '1' };
      try {
        if (n) await api('PUT', `/api/admin/news/${n.id}`, payload); else await api('POST', '/api/admin/news', payload);
        dlg.close(); toast('Хадгаллаа'); reload();
      } catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
    });
    const dlg = modal(n ? 'Мэдээ засах' : 'Шинэ мэдээ', form);
    title.focus();
  }
  main.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Мэдээ'),
      h('div', { class: 'toolbar-right' }, h('button', { class: 'btn primary small', type: 'button', onclick: () => openNews(null) }, '+ Мэдээ нэмэх'))),
    h('div', { class: 'table-wrap' }, enhanceTable(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Огноо', 'Гарчиг', 'Төлөв', 'Нийтэлсэн', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, list.length ? list.map(n => h('tr', { class: 'clickable', onclick: () => openNews(n) },
        h('td', {}, FMT.dt(n.created_at)), h('td', { class: 'note-cell' }, h('strong', {}, n.title)),
        h('td', {}, n.published ? badge('approved', 'Нийтэлсэн') : badge('Цуцалсан', 'Ноорог')),
        h('td', {}, n.author || ''),
        h('td', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn ghost small', onclick: e => { e.stopPropagation(); openNews(n); } }, 'Засах'),
          h('button', { type: 'button', class: 'btn danger small', onclick: async e => {
            e.stopPropagation();
            if (!confirm(`"${n.title}" мэдээг устгах уу?`)) return;
            try { await api('DELETE', `/api/admin/news/${n.id}`); toast('Устгалаа'); reload(); } catch (ex) { toast(ex.message, 'err'); }
          } }, 'Устгах')))) : h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'Мэдээ алга'))))))));
};

PAGES.audit = async main => {
  const rows = await api('GET', '/api/admin/audit');
  let q = '';
  const tbody = h('tbody');
  const draw = () => {
    const list = rows.filter(r => !q || [r.user_name, r.user_phone, r.farm_name, r.action, r.entity, r.detail].some(v => String(v ?? '').toLowerCase().includes(q)));
    tbody.replaceChildren(...list.map(r => h('tr', {},
      h('td', {}, FMT.dt(r.at)), h('td', {}, r.user_name ? `${r.user_name} (${r.user_phone})` : '—'), h('td', {}, r.farm_name ?? ''),
      h('td', {}, r.action), h('td', {}, r.detail ?? ''))));
  };
  main.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Үйлдлийн түүх (сүүлийн 1000)'),
      h('div', { class: 'toolbar-right' }, h('input', { type: 'search', class: 'search', placeholder: 'Хайх…', oninput: e => { q = e.target.value.toLowerCase(); draw(); } }))),
    h('div', { class: 'table-wrap' }, enhanceTable(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Цаг', 'Хэрэглэгч', 'Ферм', 'Үйлдэл', 'Дэлгэрэнгүй'].map(t => h('th', {}, t)))), tbody)))));
  draw();
};

PAGES.profile = async main => {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const nw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const msg = h('div', { class: 'form-msg' });
  main.replaceChildren(
    h('section', { class: 'card narrow' }, h('h2', {}, 'Миний мэдээлэл'),
      h('div', { class: 'kv-grid' },
        h('div', { class: 'kv' }, h('span', {}, 'Нэр'), h('span', {}, state.user.name)),
        h('div', { class: 'kv' }, h('span', {}, 'Утас'), h('span', {}, state.user.phone)),
        h('div', { class: 'kv' }, h('span', {}, 'Эрх'), h('span', {}, ROLE_LABEL[state.user.role])))),
    h('section', { class: 'card narrow' }, h('h2', {}, 'Нууц үг солих'),
      h('form', {
        onsubmit: async e => {
          e.preventDefault(); msg.className = 'form-msg'; msg.textContent = '';
          try {
            if (nw.value !== nw2.value) throw new Error('Шинэ нууц үг таарахгүй байна');
            await api('POST', '/api/auth/password', { current: cur.value, next: nw.value });
            e.target.reset(); msg.className = 'form-msg ok'; msg.textContent = 'Нууц үг солигдлоо';
          } catch (ex) { msg.className = 'form-msg err'; msg.textContent = ex.message; }
        }
      }, field('Одоогийн нууц үг', cur), field('Шинэ нууц үг', nw), field('Шинэ нууц үг давтах', nw2), msg,
      h('div', { class: 'form-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Солих')))));
};

// ---------- Эхлүүлэх ----------
(async () => {
  try { state.user = (await api('GET', '/api/auth/me')).user; } catch { state.user = null; }
  render();
})();

import { createDb } from './db.js';
import * as maps from './maps/provider.js';
import { solvePath } from './solver.js';
import { wazeUrl, gmapsUrl, gmapsSegments } from './nav.js';
import {
  $, el, esc, todayStr, fmtDate, fmtTime, fmtDist, fmtDur, norm, addressKey, fullAddress,
  splitAddress, haversine, decodePolyline, getCurrentPosition, prefs,
} from './util.js';

// ------------------------------------------------------------------ constants
const STATUS = {
  pending:         { label: 'ממתין',          icon: '⏳', active: true },
  no_answer_temp:  { label: 'לא ענה – זמני',   icon: '📵', active: true, cls: 'temp' },
  delivered_hand:  { label: 'נמסר ביד',        icon: '🤝', final: true, cls: 'done' },
  delivered_door:  { label: 'נמסר ליד הדלת',   icon: '🚪', final: true, cls: 'done' },
  no_answer_final: { label: 'לא ענה – סופי',   icon: '❌', final: true, cls: 'nofinal' },
};
const DEFAULT_SETTINGS = { defaultCity: 'חולון', geocoder: 'osm', googleKey: '' };

// ------------------------------------------------------------------ state
const S = {
  db: null, user: null,
  today: todayStr(), date: todayStr(),
  day: null, deliveries: [], unsubs: [],
  unlocked: false,
  hideDone: prefs.get('hideDone', false),
  sort: prefs.get('sort', 'updated'),
  me: null, dist: {}, distAt: null,
  streets: {}, settings: { ...DEFAULT_SETTINGS },
  map: null, layers: null, pickFor: null, mapFitted: false,
  movePromptShown: false,
};

// ------------------------------------------------------------------ helpers
const isFinal = (d) => !!STATUS[d.status]?.final || !!d.movedTo;
const isActive = (d) => !isFinal(d);
const hasCoords = (d) => d.lat != null && d.lng != null;
const readonly = () => S.date < S.today && !S.unlocked;
const stopLabel = (stop, sub) => (stop == null ? null : sub ? `${stop}-${sub}` : `${stop}`);
const orderKey = (stop, sub) => (stop == null ? Infinity : stop * 1000 + (sub || 0));
const now = () => Date.now();

function toast(msg, { err = false, ms = 3200 } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => (t.hidden = true), ms);
}

function openModal(build, { onClose } = {}) {
  const root = $('#modalRoot');
  const sheet = el('div', { class: 'sheet', role: 'dialog' });
  const overlay = el('div', { class: 'overlay' }, sheet);
  const close = () => { overlay.remove(); onClose?.(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  build(sheet, close);
  root.append(overlay);
  return close;
}

function confirmModal({ title, body, okText = 'אישור', danger = false, requireWord = null }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, close) => { done = true; close(); resolve(v); };
    openModal((m, close) => {
      m.append(el('h2', {}, title));
      if (body) m.append(typeof body === 'string' ? el('p', { html: body }) : body);
      let input;
      const ok = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => finish(true, close) }, okText);
      if (requireWord) {
        input = el('input', { type: 'text', placeholder: `הקלד "${requireWord}"`, autocomplete: 'off' });
        ok.disabled = true;
        input.addEventListener('input', () => (ok.disabled = input.value.trim() !== requireWord));
        m.append(el('label', { class: 'field' }, `כדי לאשר הקלד: ${requireWord}`, input));
      }
      m.append(el('div', { class: 'sheet-actions' }, ok, el('button', { class: 'btn', type: 'button', onclick: () => finish(false, close) }, 'ביטול')));
      input?.focus();
    }, { onClose: () => { if (!done) resolve(false); } });
  });
}

// ------------------------------------------------------------------ streets autocomplete
async function ensureStreets(city) {
  city = (city || '').trim();
  if (!city) return [];
  if (S.streets[city]) return S.streets[city];
  const metaName = 'streets-' + city;
  try {
    const cached = await S.db.getMeta(metaName);
    if (cached?.names?.length) return (S.streets[city] = cached.names);
  } catch { /* ignore */ }
  try {
    const names = await maps.streets(city);
    S.streets[city] = names;
    if (names.length) S.db.setMeta(metaName, { names, city, at: now() }).catch(() => {});
    return names;
  } catch (e) {
    console.warn('streets', e);
    return (S.streets[city] = []);
  }
}

function attachAutocomplete(input, getCity) {
  const wrap = input.parentElement;
  let box = null, items = [], idx = -1;
  const hide = () => { box?.remove(); box = null; idx = -1; };
  const pick = (name) => { input.value = name; hide(); input.dispatchEvent(new Event('change')); };
  const show = async () => {
    const list = await ensureStreets(getCity());
    items = maps.streetSuggest(list, input.value);
    hide();
    if (!items.length || (items.length === 1 && norm(items[0]) === norm(input.value))) return;
    const q = norm(input.value);
    box = el('div', { class: 'ac-list' });
    items.forEach((name) => {
      const n = norm(name), i = n.indexOf(q);
      const html = i >= 0 && n === name.toLowerCase()
        ? esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length))
        : esc(name);
      box.append(el('div', { html, onmousedown: (e) => { e.preventDefault(); pick(name); } }));
    });
    wrap.append(box);
  };
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', show);
  input.addEventListener('focus', () => { if (input.value) show(); });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => {
    if (!box) return;
    const nodes = [...box.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length;
      nodes.forEach((n, i) => n.classList.toggle('on', i === idx));
    } else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); pick(items[idx]); }
    else if (e.key === 'Escape') hide();
  });
}

// ------------------------------------------------------------------ geocoding
async function geocodeDelivery(d, { force = false } = {}) {
  const key = addressKey(d);
  let res = null;
  if (!force) {
    const c = await S.db.getGeo(key).catch(() => null);
    if (c && (c.precision === 'house' || c.precision === 'manual' || c.src === maps.geocoderName())) res = c;
  }
  if (!res) {
    try {
      const r = await maps.geocode({ street: d.street, houseNo: d.houseNo, city: d.city });
      res = r ? { lat: r.lat, lng: r.lng, precision: r.precision, src: maps.geocoderName(), at: now() } : { precision: 'none', src: maps.geocoderName(), at: now() };
      if (r) S.db.setGeo(key, res).catch(() => {});
    } catch (e) {
      console.warn('geocode', e);
      res = { precision: 'none' };
    }
  }
  const patch = res.lat != null
    ? { lat: res.lat, lng: res.lng, geoStatus: res.precision === 'house' ? 'ok' : res.precision === 'manual' ? 'manual' : 'approx' }
    : { lat: null, lng: null, geoStatus: 'failed' };
  await S.db.updateDelivery(S.date, d.shipmentId, patch);
  return patch;
}

async function geocodeMany(list, { force = false } = {}) {
  if (!list.length) return;
  const seen = new Map();
  let i = 0, failed = 0;
  for (const d of list) {
    i++;
    toast(`מאתר כתובות ${i}/${list.length}…`, { ms: 0 });
    const k = addressKey(d);
    let patch = seen.get(k);
    if (patch) await S.db.updateDelivery(S.date, d.shipmentId, patch);
    else { patch = await geocodeDelivery(d, { force }); seen.set(k, patch); }
    if (patch.geoStatus === 'failed') failed++;
  }
  toast(failed ? `איתור הסתיים – ${failed} כתובות לא אותרו (מסומנות באדום)` : 'כל הכתובות אותרו ✓', { err: !!failed, ms: 5000 });
}

// ------------------------------------------------------------------ route building
async function resolvePoint(spec) {
  if (spec.type === 'gps') {
    const p = await getCurrentPosition();
    setMe(p);
    return { lat: p.lat, lng: p.lng, type: 'gps', text: 'מיקום נוכחי' };
  }
  const text = spec.text.trim();
  const { street, houseNo } = splitAddress(text.split(',')[0]);
  const city = (text.split(',')[1] || S.settings.defaultCity).trim();
  const r = await maps.geocode({ street, houseNo, city });
  if (!r) throw new Error(`לא נמצאה הכתובת: ${text}`);
  return { lat: r.lat, lng: r.lng, type: 'address', text: `${street} ${houseNo}, ${city}`.replace(/\s+,/, ',') };
}

async function buildMatrix(points) {
  const fallback = () => points.map((a) => points.map((b) => haversine(a, b) / 7));
  if (points.length > 100) return fallback();
  try {
    const m = await maps.matrix(points);
    return m.map((row, i) => row.map((v, j) => (v == null ? haversine(points[i], points[j]) / 7 : v)));
  } catch (e) {
    console.warn('matrix fallback', e);
    toast('שירות המסלולים לא זמין – משתמש במרחק אווירי', { err: true });
    return fallback();
  }
}

async function buildRoute(kind, startSpec, endSpec) {
  if (kind === 'initial' && S.day?.hasInitialRoute) throw new Error('המסלול הראשוני כבר נבנה ואינו משתנה');
  const eligible = S.deliveries.filter((d) => isActive(d) && hasCoords(d));
  if (!eligible.length) throw new Error('אין כתובות פעילות מאותרות לבניית מסלול');

  toast('מחשב מסלול…', { ms: 0 });
  const start = await resolvePoint(startSpec);
  const end = endSpec ? await resolvePoint(endSpec) : null;

  const groups = new Map();
  for (const d of eligible) {
    const k = addressKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const gList = [...groups.values()].map((members) => {
    members.sort((a, b) => (a.appOrder ?? 1e9) - (b.appOrder ?? 1e9) || String(a.shipmentId).localeCompare(String(b.shipmentId)));
    return { members, lat: members[0].lat, lng: members[0].lng };
  });

  const points = [start, ...gList, ...(end ? [end] : [])];
  const matrix = await buildMatrix(points);
  const order = solvePath(matrix, { hasEnd: !!end });
  const ordered = order.map((i) => gList[i - 1]);

  const updates = [];
  const touched = new Set();
  ordered.forEach((g, gi) => {
    g.members.forEach((d, mi) => {
      const stop = gi + 1, sub = g.members.length > 1 ? mi + 1 : null;
      const patch = { updatedStop: stop, updatedSub: sub };
      if (kind === 'initial') Object.assign(patch, { initialStop: stop, initialSub: sub });
      updates.push({ id: d.shipmentId, patch });
      touched.add(d.shipmentId);
    });
  });
  for (const d of S.deliveries) {
    if (!touched.has(d.shipmentId) && d.updatedStop != null) updates.push({ id: d.shipmentId, patch: { updatedStop: null, updatedSub: null } });
  }
  await S.db.updateMany(S.date, updates);

  let line = null;
  try { line = await maps.routeLine([start, ...ordered, ...(end ? [end] : [])]); } catch (e) { console.warn('route line', e); }

  const dayPatch = {
    start, end: end || null,
    routePolyline: line?.polyline || null,
    routeDistance: line?.distance ?? null,
    routeDuration: line?.duration ?? null,
    updatedBuiltAt: now(),
  };
  if (kind === 'initial') Object.assign(dayPatch, { hasInitialRoute: true, initialBuiltAt: now() });
  await S.db.saveDay(S.date, dayPatch);

  const skipped = S.deliveries.filter((d) => isActive(d) && !hasCoords(d)).length;
  toast(`${kind === 'initial' ? 'מסלול ראשוני' : 'מסלול מעודכן'} נבנה: ${ordered.length} עצירות` +
    (line ? ` · ${fmtDist(line.distance)} · ${fmtDur(line.duration)}` : '') +
    (skipped ? ` · ${skipped} לא אותרו ולא נכללו` : ''), { ms: 6000 });
}

// ------------------------------------------------------------------ location & distances
function setMe(p) {
  S.me = p;
  renderMap();
}

async function refreshLocation() {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  try {
    toast('מאתר מיקום…', { ms: 0 });
    const me = await getCurrentPosition();
    setMe(me);
    const targets = S.deliveries.filter((d) => isActive(d) && hasCoords(d));
    const dist = {};
    targets.forEach((d) => (dist[d.shipmentId] = { air: haversine(me, d) }));
    // Unique coordinates only (several parcels at one address).
    const uniq = new Map();
    targets.forEach((d) => { const k = `${d.lat.toFixed(6)},${d.lng.toFixed(6)}`; if (!uniq.has(k)) uniq.set(k, { lat: d.lat, lng: d.lng, ids: [] }); uniq.get(k).ids.push(d.shipmentId); });
    const pts = [...uniq.values()];
    toast('מחשב מרחקים…', { ms: 0 });
    let failed = 0;
    for (let i = 0; i < pts.length; i += 90) {
      const chunk = pts.slice(i, i + 90);
      const [car, foot] = await Promise.allSettled([maps.fromOrigin([me, ...chunk], 'car'), maps.fromOrigin([me, ...chunk], 'foot')]);
      chunk.forEach((p, j) => p.ids.forEach((id) => {
        if (car.status === 'fulfilled') dist[id].car = car.value[j];
        if (foot.status === 'fulfilled') dist[id].foot = foot.value[j];
      }));
      if (car.status === 'rejected' || foot.status === 'rejected') failed++;
    }
    S.dist = dist;
    S.distAt = now();
    render();
    toast(failed ? 'חלק מהמרחקים חושבו באוויר (שירות המסלולים לא זמין)' : `המרחקים עודכנו (${targets.length} יעדים)`, { err: !!failed });
  } catch (e) {
    toast(e.message, { err: true, ms: 6000 });
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ status
async function setStatus(d, status) {
  if (readonly()) return;
  const history = [...(d.history || []), { status, at: now() }].slice(-30);
  await S.db.updateDelivery(S.date, d.shipmentId, { status, statusAt: now(), history });
  if (STATUS[status].final) toast(`${d.name || d.shipmentId}: ${STATUS[status].label}`);
}

function statusSheet(d) {
  openModal((m, close) => {
    m.append(el('h2', {}, `סטטוס · ${d.name || d.shipmentId}`), el('p', { class: 'muted' }, fullAddress(d)));
    const box = el('div', { class: 'status-opts' });
    for (const [key, s] of Object.entries(STATUS)) {
      box.append(el('button', {
        class: 'btn' + (d.status === key ? ' cur' : ''), type: 'button',
        onclick: async () => { close(); await setStatus(d, key); },
      }, `${s.icon} ${s.label}`));
    }
    m.append(box);
    if (isFinal(d) && !d.movedTo) {
      m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: async () => { close(); await setStatus(d, 'pending'); } }, '↩ בטל – חזרה לממתין')));
    }
    if (d.history?.length) {
      m.append(el('h3', {}, 'היסטוריה'), el('div', { class: 'muted' },
        d.history.slice().reverse().map((h) => el('div', {}, `${fmtTime(h.at)} · ${STATUS[h.status]?.label || h.status}`))));
    }
  });
}

// ------------------------------------------------------------------ rendering
function sorted(list) {
  const dk = (d, mode, f) => S.dist[d.shipmentId]?.[mode]?.[f];
  const cmp = {
    updated: (a, b) => orderKey(a.updatedStop, a.updatedSub) - orderKey(b.updatedStop, b.updatedSub) || orderKey(a.initialStop, a.initialSub) - orderKey(b.initialStop, b.initialSub),
    initial: (a, b) => orderKey(a.initialStop, a.initialSub) - orderKey(b.initialStop, b.initialSub),
    app: (a, b) => (a.appOrder ?? Infinity) - (b.appOrder ?? Infinity),
    drive: (a, b) => (dk(a, 'car', 't') ?? Infinity) - (dk(b, 'car', 't') ?? Infinity),
    walk: (a, b) => (dk(a, 'foot', 't') ?? Infinity) - (dk(b, 'foot', 't') ?? Infinity),
    dist: (a, b) => (dk(a, 'car', 'd') ?? S.dist[a.shipmentId]?.air ?? Infinity) - (dk(b, 'car', 'd') ?? S.dist[b.shipmentId]?.air ?? Infinity),
  }[S.sort];
  const tie = (a, b) => (a.appOrder ?? Infinity) - (b.appOrder ?? Infinity) || String(a.shipmentId).localeCompare(String(b.shipmentId));
  return list.slice().sort((a, b) => {
    const r = cmp(a, b);
    return Number.isNaN(r) || r === 0 ? tie(a, b) : r;
  });
}

function badge(cls, label, value) {
  return value == null
    ? el('span', { class: 'badge none' }, `${label} —`)
    : el('span', { class: 'badge ' + cls }, el('small', {}, label), value);
}

function geoChip(d) {
  const map = { approx: ['approx', 'מיקום משוער (רחוב)'], failed: ['failed', 'לא אותר!'], manual: ['manual', 'סומן ידנית'], pending: ['pending', 'ממתין לאיתור'] };
  const g = map[d.geoStatus || 'pending'];
  return g ? el('span', { class: 'geo ' + g[0] }, g[1]) : null;
}

function card(d) {
  const st = STATUS[d.status] || STATUS.pending;
  const fin = isFinal(d);
  const ro = readonly();
  const dist = S.dist[d.shipmentId];
  const c = el('article', { class: 'card ' + (fin ? 'done' : st.cls || ''), id: 'c-' + d.shipmentId });

  c.append(el('div', { class: 'card-top' },
    badge('init', 'ראשוני', stopLabel(d.initialStop, d.initialSub)),
    badge('upd', 'מעודכן', fin ? null : stopLabel(d.updatedStop, d.updatedSub)),
    badge('app', 'אפליקציה', d.appOrder != null ? '#' + d.appOrder : null),
    el('span', { class: 'ship' }, d.shipmentId),
  ));
  c.append(el('div', { class: 'name strike' }, d.name || '—'));
  c.append(el('div', { class: 'addr' }, el('span', { class: 'strike' }, fullAddress(d)), geoChip(d)));
  if (d.ref) c.append(el('div', { class: 'ref' }, `אס' 2: ${d.ref}`));

  if (!fin && dist) {
    c.append(el('div', { class: 'dist' },
      dist.car ? el('span', {}, `🚗 ${fmtDist(dist.car.d)} · ${fmtDur(dist.car.t)}`) : null,
      dist.foot ? el('span', {}, `🚶 ${fmtDist(dist.foot.d)} · ${fmtDur(dist.foot.t)}`) : null,
      !dist.car && !dist.foot ? el('span', { class: 'air' }, `✈️ ${fmtDist(dist.air)} (אווירי)`) : null,
    ));
  }
  if (d.movedTo) c.append(el('div', { class: 'status-line' }, `➡️ הועבר ליום ${d.movedTo.split('-').reverse().join('/')}`));
  else if (d.status && d.status !== 'pending') c.append(el('div', { class: 'status-line ' + (st.cls || '') }, `${st.icon} ${st.label}${d.statusAt ? ' · ' + fmtTime(d.statusAt) : ''}`));

  const actions = el('div', { class: 'actions' });
  if (!ro && !d.movedTo) {
    if (fin) actions.append(el('button', { class: 'btn', type: 'button', onclick: () => setStatus(d, 'pending') }, '↩ בטל'));
    actions.append(el('button', { class: 'btn', type: 'button', onclick: () => statusSheet(d) }, fin ? 'שנה סטטוס' : `${st.icon} סטטוס`));
  }
  if (!fin) {
    actions.append(
      el('a', { class: 'btn waze', href: wazeUrl(d), target: '_blank', rel: 'noopener' }, 'Waze'),
      el('a', { class: 'btn gmaps', href: gmapsUrl(d), target: '_blank', rel: 'noopener' }, 'Google'),
    );
  }
  if (!ro) actions.append(el('button', { class: 'btn edit', type: 'button', title: 'עריכה', onclick: () => editSheet(d) }, '✎'));
  c.append(actions);
  return c;
}

function nextStops() {
  const act = S.deliveries.filter(isActive);
  const byRoute = act.slice().sort((a, b) => orderKey(a.updatedStop, a.updatedSub) - orderKey(b.updatedStop, b.updatedSub) || (a.appOrder ?? 1e9) - (b.appOrder ?? 1e9));
  const next = byRoute[0] || null;
  let nearest = null;
  if (S.me) {
    const withD = act.filter(hasCoords).map((d) => ({ d, v: S.dist[d.shipmentId]?.car?.t ?? haversine(S.me, d) / 7 }));
    withD.sort((a, b) => a.v - b.v);
    nearest = withD[0]?.d || null;
  }
  return { next, nearest };
}

function renderNext() {
  const box = $('#nextStop');
  const { next, nearest } = nextStops();
  if (!next || readonly()) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(...[
    el('div', { class: 'lbl' }, `העצירה הבאה · מסלול מעודכן ${stopLabel(next.updatedStop, next.updatedSub) ?? '—'} · ראשוני ${stopLabel(next.initialStop, next.initialSub) ?? '—'}`),
    el('div', { class: 'who' }, `${next.name || ''} – ${fullAddress(next)}`),
    el('div', { class: 'row' },
      el('a', { class: 'btn waze small', href: wazeUrl(next), target: '_blank', rel: 'noopener' }, 'נווט ב-Waze'),
      el('a', { class: 'btn gmaps small', href: gmapsUrl(next), target: '_blank', rel: 'noopener' }, 'Google Maps'),
      el('button', { class: 'btn small', type: 'button', onclick: () => scrollToCard(next.shipmentId) }, 'הצג'),
    ),
    nearest && nearest.shipmentId !== next.shipmentId
      ? el('div', { class: 'alt' }, `📍 הכי קרוב אליך עכשיו: ${nearest.name || ''} – ${fullAddress(nearest)} `, el('button', { class: 'btn small ghost', style: 'color:#fff;border-color:rgba(255,255,255,.4)', type: 'button', onclick: () => scrollToCard(nearest.shipmentId) }, 'הצג'))
      : null,
  ].filter(Boolean));
}

function scrollToCard(id) {
  const c = document.getElementById('c-' + id);
  if (!c) { S.hideDone = false; $('#hideDone').checked = false; render(); return scrollToCard(id); }
  c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  c.classList.add('highlight');
  setTimeout(() => c.classList.remove('highlight'), 1800);
}

function renderCounts() {
  const all = S.deliveries;
  const act = all.filter(isActive);
  const temp = all.filter((d) => d.status === 'no_answer_temp' && !d.movedTo).length;
  const done = all.filter((d) => ['delivered_hand', 'delivered_door'].includes(d.status)).length;
  const nf = all.filter((d) => d.status === 'no_answer_final').length;
  const failed = all.filter((d) => d.geoStatus === 'failed').length;
  const pill = (t, n) => el('span', { class: 'pill' }, t, ' ', el('b', {}, n));
  $('#counts').replaceChildren(...[
    pill('סה״כ', all.length), pill('פעילים', act.length), pill('נמסרו', done),
    temp ? pill('לא ענה זמני', temp) : null, nf ? pill('לא ענה סופי', nf) : null,
    failed ? el('span', { class: 'pill', style: 'color:var(--danger)' }, `לא אותרו `, el('b', {}, failed)) : null,
  ].filter(Boolean));
  const parts = [];
  if (S.me) parts.push(`📍 מיקום עודכן ${fmtTime(S.me.at)} (±${Math.round(S.me.accuracy || 0)} מ׳)`);
  if (S.day?.routeDistance) parts.push(`מסלול: ${fmtDist(S.day.routeDistance)} · ${fmtDur(S.day.routeDuration)}`);
  $('#locInfo').textContent = parts.join(' · ');
}

function render() {
  if (!S.user) return;
  const ro = readonly();
  $('#readonlyBanner').hidden = !(S.date < S.today);
  $('#readonlyText').textContent = ro ? `צפייה ב${fmtDate(S.date, false)} – קריאה בלבד` : `עריכת יום קודם: ${fmtDate(S.date)}`;
  $('#unlockBtn').hidden = !ro;
  $('#dayBtn').textContent = '📅 ' + fmtDate(S.date);
  ['#routeBtn', '#importBtn'].forEach((s) => ($(s).disabled = ro));
  $('#hideDone').checked = S.hideDone;
  $('#sortSel').value = S.sort;

  renderCounts();
  renderNext();
  const list = sorted(S.deliveries.filter((d) => !(S.hideDone && isFinal(d))));
  $('#list').replaceChildren(...list.map(card));
  $('#empty').hidden = S.deliveries.length > 0;
  renderMap();
}

// ------------------------------------------------------------------ map
function ensureMap() {
  if (S.map || !window.L) return;
  S.map = L.map('map', { zoomControl: true }).setView([32.018, 34.78], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(S.map);
  S.layers = { line: L.layerGroup().addTo(S.map), stops: L.layerGroup().addTo(S.map), me: L.layerGroup().addTo(S.map) };
  S.map.on('click', onMapPick);
}

function renderMap() {
  if ($('#mapWrap').hidden || !S.map) return;
  const { line, stops, me } = S.layers;
  line.clearLayers(); stops.clearLayers(); me.clearLayers();
  if (S.day?.routePolyline) {
    try { L.polyline(decodePolyline(S.day.routePolyline), { color: '#2563eb', weight: 4, opacity: .7 }).addTo(line); } catch { /* ignore */ }
  }
  const groups = new Map();
  S.deliveries.filter(hasCoords).filter((d) => !(S.hideDone && isFinal(d))).forEach((d) => {
    const k = addressKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  });
  const bounds = [];
  for (const members of groups.values()) {
    const d = members[0];
    const act = members.filter(isActive);
    const ref = act[0] || d;
    const label = act.length ? (ref.updatedStop ?? ref.initialStop ?? (ref.appOrder != null ? '#' + ref.appOrder : '?')) : '✓';
    const cls = !act.length ? 'done' : act.some((x) => x.status === 'no_answer_temp') ? 'temp' : ref.updatedStop == null ? 'nonum' : '';
    const icon = L.divIcon({ className: '', html: `<div class="stop-marker ${cls}">${esc(label)}${members.length > 1 ? '×' + members.length : ''}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    const popup = `<div dir="rtl" style="font-family:Rubik,sans-serif"><b>${esc(fullAddress(d))}</b><br>` +
      members.map((x) => `${esc(stopLabel(x.updatedStop, x.updatedSub) ?? '')} ${esc(x.name || x.shipmentId)} – ${esc(STATUS[x.status]?.label || '')}`).join('<br>') +
      `<br><a href="${esc(wazeUrl(d))}" target="_blank">Waze</a> · <a href="${esc(gmapsUrl(d))}" target="_blank">Google</a></div>`;
    L.marker([d.lat, d.lng], { icon }).bindPopup(popup).addTo(stops);
    bounds.push([d.lat, d.lng]);
  }
  if (S.me) {
    L.marker([S.me.lat, S.me.lng], { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(me);
    bounds.push([S.me.lat, S.me.lng]);
  }
  if (!S.mapFitted && bounds.length) { S.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 }); S.mapFitted = true; }
}

function toggleMap(show = $('#mapWrap').hidden) {
  $('#mapWrap').hidden = !show;
  prefs.set('mapOpen', show);
  if (show) {
    ensureMap();
    setTimeout(() => { S.map?.invalidateSize(); renderMap(); }, 50);
  }
}

function startPick(d) {
  S.pickFor = d;
  toggleMap(true);
  $('#pickHint').hidden = false;
  $('#mapWrap').scrollIntoView({ behavior: 'smooth' });
  if (hasCoords(d)) S.map.setView([d.lat, d.lng], 17);
}

async function onMapPick(e) {
  if (!S.pickFor) return;
  const d = S.pickFor;
  S.pickFor = null;
  $('#pickHint').hidden = true;
  const { lat, lng } = e.latlng;
  await S.db.updateDelivery(S.date, d.shipmentId, { lat, lng, geoStatus: 'manual' });
  // Remember for next time this address shows up.
  S.db.setGeo(addressKey(d), { lat, lng, precision: 'manual', src: 'manual', at: now() }).catch(() => {});
  const same = S.deliveries.filter((x) => x.shipmentId !== d.shipmentId && addressKey(x) === addressKey(d));
  if (same.length) await S.db.updateMany(S.date, same.map((x) => ({ id: x.shipmentId, patch: { lat, lng, geoStatus: 'manual' } })));
  toast('המיקום נשמר ✓');
}

// ------------------------------------------------------------------ edit
function editSheet(d) {
  openModal((m, close) => {
    const f = {
      name: el('input', { value: d.name || '' }),
      street: el('input', { value: d.street || '' }),
      houseNo: el('input', { value: d.houseNo || '', inputmode: 'text' }),
      city: el('input', { value: d.city || S.settings.defaultCity }),
      appOrder: el('input', { value: d.appOrder ?? '', inputmode: 'numeric' }),
      ref: el('input', { value: d.ref || '' }),
    };
    const streetField = el('label', { class: 'field' }, 'רחוב (הקלד חלק מהשם)', f.street);
    m.append(
      el('h2', {}, 'עריכת משלוח ', el('span', { class: 'muted' }, d.shipmentId)),
      el('label', { class: 'field' }, 'שם', f.name),
      el('div', { class: 'row2' }, streetField, el('label', { class: 'field' }, 'מספר בית', f.houseNo)),
      el('label', { class: 'field' }, 'עיר', f.city),
      el('div', { class: 'row2' }, el('label', { class: 'field' }, "אס' 2", f.ref), el('label', { class: 'field' }, 'סדר אפליקציה', f.appOrder)),
      el('p', { class: 'muted' }, 'מצב איתור: ', geoChip(d) || el('span', { class: 'geo manual' }, 'מדויק ✓')),
    );
    attachAutocomplete(f.street, () => f.city.value);

    const collect = () => ({
      name: f.name.value.trim(), street: f.street.value.trim(), houseNo: f.houseNo.value.trim(),
      city: f.city.value.trim() || S.settings.defaultCity,
      appOrder: f.appOrder.value.trim() === '' ? null : parseInt(f.appOrder.value.replace('#', ''), 10) || null,
      ref: f.ref.value.trim() || null,
    });
    const save = async (recheck) => {
      const data = collect();
      const addrChanged = addressKey(data) !== addressKey(d);
      close();
      await S.db.updateDelivery(S.date, d.shipmentId, data);
      if (addrChanged || recheck) {
        toast('בודק כתובת…', { ms: 0 });
        const p = await geocodeDelivery({ ...d, ...data }, { force: true });
        toast(p.geoStatus === 'failed' ? 'הכתובת לא נמצאה – נסה לתקן או לסמן על המפה' : p.geoStatus === 'approx' ? 'נמצא מיקום משוער (רחוב בלבד). אפשר לסמן מדויק על המפה' : 'הכתובת אותרה ✓', { err: p.geoStatus === 'failed', ms: 5000 });
      } else toast('נשמר ✓');
    };
    m.append(el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => save(false) }, 'שמור'),
      el('button', { class: 'btn', type: 'button', onclick: () => save(true) }, '🔍 שמור ובדוק שוב'),
    ), el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => { close(); startPick(d); } }, '📍 סמן על המפה'),
      el('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (await confirmModal({ title: 'מחיקת משלוח', body: `למחוק את ${esc(d.shipmentId)} (${esc(d.name || '')})?`, okText: 'מחק', danger: true })) {
          close(); await S.db.deleteDeliveries(S.date, [d.shipmentId]); toast('נמחק');
        }
      } }, '🗑 מחק'),
    ));
  });
}

// ------------------------------------------------------------------ import
const COLS = [
  ['appOrder', 'סדר אפליקציה'], ['shipmentId', 'מספר משלוח'], ['name', 'שם'],
  ['street', 'רחוב'], ['houseNo', 'מס׳ בית'], ['city', 'עיר'], ['ref', "אס' 2"],
];

function parseImport(text) {
  let lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines = lines.filter((l) => !/^\|?\s*:?-{2,}/.test(l)); // markdown separator
  const splitLine = (l) => {
    if (l.includes('\t')) return l.split('\t');
    if (l.includes('|')) return l.replace(/^\|/, '').replace(/\|$/, '').split('|');
    return l.split(/\s*,\s*/);
  };
  let rows = lines.map((l) => splitLine(l).map((c) => c.trim()));
  let map = ['appOrder', 'shipmentId', 'name', 'street', 'houseNo', 'city', 'ref'];
  const head = rows[0]?.join(' ') || '';
  if (/משלוח|רחוב|כתובת|שם/.test(head) && !/\d{6,}/.test(head)) {
    map = rows[0].map((h) => {
      if (/משלוח/.test(h)) return 'shipmentId';
      if (/סדר|אפליקציה/.test(h)) return 'appOrder';
      if (/בית/.test(h)) return 'houseNo';
      if (/רחוב/.test(h)) return 'street';
      if (/כתובת|יעד/.test(h)) return 'address';
      if (/עיר|ישוב|יישוב/.test(h)) return 'city';
      if (/אס|אסמכתא|חבילה|ref/i.test(h)) return 'ref';
      if (/שם|לקוח/.test(h)) return 'name';
      return null;
    });
    rows = rows.slice(1);
  }
  return rows.map((cells) => {
    const r = {};
    map.forEach((k, i) => { if (k) r[k] = (cells[i] ?? '').trim(); });
    if (r.address) {
      let a = r.address.replace(/^חולון\s+/, (m) => { r.city ||= 'חולון'; return ''; });
      const parts = a.split(',');
      if (parts[1]) r.city ||= parts[1].trim();
      Object.assign(r, splitAddress(parts[0]));
      delete r.address;
    }
    const clean = (v) => (v == null || /^[-—–]*$/.test(v) || /^\(.*\)$/.test(v) ? '' : v);
    return {
      appOrder: clean(r.appOrder).replace('#', ''),
      shipmentId: clean(r.shipmentId).replace(/\s/g, ''),
      name: clean(r.name), street: clean(r.street), houseNo: clean(r.houseNo),
      city: clean(r.city) || S.settings.defaultCity, ref: clean(r.ref),
    };
  });
}

function importSheet() {
  openModal((m, close) => {
    const ta = el('textarea', { placeholder: 'הדבק כאן את הטבלה (שורה לכל משלוח, עמודות מופרדות בטאב)…\nסדר אפליקציה | מספר משלוח | שם | רחוב | מס׳ בית | עיר | אס׳ 2' });
    m.append(
      el('h2', {}, '📥 ייבוא משלוחים'),
      el('p', { class: 'muted' }, 'הדבק את הטבלה שקיבלת מ-Claude (או מ-Excel). אפשר גם עמודת "כתובת" אחת במקום רחוב + מספר.'),
      el('label', { class: 'field' }, 'נתונים', ta),
      el('div', { class: 'sheet-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => { const rows = parseImport(ta.value); if (!rows.length) return toast('לא נמצאו שורות', { err: true }); close(); previewSheet(rows); } }, 'הצג תצוגה מקדימה ←'),
        el('button', { class: 'btn', type: 'button', onclick: close }, 'ביטול'),
      ),
    );
    ta.focus();
  });
}

function previewSheet(rows) {
  const existing = new Map(S.deliveries.map((d) => [String(d.shipmentId), d]));
  openModal((m, close) => {
    const seen = new Map();
    rows.forEach((r) => seen.set(r.shipmentId, (seen.get(r.shipmentId) || 0) + 1));
    const tbody = el('tbody');
    const table = el('table', { class: 'preview' },
      el('thead', {}, el('tr', {}, el('th', {}, 'ייבא'), ...COLS.map(([, h]) => el('th', {}, h)), el('th', {}, 'הערות'))),
      tbody);
    const summary = el('p', { class: 'muted' });

    const rowEls = rows.map((r) => {
      const notes = [];
      let cls = '', include = true;
      if (!r.shipmentId || !r.street) { notes.push(el('span', { class: 'tag bad' }, 'חסר מספר משלוח/רחוב')); cls = 'bad'; include = false; }
      if (existing.has(r.shipmentId)) { notes.push(el('span', { class: 'tag warn' }, 'כבר קיים – יעודכן אם מסומן')); cls ||= 'dup'; include = false; }
      if (seen.get(r.shipmentId) > 1) { notes.push(el('span', { class: 'tag warn' }, 'כפול בהדבקה')); cls ||= 'dup'; }
      const cb = el('input', { type: 'checkbox' });
      cb.checked = include;
      const tr = el('tr', { class: cls + (include ? '' : ' off') },
        el('td', {}, cb),
        ...COLS.map(([k]) => el('td', { contenteditable: 'true', dataset: { k } }, r[k] ?? '')),
        el('td', {}, notes));
      cb.addEventListener('change', () => { tr.classList.toggle('off', !cb.checked); upd(); });
      tbody.append(tr);
      return { tr, cb };
    });
    const upd = () => (summary.textContent = `${rowEls.filter((x) => x.cb.checked).length} מתוך ${rows.length} שורות מסומנות לייבוא. אפשר לערוך כל תא לפני האישור.`);
    upd();

    const confirm = async () => {
      const chosen = rowEls.filter((x) => x.cb.checked).map(({ tr }) => {
        const r = {};
        tr.querySelectorAll('td[data-k]').forEach((td) => (r[td.dataset.k] = td.textContent.trim()));
        return r;
      }).filter((r) => r.shipmentId && r.street);
      if (!chosen.length) return toast('לא סומנו שורות', { err: true });
      close();
      const docs = chosen.map((r) => {
        const base = {
          shipmentId: r.shipmentId, name: r.name, street: r.street, houseNo: r.houseNo,
          city: r.city || S.settings.defaultCity,
          appOrder: r.appOrder === '' ? null : parseInt(r.appOrder.replace('#', ''), 10) || null,
          ref: r.ref || null,
        };
        const ex = existing.get(r.shipmentId);
        if (ex) return addressKey(ex) === addressKey(base) ? base : { ...base, geoStatus: 'pending', lat: null, lng: null };
        return {
          ...base, status: 'pending', statusAt: null, history: [], geoStatus: 'pending', lat: null, lng: null,
          initialStop: null, initialSub: null, updatedStop: null, updatedSub: null, importedAt: now(),
        };
      });
      if (!S.day) await S.db.saveDay(S.date, { createdAt: now(), hasInitialRoute: false });
      await S.db.putDeliveries(S.date, docs);
      toast(`יובאו ${docs.length} משלוחים ✓`);
      const toGeo = docs.filter((d) => d.geoStatus === 'pending').map((d) => ({ ...existing.get(d.shipmentId), ...d }));
      await geocodeMany(toGeo);
    };

    m.append(
      el('h2', {}, `תצוגה מקדימה – ${rows.length} שורות`),
      summary,
      el('div', { class: 'tbl-wrap' }, table),
      el('div', { class: 'sheet-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: confirm }, '✓ אשר ייבוא'),
        el('button', { class: 'btn', type: 'button', onclick: () => { close(); importSheet(); } }, 'חזור'),
      ),
    );
  });
}

// ------------------------------------------------------------------ route dialog
function pointPicker(title, { allowNone }) {
  const name = 'pp' + Math.random().toString(36).slice(2);
  const opts = [
    ...(allowNone ? [['none', 'ללא – לסיים בעצירה האחרונה']] : []),
    ['gps', '📍 המיקום הנוכחי שלי'],
    ['address', '✍️ כתובת'],
  ];
  const street = el('input', { placeholder: 'רחוב' });
  const house = el('input', { placeholder: 'מס׳' });
  const city = el('input', { value: S.settings.defaultCity, placeholder: 'עיר' });
  const addrBox = el('div', { hidden: true },
    el('div', { class: 'row2' }, el('label', { class: 'field' }, 'רחוב', street), el('label', { class: 'field' }, 'מספר', house)),
    el('label', { class: 'field' }, 'עיר', city));
  attachAutocomplete(street, () => city.value);
  const radios = opts.map(([v, label], i) => {
    const r = el('input', { type: 'radio', name, value: v });
    r.checked = i === 0;
    r.addEventListener('change', () => (addrBox.hidden = v !== 'address'));
    return el('label', {}, r, label);
  });
  const node = el('div', {}, el('h3', {}, title), el('div', { class: 'radio-list' }, radios), addrBox);
  return {
    node,
    get() {
      const v = node.querySelector(`input[name="${name}"]:checked`).value;
      if (v === 'none') return null;
      if (v === 'gps') return { type: 'gps' };
      if (!street.value.trim()) throw new Error(`יש להזין כתובת ב"${title}"`);
      return { type: 'address', text: `${street.value.trim()} ${house.value.trim()}, ${city.value.trim() || S.settings.defaultCity}` };
    },
  };
}

function routeSheet() {
  if (!S.deliveries.length) return toast('אין משלוחים – יש לייבא קודם', { err: true });
  if (S.day?.hasInitialRoute) return routeChoiceSheet();
  routeBuildSheet('initial');
}

function routeChoiceSheet() {
  openModal((m, close) => {
    const act = S.deliveries.filter(isActive).length;
    m.append(
      el('h2', {}, '🧭 כבר קיים מסלול'),
      el('p', {}, `המסלול הראשוני נבנה ${S.day.initialBuiltAt ? 'ב-' + fmtTime(S.day.initialBuiltAt) : ''} ואינו משתנה. נשארו ${act} משלוחים פעילים.`),
      el('div', { class: 'status-opts' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => { close(); routeBuildSheet('updated'); } }, '🔄 בנה מסלול מעודכן (רק ממתין + לא ענה זמני)'),
        el('button', { class: 'btn', type: 'button', onclick: () => { close(); stayOnRouteSheet(); } }, '➡️ השאר את המסלול הקיים – מאיפה להמשיך?'),
      ),
    );
  });
}

async function stayOnRouteSheet() {
  if (!S.me) { try { toast('מאתר מיקום…', { ms: 0 }); setMe(await getCurrentPosition()); $('#toast').hidden = true; } catch { /* optional */ } }
  const { next, nearest } = nextStops();
  openModal((m, close) => {
    m.append(el('h2', {}, '➡️ המשך במסלול הקיים'));
    if (!next) m.append(el('p', {}, 'אין משלוחים פעילים 🎉'));
    else {
      m.append(el('p', {}, 'העצירה הבאה לפי המסלול המעודכן:'),
        el('p', {}, el('b', {}, `עצירה ${stopLabel(next.updatedStop, next.updatedSub) ?? '—'} (ראשוני ${stopLabel(next.initialStop, next.initialSub) ?? '—'})`), ` · ${next.name || ''} · ${fullAddress(next)}`),
        el('div', { class: 'sheet-actions' }, el('a', { class: 'btn waze', href: wazeUrl(next), target: '_blank', rel: 'noopener' }, 'נווט ב-Waze'), el('a', { class: 'btn gmaps', href: gmapsUrl(next), target: '_blank', rel: 'noopener' }, 'Google Maps')));
      if (nearest && nearest.shipmentId !== next.shipmentId) {
        m.append(el('p', { class: 'muted' }, `📍 שים לב: הכי קרוב למיקום שלך עכשיו הוא ${nearest.name || ''} – ${fullAddress(nearest)} (עצירה ${stopLabel(nearest.updatedStop, nearest.updatedSub) ?? '—'}).`));
      }
    }
    m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')));
  });
}

function routeBuildSheet(kind) {
  openModal((m, close) => {
    const start = pointPicker('נקודת התחלה', { allowNone: false });
    const end = pointPicker('נקודת סיום', { allowNone: true });
    const pool = S.deliveries.filter(isActive);
    const missing = pool.filter((d) => !hasCoords(d));
    const approx = pool.filter((d) => d.geoStatus === 'approx');
    m.append(el('h2', {}, kind === 'initial' ? '🧭 בניית מסלול ראשוני' : '🔄 בניית מסלול מעודכן'));
    m.append(el('p', { class: 'muted' }, kind === 'initial'
      ? `המסלול הראשוני ימוספר פעם אחת (לפיו מסדרים את הרכב) ולא ישתנה. ${pool.length} משלוחים.`
      : `המסלול המעודכן כולל רק "ממתין" ו"לא ענה זמני": ${pool.length} משלוחים. המספור הראשוני נשאר.`));
    if (missing.length) m.append(el('div', { class: 'danger-box' }, `${missing.length} כתובות לא אותרו ולא ייכנסו למסלול: ${missing.map((d) => fullAddress(d)).join(' · ')}`));
    if (approx.length) m.append(el('p', { class: 'muted' }, `⚠️ ${approx.length} כתובות אותרו ברמת רחוב בלבד (מיקום משוער). כדי לדייק: ✎ ← "סמן על המפה", או הפעל איתור Google בהגדרות.`));
    m.append(start.node, end.node);
    const go = el('button', { class: 'btn primary', type: 'button' }, 'חשב מסלול');
    go.addEventListener('click', async () => {
      let s, e;
      try { s = start.get(); e = end.get(); } catch (err) { return toast(err.message, { err: true }); }
      go.disabled = true;
      try { await buildRoute(kind, s, e); close(); S.sort = 'updated'; prefs.set('sort', 'updated'); render(); }
      catch (err) { console.error(err); toast(err.message, { err: true, ms: 6000 }); go.disabled = false; }
    });
    m.append(el('div', { class: 'sheet-actions' }, go, el('button', { class: 'btn', type: 'button', onclick: close }, 'ביטול')));
  });
}

// ------------------------------------------------------------------ days: history & new day
function openDate(date) {
  S.date = date;
  S.unlocked = false;
  S.dist = {};
  S.mapFitted = false;
  subscribe();
}

async function daysSheet() {
  const days = await S.db.listDays().catch(() => []);
  openModal((m, close) => {
    const input = el('input', { type: 'date', value: S.date });
    m.append(
      el('h2', {}, '📅 ימים ותאריכים'),
      el('div', { class: 'row2' }, el('label', { class: 'field' }, 'פתח תאריך', input),
        el('div', { class: 'field' }, ' ', el('button', { class: 'btn primary', type: 'button', onclick: () => { if (input.value) { close(); openDate(input.value); } } }, 'פתח'))),
      el('h3', {}, 'ימים קודמים'),
    );
    const list = el('div', { class: 'days-list' });
    if (!days.some((d) => d.date === S.today)) days.unshift({ date: S.today, total: 0, active: 0 });
    days.forEach((d) => list.append(el('button', {
      class: 'btn' + (d.date === S.date ? ' cur' : ''), type: 'button', onclick: () => { close(); openDate(d.date); },
    }, el('span', {}, fmtDate(d.date)), el('span', { class: 'muted' }, `${d.total ?? 0} משלוחים${d.active ? ` · ${d.active} פעילים` : ''}`))));
    m.append(list, el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => { close(); newDaySheet(); } }, '🆕 יום חדש'),
      el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')));
  });
}

async function moveActives(fromDate, toDate, items) {
  const docs = items.map((d) => ({
    ...d, initialStop: null, initialSub: null, updatedStop: null, updatedSub: null, movedTo: null,
    movedFrom: fromDate, history: [...(d.history || []), { status: 'moved', at: now(), from: fromDate }].slice(-30),
  }));
  const target = await S.db.getDay(toDate);
  if (!target) await S.db.saveDay(toDate, { createdAt: now(), hasInitialRoute: false });
  await S.db.putDeliveries(toDate, docs);
  await S.db.updateMany(fromDate, items.map((d) => ({ id: d.shipmentId, patch: { movedTo: toDate } })));
}

function newDaySheet() {
  openModal((m, close) => {
    const cur = S.date;
    const act = S.deliveries.filter(isActive);
    const input = el('input', { type: 'date', value: S.today });
    const body = el('div', {});
    m.append(el('h2', {}, '🆕 יום חדש'), el('label', { class: 'field' }, 'תאריך היום החדש', input), body);

    const draw = () => {
      const target = input.value;
      body.replaceChildren();
      if (!target) return;
      const same = target === cur;
      if (act.length) body.append(el('div', { class: 'danger-box', style: 'margin-top:10px' }, `⚠️ ב${fmtDate(cur, false)} נשארו ${act.length} משלוחים פעילים (ממתין / לא ענה זמני)!`));
      const actions = el('div', { class: 'status-opts', style: 'margin-top:10px' });
      if (act.length && !same) {
        actions.append(el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          close(); await moveActives(cur, target, act); toast(`${act.length} משלוחים הועברו ל-${target.split('-').reverse().join('/')}`); openDate(target);
        } }, `➡️ העבר ${act.length} פעילים ל${fmtDate(target)}`));
      }
      actions.append(el('button', { class: 'btn danger', type: 'button', onclick: async () => {
        const word = act.length || same ? 'איפוס' : null;
        const ok = await confirmModal({
          title: same ? 'איפוס היום הנוכחי' : 'יום חדש ריק',
          body: same
            ? `<b style="color:var(--danger)">כל ${S.deliveries.length} המשלוחים של ${esc(fmtDate(cur))} יימחקו, כולל המסלול הראשוני.</b>`
            : act.length ? `<b style="color:var(--danger)">${act.length} משלוחים פעילים יישארו ב${esc(fmtDate(cur, false))} ולא יועברו.</b> היום הקודם נשמר בהיסטוריה.` : 'היום הקודם נשמר בהיסטוריה.',
          okText: same ? 'אפס' : 'התחל יום ריק', danger: true, requireWord: word,
        });
        if (!ok) return;
        close();
        if (same) {
          await S.db.deleteDeliveries(cur, S.deliveries.map((d) => d.shipmentId));
          await S.db.saveDay(cur, { hasInitialRoute: false, routePolyline: null, routeDistance: null, routeDuration: null, start: null, end: null, initialBuiltAt: null });
          toast('היום אופס');
        } else {
          if (!(await S.db.getDay(target))) await S.db.saveDay(target, { createdAt: now(), hasInitialRoute: false });
          openDate(target);
        }
      } }, same ? '🗑 איפוס היום הנוכחי' : '🆕 התחל יום ריק (בלי להעביר)'));
      body.append(actions);
    };
    input.addEventListener('change', draw);
    draw();
    m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: close }, 'ביטול')));
  });
}

async function maybePromptCarryOver() {
  if (S.movePromptShown || S.date !== S.today || S.deliveries.length) return;
  S.movePromptShown = true;
  const days = await S.db.listDays(10).catch(() => []);
  const prev = days.find((d) => d.date < S.today && d.active > 0);
  if (!prev) return;
  const items = (await S.db.getDeliveries(prev.date)).filter(isActive);
  if (!items.length) return;
  const ok = await confirmModal({
    title: 'נשארו משלוחים מיום קודם',
    body: `ב${esc(fmtDate(prev.date, false))} נשארו <b>${items.length}</b> משלוחים פעילים. להעביר אותם להיום?`,
    okText: 'העבר להיום',
  });
  if (ok) { await moveActives(prev.date, S.today, items); toast(`${items.length} משלוחים הועברו להיום`); }
}

// ------------------------------------------------------------------ export, segments, settings, menu
function exportCsv() {
  const head = ['מסלול ראשוני', 'מסלול מעודכן', 'סדר אפליקציה', 'מספר משלוח', 'שם', 'רחוב', 'מספר בית', 'עיר', "אס' 2", 'סטטוס', 'שעת סטטוס', 'איתור', 'lat', 'lng'];
  const rows = S.deliveries.slice().sort((a, b) => orderKey(a.initialStop, a.initialSub) - orderKey(b.initialStop, b.initialSub)).map((d) => [
    stopLabel(d.initialStop, d.initialSub) ?? '', stopLabel(d.updatedStop, d.updatedSub) ?? '', d.appOrder ?? '', d.shipmentId, d.name, d.street, d.houseNo, d.city, d.ref ?? '',
    d.movedTo ? 'הועבר ' + d.movedTo : STATUS[d.status]?.label ?? '', d.statusAt ? new Date(d.statusAt).toLocaleString('he-IL') : '', d.geoStatus ?? '', d.lat ?? '', d.lng ?? '',
  ]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: `smartrun-${S.date}.csv` });
  document.body.append(a); a.click(); a.remove();
}

function segmentsSheet() {
  const stops = [];
  const seen = new Set();
  S.deliveries.filter(isActive).sort((a, b) => orderKey(a.updatedStop, a.updatedSub) - orderKey(b.updatedStop, b.updatedSub)).forEach((d) => {
    const k = addressKey(d);
    if (!seen.has(k)) { seen.add(k); stops.push(d); }
  });
  openModal((m, close) => {
    m.append(el('h2', {}, '🗺️ מסלול מלא ב-Google Maps'), el('p', { class: 'muted' }, 'Google Maps מקבל עד 10 יעדים בכל פעם, ולכן המסלול מחולק למקטעים. ההתחלה היא מהמיקום הנוכחי שלך.'));
    if (!stops.length) m.append(el('p', {}, 'אין עצירות פעילות.'));
    const box = el('div', { class: 'menu-list' });
    gmapsSegments(stops).forEach((s, i) => box.append(el('a', { class: 'btn gmaps', href: s.url, target: '_blank', rel: 'noopener' }, `מקטע ${i + 1}: עצירות ${s.from}–${s.to}`)));
    m.append(box, el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: close }, 'סגור')));
  });
}

async function settingsSheet() {
  const usage = await S.db.getMeta('usage-' + new Date().toISOString().slice(0, 7)).catch(() => null);
  openModal((m, close) => {
    const city = el('input', { value: S.settings.defaultCity });
    const geocoder = el('select', {}, el('option', { value: 'osm' }, 'OpenStreetMap (חינמי, לרוב ברמת רחוב)'), el('option', { value: 'google' }, 'Google (מדויק לכתובת, דורש מפתח API)'));
    geocoder.value = S.settings.geocoder;
    const key = el('input', { value: S.settings.googleKey, placeholder: 'AIza…', dir: 'ltr' });
    m.append(
      el('h2', {}, '⚙️ הגדרות'),
      el('label', { class: 'field' }, 'עיר ברירת מחדל', city),
      el('label', { class: 'field' }, 'איתור כתובות (Geocoding)', geocoder),
      el('label', { class: 'field' }, 'מפתח Google Maps API (לא חובה)', key),
      el('p', { class: 'usage' }, `שימוש ב-Google החודש: ${usage?.geocode || 0} איתורים (חינם עד 10,000 בחודש).`),
      el('p', { class: 'muted' }, S.db.mode === 'firebase' ? `מחובר כ: ${S.user.email || S.user.name}` : 'מצב הדגמה – הנתונים בדפדפן הזה בלבד.'),
    );
    const save = async () => {
      const next = { defaultCity: city.value.trim() || 'חולון', geocoder: geocoder.value, googleKey: key.value.trim() };
      if (next.geocoder === 'google' && !next.googleKey) return toast('לאיתור Google צריך מפתח API', { err: true });
      S.settings = next;
      await S.db.setMeta('settings', next);
      maps.configure({ geocoderName: next.geocoder, googleKey: next.googleKey });
      close(); toast('ההגדרות נשמרו ✓');
    };
    const actions = el('div', { class: 'sheet-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: save }, 'שמור'),
      el('button', { class: 'btn', type: 'button', onclick: close }, 'ביטול'));
    m.append(actions);
    const failed = S.deliveries.filter((d) => d.geoStatus !== 'ok' && d.geoStatus !== 'manual');
    if (failed.length && !readonly()) {
      m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', type: 'button', onclick: async () => { close(); await geocodeMany(failed, { force: true }); } }, `🔍 אתר מחדש ${failed.length} כתובות לא מדויקות`)));
    }
    if (S.db.mode === 'firebase') m.append(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn danger', type: 'button', onclick: () => { close(); S.db.signOut(); } }, 'התנתק')));
  });
}

function menuSheet() {
  openModal((m, close) => {
    const item = (label, fn, disabled = false) => el('button', { class: 'btn', type: 'button', disabled, onclick: () => { close(); fn(); } }, label);
    m.append(el('h2', {}, 'תפריט'), el('div', { class: 'menu-list' },
      item('🆕 יום חדש', newDaySheet, readonly()),
      item('📅 ימים קודמים / בחירת תאריך', daysSheet),
      item('🗺️ מסלול מלא ב-Google Maps', segmentsSheet),
      item('📤 ייצוא CSV', exportCsv),
      item('⚙️ הגדרות', settingsSheet),
    ));
  });
}

// ------------------------------------------------------------------ subscriptions & boot
function subscribe() {
  S.unsubs.forEach((u) => u());
  S.unsubs = [];
  S.day = null; S.deliveries = [];
  render();
  const date = S.date;
  S.unsubs.push(S.db.watchDay(date, (day) => { if (date !== S.date) return; S.day = day; render(); }));
  S.unsubs.push(S.db.watchDeliveries(date, (list) => {
    if (date !== S.date) return;
    S.deliveries = list;
    render();
    syncSummary();
    maybePromptCarryOver();
  }, (e) => toast('שגיאת חיבור לענן: ' + e.message, { err: true, ms: 8000 })));
}

// Keep day doc counters (total/active) in sync – used by the history list.
function syncSummary() {
  const total = S.deliveries.length;
  const active = S.deliveries.filter(isActive).length;
  if (!total && !S.day) return;
  if (S.day?.total === total && S.day?.active === active) return;
  S.db.saveDay(S.date, { total, active }).catch(() => {});
}

function bindUi() {
  $('#menuBtn').addEventListener('click', menuSheet);
  $('#dayBtn').addEventListener('click', daysSheet);
  $('#refreshBtn').addEventListener('click', refreshLocation);
  $('#routeBtn').addEventListener('click', routeSheet);
  $('#importBtn').addEventListener('click', importSheet);
  $('#mapBtn').addEventListener('click', () => toggleMap());
  $('#pickCancel').addEventListener('click', () => { S.pickFor = null; $('#pickHint').hidden = true; });
  $('#hideDone').addEventListener('change', (e) => { S.hideDone = e.target.checked; prefs.set('hideDone', S.hideDone); render(); });
  $('#sortSel').addEventListener('change', (e) => {
    S.sort = e.target.value; prefs.set('sort', S.sort); render();
    if (['drive', 'walk', 'dist'].includes(S.sort) && !S.distAt) toast('לחץ "רענון מיקום" כדי לחשב מרחקים', { ms: 4000 });
  });
  $('#unlockBtn').addEventListener('click', async () => {
    if (await confirmModal({ title: 'עריכת יום קודם', body: `לאפשר עריכה של ${esc(fmtDate(S.date))}?` })) { S.unlocked = true; render(); }
  });
  $('#goTodayBtn').addEventListener('click', () => openDate(S.today));
  document.addEventListener('click', (e) => { if (e.target.closest('[data-action="import"]')) importSheet(); });
  // Date rolls over while the app stays open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayStr() !== S.today) { S.today = todayStr(); render(); }
  });
}

async function boot() {
  bindUi();
  try {
    S.db = await createDb();
  } catch (e) {
    $('#loading').textContent = 'שגיאה בחיבור ל-Firebase: ' + e.message;
    return;
  }
  $('#demoBanner').hidden = S.db.mode !== 'demo';
  maps.configure({ usage: (kind) => S.db.incUsage(kind).catch(() => {}) });

  $('#loginBtn').addEventListener('click', async () => {
    $('#loginErr').textContent = '';
    try { await S.db.signIn(); } catch (e) { $('#loginErr').textContent = e.message; }
  });

  S.db.onAuth(async (user) => {
    S.user = user;
    $('#loading').hidden = true;
    $('#login').hidden = !!user;
    $('#app').hidden = !user;
    if (!user) { S.unsubs.forEach((u) => u()); S.unsubs = []; return; }
    const saved = await S.db.getMeta('settings').catch(() => null);
    S.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    maps.configure({ geocoderName: S.settings.geocoder, googleKey: S.settings.googleKey });
    if (prefs.get('mapOpen', false)) toggleMap(true);
    subscribe();
    ensureStreets(S.settings.defaultCity);
  });
}

boot();

'use strict';

/* ================= ユーティリティ ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function haversine(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtTime(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}時間${min % 60 ? (min % 60) + '分' : ''}`;
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function yen(n) { return '¥' + n.toLocaleString('ja-JP'); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const WALK_LINE = { id: 'WALK', name: '徒歩', short: '徒歩', color: '#5c6b70', operator: 'WALK' };
function lineById(id) { return id === 'WALK' ? WALK_LINE : LINES.find(l => l.id === id); }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ================= 永続化 ================= */
const store = {
  get delays() { try { return JSON.parse(localStorage.getItem('nn_delays') || '[]'); } catch { return []; } },
  set delays(v) { localStorage.setItem('nn_delays', JSON.stringify(v)); },
  get pass() { return localStorage.getItem('nn_pass') || 'none'; },
  set pass(v) { localStorage.setItem('nn_pass', v); }
};

const state = {
  mode: 'train',          // train | bike | walk
  timeType: 'dep',        // dep | arr
  routes: [],
  current: null,          // 選択中の電車ルート
  lastSearch: null,       // { points, mode, baseMin, timeType, dateStr }
  pathResult: null        // 自転車/徒歩の結果
};

/* 路線の所要時間・営業キロを座標から補完(times/km が無い路線のみ自動算出) */
function normalizeLines() {
  for (const line of LINES) {
    const n = line.stations.length;
    const hops = line.loop ? n : n - 1;
    if (!line.km || line.km.length !== hops) {
      line.km = [];
      for (let i = 0; i < hops; i++) {
        const a = STATIONS[line.stations[i]], b = STATIONS[line.stations[(i + 1) % n]];
        line.km.push(+(haversine(a, b) * 1.18).toFixed(1)); // 直線距離×1.18で線路長を概算
      }
    }
    if (!line.times || line.times.length !== hops) {
      const sp = line.speed || 35;
      line.times = line.km.map(k => Math.max(2, Math.round(k / sp * 60)));
    }
  }
}
normalizeLines();

/* 駅名エイリアス(別名)を収録駅名に解決 */
function resolveAlias(name) {
  return (typeof ALIASES !== 'undefined' && ALIASES[name]) || name;
}

/* 駅 → 乗り入れ路線 */
const STATION_LINES = {};
for (const line of LINES) for (const st of line.stations) (STATION_LINES[st] = STATION_LINES[st] || []).push(line);

/* 近接駅の徒歩連絡(同一路線で隣接しない0.6km以内の駅同士)を事前計算
   例: 大阪天満宮↔南森町、北新地↔梅田、心斎橋↔四ツ橋、京都河原町↔祇園四条 */
const WALK_PAIRS = (() => {
  const adjacent = new Set();
  for (const line of LINES) {
    const n = line.stations.length;
    const hops = line.loop ? n : n - 1;
    for (let i = 0; i < hops; i++) {
      const a = line.stations[i], b = line.stations[(i + 1) % n];
      adjacent.add(a < b ? a + '|' + b : b + '|' + a);
    }
  }
  const names = Object.keys(STATIONS);
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (adjacent.has(a < b ? a + '|' + b : b + '|' + a)) continue;
      const d = haversine(STATIONS[a], STATIONS[b]);
      if (d <= 0.6) {
        pairs.push({ a, b, km: +(d * 1.25).toFixed(2), min: Math.max(2, Math.round(d * 1.25 / 4.8 * 60) + 2) });
      }
    }
  }
  return pairs;
})();

function nearestStations(pt, count, maxKm) {
  const sorted = Object.keys(STATIONS)
    .filter(n => n !== '現在地')
    .map(n => ({ name: n, km: haversine(pt, STATIONS[n]) }))
    .sort((x, y) => x.km - y.km);
  return sorted.filter((s, i) => i < count && (i === 0 || s.km <= maxKm));
}

/* ================= 経路探索(電車) ================= */
class Heap {
  constructor() { this.a = []; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

function suspendedLineIds() {
  return store.delays.filter(d => d.min === 'suspend').map(d => d.lineId);
}

function buildAdj(excludeSet) {
  const adj = {};
  for (const line of LINES) {
    if (excludeSet.has(line.id)) continue;
    const n = line.stations.length;
    const hops = line.loop ? n : n - 1;
    for (let i = 0; i < hops; i++) {
      const a = line.stations[i], b = line.stations[(i + 1) % n];
      (adj[a] = adj[a] || []).push({ to: b, line: line.id, min: line.times[i], km: line.km[i] });
      (adj[b] = adj[b] || []).push({ to: a, line: line.id, min: line.times[i], km: line.km[i] });
    }
  }
  // 近接駅の徒歩連絡
  for (const p of WALK_PAIRS) {
    (adj[p.a] = adj[p.a] || []).push({ to: p.b, line: 'WALK', min: p.min, km: p.km });
    (adj[p.b] = adj[p.b] || []).push({ to: p.a, line: 'WALK', min: p.min, km: p.km });
  }
  // 現在地 → 近隣駅への徒歩接続(GPS取得後のみ)
  if (STATIONS['現在地']) {
    for (const s of nearestStations(STATIONS['現在地'], 4, 4)) {
      const km = +(s.km * 1.25).toFixed(2);
      const min = Math.max(1, Math.round(km / 4.8 * 60) + 1);
      (adj['現在地'] = adj['現在地'] || []).push({ to: s.name, line: 'WALK', min, km });
      (adj[s.name] = adj[s.name] || []).push({ to: '現在地', line: 'WALK', min, km });
    }
  }
  return adj;
}

function dijkstra(adj, from, to, cfg) {
  if (from === to) return null;
  const dist = new Map(), prev = new Map();
  const h = new Heap();
  dist.set(from + '|*', 0);
  h.push([0, from, '*']);
  while (h.size) {
    const [d, st, ln] = h.pop();
    const key = st + '|' + ln;
    if (d > (dist.get(key) ?? Infinity)) continue;
    if (st === to) return reconstruct(prev, key);
    for (const e of (adj[st] || [])) {
      // 徒歩連絡は乗換ペナルティなし(所要時間に連絡時間込み)
      const transfer = ln !== '*' && e.line !== ln && e.line !== 'WALK' && ln !== 'WALK';
      const w = e.min + (transfer ? cfg.tp : 0) + (cfg.kmW ? cfg.kmW(e.line) * e.km : 0);
      const nk = e.to + '|' + e.line;
      const nd = d + w;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { key, e, from: st });
        h.push([nd, e.to, e.line]);
      }
    }
  }
  return null;
}

function reconstruct(prev, endKey) {
  const steps = [];
  let k = endKey;
  while (prev.has(k)) {
    const p = prev.get(k);
    steps.push({ from: p.from, to: p.e.to, line: p.e.line, min: p.e.min, km: p.e.km });
    k = p.key;
  }
  steps.reverse();
  const legs = [];
  for (const s of steps) {
    const last = legs[legs.length - 1];
    if (last && last.lineId === s.line) {
      last.stations.push(s.to); last.min += s.min; last.km += s.km;
    } else {
      legs.push({ lineId: s.line, stations: [s.from, s.to], min: s.min, km: s.km });
    }
  }
  return legs;
}

function routeWithVias(points, cfg, adj) {
  let legs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const seg = dijkstra(adj, points[i], points[i + 1], cfg);
    if (!seg) return null;
    for (const leg of seg) {
      const last = legs[legs.length - 1];
      if (last && last.lineId === leg.lineId && last.stations[last.stations.length - 1] === leg.stations[0]) {
        last.stations.push(...leg.stations.slice(1));
        last.min += leg.min; last.km += leg.km;
      } else {
        legs.push({ ...leg, stations: [...leg.stations] });
      }
    }
  }
  return legs;
}

function calcFare(legs, passId) {
  const pass = PASSES.find(p => p.id === passId) || PASSES[0];
  const groups = [];
  for (const leg of legs) {
    if (leg.lineId === 'WALK') continue; // 徒歩は運賃なし(前後の同一事業者は通し運賃)
    const op = lineById(leg.lineId).operator;
    const last = groups[groups.length - 1];
    if (last && last.op === op) last.km += leg.km;
    else groups.push({ op, km: leg.km });
  }
  let ticket = 0, ic = 0, passApplied = false;
  for (const g of groups) {
    if (pass.covers.includes(g.op)) { passApplied = true; continue; }
    const fare = OPERATORS[g.op].fareTable.find(([km]) => g.km <= km)[1];
    ticket += fare; ic += fare - 5;
  }
  return { ticket, ic, passApplied };
}

/* ================= リアルタイム遅延(JR西日本 列車走行位置) ================= */
// 収録JR路線 → JR西日本「列車走行位置」APIのエンドポイント対応
const JR_REALTIME = [
  { lineId: 'o_loop',  api: 'osakaloop',    label: '大阪環状線' },
  { lineId: 'o_jrkk',  api: 'kobesanyo',    label: '京都線・神戸線' },
  { lineId: 'o_tozai', api: 'gakkentoshi',  label: 'JR東西線・学研都市線' }
];
const JR_API_BASE = 'https://www.train-guide.westjr.co.jp/api/v3/';

// ブラウザから他ドメインを取得するための公開CORSプロキシ(上から順に試す)
const CORS_PROXIES = [
  u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://thingproxy.freeboard.io/fetch/' + u
];

let feedDelays = {};    // GitHub Actions が保存した live/delays.json 由来(バックアップ)
let liveDelays = {};    // 取得ボタンでブラウザが直接取得した最新分
let liveFetchedAt = 0;
let feedUpdatedAt = 0;

async function proxyFetchJson(url) {
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(url), { cache: 'no-store' });
      if (!res.ok) continue;
      return await res.json();
    } catch { /* 次のプロキシへ */ }
  }
  return null;
}

function jrEntry(lineId, max, trains, updateStr) {
  const line = lineById(lineId);
  return {
    lineId, min: max, auto: true, source: 'live',
    reason: '遅延(JR西日本 走行位置)',
    comment: `${line.short}で最大${max}分の遅延(走行${trains}本)`,
    ts: updateStr ? Date.parse(updateStr) : Date.now()
  };
}

// 取得ボタン: 今この瞬間のJR遅延をブラウザから直接取得(約8秒鮮度)
async function fetchLiveJRDelays() {
  const entries = {};
  let ok = 0;
  await Promise.all(JR_REALTIME.map(async ({ lineId, api }) => {
    const data = await proxyFetchJson(JR_API_BASE + api + '.json');
    if (!data || !Array.isArray(data.trains)) return;
    ok++;
    const max = data.trains.reduce((m, t) => Math.max(m, t.delayMinutes || 0), 0);
    if (max > 0) entries[lineId] = jrEntry(lineId, max, data.trains.length, data.update);
  }));
  if (ok === 0) return { ok: false };
  liveDelays = entries;
  liveFetchedAt = Date.now();
  renderDelays();
  return { ok: true, lines: ok, delayed: Object.keys(entries).length };
}

// GitHub Actions が保存した live/delays.json を読み込み(初期表示・バックアップ)
async function loadFeedDelays() {
  try {
    const res = await fetch('live/delays.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    feedUpdatedAt = (data.updated || 0) * 1000;
    const m = {};
    for (const d of (data.delays || [])) {
      const line = lineById(d.lineId);
      if (!line || typeof d.min !== 'number' || d.min <= 0) continue;
      m[d.lineId] = {
        lineId: d.lineId, min: d.min, auto: true, source: 'feed',
        reason: '遅延(JR西日本 走行位置)',
        comment: `${line.short}で最大${d.min}分の遅延${d.trains ? `(走行${d.trains}本)` : ''}`,
        ts: feedUpdatedAt || Date.now()
      };
    }
    feedDelays = m;
    renderDelays();
  } catch { /* オフライン等は無視 */ }
}

function autoDelayEntries() {
  // 直接取得済みなら対象JR路線は live を正とし、それ以外は feed で補完
  if (liveFetchedAt) {
    const covered = new Set(JR_REALTIME.map(j => j.lineId));
    const m = {};
    for (const [k, v] of Object.entries(feedDelays)) if (!covered.has(k)) m[k] = v;
    return { ...m, ...liveDelays };
  }
  return { ...feedDelays };
}

function delayMap() {
  const m = autoDelayEntries();               // JR西日本のリアルタイム由来
  for (const d of store.delays) m[d.lineId] = d; // 手動登録が最優先
  return m;
}

function buildRoute(legs, sig, dmap, passId, passPriority) {
  const pass = PASSES.find(p => p.id === passId) || PASSES[0];
  let rideMin = 0, delayTotal = 0;
  for (const leg of legs) {
    const line = lineById(leg.lineId);
    leg.passFree = pass.covers.includes(line.operator);
    const d = dmap[leg.lineId];
    leg.delay = (d && d.min !== 'suspend') ? Number(d.min) : 0;
    leg.delayInfo = leg.delay ? d : null;
    rideMin += leg.min;
    delayTotal += leg.delay;
  }
  const h = hashStr(sig);
  return {
    legs, sig,
    transfers: Math.max(0, legs.filter(l => l.lineId !== 'WALK').length - 1),
    rideMin, delayTotal,
    fare: calcFare(legs, passId),
    congestion: h % 3,
    passPriority: !!passPriority,
    passName: pass.id !== 'none' && pass.covers.length ? pass.name : null
  };
}

/* 時間帯別の運転間隔(分)。ラッシュは本数多め、深夜早朝は少なめの擬似ダイヤ */
function headwayFor(lineId, minOfDay) {
  const line = lineById(lineId);
  const h = (((minOfDay % 1440) + 1440) % 1440) / 60;
  const base = (line.operator === 'OSAKAMETRO' || line.id === 'yamanote' || line.id === 'o_loop') ? 4
    : line.operator === 'JR' ? 6 : 6;
  if ((h >= 7 && h < 9.5) || (h >= 17 && h < 19.5)) return Math.max(3, Math.round(base * 0.7)); // ラッシュ
  if (h >= 22 || h < 6) return base + 7; // 深夜・早朝
  return base + 2; // 日中
}

function computeTimes(r, dep) {
  let cur = dep;
  const h = hashStr(r.sig);
  r.legs.forEach((leg, i) => {
    if (leg.lineId !== 'WALK') {
      const hw = headwayFor(leg.lineId, cur);
      cur += 1 + (h + i * 7) % hw; // 次の便までの待ち(運転間隔モデル・徒歩は待ちなし)
    }
    leg.depTime = cur;
    leg.arrTime = cur + leg.min + leg.delay;
    cur = leg.arrTime;
  });
  return cur - dep;
}

function scheduleRoute(r, baseMin, timeType) {
  const dur = computeTimes(r, 0);
  const dep = timeType === 'arr' ? baseMin - dur : baseMin;
  r.total = computeTimes(r, dep);
  r.dep = dep;
  r.arr = dep + r.total;
}

function assignBadges(routes) {
  if (!routes.length) return;
  const minTotal = Math.min(...routes.map(r => r.total));
  const minFare = Math.min(...routes.map(r => r.fare.ic));
  const minTr = Math.min(...routes.map(r => r.transfers));
  for (const r of routes) {
    r.badges = [];
    if (r.total === minTotal) r.badges.push(['fast', '早']);
    if (r.fare.ic === minFare) r.badges.push(['cheap', '安']);
    if (r.transfers === minTr) r.badges.push(['easy', '楽']);
  }
}

const MAX_ROUTES = 6;

function searchTrainRoutes(points, baseMin, timeType, passId) {
  const suspended = suspendedLineIds();
  const pass = PASSES.find(p => p.id === passId) || PASSES[0];
  const dmap = delayMap();
  const seen = new Set();
  const routes = [];

  // 除外路線の組み合わせごとに隣接リストをキャッシュ
  const adjCache = {};
  function getAdj(ban) {
    const ex = new Set(suspended);
    if (ban) for (const b of ban) ex.add(b);
    const key = [...ex].sort().join(',');
    return adjCache[key] || (adjCache[key] = buildAdj(ex));
  }
  function tryRoute(cfg, ban) {
    if (routes.length >= MAX_ROUTES) return;
    const legs = routeWithVias(points, cfg, getAdj(ban));
    if (!legs || !legs.length) return;
    const sig = legs.map(l => l.lineId + ':' + l.stations[0] + '>' + l.stations[l.stations.length - 1]).join('|');
    if (seen.has(sig)) return;
    seen.add(sig);
    routes.push(buildRoute(legs, sig, dmap, passId, cfg.passPriority));
  }

  const cfgs = [
    { tp: 5 },
    { tp: 25 },
    { tp: 5, kmW: id => (lineById(id).operator === 'JR' ? 1.0 : 0.8) * 0.35 },
    { tp: 5, kmW: id => lineById(id).operator === 'JR' ? 0 : 1.5 },  // JR優先
    { tp: 5, kmW: id => lineById(id).operator === 'JR' ? 1.5 : 0 }   // 私鉄優先
  ];
  if (pass.covers.length) {
    cfgs.unshift({ tp: 5, kmW: id => pass.covers.includes(lineById(id).operator) ? 0 : 2.0, passPriority: true });
  }

  // 1) コスト設定違いでの基本候補
  for (const cfg of cfgs) tryRoute(cfg, null);

  // 2) 代替ルート: 見つかった経路の使用路線を1本ずつ除外して再探索(連鎖的に別ルートを発掘)
  for (let i = 0; i < routes.length && routes.length < MAX_ROUTES; i++) {
    for (const leg of routes[i].legs) {
      if (leg.lineId === 'WALK') continue;
      if (routes.length >= MAX_ROUTES) break;
      tryRoute({ tp: 8 }, [leg.lineId]);
    }
  }

  for (const r of routes) scheduleRoute(r, baseMin, timeType);
  routes.sort((a, b) =>
    (b.passPriority ? 1 : 0) - (a.passPriority ? 1 : 0) ||
    a.arr - b.arr || a.transfers - b.transfers);
  assignBadges(routes);
  return routes;
}

function legDirection(leg) {
  if (leg.lineId === 'WALK') return '徒歩連絡';
  const line = lineById(leg.lineId);
  const n = line.stations.length;
  const i0 = line.stations.indexOf(leg.stations[0]);
  if (line.loop) {
    return line.stations[(i0 + 1) % n] === leg.stations[1] ? '外回り' : '内回り';
  }
  const i1 = line.stations.indexOf(leg.stations[1]);
  return (i1 > i0 ? line.stations[n - 1] : line.stations[0]) + '行';
}

/* ================= 自転車・徒歩 ================= */
function searchPathRoute(points, mode, baseMin, timeType) {
  let km = 0;
  for (let i = 0; i < points.length - 1; i++) km += haversine(STATIONS[points[i]], STATIONS[points[i + 1]]);
  km *= 1.25; // 実道路換算の概算係数
  const speed = mode === 'bike' ? 15 : 4.8;
  const min = Math.max(1, Math.round(km / speed * 60));
  const kcal = Math.round(km * (mode === 'bike' ? 25 : 50));
  const dep = timeType === 'arr' ? baseMin - min : baseMin;
  return { points, mode, km, min, kcal, dep, arr: dep + min };
}

/* ================= Googleマップ連携 ================= */
function gmapsUrl(points, mode) {
  const enc = n => (n === '現在地' && STATIONS['現在地'])
    ? `${STATIONS['現在地'].lat.toFixed(6)},${STATIONS['現在地'].lng.toFixed(6)}`
    : encodeURIComponent(n + '駅');
  if (mode === 'train') {
    // transitモードは経由地パラメータ非対応のため、経由地ありはマルチストップ形式で開く
    if (points.length > 2) return 'https://www.google.com/maps/dir/' + points.map(enc).join('/');
    return `https://www.google.com/maps/dir/?api=1&origin=${enc(points[0])}&destination=${enc(points[points.length - 1])}&travelmode=transit`;
  }
  const tm = mode === 'bike' ? 'bicycling' : 'walking';
  let url = `https://www.google.com/maps/dir/?api=1&origin=${enc(points[0])}&destination=${enc(points[points.length - 1])}&travelmode=${tm}`;
  const vias = points.slice(1, -1);
  if (vias.length) url += '&waypoints=' + vias.map(enc).join('%7C');
  return url;
}
function openGmaps() {
  if (!state.lastSearch) { toast('先にルート検索をしてください'); return; }
  window.open(gmapsUrl(state.lastSearch.points, state.lastSearch.mode), '_blank', 'noopener');
}

/* ================= 画面遷移 ================= */
function switchTab(name) {
  $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  $$('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'map') {
    ensureMap();
    setTimeout(() => map.invalidateSize(), 60);
  }
  updateHeader();
}
function currentTab() {
  return $$('.tab-btn').find(b => b.classList.contains('on')).dataset.tab;
}
function showScreen(name) {
  $$('#tab-nav .screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  updateHeader();
}
function currentScreen() {
  const s = $$('#tab-nav .screen').find(x => x.classList.contains('active'));
  return s ? s.id.replace('screen-', '') : 'search';
}
function updateHeader() {
  const tab = currentTab();
  const back = $('#header-back'), action = $('#header-action'), text = $('#header-text');
  back.classList.add('hidden');
  action.classList.add('hidden');
  if (tab === 'nav') {
    const sc = currentScreen();
    if (sc === 'search') text.textContent = 'のりかえNavi';
    else if (sc === 'results') {
      text.textContent = '検索結果';
      back.classList.remove('hidden');
      action.classList.remove('hidden');
    } else {
      text.textContent = 'ルート詳細';
      back.classList.remove('hidden');
    }
  } else {
    text.textContent = { map: '地図', delay: '遅延情報', menu: 'メニュー' }[tab];
  }
}

/* ================= 経由地UI ================= */
const MAX_VIAS = 8;
function addViaRow(value = '') {
  const cont = $('#via-container');
  if (cont.children.length >= MAX_VIAS) { toast(`経由地は最大${MAX_VIAS}件までです`); return; }
  const row = document.createElement('div');
  row.className = 'point-row';
  row.dataset.kind = 'via';
  row.innerHTML = `
    <span class="point-dot dot-via"></span>
    <input type="text" class="point-input via-input" placeholder="経由地(駅名)" autocomplete="off" value="${esc(value)}">
    <button class="via-remove" aria-label="経由地を削除">×</button>`;
  row.querySelector('.via-remove').addEventListener('click', () => { row.remove(); hideSuggest(); });
  cont.appendChild(row);
  row.querySelector('input').focus();
}

/* ================= 駅名サジェスト ================= */
const POPULAR = ['梅田', 'なんば', '三宮', '天王寺', '京都', '新宿', '横浜', '東京'];
let activeInput = null;

function showSuggest(input) {
  activeInput = input;
  const q = input.value.trim();
  let names;
  if (q) {
    names = Object.keys(STATIONS).filter(n => n !== '現在地' && n.includes(q));
    // 別名(大阪→梅田 など)でも一致させる
    if (typeof ALIASES !== 'undefined') {
      for (const a in ALIASES) {
        if (a.includes(q) && !names.includes(ALIASES[a])) names.push(ALIASES[a]);
      }
    }
  } else {
    names = POPULAR.slice();
  }
  names = names.slice(0, 8);
  if (!q || '現在地'.includes(q)) names.unshift('現在地');
  const box = $('#suggest-box');
  if (!names.length) { hideSuggest(); return; }
  box.innerHTML = names.map(n => n === '現在地' ? `
    <div class="suggest-item" data-name="現在地">
      <svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="3.2" fill="#1668b3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3" stroke="#1668b3" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="7" fill="none" stroke="#1668b3" stroke-width="2"/></svg>
      <span style="color:#1668b3;font-weight:800">現在地</span>
      <span class="st-lines" style="font-size:10px;color:#8fa093">GPSで取得</span>
    </div>` : `
    <div class="suggest-item" data-name="${esc(n)}">
      <svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 2a7 7 0 00-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z" fill="#8fa093"/></svg>
      <span>${esc(n)}</span>
      <span class="st-lines">${(STATION_LINES[n] || []).map(l => `<i class="line-dot" style="background:${l.color}"></i>`).join('')}</span>
    </div>`).join('');
  const card = $('.search-card');
  const cr = card.getBoundingClientRect();
  const ir = input.getBoundingClientRect();
  box.style.top = (ir.bottom - cr.top + 4) + 'px';
  box.classList.remove('hidden');
}
function hideSuggest() {
  $('#suggest-box').classList.add('hidden');
  activeInput = null;
}

/* ================= 現在地(GPS) ================= */
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('geolocation unsupported')); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        STATIONS['現在地'] = pt;
        resolve(pt);
      },
      err => reject(err),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
}

/* ================= 検索実行 ================= */
function collectPoints() {
  const raw = [
    $('#input-origin').value.trim(),
    ...$$('.via-input').map(i => i.value.trim()).filter(Boolean),
    $('#input-dest').value.trim()
  ];
  if (!raw[0] || !raw[raw.length - 1]) { toast('出発地と目的地を入力してください'); return null; }
  const names = raw.map(resolveAlias); // 別名(大阪→梅田 など)を収録駅名に解決
  for (let i = 0; i < names.length; i++) {
    if (!STATIONS[names[i]]) { toast(`「${raw[i]}」はサンプルデータにありません。候補から選択してください`); return null; }
  }
  const points = names.filter((n, i) => i === 0 || n !== names[i - 1]); // 連続重複を除去
  if (points.length < 2) { toast('出発地と目的地が同じです'); return null; }
  return points;
}

function baseMinutes() {
  const t = $('#input-time').value;
  if (!t) { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

async function doSearch() {
  hideSuggest();
  const wantsGeo = [$('#input-origin'), ...$$('.via-input'), $('#input-dest')]
    .some(i => i.value.trim() === '現在地');
  if (wantsGeo && !STATIONS['現在地']) {
    toast('現在地を取得しています…');
    try { await locate(); }
    catch { toast('位置情報を取得できませんでした。ブラウザの許可設定を確認してください'); return; }
  }
  await loadFeedDelays(); // 自動取得済みの遅延(バックアップ)を最新化
  const points = collectPoints();
  if (!points) return;
  const baseMin = baseMinutes();
  const dateStr = $('#input-date').value;
  state.lastSearch = { points, mode: state.mode, baseMin, timeType: state.timeType, dateStr };

  if (state.mode === 'train') {
    const routes = searchTrainRoutes(points, baseMin, state.timeType, store.pass);
    if (!routes.length) { toast('経路が見つかりませんでした(運転見合わせ路線を確認してください)'); return; }
    state.routes = routes;
    state.pathResult = null;
    renderResults();
  } else {
    state.pathResult = searchPathRoute(points, state.mode, baseMin, state.timeType);
    state.routes = [];
    renderResults();
  }
  showScreen('results');
}

/* ================= 結果描画 ================= */
function fmtDateLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return '';
  const w = '日月火水木金土'[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${w})`;
}

function renderResults() {
  const { points, mode, baseMin, timeType, dateStr } = state.lastSearch;
  $('#results-summary').textContent =
    `${points.join(' → ')} ・ ${fmtDateLabel(dateStr)} ${fmtTime(baseMin)}${timeType === 'dep' ? '出発' : '到着'}`;

  const bannerEl = $('#results-banner');
  const banners = [];
  const suspended = suspendedLineIds();
  if (suspended.length) {
    banners.push(`<div class="banner warn">${warnSvg()}<span>${suspended.map(id => esc(lineById(id).name)).join('・')}は運転見合わせのため検索から除外しています</span></div>`);
  }
  const activeDelays = store.delays.filter(d => d.min !== 'suspend');
  if (mode === 'train' && activeDelays.length) {
    banners.push(`<div class="banner warn">${warnSvg()}<span>ユーザー登録の遅延情報 ${activeDelays.length}件を所要時間に反映しています</span></div>`);
  }
  const autoEntries = Object.values(autoDelayEntries());
  if (mode === 'train' && autoEntries.length) {
    const txt = autoEntries.map(d => `${lineById(d.lineId).short}+${d.min}分`).join('・');
    banners.push(`<div class="banner warn">${warnSvg()}<span>JR西日本の最新運行情報: ${esc(txt)} を所要時間に反映しています</span></div>`);
  }
  if (mode === 'train' && !banners.length) {
    banners.push(`<div class="banner info">${infoSvg()}<span>運賃は通常運賃を表示しています(きっぷ/IC)</span></div>`);
  }
  bannerEl.innerHTML = banners.join('');

  const list = $('#results-list');
  if (mode !== 'train') { renderPathCard(list); return; }

  const congestionLabel = ['空いています', '普通', '混雑'];
  list.innerHTML = state.routes.map((r, idx) => {
    const tags = [];
    if (r.passName && r.legs.some(l => l.passFree)) tags.push(`<span class="tag pass">${esc(r.passName)}</span>`);
    for (const [cls, label] of r.badges) tags.push(`<span class="tag ${cls}">${label}</span>`);
    if (r.delayTotal) tags.push(`<span class="tag delay">遅延 +${r.delayTotal}分</span>`);
    const chips = r.legs.filter(l => l.lineId !== 'WALK').map(l => {
      const line = lineById(l.lineId);
      return `<span class="route-line-chip"><i style="background:${line.color}"></i>${esc(line.short)}</span>`;
    }).join('<span style="color:#b9c6ba;font-weight:800">›</span>');
    const cardDep = r.legs[0].depTime;
    const firstRide = r.legs.find(l => l.lineId !== 'WALK');
    const nextDep = firstRide && r.legs[0].lineId !== 'WALK'
      ? (() => { const hw = headwayFor(firstRide.lineId, firstRide.depTime);
          return `<span>次発 ${fmtTime(cardDep + hw)} / ${fmtTime(cardDep + hw * 2)}</span>`; })()
      : '';
    return `
    <div class="route-card" data-idx="${idx}">
      <div class="route-tags">${tags.join('')}</div>
      <div class="route-time-row">
        <span class="route-time">${fmtTime(cardDep)}</span>
        <span class="route-arrow">→</span>
        <span class="route-time arr">${fmtTime(r.arr)}</span>
      </div>
      <div class="route-meta">
        <span>所要 ${fmtDur(r.arr - cardDep)}</span>
        <span>乗換 ${r.transfers}回</span>
        <span class="congestion c${r.congestion}">${congestionLabel[r.congestion]}</span>
        <span class="route-fare">${r.fare.ticket === 0 ? '¥0(パス適用)' : 'IC ' + yen(r.fare.ic)}</span>
        ${nextDep}
      </div>
      <div class="route-lines">${chips}</div>
      <span class="chev">›</span>
    </div>`;
  }).join('');

  $$('#results-list .route-card').forEach(card => {
    card.addEventListener('click', () => {
      state.current = state.routes[Number(card.dataset.idx)];
      renderDetail();
      showScreen('detail');
    });
  });
}

function renderPathCard(list) {
  const p = state.pathResult;
  const label = p.mode === 'bike' ? '自転車' : '徒歩';
  list.innerHTML = `
    <div class="route-card" style="cursor:default">
      <div class="route-tags"><span class="tag easy">${label}ルート</span></div>
      <div class="route-time-row">
        <span class="route-time">${fmtTime(p.dep)}</span>
        <span class="route-arrow">→</span>
        <span class="route-time arr">${fmtTime(p.arr)}</span>
      </div>
      <div class="route-meta">
        <span>所要 ${fmtDur(p.min)}</span>
        <span>約${p.km.toFixed(1)}km</span>
        <span>消費 約${p.kcal}kcal</span>
        <span class="route-fare">¥0</span>
      </div>
      <div class="route-lines">
        ${p.points.map(esc).join(' <span style="color:#b9c6ba;font-weight:800">›</span> ')}
      </div>
      <div class="detail-actions" style="margin-top:12px">
        <button class="secondary-btn" id="btn-path-map">地図で確認</button>
        <button class="gmap-btn" id="btn-path-gmap">Googleマップで開く</button>
      </div>
      <p class="demo-note" style="margin-top:8px">※距離・時間は直線距離×1.25の概算です。実際のルートはGoogleマップでご確認ください。</p>
    </div>`;
  $('#btn-path-map').addEventListener('click', () => { switchTab('map'); showPathOnMap(p); });
  $('#btn-path-gmap').addEventListener('click', openGmaps);
}

/* ================= 詳細描画 ================= */
function warnSvg() {
  return '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3L2 20h20L12 3zm0 6v5m0 3v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function infoSvg() {
  return '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v.5M12 11v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
}

function renderDetail() {
  const r = state.current;
  const { points } = state.lastSearch;
  const vias = new Set(points.slice(1, -1));

  const headDep = r.legs[0].depTime;
  $('#detail-head').innerHTML = `
    <div class="detail-sum-card">
      <div class="detail-sum-time">${fmtTime(headDep)} → ${fmtTime(r.arr)}</div>
      <div class="detail-sum-meta">
        <span>所要 <b>${fmtDur(r.arr - headDep)}</b></span>
        <span>乗換 <b>${r.transfers}</b>回</span>
        <span>${r.fare.ticket === 0 ? 'フリーパス適用 ¥0' : 'IC <b>' + yen(r.fare.ic) + '</b>'}</span>
      </div>
    </div>`;

  const rows = [];
  r.legs.forEach((leg, i) => {
    const line = lineById(leg.lineId);
    const first = i === 0;
    const stName = leg.stations[0];
    const cls = first ? 'origin' : (vias.has(stName) ? 'via' : '');
    if (first) {
      rows.push(stationRow(stName, cls, `${fmtTime(leg.depTime)}`, '発'));
    } else {
      const prevArr = r.legs[i - 1].arrTime;
      rows.push(stationRow(stName, cls, fmtTime(prevArr), `発 ${fmtTime(leg.depTime)}`, vias.has(stName)));
    }
    if (leg.lineId === 'WALK') {
      rows.push(`
      <div class="tl-leg">
        <div class="tl-leg-rail walk-rail"></div>
        <div class="tl-leg-body">
          <div class="leg-line-name" style="color:#5c6b70">徒歩</div>
          <div class="leg-sub">約${Math.round(leg.km * 1000)}m ・ ${leg.min}分</div>
        </div>
      </div>`);
      return;
    }
    const platform = (hashStr(leg.lineId + leg.stations[0]) % 11) + 1;
    const delayHtml = leg.delayInfo ? `
      <div class="leg-delay">${warnSvg()}
        <span>${esc(leg.delayInfo.reason)}の影響により約${leg.delay}分の遅延
        ${leg.delayInfo.comment ? '<br>「' + esc(leg.delayInfo.comment) + '」' : ''}
        <br><small>${leg.delayInfo.auto ? '公式運行情報' : 'ユーザー登録'} ${new Date(leg.delayInfo.ts).getMonth() + 1}/${new Date(leg.delayInfo.ts).getDate()} ${fmtTime(new Date(leg.delayInfo.ts).getHours() * 60 + new Date(leg.delayInfo.ts).getMinutes())}</small></span>
      </div>` : '';
    rows.push(`
      <div class="tl-leg">
        <div class="tl-leg-rail" style="background:${line.color}"></div>
        <div class="tl-leg-body">
          ${leg.passFree && r.passName ? `<div class="leg-badges"><span class="tag pass">${esc(r.passName)}</span></div>` : ''}
          <div class="leg-line-name" style="color:${line.color}">${esc(line.name)}</div>
          <div class="leg-sub">${esc(legDirection(leg))} ・ ${leg.stations.length - 1}駅 ・ ${leg.min + leg.delay}分 ・ [発]${platform}番線</div>
          ${delayHtml}
        </div>
      </div>`);
  });
  const lastLeg = r.legs[r.legs.length - 1];
  rows.push(stationRow(lastLeg.stations[lastLeg.stations.length - 1], 'dest', fmtTime(lastLeg.arrTime), '着'));

  $('#detail-timeline').innerHTML = `
    <div class="timeline">${rows.join('')}</div>
    <div class="fare-box">
      <span>きっぷ <b>${yen(r.fare.ticket)}</b></span>
      <span>IC <b>${yen(r.fare.ic)}</b></span>
      ${r.fare.passApplied ? '<span style="color:var(--green);font-weight:800">フリーパス適用区間あり</span>' : ''}
    </div>`;
}

function stationRow(name, cls, time, sub, isVia) {
  return `
    <div class="tl-station ${cls || ''}">
      <div class="tl-time">${time}<small>${esc(sub)}</small></div>
      <div class="tl-node"></div>
      <div class="tl-name">${esc(name)}${isVia ? '<small>経由</small>' : ''}</div>
    </div>`;
}

/* ================= 地図(Leaflet) ================= */
let map = null, routeGroup = null;

function ensureMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false }).setView([34.70, 135.50], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);
  for (const line of LINES) {
    const pts = line.stations.map(n => [STATIONS[n].lat, STATIONS[n].lng]);
    if (line.loop) pts.push(pts[0]);
    L.polyline(pts, { color: line.color, weight: 2.5, opacity: 0.35 }).addTo(map);
  }
  routeGroup = L.layerGroup().addTo(map);
}

function marker(name, color, big) {
  const m = L.circleMarker([STATIONS[name].lat, STATIONS[name].lng], {
    radius: big ? 9 : 5, color: '#fff', weight: 2.5, fillColor: color, fillOpacity: 1
  });
  m.bindTooltip(name, big
    ? { permanent: true, direction: 'top', className: 'map-label', offset: [0, -8] }
    : { direction: 'top', className: 'map-label' });
  return m;
}

function showRouteOnMap(route) {
  ensureMap();
  routeGroup.clearLayers();
  const all = [];
  for (const leg of route.legs) {
    const line = lineById(leg.lineId);
    const pts = leg.stations.map(n => [STATIONS[n].lat, STATIONS[n].lng]);
    all.push(...pts);
    L.polyline(pts, { color: '#fff', weight: 9, opacity: .9 }).addTo(routeGroup);
    if (leg.lineId === 'WALK') {
      L.polyline(pts, { color: '#5c6b70', weight: 4, dashArray: '5 8' }).addTo(routeGroup);
    } else {
      L.polyline(pts, { color: line.color, weight: 5, opacity: 1 }).addTo(routeGroup);
    }
  }
  const { points } = state.lastSearch;
  const vias = points.slice(1, -1);
  route.legs.forEach((leg, i) => { if (i > 0) marker(leg.stations[0], '#fff', false).setStyle({ fillColor: '#15241c' }).addTo(routeGroup); });
  for (const v of vias) marker(v, '#e8780a', true).addTo(routeGroup);
  marker(points[0], '#067a46', true).addTo(routeGroup);
  marker(points[points.length - 1], '#d92638', true).addTo(routeGroup);
  fitMap(L.latLngBounds(all));
  $('#map-route-info').innerHTML =
    `${esc(points[0])} → ${esc(points[points.length - 1])} ・ ${fmtTime(route.dep)}発 ・ ${fmtDur(route.total)} ・ ${route.fare.ticket === 0 ? '¥0(パス適用)' : 'IC ' + yen(route.fare.ic)}`;
  $('#map-route-info').classList.remove('hidden');
  $('#btn-gmap-map').classList.remove('hidden');
}

// タブ切替直後はコンテナサイズが未確定のため、確定後に再フィット
function fitMap(bounds) {
  map.fitBounds(bounds, { padding: [40, 40] });
  setTimeout(() => {
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [40, 40] });
  }, 150);
}

function showPathOnMap(p) {
  ensureMap();
  routeGroup.clearLayers();
  const pts = p.points.map(n => [STATIONS[n].lat, STATIONS[n].lng]);
  L.polyline(pts, { color: '#fff', weight: 9, opacity: .9 }).addTo(routeGroup);
  L.polyline(pts, { color: '#1668b3', weight: 5, dashArray: '10 7' }).addTo(routeGroup);
  p.points.slice(1, -1).forEach(v => marker(v, '#e8780a', true).addTo(routeGroup));
  marker(p.points[0], '#067a46', true).addTo(routeGroup);
  marker(p.points[p.points.length - 1], '#d92638', true).addTo(routeGroup);
  fitMap(L.latLngBounds(pts));
  $('#map-route-info').innerHTML =
    `${p.mode === 'bike' ? '自転車' : '徒歩'}: ${esc(p.points[0])} → ${esc(p.points[p.points.length - 1])} ・ 約${p.km.toFixed(1)}km ・ ${fmtDur(p.min)}`;
  $('#map-route-info').classList.remove('hidden');
  $('#btn-gmap-map').classList.remove('hidden');
}

/* ================= 遅延情報 ================= */
function renderDelays() {
  const delays = store.delays;
  const auto = Object.values(autoDelayEntries());
  const list = $('#delay-list');

  // JR西日本リアルタイム遅延セクション
  const fresh = liveFetchedAt ? new Date(liveFetchedAt) : (feedUpdatedAt ? new Date(feedUpdatedAt) : null);
  const srcLabel = liveFetchedAt ? '取得ボタンで直接取得' : (feedUpdatedAt ? '自動取得(バックアップ)' : null);
  let html = `
    <div class="card delay-form-card">
      <h2 class="card-title">JR西日本 リアルタイム遅延</h2>
      <p class="card-sub">JR西日本「列車走行位置」の公式データ(約8秒鮮度)から、収録JR路線(大阪環状線・京都線神戸線・JR東西線)の実際の遅延分を取得します。${fresh ? `最終取得: ${fresh.getMonth() + 1}/${fresh.getDate()} ${fmtTime(fresh.getHours() * 60 + fresh.getMinutes())}・${srcLabel}` : ''}</p>
      <button id="btn-fetch-live" class="primary-btn small">
        <svg viewBox="0 0 24 24" width="16" height="16" style="margin-right:5px"><path d="M21 12a9 9 0 11-3-6.7M21 4v4h-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        JRの最新遅延を取得
      </button>
      ${auto.length ? auto.map(d => {
        const line = lineById(d.lineId);
        const dt = new Date(d.ts);
        return `
      <div class="delay-item">
        <div class="delay-item-body">
          <div class="delay-item-line"><i style="background:${line.color}"></i>${esc(line.name)}</div>
          <div class="delay-item-status">最大${d.min}分の遅延</div>
          <div class="delay-item-sub">${esc(d.comment)}<br>${d.source === 'live' ? '直接取得' : '自動取得'} ${isNaN(dt) ? '' : `${dt.getMonth() + 1}/${dt.getDate()} ${fmtTime(dt.getHours() * 60 + dt.getMinutes())} 時点`}</div>
        </div>
      </div>`;
      }).join('') : `<p class="card-sub" style="margin:8px 0 0">${fresh ? '現在、収録JR路線に目立った遅延はありません。' : '「取得」ボタンで最新の運行状況を確認できます。'}</p>`}
    </div>`;

  // 手動登録セクション
  if (!delays.length) {
    html += '<div class="empty-note">手動登録された遅延情報はありません。<br>上のフォームから登録すると、経路検索に反映されます。</div>';
  } else {
    html += delays.slice().sort((a, b) => b.ts - a.ts).map(d => {
      const line = lineById(d.lineId);
      const dt = new Date(d.ts);
      return `
      <div class="delay-item ${d.min === 'suspend' ? 'suspend' : ''}">
        <div class="delay-item-body">
          <div class="delay-item-line"><i style="background:${line.color}"></i>${esc(line.name)}</div>
          <div class="delay-item-status">${d.min === 'suspend' ? '運転見合わせ' : `約${d.min}分の遅延`} ・ ${esc(d.reason)}</div>
          <div class="delay-item-sub">${d.comment ? esc(d.comment) + '<br>' : ''}${dt.getMonth() + 1}/${dt.getDate()} ${fmtTime(dt.getHours() * 60 + dt.getMinutes())} 登録</div>
        </div>
        <button class="delay-del" data-id="${d.id}">削除</button>
      </div>`;
    }).join('');
  }
  list.innerHTML = html;
  const fetchBtn = $('#btn-fetch-live');
  if (fetchBtn) fetchBtn.addEventListener('click', runLiveFetch);
  $$('#delay-list .delay-del').forEach(b => b.addEventListener('click', () => {
    store.delays = store.delays.filter(x => String(x.id) !== b.dataset.id);
    renderDelays();
    toast('遅延情報を削除しました');
  }));

  const total = delays.length + auto.length;
  const badge = $('#delay-tab-badge');
  badge.classList.toggle('hidden', !total);
  badge.textContent = total;

  const home = $('#delay-notice-home');
  home.innerHTML = total
    ? `<div class="banner warn" style="cursor:pointer" id="home-delay-banner">${warnSvg()}<span>遅延情報 ${total}件(手動${delays.length}・公式${auto.length})が検索結果に反映されます</span></div>`
    : '';
  if (total) $('#home-delay-banner').addEventListener('click', () => switchTab('delay'));
}

let liveFetching = false;
async function runLiveFetch() {
  if (liveFetching) return;
  liveFetching = true;
  const btn = $('#btn-fetch-live');
  if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
  toast('JRの最新運行情報を取得中…');
  try {
    const r = await fetchLiveJRDelays();
    if (!r.ok) toast('取得できませんでした(プロキシ混雑の可能性・時間をおいて再試行)');
    else if (r.delayed) toast(`取得完了: ${r.delayed}路線で遅延あり`);
    else toast('取得完了: 収録JR路線に目立った遅延はありません');
  } finally {
    liveFetching = false;
    const b = $('#btn-fetch-live');
    if (b) { b.disabled = false; b.style.opacity = ''; }
  }
}

function addDelay() {
  const lineId = $('#delay-line').value;
  const min = $('#delay-min').value;
  const reason = $('#delay-reason').value;
  const comment = $('#delay-comment').value.trim();
  const delays = store.delays.filter(d => d.lineId !== lineId); // 同一路線は上書き
  delays.push({ id: Date.now(), lineId, min, reason, comment, ts: Date.now() });
  store.delays = delays;
  $('#delay-comment').value = '';
  renderDelays();
  const line = lineById(lineId);
  toast(`${line.name}の${min === 'suspend' ? '運転見合わせ' : '遅延情報'}を登録しました`);
}

/* ================= フリーパス ================= */
function renderPassUI() {
  const cur = store.pass;
  const pass = PASSES.find(p => p.id === cur) || PASSES[0];
  const label = $('#pass-label');
  label.textContent = pass.id === 'none' ? 'フリーパスなし' : pass.name;
  label.classList.toggle('pass-on', pass.id !== 'none');
  $('#menu-pass-label').textContent = pass.id === 'none' ? 'なし' : pass.name;

  $('#pass-list').innerHTML = PASSES.map(p => `
    <button class="pass-item ${p.id === cur ? 'selected' : ''} ${p.id !== 'none' && !p.covers.length ? 'outside' : ''}" data-id="${p.id}">
      <span class="pass-check">${p.id === cur ? '✓' : ''}</span>
      <span class="pass-body">${esc(p.name)}${p.note ? `<span class="pass-note">${esc(p.note)}</span>` : ''}</span>
    </button>`).join('');
  $$('#pass-list .pass-item').forEach(b => b.addEventListener('click', () => {
    store.pass = b.dataset.id;
    const p = PASSES.find(x => x.id === b.dataset.id);
    if (p.id !== 'none' && !p.covers.length) toast('このパスはデモエリア外のため運賃計算には影響しません');
    renderPassUI();
  }));
}

/* ================= 初期化 ================= */
function init() {
  // 日時デフォルト
  const now = new Date();
  $('#input-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const rounded = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
  $('#input-time').value = fmtTime(rounded);

  // 遅延フォームの選択肢
  $('#delay-line').innerHTML = LINES.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  $('#delay-reason').innerHTML = DELAY_REASONS.map(r => `<option>${esc(r)}</option>`).join('');

  // タブ
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // ヘッダー
  $('#header-back').addEventListener('click', () => {
    showScreen(currentScreen() === 'detail' ? 'results' : 'search');
  });
  $('#header-action').addEventListener('click', () => showScreen('search'));

  // 検索フォーム
  $('#btn-add-via').addEventListener('click', () => addViaRow());
  $('#btn-swap').addEventListener('click', () => {
    const o = $('#input-origin'), d = $('#input-dest');
    [o.value, d.value] = [d.value, o.value];
    const vias = $$('.via-input').map(i => i.value);
    $$('.via-input').forEach((i, idx) => { i.value = vias[vias.length - 1 - idx]; });
  });
  $('#seg-timetype').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state.timeType = b.dataset.v;
    $$('#seg-timetype button').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#mode-row').addEventListener('click', e => {
    const b = e.target.closest('.mode-btn');
    if (!b) return;
    state.mode = b.dataset.mode;
    $$('.mode-btn').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#btn-search').addEventListener('click', doSearch);

  // サジェスト(イベント委譲)
  document.addEventListener('focusin', e => {
    if (e.target.classList && e.target.classList.contains('point-input')) showSuggest(e.target);
  });
  document.addEventListener('input', e => {
    if (e.target.classList && e.target.classList.contains('point-input')) showSuggest(e.target);
  });
  $('#suggest-box').addEventListener('mousedown', e => {
    const item = e.target.closest('.suggest-item');
    if (!item || !activeInput) return;
    e.preventDefault();
    activeInput.value = item.dataset.name;
    hideSuggest();
    if (item.dataset.name === '現在地') {
      locate().then(pt => {
        const near = nearestStations(pt, 1, 9999)[0];
        toast(`現在地を取得しました(最寄り: ${near.name}駅 約${near.km.toFixed(1)}km)`);
      }).catch(() => toast('位置情報を取得できませんでした。ブラウザの許可設定を確認してください'));
    }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.suggest-item') && !e.target.closest('.point-input')) hideSuggest();
  });

  // 詳細画面アクション
  $('#btn-show-map').addEventListener('click', () => {
    if (!state.current) return;
    switchTab('map');
    showRouteOnMap(state.current);
  });
  $('#btn-gmap-detail').addEventListener('click', openGmaps);
  $('#btn-gmap-map').addEventListener('click', openGmaps);

  // 遅延
  $('#btn-delay-add').addEventListener('click', addDelay);

  // フリーパスモーダル
  $('#btn-pass').addEventListener('click', () => $('#pass-modal').classList.remove('hidden'));
  $('#menu-pass').addEventListener('click', () => $('#pass-modal').classList.remove('hidden'));
  $('#pass-done').addEventListener('click', () => $('#pass-modal').classList.add('hidden'));
  $('#pass-modal').addEventListener('click', e => {
    if (e.target.id === 'pass-modal') $('#pass-modal').classList.add('hidden');
  });

  // メニュー
  $('#menu-clear-delays').addEventListener('click', () => {
    store.delays = [];
    renderDelays();
    toast('遅延情報をすべて削除しました');
  });
  $('#menu-reset').addEventListener('click', () => {
    localStorage.removeItem('nn_delays');
    localStorage.removeItem('nn_pass');
    location.reload();
  });

  renderDelays();
  renderPassUI();
  updateHeader();
  loadFeedDelays();

  // デモ用の初期値
  $('#input-origin').value = '梅田';
  $('#input-dest').value = '三宮';

  // PWA
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);

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
  set pass(v) { localStorage.setItem('nn_pass', v); },
  get history() { try { return JSON.parse(localStorage.getItem('nn_history') || '[]'); } catch { return []; } },
  set history(v) { localStorage.setItem('nn_history', JSON.stringify(v)); },
  get alarm() { return localStorage.getItem('nn_alarm') || ''; },
  set alarm(v) { v ? localStorage.setItem('nn_alarm', v) : localStorage.removeItem('nn_alarm'); },
  get driveLogs() { try { return JSON.parse(localStorage.getItem('nn_drivelogs') || '[]'); } catch { return []; } },
  set driveLogs(v) { localStorage.setItem('nn_drivelogs', JSON.stringify(v)); },
  get theme() { return localStorage.getItem('nn_theme') || 'light'; },
  set theme(v) { localStorage.setItem('nn_theme', v); },
  get mapStyle() { return localStorage.getItem('nn_mapstyle') || 'pale'; },
  set mapStyle(v) { localStorage.setItem('nn_mapstyle', v); },
  get parked() { try { return JSON.parse(localStorage.getItem('nn_parked') || 'null'); } catch { return null; } },
  set parked(v) { v ? localStorage.setItem('nn_parked', JSON.stringify(v)) : localStorage.removeItem('nn_parked'); }
};

/* テーマ(ライト/ダーク) */
function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0c8a50' : '#04532f');
}

const MAX_HISTORY = 8;
// 検索した地点名を履歴の先頭に積む(駅名・住所・現在地)
function recordHistory(points) {
  let h = store.history;
  for (const p of points) {
    if (p === '現在地') continue;
    h = [p, ...h.filter(x => x !== p)];
  }
  store.history = h.slice(0, MAX_HISTORY);
}

const state = {
  mode: 'train',          // train | bike | walk
  timeType: 'dep',        // dep | arr
  routes: [],
  current: null,          // 選択中の電車ルート
  lastSearch: null,       // { points, mode, baseMin, timeType, dateStr }
  pathResult: null,       // 自転車/徒歩の結果
  resultView: 'list'      // list | board(発車標)
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

/* 仮想地点(現在地・住所検索でヒットした地点)。駅ではないが経路の端点になれる */
const VIRTUAL = {};
function setVirtual(name, pt) { VIRTUAL[name] = pt; STATIONS[name] = pt; }
function isVirtual(name) { return Object.prototype.hasOwnProperty.call(VIRTUAL, name); }

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
        // 別駅間の乗換徒歩は、直線距離だけでなく階段・改札・地下通路の移動が加わるため
        // 経路係数1.35・実効速度4.5km/h・乗換オーバーヘッド4分で見積もる(短すぎ防止)
        pairs.push({ a, b, km: +(d * 1.25).toFixed(2), min: Math.max(3, Math.round(d * 1.35 / 4.5 * 60) + 4) });
      }
    }
  }
  return pairs;
})();

function nearestStations(pt, count, maxKm) {
  const sorted = Object.keys(STATIONS)
    .filter(n => !isVirtual(n))
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
  // 仮想地点(現在地・住所)→ 近隣駅への徒歩接続
  for (const vname in VIRTUAL) {
    for (const s of nearestStations(VIRTUAL[vname], 4, 4)) {
      const km = +(s.km * 1.25).toFixed(2);
      const min = Math.max(1, Math.round(km / 4.8 * 60) + 1);
      (adj[vname] = adj[vname] || []).push({ to: s.name, line: 'WALK', min, km });
      (adj[s.name] = adj[s.name] || []).push({ to: vname, line: 'WALK', min, km });
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
      const w = e.min + (transfer ? cfg.tp : 0) + (cfg.kmW ? cfg.kmW(e.line) * e.km : 0)
        + (cfg.walkPen && e.line === 'WALK' ? cfg.walkPen : 0);
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

// JR西日本 公式運行情報(近畿エリア)
const JR_DELAY_OFFICIAL = 'https://trafficinfo.westjr.co.jp/kinki.html';

// よく使う駅(マイ駅)。収録駅名 → 公式時刻表(JRおでかけネット)URL
const MY_STATIONS = ['三宮', '大阪天満宮', '梅田'];
const TIMETABLE_URL = {
  '梅田': 'https://www.jr-odekake.net/eki/timetable?id=0610130',       // JR大阪駅
  '三宮': 'https://www.jr-odekake.net/eki/timetable?id=0610143',       // JR三ノ宮駅
  '大阪天満宮': 'https://www.jr-odekake.net/eki/timetable?id=0612302'  // JR大阪天満宮駅
};
// 行先キーワードから方面を判定(リアルタイム実データの dest で方向を見分ける)
const DIR_KEYWORDS = {
  '大阪方面': ['大阪', '京都', '野洲', '米原', '環状', '京橋', '高槻', '草津'],
  '三ノ宮方面': ['三ノ宮', '三宮', '神戸', '西明石', '姫路', '須磨', '明石', '加古川']
};
// 時間帯による基本の向き(午前=大阪方面・午後=三ノ宮方面)
function preferredDir() {
  const h = new Date().getHours();
  return h < 12 ? '大阪方面' : '三ノ宮方面';
}
function destFaces(dests, facing) {
  const kws = DIR_KEYWORDS[facing] || [];
  return Object.keys(dests).some(d => kws.some(k => d.includes(k)));
}

// ブラウザから他ドメインを取得するための公開CORSプロキシ(上から順に試す)
const CORS_PROXIES = [
  u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://thingproxy.freeboard.io/fetch/' + u
];

let feedDelays = {};    // GitHub Actions が保存した live/delays.json 由来(バックアップ)
let liveDelays = {};    // 取得ボタンでブラウザが直接取得した最新分
let liveStatus = {};    // 路線ごとの方向別リアルタイム運行状況(JR)
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
  const status = {};
  let ok = 0;
  await Promise.all(JR_REALTIME.map(async ({ lineId, api }) => {
    const data = await proxyFetchJson(JR_API_BASE + api + '.json');
    if (!data || !Array.isArray(data.trains)) return;
    ok++;
    // 方向別(dir 0/1)に運行本数・最大遅延・主な行先を集計
    const dirs = { 0: { count: 0, max: 0, dests: {}, types: {} }, 1: { count: 0, max: 0, dests: {}, types: {} } };
    for (const t of data.trains) {
      const d = Number(t.direction) === 1 ? 1 : 0;
      dirs[d].count++;
      dirs[d].max = Math.max(dirs[d].max, t.delayMinutes || 0);
      const dest = t.dest && t.dest.text;
      if (dest) dirs[d].dests[dest] = (dirs[d].dests[dest] || 0) + 1;
      const ty = cleanTrainType(t.displayType || t.type);
      dirs[d].types[ty] = (dirs[d].types[ty] || 0) + 1;
    }
    status[lineId] = { dirs, total: data.trains.length, update: data.update };
    const max = data.trains.reduce((m, t) => Math.max(m, t.delayMinutes || 0), 0);
    if (max > 0) entries[lineId] = jrEntry(lineId, max, data.trains.length, data.update);
  }));
  if (ok === 0) return { ok: false };
  liveDelays = entries;
  liveStatus = status;
  liveFetchedAt = Date.now();
  renderDelays();
  return { ok: true, lines: ok, delayed: Object.keys(entries).length };
}

// 方向グループの代表行先(本数の多い順に最大2つ)を「○○・△△方面」の形にする
function dirLabel(destObj) {
  const tops = Object.entries(destObj).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
  return tops.length ? tops.join('・') + '方面' : '—';
}

// displayType の装飾を落として代表的な種別名に正規化
const TRAIN_TYPES = ['新快速', '区間快速', '直通快速', '大和路快速', '関空快速', '紀州路快速', '快速', '特急', '急行', '準急', '普通'];
function cleanTrainType(s) {
  for (const k of TRAIN_TYPES) if (s && s.includes(k)) return k;
  return s || '列車';
}
// 種別内訳を「新快速2・快速3・普通5」の形に(本数の多い順)
function typeSummary(typesObj) {
  return Object.entries(typesObj).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}${n}`).join('・');
}

// Googleマップ周辺検索URL(指定座標を中心に検索)
function gmapNearbyUrl(query, pt) {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${pt.lat.toFixed(6)},${pt.lng.toFixed(6)},16z`;
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

// 運行時間帯: 始発5:00〜終電(最終乗車0:30頃)。0:30〜5:00は運行なし。
const FIRST_DEP = 300;    // 5:00
const LAST_BOARD = 30;    // 翌0:30(時刻帯の0〜30分)まで乗車可
function todOf(min) { return ((min % 1440) + 1440) % 1440; }
function inDeadZone(min) { const t = todOf(min); return t > LAST_BOARD && t < FIRST_DEP; }

/* ===== 実時刻表(REAL_TIMETABLES)による発車標の補正 ===== */
// 平日/休日の判定(日本の祝日は考慮しない簡易判定)
function realDayType(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const w = d.getDay();
  return (w === 0 || w === 6) ? 'holiday' : 'weekday';
}
// legの進行方向(路線の駅配列上で添字が増える方向か減る方向か)
function realDirection(leg) {
  const line = lineById(leg.lineId);
  const i0 = line.stations.indexOf(leg.stations[0]);
  const i1 = line.stations.indexOf(leg.stations[1]);
  return i1 > i0 ? 'down' : 'up';
}
// 指定駅・路線・方向・日種の実時刻表(発車時刻昇順)を取得
function realTimetableFor(station, lineId, leg, dateStr) {
  const t = REAL_TIMETABLES[station] && REAL_TIMETABLES[station][lineId];
  if (!t) return null;
  const byDir = t[realDirection(leg)];
  return (byDir && byDir[realDayType(dateStr)]) || null;
}
// ルートrの発車時刻を実時刻表上の直近の発車に合わせて補正する(見つからなければ何もしない)
// cursor: 同じ時刻表配列を複数ルートで共有する際に、同じ発車を重複して割り当てないための Map(list -> 次に検索を始める分)
function applyRealTimetable(r, station, dateStr, cursor) {
  const fr = r.legs.find(l => l.lineId !== 'WALK');
  if (!fr || fr.stations[0] !== station) return null;
  const list = realTimetableFor(station, fr.lineId, fr, dateStr);
  if (!list || !list.length) return null;
  let from = todOf(r.dep);
  if (from < FIRST_DEP) from += 1440; // 0:00〜0:30の検索は終電後扱いで比較
  let searchFrom = from;
  if (cursor && cursor.has(list)) searchFrom = Math.max(searchFrom, cursor.get(list));
  const cand = list.find(e => e.min >= searchFrom);
  if (!cand) return null;
  if (cursor) cursor.set(list, cand.min + 1);
  const delta = cand.min - from;
  for (const leg of r.legs) { leg.depTime += delta; leg.arrTime += delta; }
  r.dep += delta; r.arr += delta;
  return { type: cand.type, dest: cand.dest };
}

function scheduleRoute(r, baseMin, timeType) {
  const dur = computeTimes(r, 0);
  let dep = timeType === 'arr' ? baseMin - dur : baseMin;
  computeTimes(r, dep); // 各legの時刻を仮置き

  // 最初の電車が始発前(運行時間外)なら、全体を始発(5:00)まで繰り下げる
  r.bumped = false;
  const firstTrain = r.legs.find(l => l.lineId !== 'WALK');
  if (firstTrain && inDeadZone(firstTrain.depTime)) {
    const delta = (firstTrain.depTime - todOf(firstTrain.depTime) + FIRST_DEP) - firstTrain.depTime;
    for (const leg of r.legs) { leg.depTime += delta; leg.arrTime += delta; }
    dep += delta;
    r.bumped = true;
  }

  // 途中の乗車が終電後(デッドゾーン)に入る経路は成立しない
  r.valid = !r.legs.some(l => l.lineId !== 'WALK' && inDeadZone(l.depTime));

  r.dep = r.legs[0].depTime;
  r.arr = r.legs[r.legs.length - 1].arrTime;
  r.total = r.arr - r.dep;
}

// 同じ経路の「k本後の便」を生成(運転間隔ぶん時刻をずらす)。終電後に入るならnull
function shiftRoute(r, k) {
  const fr = r.legs.find(l => l.lineId !== 'WALK');
  if (!fr) return null;
  const delta = (headwayFor(fr.lineId, r.dep) || 5) * k;
  const legs = r.legs.map(l => ({ ...l, depTime: l.depTime + delta, arrTime: l.arrTime + delta }));
  if (legs.some(l => l.lineId !== 'WALK' && inDeadZone(l.depTime))) return null;
  return { ...r, legs, dep: r.dep + delta, arr: r.arr + delta, total: r.total, badges: [], isLater: true };
}

// 詳細画面で前/次の一本へ移行(運転間隔ぶん時刻をずらす)
function stepRoute(dir) {
  const v = shiftRoute(state.current, dir);
  if (!v) { toast(dir > 0 ? 'これ以上後の便はありません(終電後)' : 'これ以上前の便はありません(始発前)'); return; }
  state.current = v;
  renderDetail();
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
    { tp: 5, walkPen: 15 },  // 徒歩連絡を避け、同一駅乗換(尼崎などのJR乗換)ルートを発掘
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

  // 3) 事業者の多様性確保: 既出の事業者だけだと埋もれる他社(阪神など)の最良ルートを発掘。
  //    既出事業者の路線を全て除外して再探索し、別事業者の代替を1本ずつ加える。
  for (let pass = 0; pass < 2 && routes.length < MAX_ROUTES; pass++) {
    const repOps = new Set(routes.flatMap(r =>
      r.legs.filter(l => l.lineId !== 'WALK').map(l => lineById(l.lineId).operator)));
    const ban = LINES.filter(l => repOps.has(l.operator)).map(l => l.id);
    const before = routes.length;
    tryRoute({ tp: 8 }, ban);
    if (routes.length === before) break; // 新たな事業者の経路が無ければ終了
  }

  for (const r of routes) scheduleRoute(r, baseMin, timeType);
  const valid = routes.filter(r => r.valid); // 終電後に乗り継ぐ経路は除外
  // 「乗換の手間」を加味した総合順。別事業者の直結乗換(改札移動)や別駅間の徒歩連絡は
  // 実際の手間が大きいため、到着時刻にペナルティ分を上乗せしたスコアで並べる(到着時刻自体は変えない)。
  // これによりJR直通・乗換が楽なルートが上位に来る。最速ルートは「早」バッジで分かる。
  const WALK_PENALTY = 10, OPCHANGE_PENALTY = 6;
  const comfortScore = r => {
    const rides = r.legs.filter(l => l.lineId !== 'WALK');
    let opChanges = 0;
    for (let i = 1; i < r.legs.length; i++) {
      const cur = r.legs[i], prev = r.legs[i - 1];
      if (cur.lineId !== 'WALK' && prev.lineId !== 'WALK'
        && lineById(cur.lineId).operator !== lineById(prev.lineId).operator) opChanges++;
    }
    const walks = r.legs.filter(l => l.lineId === 'WALK').length;
    return r.arr + walks * WALK_PENALTY + opChanges * OPCHANGE_PENALTY;
  };
  valid.sort((a, b) =>
    (b.passPriority ? 1 : 0) - (a.passPriority ? 1 : 0) ||
    comfortScore(a) - comfortScore(b) || a.arr - b.arr || a.transfers - b.transfers);
  assignBadges(valid);

  // 結果が少ない時は各経路の次発・次々発を加えてリストを充実させる(到着指定時は除く)
  const TARGET = 6;
  const expanded = valid.slice();
  if (timeType !== 'arr') {
    const dseen = new Set(expanded.map(r => r.sig + '@' + r.dep));
    for (let k = 1; k <= 3 && expanded.length < TARGET; k++) {
      for (const r of valid) {
        if (expanded.length >= TARGET) break;
        const v = shiftRoute(r, k);
        if (!v) continue;
        const key = v.sig + '@' + v.dep;
        if (dseen.has(key)) continue;
        dseen.add(key);
        expanded.push(v);
      }
    }
  }
  // 乗換の手間を加味した総合順で表示(同程度なら出発が早い順)。JR直通・乗換が楽なルートを上位に。
  expanded.sort((a, b) =>
    (b.passPriority ? 1 : 0) - (a.passPriority ? 1 : 0) ||
    comfortScore(a) - comfortScore(b) || a.dep - b.dep || a.arr - b.arr);
  return expanded;
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
  km *= (mode === 'car' ? 1.35 : 1.25); // 実道路換算の概算係数(車は道なりで長め)
  const speed = mode === 'car' ? 28 : mode === 'bike' ? 15 : 4.8; // km/h(市街地平均の目安)
  const min = Math.max(1, Math.round(km / speed * 60));
  const kcal = mode === 'car' ? 0 : Math.round(km * (mode === 'bike' ? 25 : 50));
  const fuel = mode === 'car' ? Math.round(km / 12 * 170) : 0; // 燃料概算: 12km/L・170円/L
  const dep = timeType === 'arr' ? baseMin - min : baseMin;
  return { points, mode, km, min, kcal, fuel, dep, arr: dep + min };
}

/* ================= Googleマップ連携 ================= */
function gmapsUrl(points, mode) {
  const enc = n => (isVirtual(n) && STATIONS[n])
    ? `${STATIONS[n].lat.toFixed(6)},${STATIONS[n].lng.toFixed(6)}`
    : encodeURIComponent(n + '駅');
  if (mode === 'train' || mode === 'bus') {
    // 公共交通(電車・バス)はtransit。経由地パラメータ非対応のためマルチストップ形式で開く
    if (points.length > 2) return 'https://www.google.com/maps/dir/' + points.map(enc).join('/');
    return `https://www.google.com/maps/dir/?api=1&origin=${enc(points[0])}&destination=${enc(points[points.length - 1])}&travelmode=transit`;
  }
  const tm = mode === 'car' ? 'driving' : mode === 'bike' ? 'bicycling' : 'walking';
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
  if (name !== 'results') stopApproach(); // 結果画面以外では接近アニメを止める
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
    if (sc === 'search') text.textContent = '福ちゃんNavi';
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

  // 事業者キーワード(路線名に含まれない呼び方)→ 事業者ID
  const OP_KEYWORDS = { '地下鉄': 'OSAKAMETRO', 'メトロ': 'OSAKAMETRO', '市営': 'OSAKAMETRO' };

  // 駅候補を収集(駅名・別名・路線名/略称・事業者名で一致)
  function matchStations(query) {
    const set = new Set();
    for (const n of Object.keys(STATIONS)) if (!isVirtual(n) && n.includes(query)) set.add(n);
    if (typeof ALIASES !== 'undefined') for (const a in ALIASES) if (a.includes(query)) set.add(ALIASES[a]);
    // 路線名・略称での一致 → その路線の全駅
    for (const line of LINES) {
      if (line.name.includes(query) || line.short.includes(query)) line.stations.forEach(s => set.add(s));
    }
    // 事業者キーワードでの一致 → その事業者の全駅
    for (const kw in OP_KEYWORDS) {
      if (query.includes(kw)) for (const line of LINES) if (line.operator === OP_KEYWORDS[kw]) line.stations.forEach(s => set.add(s));
    }
    return [...set];
  }

  const items = []; // { name, kind } kind: history | current | station
  const used = new Set();
  const push = (name, kind) => { if (!used.has(name)) { used.add(name); items.push({ name, kind }); } };

  // 1) 検索履歴(上位に残す)
  for (const h of store.history) {
    if (!q || h.includes(q)) push(h, 'history');
  }
  // 2) 現在地
  if (!q || '現在地'.includes(q)) push('現在地', 'current');
  // 3) 駅・路線・事業者一致(クエリ無しは主要駅)
  for (const n of (q ? matchStations(q) : POPULAR)) push(n, 'station');

  const list = items.slice(0, 12);
  const box = $('#suggest-box');
  if (!list.length) { hideSuggest(); return; }

  const stationItem = (n, kind) => {
    const lines = (STATION_LINES[n] || []);
    const lineNames = lines.map(l => l.short).join('・');
    const tag = kind === 'history'
      ? '<span class="sg-tag hist">履歴</span>'
      : `<span class="st-lines">${lines.map(l => `<i class="line-dot" style="background:${l.color}"></i>`).join('')}</span>`;
    const pin = kind === 'history'
      ? '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" fill="none" stroke="#e8780a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 2a7 7 0 00-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z" fill="#8fa093"/></svg>';
    const sub = lineNames ? `<span class="sg-sub">${esc(lineNames)}</span>` : (STATIONS[n] ? '' : '<span class="sg-sub">住所として検索</span>');
    return `<div class="suggest-item" data-name="${esc(n)}">${pin}<span class="sg-name">${esc(n)}</span>${sub}${tag}</div>`;
  };

  box.innerHTML = list.map(it => it.kind === 'current' ? `
    <div class="suggest-item" data-name="現在地">
      <svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="3.2" fill="#1668b3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3" stroke="#1668b3" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="7" fill="none" stroke="#1668b3" stroke-width="2"/></svg>
      <span class="sg-name" style="color:#1668b3;font-weight:800">現在地</span>
      <span class="sg-sub">GPSで取得</span>
    </div>` : stationItem(it.name, it.kind)).join('');
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
        setVirtual('現在地', pt);
        resolve(pt);
      },
      err => reject(err),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
}

/* ================= 降車駅アラーム(乗り過ごし防止) ================= */
const alarm = { target: null, watchId: null, triggered: false, dist: null };
const ALARM_KM = 1.3; // この距離まで近づいたら通知

// モバイル(特にiOS)では、ユーザー操作中に生成・解錠したAudioContextでないと音が鳴らない。
// アラーム設定ボタンのタップ時にensureAudio()を呼んで解錠し、後で位置情報コールバックから鳴らせるようにする。
let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // iOS解錠: 1サンプルの無音バッファを再生してコンテキストを起動する定番手法
      const src = audioCtx.createBufferSource();
      src.buffer = audioCtx.createBuffer(1, 1, 22050);
      src.connect(audioCtx.destination); src.start(0);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { audioCtx = null; }
  return audioCtx;
}

function beep(times = 4) {
  const ctx = ensureAudio();
  if (!ctx) return;
  for (let i = 0; i < times; i++) {
    const t = i * 0.25;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, ctx.currentTime + t);
    g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.22);
    o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.24);
  }
}

function armAlarm(name) {
  if (!STATIONS[name] || isVirtual(name)) { toast('この駅にはアラームを設定できません'); return; }
  if (!navigator.geolocation) { toast('位置情報が使えない端末です'); return; }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  ensureAudio(); // タップ操作中に音声を解錠(到着時にコールバックから鳴らせるように)
  if (navigator.vibrate) navigator.vibrate(40); // 設定できたことをハプティックで即時フィードバック(iOSは非対応のため無反応)
  alarm.target = { name, lat: STATIONS[name].lat, lng: STATIONS[name].lng };
  alarm.triggered = false; alarm.dist = null;
  store.alarm = name;
  if (alarm.watchId != null) navigator.geolocation.clearWatch(alarm.watchId);
  alarm.watchId = navigator.geolocation.watchPosition(onAlarmPos,
    () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 25000 });
  renderAlarmBar();
  toast(`「${name}」の降車アラームをセットしました`);
}

function onAlarmPos(pos) {
  if (!alarm.target) return;
  alarm.dist = haversine({ lat: pos.coords.latitude, lng: pos.coords.longitude }, alarm.target);
  renderAlarmBar();
  if (alarm.dist <= ALARM_KM && !alarm.triggered) { alarm.triggered = true; fireAlarm(); }
}

function fireAlarm() {
  const n = alarm.target.name;
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]);
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('まもなく到着', { body: `${n} に近づいています。降りる準備をしてください。`, icon: 'icon-192.png' }); } catch {}
  }
  toast(`まもなく「${n}」です！降車準備を`);
  renderAlarmBar();
}

function disarmAlarm() {
  if (alarm.watchId != null) navigator.geolocation.clearWatch(alarm.watchId);
  alarm.watchId = null; alarm.target = null; alarm.triggered = false; alarm.dist = null;
  store.alarm = '';
  renderAlarmBar();
}

function renderAlarmBar() {
  const bar = $('#alarm-bar');
  if (!alarm.target) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const d = alarm.dist;
  const distTxt = d == null ? '位置取得中…' : (d <= ALARM_KM ? 'まもなく到着' : `あと約${d.toFixed(1)}km`);
  bar.className = alarm.triggered ? 'fired' : '';
  bar.innerHTML = `
    <span class="alarm-ico">${alarm.triggered ? '🔔' : '🔕'}</span>
    <span class="alarm-text"><b>${esc(alarm.target.name)}</b>で降車アラーム ・ ${esc(distTxt)}</span>
    <button id="alarm-off" class="alarm-off">解除</button>`;
  $('#alarm-off').addEventListener('click', disarmAlarm);
}

/* ================= 本日のドライブログ(走行記録＋ETC概算) ================= */
const drive = { recording: false, watchId: null, track: [], startTs: 0, dist: 0, hwyDist: 0, hwy: false, lastPt: null, vehicle: 'normal',
  maxSpeed: 0, harsh: 0, lastSpeed: 0, lastSpeedTs: 0, breakAt: 0 };
const BREAK_INTERVAL = 2 * 3600 * 1000; // 2時間ごとに休憩リマインダー
// ETC/高速料金の概算: 本線24.6円/km + ターミナル150円(税込・普通車の目安)。正確値はNEXCO等の有料データが必要
const ETC_RATE = 24.6, ETC_TERMINAL = 150;
const VEHICLE = { light: { label: '軽', f: 0.8 }, normal: { label: '普通車', f: 1.0 }, medium: { label: '中型', f: 1.2 }, large: { label: '大型', f: 1.65 } };

function etcEstimate(hwyKm, vehicle) {
  if (hwyKm <= 0) return 0;
  const f = (VEHICLE[vehicle] || VEHICLE.normal).f;
  return Math.round((Math.ceil(hwyKm) * ETC_RATE + ETC_TERMINAL) * f / 10) * 10;
}

function startDrive() {
  if (!navigator.geolocation) { toast('位置情報が使えない端末です'); return; }
  drive.recording = true; drive.track = []; drive.dist = 0; drive.hwyDist = 0;
  drive.hwy = false; drive.lastPt = null; drive.startTs = Date.now();
  drive.maxSpeed = 0; drive.harsh = 0; drive.lastSpeed = 0; drive.lastSpeedTs = Date.now(); drive.breakAt = Date.now() + BREAK_INTERVAL;
  drive.vehicle = $('#drive-vehicle').value;
  drive.watchId = navigator.geolocation.watchPosition(onDrivePos,
    () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 25000 });
  renderDrivePanel();
  toast('走行ログの記録を開始しました');
}

function onDrivePos(pos) {
  const now = Date.now();
  const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: now, hwy: drive.hwy };
  if (drive.lastPt) {
    const d = haversine(drive.lastPt, p); // km
    if (d > 0.003) { // 3m未満のブレは無視
      drive.dist += d;
      if (drive.hwy) drive.hwyDist += d;
      drive.track.push(p);
      // 速度(km/h)を算出。GPS由来があればそれを優先
      const dtH = Math.max(0.0003, (now - (drive.lastPt.t || now)) / 3600000);
      const spd = pos.coords.speed != null && pos.coords.speed >= 0 ? pos.coords.speed * 3.6 : d / dtH;
      if (spd < 200) { // 異常値は除外
        drive.maxSpeed = Math.max(drive.maxSpeed, spd);
        const dtS = (now - (drive.lastSpeedTs || now)) / 1000;
        if (dtS > 0 && dtS < 6) {
          const accel = (spd - drive.lastSpeed) / dtS; // km/h 毎秒
          if (Math.abs(accel) >= 12) drive.harsh++; // 急加速/急減速
        }
        drive.lastSpeed = spd; drive.lastSpeedTs = now;
      }
      drive.lastPt = p;
    }
  } else {
    drive.lastPt = p; drive.track.push(p);
  }
  // 休憩リマインダー(連続運転2時間ごと)
  if (now >= drive.breakAt) {
    drive.breakAt = now + BREAK_INTERVAL;
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('そろそろ休憩を', { body: '運転を始めて約2時間です。安全のため休憩しましょう。', icon: 'icon-192.png' }); } catch {}
    }
    toast('運転2時間が経過。安全のため休憩を(SA/PAはドライブタブから探せます)');
  }
  renderDrivePanel();
}

// GPS速度・急操作から安全運転スコア(0〜100の目安)を算出
function safetyScore() {
  const hours = Math.max(0.1, (Date.now() - drive.startTs) / 3600000);
  const harshPer = drive.harsh / hours;        // 1時間あたりの急加減速
  const overPenalty = drive.maxSpeed > 120 ? 15 : drive.maxSpeed > 100 ? 8 : 0;
  let s = 100 - harshPer * 4 - overPenalty;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function stopDrive() {
  if (drive.watchId != null) navigator.geolocation.clearWatch(drive.watchId);
  drive.watchId = null; drive.recording = false;
  if (drive.dist >= 0.05) {
    const log = {
      id: Date.now(), ts: drive.startTs, end: Date.now(),
      dist: +drive.dist.toFixed(2), hwyDist: +drive.hwyDist.toFixed(2),
      vehicle: drive.vehicle, etc: etcEstimate(drive.hwyDist, drive.vehicle),
      score: safetyScore(), maxSpeed: Math.round(drive.maxSpeed), harsh: drive.harsh,
      track: decimate(drive.track, 200)
    };
    store.driveLogs = [log, ...store.driveLogs].slice(0, 50);
    toast(`記録を保存しました(${log.dist.toFixed(1)}km・ETC概算${yen(log.etc)})`);
  } else {
    toast('記録を終了しました(距離が短いため保存しませんでした)');
  }
  drive.track = []; drive.dist = 0; drive.hwyDist = 0; drive.lastPt = null;
  renderDrivePanel(); renderDriveLogs();
}

function decimate(arr, max) {
  if (arr.length <= max) return arr.map(p => [+p.lat.toFixed(5), +p.lng.toFixed(5)]);
  const step = Math.ceil(arr.length / max), out = [];
  for (let i = 0; i < arr.length; i += step) out.push([+arr[i].lat.toFixed(5), +arr[i].lng.toFixed(5)]);
  return out;
}

function fmtDur2(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60}分`;
}

function renderDrivePanel() {
  const stats = $('#drive-stats');
  if (!stats) return;
  const dur = drive.recording ? Date.now() - drive.startTs : 0;
  const etc = etcEstimate(drive.hwyDist, drive.vehicle);
  stats.innerHTML = `
    <div class="ds-item"><span class="ds-v">${drive.dist.toFixed(1)}</span><span class="ds-l">km 走行</span></div>
    <div class="ds-item"><span class="ds-v">${drive.hwyDist.toFixed(1)}</span><span class="ds-l">km 高速</span></div>
    <div class="ds-item"><span class="ds-v">${drive.recording ? fmtDur2(dur) : '—'}</span><span class="ds-l">経過</span></div>
    <div class="ds-item etc"><span class="ds-v">${yen(etc)}</span><span class="ds-l">ETC概算</span></div>`;
  const tg = $('#drive-toggle');
  if (tg) { tg.textContent = drive.recording ? '記録を停止' : '記録を開始'; tg.classList.toggle('rec', drive.recording); }
  const hb = $('#drive-hwy');
  if (hb) { hb.textContent = '高速 ' + (drive.hwy ? 'ON' : 'OFF'); hb.classList.toggle('on', drive.hwy); }
}

function renderDriveLogs() {
  const el = $('#drive-logs');
  if (!el) return;
  const logs = store.driveLogs;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todays = logs.filter(l => l.ts >= today.getTime());
  const sumDist = todays.reduce((s, l) => s + l.dist, 0);
  const sumEtc = todays.reduce((s, l) => s + l.etc, 0);
  let html = '';
  if (todays.length) {
    html += `<div class="drive-total">本日の合計: <b>${sumDist.toFixed(1)}km</b> ・ ETC概算 <b>${yen(sumEtc)}</b>(${todays.length}件)</div>`;
  }
  if (!logs.length) {
    html += '<p class="card-sub" style="margin:8px 0 0">記録はまだありません。「記録を開始」で本日の走行を残せます。</p>';
  } else {
    html += logs.slice(0, 10).map(l => {
      const d = new Date(l.ts);
      const sc = l.score != null
        ? `<span class="dl-score ${l.score >= 80 ? 'good' : l.score >= 60 ? 'mid' : 'bad'}">安全運転 ${l.score}点</span>` : '';
      return `<div class="drive-log" data-id="${l.id}">
        <div class="dl-body">
          <div class="dl-head">${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d.getHours() * 60 + d.getMinutes())} ・ ${(VEHICLE[l.vehicle] || VEHICLE.normal).label} ${sc}</div>
          <div class="dl-meta">${l.dist.toFixed(1)}km(高速${l.hwyDist.toFixed(1)}km) ・ ${fmtDur2(l.end - l.ts)} ・ ETC概算 ${yen(l.etc)}</div>
        </div>
        <button class="dl-map" data-id="${l.id}">地図</button>
        <button class="dl-del" data-id="${l.id}">削除</button>
      </div>`;
    }).join('');
  }
  el.innerHTML = html;
  $$('#drive-logs .dl-del').forEach(b => b.addEventListener('click', () => {
    store.driveLogs = store.driveLogs.filter(x => String(x.id) !== b.dataset.id);
    renderDriveLogs();
  }));
  $$('#drive-logs .dl-map').forEach(b => b.addEventListener('click', () => {
    const log = store.driveLogs.find(x => String(x.id) === b.dataset.id);
    if (log) showDriveTrack(log.track);
  }));
}

function showDriveTrack(track) {
  if (!track || !track.length) { toast('この記録には経路データがありません'); return; }
  switchTab('map');
  ensureMap();
  routeGroup.clearLayers();
  L.polyline(track, { color: '#1668b3', weight: 6, opacity: .9 }).addTo(routeGroup);
  L.circleMarker(track[0], { radius: 8, color: '#fff', weight: 2.5, fillColor: '#067a46', fillOpacity: 1 }).addTo(routeGroup);
  L.circleMarker(track[track.length - 1], { radius: 8, color: '#fff', weight: 2.5, fillColor: '#d92638', fillOpacity: 1 }).addTo(routeGroup);
  fitMap(L.latLngBounds(track));
  $('#map-route-info').innerHTML = '走行ログを表示中';
  $('#map-route-info').classList.remove('hidden');
}

/* ===== 駐車位置メモ ===== */
function saveParked() {
  if (!navigator.geolocation) { toast('位置情報が使えない端末です'); return; }
  toast('現在地を取得中…');
  navigator.geolocation.getCurrentPosition(pos => {
    store.parked = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };
    renderParkStatus();
    toast('駐車位置を保存しました');
  }, () => toast('位置情報を取得できませんでした。許可設定を確認してください'),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 });
}

function renderParkStatus() {
  const el = $('#park-status');
  if (!el) return;
  const p = store.parked;
  if (!p) { el.innerHTML = '<p class="card-sub" style="margin:0 0 10px">保存された駐車位置はありません。</p>'; return; }
  const d = new Date(p.ts);
  const gmap = `https://www.google.com/maps/dir/?api=1&destination=${p.lat.toFixed(6)},${p.lng.toFixed(6)}&travelmode=walking`;
  el.innerHTML = `
    <div class="park-saved">
      <div>📍 ${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d.getHours() * 60 + d.getMinutes())} に保存</div>
      <div class="park-acts">
        <button class="secondary-btn" id="park-map">地図で見る</button>
        <a class="gmap-btn" href="${gmap}" target="_blank" rel="noopener">歩いて戻る(Google)</a>
        <button class="secondary-btn" id="park-clear">クリア</button>
      </div>
    </div>`;
  $('#park-map').addEventListener('click', () => {
    switchTab('map'); ensureMap();
    routeGroup.clearLayers();
    L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'pk-pin', html: 'P', iconSize: [24, 24] }) })
      .addTo(routeGroup).bindPopup('駐車位置').openPopup();
    map.setView([p.lat, p.lng], 17);
    setTimeout(() => map.invalidateSize(), 60);
  });
  $('#park-clear').addEventListener('click', () => { store.parked = null; renderParkStatus(); toast('駐車位置をクリアしました'); });
}

/* ===== 休憩できる場所(SA/PA・道の駅)= OpenStreetMap Overpass ===== */
async function showRestSpots() {
  switchTab('map'); ensureMap();
  const c = map.getCenter();
  toast('休憩できる場所を検索中…');
  const q = `[out:json][timeout:20];(node["highway"="services"](around:8000,${c.lat},${c.lng});way["highway"="services"](around:8000,${c.lat},${c.lng});node["highway"="rest_area"](around:8000,${c.lat},${c.lng});way["highway"="rest_area"](around:8000,${c.lat},${c.lng});node["amenity"="parking"]["name"~"道の駅"](around:8000,${c.lat},${c.lng}););out center 60;`;
  let data = null;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
    if (res.ok) data = await res.json();
  } catch {}
  if (!data) { toast('休憩スポットを取得できませんでした'); return; }
  if (parkingLayer) map.removeLayer(parkingLayer);
  parkingLayer = L.layerGroup().addTo(map);
  const spots = (data.elements || []).map(e => {
    const t = e.tags || {};
    const pt = e.type === 'node' ? { lat: e.lat, lng: e.lon } : (e.center ? { lat: e.center.lat, lng: e.center.lon } : null);
    return pt ? { lat: pt.lat, lng: pt.lng, name: t.name || (t.highway === 'services' ? 'SA/PA' : t.highway === 'rest_area' ? 'PA・休憩所' : '休憩スポット') } : null;
  }).filter(Boolean);
  for (const s of spots) {
    const gnav = `https://www.google.com/maps/dir/?api=1&destination=${s.lat.toFixed(6)},${s.lng.toFixed(6)}&travelmode=driving`;
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: 'rest-pin', html: '☕', iconSize: [24, 24] }) })
      .addTo(parkingLayer)
      .bindPopup(`<b>${esc(s.name)}</b><br>約${(haversine(c, s) * 1000).toFixed(0)}m<br><a href="${gnav}" target="_blank" rel="noopener">ここへナビ</a>`);
  }
  const leg = $('#parking-legend');
  leg.classList.remove('hidden');
  leg.innerHTML = `<span>☕ 休憩できる場所 ${spots.length}件</span><span class="src">SA/PA・休憩所(OpenStreetMap)</span><button id="pk-clear">×</button>`;
  $('#pk-clear').addEventListener('click', clearParking);
  toast(spots.length ? `休憩できる場所 ${spots.length}件を表示` : '近くにSA/PA等が見つかりませんでした');
}

/* ================= 住所・地名のジオコーディング(OpenStreetMap Nominatim・無料) ================= */
const geocodeCache = {};
async function geocode(query) {
  if (geocodeCache[query]) return geocodeCache[query];
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ja&countrycodes=jp&q='
    + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!arr.length) return null;
    const hit = { lat: +arr[0].lat, lng: +arr[0].lon, label: arr[0].display_name };
    geocodeCache[query] = hit;
    return hit;
  } catch { return null; }
}

/* ================= 検索実行 ================= */
// 各入力を「収録駅名」または「仮想地点名」に解決する。
// 駅でも別名でもなければ住所としてジオコーディングし、最寄り駅へ徒歩接続する。
async function resolvePoints() {
  const raw = [
    $('#input-origin').value.trim(),
    ...$$('.via-input').map(i => i.value.trim()).filter(Boolean),
    $('#input-dest').value.trim()
  ];
  if (!raw[0] || !raw[raw.length - 1]) { toast('出発地と目的地を入力してください'); return null; }

  const nodes = [];
  for (const r of raw) {
    if (r === '現在地') {
      if (!STATIONS['現在地']) {
        toast('現在地を取得しています…');
        try { await locate(); } catch { toast('位置情報を取得できませんでした。許可設定を確認してください'); return null; }
      }
      nodes.push('現在地');
      continue;
    }
    const alias = resolveAlias(r);
    if (STATIONS[alias] && !isVirtual(alias)) { nodes.push(alias); continue; } // 収録駅
    if (isVirtual(r)) { nodes.push(r); continue; }                              // 取得済みの住所
    // 住所・地名としてジオコーディング
    toast(`「${r}」を住所検索しています…`);
    const hit = await geocode(r);
    if (!hit) { toast(`「${r}」が見つかりませんでした。駅名・住所・施設名で入力してください`); return null; }
    setVirtual(r, { lat: hit.lat, lng: hit.lng });
    const near = nearestStations(hit, 1, 9999)[0];
    if (!near || near.km > 6) {
      toast(`「${r}」付近に収録駅がありません(最寄りまで約${near ? near.km.toFixed(1) : '?'}km)`);
      delete VIRTUAL[r]; delete STATIONS[r];
      return null;
    }
    nodes.push(r);
  }
  const points = nodes.filter((n, i) => i === 0 || n !== nodes[i - 1]); // 連続重複を除去
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
  await loadFeedDelays(); // 自動取得済みの遅延(バックアップ)を最新化
  const points = await resolvePoints();
  if (!points) return;
  recordHistory(points); // 検索履歴に記録
  try {
    localStorage.setItem('nn_lastinputs', JSON.stringify({
      origin: $('#input-origin').value.trim(),
      dest: $('#input-dest').value.trim(),
      vias: $$('.via-input').map(i => i.value.trim()).filter(Boolean),
      mode: state.mode
    }));
  } catch {}
  const baseMin = baseMinutes();
  const dateStr = $('#input-date').value;
  state.lastSearch = { points, mode: state.mode, baseMin, timeType: state.timeType, dateStr };

  if (state.mode === 'train') {
    const routes = searchTrainRoutes(points, baseMin, state.timeType, store.pass);
    if (!routes.length) {
      const late = state.timeType === 'dep' && (todOf(baseMin) > 30 && todOf(baseMin) < 300);
      toast(late
        ? '指定時刻は運行時間外(終電後〜始発前)です。始発は約5:00です'
        : '終電後・運転見合わせなどにより、その時刻に成立する経路が見つかりませんでした');
      return;
    }
    state.routes = routes;
    state.pathResult = null;
    renderResults();
  } else if (state.mode === 'bus') {
    state.pathResult = null;
    state.routes = [];
    renderResults();
  } else {
    state.pathResult = searchPathRoute(points, state.mode, baseMin, state.timeType);
    state.routes = [];
    renderResults();
  }
  showScreen('results');
}

/* 遅延時の迂回提案: 遅延路線を含む経路と、遅延なしの代替を比較 */
function rerouteSuggestion() {
  const routes = state.routes;
  if (!routes || routes.length < 2) return null;
  // 遅延している路線とその分数を集める
  const delayInfo = {};
  for (const r of routes) for (const l of r.legs) if (l.delay > 0) delayInfo[l.lineId] = l.delay;
  if (!Object.keys(delayInfo).length) return null;
  // 遅延路線を一切使わない代替(到着が早い順で先頭)
  const free = routes.filter(r => r.legs.every(l => !(l.delay > 0)));
  if (!free.length) return null;
  const alt = free[0];
  // 遅延路線を使う経路が存在し、かつ代替の方が同等以上に早いときだけ提案
  const usesDelayed = routes.some(r => r.legs.some(l => l.delay > 0));
  if (!usesDelayed) return null;
  const altFirst = alt.legs.find(l => l.lineId !== 'WALK');
  const delayText = Object.entries(delayInfo).map(([id, m]) => `${lineById(id).short}+${m}分`).join('・');
  return { alt, delayText, altLabel: altFirst ? lineById(altFirst.lineId).short : '徒歩' };
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
  // 発車標は電車専用なので、リスト/発車標の切替は電車のときだけ表示
  $('#view-seg').classList.toggle('hidden', mode !== 'train');
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
  if (mode === 'train' && state.routes.length && state.routes.every(r => r.bumped)) {
    banners.push(`<div class="banner info">${infoSvg()}<span>指定時刻は運行時間外(終電後〜始発前)のため、始発(約5:00)以降の電車を表示しています</span></div>`);
  }
  const autoEntries = Object.values(autoDelayEntries());
  if (mode === 'train' && autoEntries.length) {
    const txt = autoEntries.map(d => `${lineById(d.lineId).short}+${d.min}分`).join('・');
    banners.push(`<div class="banner warn">${warnSvg()}<span>JR西日本の最新運行情報: ${esc(txt)} を所要時間に反映しています</span></div>`);
  }
  // 遅延時の迂回提案: 遅延路線を使う経路があり、遅延の無い代替が存在するとき
  const reroute = mode === 'train' ? rerouteSuggestion() : null;
  if (reroute) {
    banners.push(`<div class="banner warn reroute-banner" id="reroute-banner">${warnSvg()}<span>${esc(reroute.delayText)}が遅延中。<b>${esc(reroute.altLabel)}経由</b>なら遅延の影響が少なめです(到着 ${fmtTime(reroute.alt.arr)})<br><u>この迂回ルートを見る ›</u></span></div>`);
  }
  if (mode === 'train' && !banners.length) {
    banners.push(`<div class="banner info">${infoSvg()}<span>運賃は通常運賃を表示しています(きっぷ/IC)</span></div>`);
  }
  bannerEl.innerHTML = banners.join('');
  if (reroute) {
    const rb = $('#reroute-banner');
    if (rb) rb.addEventListener('click', () => {
      state.current = reroute.alt;
      renderDetail();
      showScreen('detail');
    });
  }

  const list = $('#results-list');
  if (mode === 'bus') { stopApproach(); list.className = ''; renderBusCard(list); return; }
  if (mode !== 'train') { stopApproach(); list.className = ''; renderPathCard(list); return; }

  if (state.resultView === 'board') { renderResultsBoard(list); return; }
  stopApproach();
  list.className = '';

  const congestionLabel = ['空いています', '普通', '混雑'];
  list.innerHTML = state.routes.map((r, idx) => {
    const tags = [];
    if (r.passName && r.legs.some(l => l.passFree)) tags.push(`<span class="tag pass">${esc(r.passName)}</span>`);
    for (const [cls, label] of r.badges) tags.push(`<span class="tag ${cls}">${label}</span>`);
    if (r.delayTotal) tags.push(`<span class="tag delay">遅延 +${r.delayTotal}分</span>`);
    const chips = r.legs.filter(l => l.lineId !== 'WALK').map(l => {
      const line = lineById(l.lineId);
      return `<span class="route-line-chip" style="background:${line.color}22;color:${line.color}"><i style="background:${line.color}"></i>${esc(line.short)}</span>`;
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

/* ===== 発車標(電光掲示板)ビュー ===== */
let approachTimer = null;
function stopApproach() { if (approachTimer) { clearInterval(approachTimer); approachTimer = null; } }

// 路線略称から発車標の種別色を決める(JR系は路線色、私鉄/メトロも路線色を使用)
function boardDest(r) {
  const firstRide = r.legs.find(l => l.lineId !== 'WALK');
  return firstRide ? legDirection(firstRide).replace(/方面$/, '') : state.lastSearch.points[state.lastSearch.points.length - 1];
}

function renderResultsBoard(list) {
  list.className = 'is-board';
  const origin = state.lastSearch.points[0];
  // 実時刻表(REAL_TIMETABLES)があれば発車時刻・行先・種別を実際のダイヤに補正
  // cursorで同じ時刻表上の同一発車が複数ルートに重複して割り当たらないようにする
  const cursor = new Map();
  const realInfo = state.routes.map(r => applyRealTimetable(r, origin, state.lastSearch.dateStr, cursor));
  const realCount = realInfo.filter(Boolean).length;

  // 補正後の発車時刻順に並べ替えて発車順(次発/次々発/…)を割り直す
  const order = state.routes
    .map((_, idx) => idx)
    .sort((a, b) => state.routes[a].legs[0].depTime - state.routes[b].legs[0].depTime);

  const rowData = order.map(idx => {
    const r = state.routes[idx];
    const firstRide = r.legs.find(l => l.lineId !== 'WALK');
    const line = firstRide ? lineById(firstRide.lineId) : null;
    const plat = firstRide ? (hashStr(firstRide.lineId + firstRide.stations[0]) % 11) + 1 : '-';
    const real = realInfo[idx];
    const typeLabel = real ? real.type : (line ? line.short : '徒歩');
    const destLabel = (real ? real.dest : boardDest(r)).replace(/行$/, '');
    return { idx, r, line, plat, typeLabel, destLabel };
  });

  const rows = rowData.map(({ idx, r, line, plat, typeLabel, destLabel }, i) => {
    const order = i === 0 ? '次発' : i === 1 ? '次々発' : `${i + 1}本目`;
    const delayTag = r.delayTotal ? `<span class="bd-delay">遅延+${r.delayTotal}</span>` : '';
    return `
    <div class="bd-row" data-idx="${idx}">
      <span class="bd-order">${order}</span>
      <span class="bd-plat">${plat}</span>
      <span class="bd-time">${fmtTime(r.legs[0].depTime)}</span>
      <span class="bd-type" style="background:${line ? line.color : '#555'}">${esc(typeLabel)}</span>
      <span class="bd-dest">${esc(destLabel)}行${delayTag}</span>
    </div>`;
  }).join('');

  const note = realCount === 0
    ? '※時刻は計算値の目安です。正確な発車時刻は各駅の公式時刻表をご確認ください。'
    : realCount === state.routes.length
      ? '※発車時刻・行先・種別は公式時刻表に基づく実際のダイヤです。'
      : '※公式時刻表に対応した路線は実際の発車時刻です。その他の路線の時刻は計算値の目安です。';

  list.innerHTML = `
    <div class="depboard">
      <div class="depboard-head">
        <span class="bd-station">${esc(origin)}</span>
        <span class="bd-clock" id="bd-clock"></span>
      </div>
      <div class="dep-approach" id="dep-approach"></div>
      <div class="depboard-cols">
        <span class="c-order">発車順</span><span class="c-plat">のりば</span><span class="c-time">発車時刻</span><span class="c-type">種別</span><span class="c-dest">行先</span>
      </div>
      <div class="depboard-rows">${rows}</div>
      <div class="depboard-note">${note}</div>
    </div>`;

  $$('#results-list .bd-row').forEach(row => row.addEventListener('click', () => {
    state.current = state.routes[Number(row.dataset.idx)];
    renderDetail();
    showScreen('detail');
  }));

  startApproach(rowData[0]);
}

function startApproach(soon) {
  stopApproach();
  // 検索基準時刻(state.lastSearch.baseMin)を起点に、実時間の経過分だけ進める「シミュレート時刻」
  const baseMin = state.lastSearch.baseMin;
  const startRealMs = Date.now();
  const tick = () => {
    const el = $('#dep-approach');
    const clk = $('#bd-clock');
    if (!el) { stopApproach(); return; }
    const now = baseMin + (Date.now() - startRealMs) / 60000;
    if (clk) clk.textContent = fmtTime(now);
    const dep = soon.r.legs[0].depTime;
    const mins = dep - now;
    const line = soon.line || { color: '#7FBE26' };
    const clamped = Math.max(0, Math.min(12, mins));
    const leftPct = 6 + (1 - clamped / 12) * 82; // 12分前=左端 → 0分=駅(右)
    let label, near = false;
    if (mins <= 0) label = 'まもなく発車 / 発車しました';
    else if (mins < 1.2) { label = 'まもなく到着・発車'; near = true; }
    else label = `次発まで 約${Math.ceil(mins)}分`;
    el.innerHTML = `
      <div class="appr-track ${near ? 'near' : ''}">
        <span class="appr-rail"></span>
        <span class="appr-home"></span>
        <span class="appr-train" style="left:${leftPct}%;color:${line.color}">
          <svg viewBox="0 0 48 24" width="48" height="24" aria-hidden="true">
            <path d="M5 5h31c3.4 0 5.4 1.6 7.2 4.3l2 3c.9 1.4.3 3.2-1.3 3.2H5c-1.7 0-3-1.3-3-3V8c0-1.7 1.3-3 3-3z" fill="currentColor"/>
            <path d="M37 6.2c2.4.3 3.9 1.7 5.4 3.9l1 1.6h-6.4z" fill="#0a1020" opacity=".5"/>
            <g fill="#0a1020" opacity=".5"><rect x="6" y="7" width="5.2" height="4.6" rx="1"/><rect x="13.4" y="7" width="5.2" height="4.6" rx="1"/><rect x="20.8" y="7" width="5.2" height="4.6" rx="1"/><rect x="28.2" y="7" width="5.2" height="4.6" rx="1"/></g>
            <rect x="3.5" y="13.2" width="40" height="1.6" fill="#fff" opacity=".55"/>
            <circle cx="44" cy="13.5" r="1.1" fill="#fff"/>
            <circle cx="12" cy="18.4" r="2.1" fill="#0a1020"/><circle cx="34" cy="18.4" r="2.1" fill="#0a1020"/>
          </svg>
        </span>
      </div>
      <div class="appr-label ${near ? 'near' : ''}">${esc(soon.typeLabel)} ${esc(soon.destLabel)}行 ・ ${label}</div>`;
  };
  tick();
  approachTimer = setInterval(tick, 3000);
}

function renderPathCard(list) {
  const p = state.pathResult;
  const isCar = p.mode === 'car';
  const label = isCar ? '自動車' : p.mode === 'bike' ? '自転車' : '徒歩';
  const cost = isCar
    ? `<span>燃料 約${yen(p.fuel)}</span>`
    : `<span>消費 約${p.kcal}kcal</span><span class="route-fare">¥0</span>`;
  list.innerHTML = `
    <div class="route-card" style="cursor:default">
      <div class="route-tags"><span class="tag ${isCar ? 'cheap' : 'easy'}">${label}ルート</span></div>
      <div class="route-time-row">
        <span class="route-time">${fmtTime(p.dep)}</span>
        <span class="route-arrow">→</span>
        <span class="route-time arr">${fmtTime(p.arr)}</span>
      </div>
      <div class="route-meta">
        <span>所要 ${fmtDur(p.min)}</span>
        <span>約${p.km.toFixed(1)}km</span>
        ${cost}
      </div>
      <div class="route-lines">
        ${p.points.map(esc).join(' <span style="color:#b9c6ba;font-weight:800">›</span> ')}
      </div>
      <div class="detail-actions" style="margin-top:12px">
        <button class="secondary-btn" id="btn-path-map">地図で確認</button>
        <button class="gmap-btn" id="btn-path-gmap">Googleマップで開く</button>
      </div>
      ${isCar ? `<div class="detail-actions" style="margin-top:8px">
        <button class="secondary-btn" id="btn-car-park">目的地周辺の駐車場</button>
        <button class="secondary-btn" id="btn-car-drive">ドライブログを記録</button>
      </div>` : ''}
      <p class="demo-note" style="margin-top:8px">※距離・時間・${isCar ? '燃料' : 'カロリー'}は直線距離×概算係数による目安です。${isCar ? '実際の道路ルート・有料道路はGoogleマップでご確認ください。' : '実際のルートはGoogleマップでご確認ください。'}</p>
    </div>`;
  $('#btn-path-map').addEventListener('click', () => { switchTab('map'); showPathOnMap(p); });
  $('#btn-path-gmap').addEventListener('click', openGmaps);
  if (isCar) {
    $('#btn-car-park').addEventListener('click', () => {
      const dest = p.points[p.points.length - 1];
      const c = STATIONS[dest];
      switchTab('map');
      if (c) { ensureMap(); map.setView([c.lat, c.lng], 15); }
      setTimeout(() => toggleParking(), 300);
    });
    $('#btn-car-drive').addEventListener('click', () => switchTab('menu'));
  }
}

/* 三宮発バス時刻表(発車標)。BUS_TIMETABLESに登録された主要路線の次発を表示 */
function renderBusBoard(origin) {
  const services = (typeof BUS_TIMETABLES !== 'undefined') && BUS_TIMETABLES[origin];
  if (!services || !services.length) return '';
  const dayType = realDayType(state.lastSearch.dateStr);
  const ref = todOf(state.lastSearch.baseMin);
  const rows = services.map(svc => {
    const list = svc.times[dayType] || svc.times.weekday;
    const up = list.filter(t => t >= ref);
    const label = svc.name + (svc.dir ? `〔${svc.dir}〕` : '');
    let timesHtml;
    if (up.length) {
      const wait = Math.max(0, Math.ceil(up[0] - ref));
      const more = up.slice(1, 3).map(t => fmtTime(t)).join(' / ');
      timesHtml = `<div class="busb-next"><b>${fmtTime(up[0])}</b><span class="busb-soon">約${wait}分後</span></div>`
        + (more ? `<div class="busb-more">次以降 ${more}</div>` : '');
    } else {
      timesHtml = `<div class="busb-end">本日の運行は終了(始発 ${fmtTime(list[0])})</div>`;
    }
    return `
      <div class="busb-row">
        <div class="busb-head">
          <span class="busb-chip" style="background:${svc.color}">${esc(label)}</span>
          <span class="busb-dest">${esc(svc.dest)}</span>
        </div>
        <div class="busb-stop">のりば: ${esc(svc.stop)} ・ ${esc(svc.operator)}</div>
        ${timesHtml}
      </div>`;
  }).join('');
  return `
    <div class="route-card busboard" style="cursor:default">
      <div class="busb-title">🚌 ${esc(origin)}発 バス時刻表 <span class="busb-day">${dayType === 'holiday' ? '土日祝' : '平日'}ダイヤ</span></div>
      ${rows}
      <p class="demo-note" style="margin-top:8px">※神姫バス・阪急/阪神バス公式時刻表に基づく実際の発車時刻です(三宮発の主要路線のみ)。経路全体はGoogleマップでご確認ください。</p>
    </div>`;
}

/* バス: 経路検索データは無いためGoogle連携＋近隣バス停。三宮発は上に実時刻表を表示 */
function renderBusCard(list) {
  const pts = state.lastSearch.points;
  list.innerHTML = renderBusBoard(pts[0]) + `
    <div class="route-card" style="cursor:default">
      <div class="route-tags"><span class="tag" style="background:#1ba5a5">バス</span></div>
      <p style="font-size:13.5px;font-weight:700;line-height:1.6;margin:4px 0 10px">
        ${esc(pts[0])} → ${esc(pts[pts.length - 1])}<br>
        <span style="color:var(--ink-soft);font-size:12.5px;font-weight:600">バスの路線・時刻表データは無料で入手できないため、アプリ内ではバス経路を計算できません。Googleマップのバス経路でご確認ください。</span>
      </p>
      <div class="detail-actions">
        <button class="gmap-btn" id="btn-bus-gmap" style="flex:1">Googleマップでバス経路を見る</button>
      </div>
      <button class="secondary-btn" id="btn-bus-stops" style="width:100%;margin-top:8px">周辺のバス停を地図で見る</button>
      <p class="demo-note" style="margin-top:8px">※バス停の位置はOpenStreetMapの実データ、経路・時刻はGoogleマップ連携です。</p>
    </div>`;
  $('#btn-bus-gmap').addEventListener('click', openGmaps);
  $('#btn-bus-stops').addEventListener('click', () => {
    const o = STATIONS[pts[0]];
    switchTab('map');
    if (o) { ensureMap(); map.setView([o.lat, o.lng], 15); }
    setTimeout(() => showBusStops(o), 300);
  });
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
    <div class="detail-step">
      <button class="step-btn" id="step-prev">‹ 前の一本</button>
      <span class="step-label">この経路</span>
      <button class="step-btn" id="step-next">次の一本 ›</button>
    </div>
    <div class="detail-sum-card">
      <div class="detail-sum-time">${fmtTime(headDep)} → ${fmtTime(r.arr)}</div>
      <div class="detail-sum-meta">
        <span>所要 <b>${fmtDur(r.arr - headDep)}</b></span>
        <span>乗換 <b>${r.transfers}</b>回</span>
        <span>${r.fare.ticket === 0 ? 'フリーパス適用 ¥0' : 'IC <b>' + yen(r.fare.ic) + '</b>'}</span>
      </div>
    </div>`;
  $('#step-prev').addEventListener('click', () => stepRoute(-1));
  $('#step-next').addEventListener('click', () => stepRoute(1));

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
      const wait = Math.max(0, leg.depTime - prevArr);
      // 電車→電車の乗り換えのときだけ「のりかえ◯分」を表示(徒歩連絡は除く)
      const isTransfer = r.legs[i - 1].lineId !== 'WALK' && leg.lineId !== 'WALK';
      rows.push(stationRow(stName, cls, fmtTime(prevArr), `発 ${fmtTime(leg.depTime)}`,
        { via: vias.has(stName), transfer: isTransfer ? wait : null }));
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

function stationRow(name, cls, time, sub, opts) {
  opts = opts || {};
  const tags = [];
  if (opts.via) tags.push('<small>経由</small>');
  if (opts.transfer != null) tags.push(`<small class="tl-transfer">のりかえ${opts.transfer}分</small>`);
  return `
    <div class="tl-station ${cls || ''}">
      <div class="tl-time">${time}<small>${esc(sub)}</small></div>
      <div class="tl-node"></div>
      <div class="tl-name">${esc(name)}${tags.join('')}</div>
    </div>`;
}

/* ================= 地図(Leaflet) ================= */
let map = null, routeGroup = null;

// 地図タイルは国土地理院(地理院タイル)を使用(無料・公式・日本特化)。
// OSM公開タイルサーバの直叩きは利用規約上ヘビーユース不可のため避ける。
const GSI_STYLES = {
  pale:  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png' },
  std:   { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png' },
  photo: { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg' },
  dark:  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', invert: true }
};
let baseTile = null;
function setMapStyle(style) {
  if (!map) return;
  const conf = GSI_STYLES[style] || GSI_STYLES.pale;
  if (baseTile) map.removeLayer(baseTile);
  baseTile = L.tileLayer(conf.url, {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル(国土地理院)</a>',
    maxZoom: 18
  }).addTo(map);
  baseTile.bringToBack();
  document.querySelector('#map').classList.toggle('map-dark', !!conf.invert);
  store.mapStyle = style;
  const sel = $('#map-style'); if (sel) sel.value = style;
}

function ensureMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false }).setView([34.70, 135.50], 11);
  setMapStyle(store.mapStyle);
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

/* ===== 地図の現在地ボタン ===== */
let locLayer = null;
async function locateOnMap() {
  const btn = $('#btn-locate');
  if (btn) btn.classList.add('loading');
  toast('現在地を取得中…');
  try { await locate(); } catch { toast('位置情報を取得できませんでした。許可設定を確認してください'); if (btn) btn.classList.remove('loading'); return; }
  ensureMap();
  const pt = STATIONS['現在地'];
  if (locLayer) map.removeLayer(locLayer);
  locLayer = L.layerGroup([
    L.circleMarker([pt.lat, pt.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#1668b3', fillOpacity: 1 }),
    L.circle([pt.lat, pt.lng], { radius: 120, color: '#1668b3', weight: 1, fillColor: '#1668b3', fillOpacity: .12 })
  ]).addTo(map);
  map.setView([pt.lat, pt.lng], 15);
  setTimeout(() => map.invalidateSize(), 60);
  const near = nearestStations(pt, 1, 9999)[0];
  if (btn) btn.classList.remove('loading');
  toast(near ? `現在地を表示(最寄り: ${near.name} 約${(near.km * 1.25).toFixed(1)}km)` : '現在地を表示しました');
}

/* ===== 地図に運行状況を色分け表示 ===== */
let railStatusLayer = null;
let railStatusOn = false;

function lineStatus(lineId) {
  const dmap = delayMap();
  const d = dmap[lineId];
  if (d && d.min === 'suspend') return { kind: 'suspend', label: '運転見合わせ', color: '#d0021b' };
  if (d && Number(d.min) > 0) return { kind: 'delay', label: `遅延 +${d.min}分`, color: '#f5a623' };
  return { kind: 'normal', label: '平常運転', color: null };
}

async function toggleRailStatus() {
  railStatusOn = !railStatusOn;
  $('#btn-rail-status').classList.toggle('on', railStatusOn);
  if (!railStatusOn) {
    if (railStatusLayer) { map.removeLayer(railStatusLayer); railStatusLayer = null; }
    $('#rail-legend').classList.add('hidden');
    return;
  }
  ensureMap();
  toast('運行状況を取得中…');
  await fetchLiveJRDelays().catch(() => {});
  await loadFeedDelays().catch(() => {});
  drawRailStatus();
}

function drawRailStatus() {
  if (!railStatusOn) return;
  ensureMap();
  if (railStatusLayer) map.removeLayer(railStatusLayer);
  railStatusLayer = L.layerGroup().addTo(map);
  let nDelay = 0, nSuspend = 0;
  for (const line of LINES) {
    const st = lineStatus(line.id);
    if (st.kind === 'normal') continue; // 異常のある路線のみ強調
    const pts = line.stations.filter(n => STATIONS[n]).map(n => [STATIONS[n].lat, STATIONS[n].lng]);
    if (line.loop && pts.length) pts.push(pts[0]);
    const opts = st.kind === 'suspend'
      ? { color: st.color, weight: 6, opacity: .95, dashArray: '10 8' }
      : { color: st.color, weight: 6, opacity: .95 };
    const pl = L.polyline(pts, opts).addTo(railStatusLayer);
    pl.bindTooltip(`${line.name}: ${st.label}`, { sticky: true, className: 'map-label' });
    if (st.kind === 'suspend') nSuspend++; else nDelay++;
  }
  const leg = $('#rail-legend');
  leg.classList.remove('hidden');
  if (!nDelay && !nSuspend) {
    leg.innerHTML = '<span class="ok">✓ 収録路線に運休・遅延はありません(JRは実データ)</span>';
  } else {
    leg.innerHTML =
      (nSuspend ? '<span><i style="background:#d0021b"></i>運転見合わせ ' + nSuspend + '</span>' : '') +
      (nDelay ? '<span><i style="background:#f5a623"></i>遅延 ' + nDelay + '</span>' : '') +
      '<span class="src">JRは実データ・他社は手動登録</span>';
  }
}

/* ===== 近隣駐車場(OpenStreetMap Overpass・無料/合法/キー不要) ===== */
let parkingLayer = null;
let parkingOn = false;

async function fetchParking(lat, lng, radius) {
  const q = `[out:json][timeout:20];(node["amenity"="parking"](around:${radius},${lat},${lng});way["amenity"="parking"](around:${radius},${lat},${lng}););out center 80;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(q)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.elements || []).map(e => {
      const t = e.tags || {};
      const p = e.type === 'node' ? { lat: e.lat, lng: e.lon } : (e.center ? { lat: e.center.lat, lng: e.center.lon } : null);
      if (!p) return null;
      return {
        lat: p.lat, lng: p.lng,
        name: t.name || (t.parking === 'multi-storey' ? '立体駐車場' : t.parking === 'underground' ? '地下駐車場' : '駐車場'),
        cap: t.capacity || null,
        fee: t.fee === 'no' ? '無料' : (t.fee === 'yes' || t.charge ? '有料' : null),
        charge: t.charge || null,
        access: t.access || null
      };
    }).filter(Boolean);
  } catch { return null; }
}

async function toggleParking() {
  ensureMap();
  parkingOn = true;
  $('#btn-parking').classList.add('loading');
  toast('周辺の駐車場を検索中…');
  const c = map.getCenter();
  const list = await fetchParking(c.lat, c.lng, 800);
  $('#btn-parking').classList.remove('loading');
  if (!list) { toast('駐車場情報を取得できませんでした(時間をおいて再試行)'); return; }
  $('#btn-parking').classList.add('on');
  drawParking(list, c);
}

function clearParking() {
  parkingOn = false;
  if (parkingLayer) { map.removeLayer(parkingLayer); parkingLayer = null; }
  $('#parking-legend').classList.add('hidden');
  $('#parking-panel').classList.add('hidden');
  $('#btn-parking').classList.remove('on');
}

function drawParking(list, center) {
  if (parkingLayer) map.removeLayer(parkingLayer);
  parkingLayer = L.layerGroup().addTo(map);
  // 近い順に並べてランク付け
  list.forEach(p => { p._d = haversine(center, p); });
  list.sort((a, b) => a._d - b._d);

  list.forEach((p, i) => {
    const gnav = `https://www.google.com/maps/dir/?api=1&destination=${p.lat.toFixed(6)},${p.lng.toFixed(6)}&travelmode=driving`;
    const gprice = `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    const icon = L.divIcon({ className: 'pk-pin', html: (i + 1), iconSize: [22, 22] });
    L.marker([p.lat, p.lng], { icon }).addTo(parkingLayer).bindPopup(
      `<b>${i + 1}. ${esc(p.name)}</b><br>` +
      `${p.cap ? '収容 ' + esc(p.cap) + '台 ・ ' : ''}${p.fee ? esc(p.fee) : '料金不明'}<br>` +
      `約${(p._d * 1000).toFixed(0)}m<br>` +
      `<a href="${gprice}" target="_blank" rel="noopener">料金を確認(Google)</a> ・ <a href="${gnav}" target="_blank" rel="noopener">ここへナビ</a>`
    );
  });

  const leg = $('#parking-legend');
  leg.classList.remove('hidden');
  leg.innerHTML = `<span><b>P</b> 周辺の駐車場 ${list.length}件(近い順)</span><span class="src">OpenStreetMap・料金/満空は各リンクで確認</span><button id="pk-clear">×</button>`;
  $('#pk-clear').addEventListener('click', clearParking);

  // 近い順ランキングのパネル
  const gArea = `https://www.google.com/maps/search/コインパーキング/@${center.lat.toFixed(5)},${center.lng.toFixed(5)},16z`;
  const rows = list.slice(0, 20).map((p, i) => {
    const gprice = `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    return `<div class="pk-row" data-lat="${p.lat}" data-lng="${p.lng}">
      <span class="pk-rank">${i + 1}</span>
      <span class="pk-info"><b>${esc(p.name)}</b><span class="pk-sub">${(p._d * 1000).toFixed(0)}m${p.cap ? ' ・ ' + esc(p.cap) + '台' : ''}${p.fee ? ' ・ ' + esc(p.fee) : ''}</span></span>
      <a class="pk-link" href="${gprice}" target="_blank" rel="noopener">料金</a>
    </div>`;
  }).join('');
  const panel = $('#parking-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="pk-head">
      <span>周辺の駐車場(近い順 ${list.length}件)</span>
      <button id="pk-panel-close">×</button>
    </div>
    <div class="pk-compare">
      <a class="pk-cbtn" href="${gArea}" target="_blank" rel="noopener">Googleで料金を比較</a>
      <a class="pk-cbtn alt" href="https://pppark.com/" target="_blank" rel="noopener">PPParkで探す</a>
    </div>
    <div class="pk-note">料金の安い順はPPPark等の有料データが必要なため、近い順で表示し料金は各リンクで確認できます。</div>
    <div class="pk-list">${rows}</div>`;
  $('#pk-panel-close').addEventListener('click', clearParking);
  $$('#parking-panel .pk-row').forEach(r => r.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    map.setView([+r.dataset.lat, +r.dataset.lng], 17);
  }));
}

/* ===== 近隣バス停(OpenStreetMap Overpass) ===== */
let busLayer = null;
async function showBusStops(center) {
  ensureMap();
  const c = center || map.getCenter();
  toast('周辺のバス停を検索中…');
  const q = `[out:json][timeout:20];(node["highway"="bus_stop"](around:900,${c.lat},${c.lng});node["amenity"="bus_station"](around:900,${c.lat},${c.lng}););out 80;`;
  let data = null;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
    if (res.ok) data = await res.json();
  } catch {}
  if (!data) { toast('バス停情報を取得できませんでした'); return; }
  if (busLayer) map.removeLayer(busLayer);
  busLayer = L.layerGroup().addTo(map);
  const stops = (data.elements || []).filter(e => e.lat);
  for (const s of stops) {
    const t = s.tags || {};
    const icon = L.divIcon({ className: 'bus-pin', html: '🚏', iconSize: [22, 22] });
    L.marker([s.lat, s.lon], { icon }).addTo(busLayer)
      .bindPopup(`<b>${esc(t.name || 'バス停')}</b>${t.operator ? '<br>' + esc(t.operator) : ''}`);
  }
  const leg = $('#parking-legend');
  leg.classList.remove('hidden');
  leg.innerHTML = `<span>🚏 周辺のバス停 ${stops.length}件</span><span class="src">OpenStreetMap・時刻はGoogle/各社で確認</span><button id="pk-clear">×</button>`;
  $('#pk-clear').addEventListener('click', () => { if (busLayer) { map.removeLayer(busLayer); busLayer = null; } leg.classList.add('hidden'); });
  toast(`周辺のバス停 ${stops.length}件を表示しました`);
}

/* Overpass問い合わせ(混雑/レート制限に備え複数ミラーへフォールバック) */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
async function overpassFetch(query) {
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query) });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) continue; // レート制限時のHTML応答などをスキップ
      const data = await res.json();
      if (data && Array.isArray(data.elements)) return data;
    } catch { /* 次のミラーへ */ }
  }
  return null;
}

/* ===== 観光・景観スポット(OpenStreetMap Overpass) ===== */
let touristLayer = null;
// OSMタグ → アイコン・ラベル(意味のある観光/景観のみ。宿泊・小さな碑/墓などは除外=null)
const TOUR_EXCLUDE_TOURISM = ['hotel', 'guest_house', 'hostel', 'motel', 'apartment', 'information', 'camp_site', 'caravan_site', 'chalet', 'love_hotel', 'wilderness_hut', 'alpine_hut'];
const TOUR_EXCLUDE_HISTORIC = ['memorial', 'monument', 'boundary_stone', 'milestone', 'wayside_cross', 'wayside_shrine', 'tomb', 'grave', 'charcoal_pile', 'cannon'];
function touristKind(t) {
  if (TOUR_EXCLUDE_TOURISM.includes(t.tourism)) return null;
  if (TOUR_EXCLUDE_HISTORIC.includes(t.historic)) return null;
  if (t.tourism === 'viewpoint') return { e: '🌄', l: '景観・展望' };
  if (t.natural === 'peak') return { e: '⛰', l: '山頂・景観' };
  if (t.natural === 'waterfall' || t.waterway === 'waterfall') return { e: '💧', l: '滝' };
  if (t.historic === 'castle' || t.castle_type) return { e: '🏯', l: '城' };
  if (t.tourism === 'museum') return { e: '🏛', l: '博物館' };
  if (t.tourism === 'gallery') return { e: '🖼', l: '美術館' };
  if (t.tourism === 'theme_park') return { e: '🎢', l: '遊園地' };
  if (t.tourism === 'zoo') return { e: '🦁', l: '動物園' };
  if (t.tourism === 'aquarium') return { e: '🐟', l: '水族館' };
  if (t.leisure === 'garden') return { e: '🌸', l: '庭園' };
  if (t.leisure === 'park') return { e: '🌳', l: '公園' };
  if (t.amenity === 'place_of_worship') return { e: '⛩', l: '神社・寺' };
  if (t.historic) return { e: '🗿', l: '史跡' };
  if (t.tourism === 'attraction') return { e: '🎡', l: '観光' };
  if (t.tourism) return { e: '📍', l: '観光' };
  return null; // 観光・景観に該当しないものは表示しない
}

async function showTouristSpots() {
  switchTab('map'); ensureMap();
  const c = map.getCenter();
  const b = map.getBounds();
  // 半径は表示範囲に合わせる(密集地で重くなりすぎない上限)
  const radius = Math.min(6000, Math.max(2000, Math.round(haversine({ lat: c.lat, lng: c.lng }, { lat: b.getNorth(), lng: b.getEast() }) * 1000)));
  toast('観光・景観スポットを検索中…(数秒〜十数秒)');
  // 主要種別に絞ったクエリ(点はnode中心、公園/庭園のみエリア=wayも取得)で高速化
  const a = `(around:${radius},${c.lat},${c.lng})`;
  // 高負荷の公開サーバでも安定するようnode中心の軽量クエリにする
  const q = `[out:json][timeout:20];(` +
    `node["tourism"~"attraction|viewpoint|museum|gallery|theme_park|zoo|aquarium"]["name"]${a};` +
    `node["historic"~"castle|ruins|archaeological"]["name"]${a};` +
    `node["natural"~"peak|waterfall"]["name"]${a};` +
    `node["leisure"~"park|garden"]["name"]${a};` +
    `node["amenity"="place_of_worship"]["name"]["wikidata"]${a};` +
    `);out 100;`;
  const data = await overpassFetch(q);
  if (!data) { toast('観光スポットを取得できませんでした(混雑の可能性・時間をおいて再試行)'); return; }
  // 公園・庭園などエリア(way)も best-effort で追加(取得できなければスキップ)
  overpassFetch(`[out:json][timeout:15];(way["leisure"~"park|garden"]["name"]${a};way["historic"="castle"]["name"]${a};way["tourism"~"museum|attraction|zoo"]["name"]${a};);out center 40;`)
    .then(extra => { if (extra && extra.elements.length) addTouristMarkers(extra.elements, c); }).catch(() => {});
  if (touristLayer) map.removeLayer(touristLayer);
  touristLayer = L.layerGroup().addTo(map);
  touristSeen = new Set();
  touristCount = 0;
  addTouristMarkers(data.elements || [], c);
  $('#parking-legend').classList.remove('hidden');
  renderTouristLegend();
  toast(touristCount ? `観光・景観スポット ${touristCount}件を表示` : 'この範囲に観光スポットが見つかりませんでした');
}

let touristSeen = new Set();
let touristCount = 0;
function addTouristMarkers(elements, c) {
  if (!touristLayer) return;
  for (const el of elements) {
    const t = el.tags || {};
    if (!t.name || touristSeen.has(t.name)) continue;
    const k = touristKind(t);
    if (!k) continue; // 観光・景観に該当しないものは除外
    const pt = el.type === 'node' ? { lat: el.lat, lng: el.lon } : (el.center ? { lat: el.center.lat, lng: el.center.lon } : null);
    if (!pt) continue;
    touristSeen.add(t.name); touristCount++;
    const g = `https://www.google.com/maps/search/?api=1&query=${pt.lat.toFixed(6)},${pt.lng.toFixed(6)}`;
    L.marker([pt.lat, pt.lng], { icon: L.divIcon({ className: 'tour-pin', html: k.e, iconSize: [26, 26] }) })
      .addTo(touristLayer)
      .bindPopup(`<b>${esc(t.name)}</b><br>${esc(k.l)} ・ 約${(haversine(c, pt) * 1000).toFixed(0)}m<br><a href="${g}" target="_blank" rel="noopener">Googleで見る・行く</a>`);
  }
  renderTouristLegend();
}
function renderTouristLegend() {
  const leg = $('#parking-legend');
  if (!leg || leg.classList.contains('hidden')) return;
  leg.innerHTML = `<span>🌄 観光・景観スポット ${touristCount}件</span><span class="src">OpenStreetMap・地図を動かして再検索</span><button id="pk-clear">×</button>`;
  $('#pk-clear').addEventListener('click', () => { if (touristLayer) { map.removeLayer(touristLayer); touristLayer = null; } leg.classList.add('hidden'); });
}

/* ===== JR走行位置(路線図・リアルタイム) ===== */
const jrMasterCache = {};
async function fetchJRMaster(api) {
  if (jrMasterCache[api]) return jrMasterCache[api];
  const data = await proxyFetchJson(JR_API_BASE + api + '_st.json');
  if (!data || !Array.isArray(data.stations)) return null;
  const sts = data.stations.map(s => ({ code: String(s.info.code), name: s.info.name }));
  const idx = {};
  sts.forEach((s, i) => { idx[s.code] = i; });
  return (jrMasterCache[api] = { sts, idx });
}

let jrTimer = null;
let jrCurLine = JR_REALTIME[0].lineId;
function stopJRTimer() { if (jrTimer) { clearInterval(jrTimer); jrTimer = null; } }

async function openJRLive() {
  jrCurLine = JR_REALTIME.find(j => j.lineId === jrCurLine) ? jrCurLine : JR_REALTIME[0].lineId;
  $('#jr-line-tabs').innerHTML = JR_REALTIME.map(j =>
    `<button class="jr-line-tab ${j.lineId === jrCurLine ? 'on' : ''}" data-line="${j.lineId}" style="--lc:${lineById(j.lineId).color}">${esc(lineById(j.lineId).short)}</button>`).join('');
  $$('#jr-line-tabs .jr-line-tab').forEach(b => b.addEventListener('click', () => { jrCurLine = b.dataset.line; openJRLive(); }));
  $('#jr-modal').classList.remove('hidden');
  $('#jr-diagram').innerHTML = '<p class="jr-loading">リアルタイム走行位置を取得中…</p>';
  await renderJRDiagram(jrCurLine);
  stopJRTimer();
  jrTimer = setInterval(() => { if (!$('#jr-modal').classList.contains('hidden')) renderJRDiagram(jrCurLine); else stopJRTimer(); }, 12000);
}

async function renderJRDiagram(lineId) {
  const conf = JR_REALTIME.find(j => j.lineId === lineId);
  const [master, data] = await Promise.all([fetchJRMaster(conf.api), proxyFetchJson(JR_API_BASE + conf.api + '.json')]);
  if (!master || !data || !Array.isArray(data.trains)) {
    $('#jr-diagram').innerHTML = '<p class="jr-loading">取得できませんでした(プロキシ混雑の可能性)。少し待って再度開いてください。</p>';
    return;
  }
  // 各駅インデックスに、その区間を走る列車を割り当て
  const gaps = master.sts.map(() => []);
  for (const t of data.trains) {
    const [fromC, toC] = String(t.pos || '').split('_');
    const fi = master.idx[fromC];
    if (fi == null) continue;
    const ti = master.idx[toC];
    const arrow = (ti != null) ? (ti > fi ? '↓' : '↑') : (Number(t.direction) === 1 ? '↑' : '↓');
    gaps[fi].push({
      type: cleanTrainType(t.displayType || t.type),
      dest: (t.dest && t.dest.text) || '',
      delay: t.delayMinutes || 0, arrow
    });
  }
  const color = lineById(lineId).color;
  const myset = new Set(MY_STATIONS);
  const rows = master.sts.map((s, i) => {
    const chips = gaps[i].map(tr =>
      `<span class="jr-train ${tr.delay > 0 ? 'd' : ''}">${tr.arrow}${esc(tr.type)}${tr.dest ? ' ' + esc(tr.dest) : ''}${tr.delay > 0 ? ` +${tr.delay}` : ''}</span>`).join('');
    const mine = (myset.has(s.name) || myset.has(resolveAlias(s.name))) ? ' mine' : '';
    return `
      <div class="jr-strow${mine}">
        <span class="jr-dot" style="background:${color}"></span>
        <span class="jr-stname">${esc(s.name)}</span>
      </div>
      ${chips ? `<div class="jr-gap"><span class="jr-gapline" style="background:${color}"></span><span class="jr-trains">${chips}</span></div>` : `<div class="jr-gap"><span class="jr-gapline" style="background:${color}"></span></div>`}`;
  }).join('');
  const total = data.trains.length;
  $('#jr-diagram').innerHTML = `
    <div class="jr-meta">${esc(lineById(lineId).name)} ・ 走行中 ${total}本 ・ ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}現在(約8秒間隔の実データ)</div>
    <div class="jr-rail">${rows}</div>
    <p class="jr-note">↓↑は進行方向。マイ駅は緑で強調。JR西日本「列車走行位置」の実データです。</p>`;
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
      <a class="link-btn alt" href="${JR_DELAY_OFFICIAL}" target="_blank" rel="noopener" style="margin-top:8px">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
        JR西日本 公式運行情報を開く
      </a>
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

/* ================= 最寄駅情報 ================= */
async function showNearStation() {
  toast('現在地とリアルタイム運行情報を取得中…');
  try { await locate(); } catch { toast('位置情報を取得できませんでした。許可設定を確認してください'); return; }
  const near = nearestStations(STATIONS['現在地'], 4, 9999);
  if (!near.length) { toast('近くに収録駅がありません'); return; }
  renderStationCard(near[0], near.slice(1));    // まず即時表示
  $('#near-modal').classList.remove('hidden');
  await fetchLiveJRDelays().catch(() => {});    // JRのリアルタイム運行状況を取得
  loadFeedDelays().catch(() => {});
  renderStationCard(near[0], near.slice(1));    // 取得後に運行状況を反映
}

// ホーム画面のマイ駅チップを描画
function renderMyStations() {
  const facing = preferredDir();
  const fEl = $('#my-facing');
  if (fEl) fEl.textContent = (new Date().getHours() < 12 ? '午前' : '午後') + ' → ' + facing;
  const wrap = $('#my-stations-chips');
  if (!wrap) return;
  wrap.innerHTML = MY_STATIONS.filter(n => STATIONS[n]).map(n => {
    const lines = (STATION_LINES[n] || []).slice(0, 3).map(l => `<i style="background:${l.color}"></i>`).join('');
    return `<button class="my-chip" data-name="${esc(n)}"><span class="my-chip-dots">${lines}</span>${esc(n)}</button>`;
  }).join('');
  $$('#my-stations-chips .my-chip').forEach(b => b.addEventListener('click', () => showMyStations(b.dataset.name)));
}

// マイ駅(よく使う駅)の運行状況を開く
async function showMyStations(startName) {
  const list = MY_STATIONS.filter(n => STATIONS[n]).map(n => ({ name: n, km: null }));
  if (!list.length) return;
  const idx = Math.max(0, list.findIndex(s => s.name === startName));
  const main = list[idx];
  toast('リアルタイム運行情報を取得中…');
  renderStationCard(main, list.filter(s => s.name !== main.name));
  $('#near-modal').classList.remove('hidden');
  await fetchLiveJRDelays().catch(() => {});
  loadFeedDelays().catch(() => {});
  renderStationCard(main, list.filter(s => s.name !== main.name));
}

// 駅情報モーダルを描画。main={name, km?(現在地からの距離)}、related=他駅リスト
function renderStationCard(main, related) {
  const dmap = delayMap();
  const facing = preferredDir();
  const lines = STATION_LINES[main.name] || [];
  const lineRows = lines.map(line => {
    const manual = dmap[line.id] && !dmap[line.id].auto ? dmap[line.id] : null;
    const st = liveStatus[line.id];
    let body;
    if (manual) {
      body = manual.min === 'suspend'
        ? '<b style="color:#7b1020">運転見合わせ(手動登録)</b>'
        : `<b style="color:var(--red)">遅延 +${manual.min}分(手動登録)</b>`;
    } else if (st) {
      // JRリアルタイム: 方向別の運行本数・最大遅延・主な行先(すべて実データ)
      const active = [0, 1].filter(d => st.dirs[d].count > 0);
      const facingDirs = active.filter(d => destFaces(st.dirs[d].dests, facing));
      const rows = active.map(d => {
        const g = st.dirs[d];
        const delay = g.max > 0 ? `<b style="color:var(--red)">最大+${g.max}分</b>` : '<b style="color:var(--green-bright)">遅れなし</b>';
        // 片方向のみが目的の方面なら「今の方向」バッジを付ける(環状線など両方向該当時は付けない)
        const hot = (facingDirs.length === 1 && facingDirs[0] === d) ? `<span class="dir-now">${esc(facing)}</span>` : '';
        return `<div class="near-dir">
          <div class="near-dir-top">${esc(dirLabel(g.dests))}${hot} ・ ${delay}</div>
          <div class="near-dir-types">運行中 ${g.count}本(${esc(typeSummary(g.types))})</div>
        </div>`;
      }).join('');
      body = rows || '<b style="color:var(--ink-soft)">現在この路線の走行列車はありません(終了/運行前)</b>';
    } else if (liveFetchedAt) {
      body = '<span style="color:var(--ink-soft)">リアルタイム運行情報なし(JR以外は未対応)</span>';
    } else {
      body = '<span style="color:var(--ink-soft)">運行状況を取得中…</span>';
    }
    return `<div class="near-line">
      <div class="near-line-head"><i style="background:${line.color}"></i>${esc(line.name)}</div>
      <div class="near-line-meta">${body}</div>
    </div>`;
  }).join('');

  const tt = TIMETABLE_URL[main.name];
  const ttBtn = tt ? `<a class="link-btn" href="${tt}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 3v4M17 3v4M4 8h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      公式時刻表(始発・終電)</a>` : '';
  const delayBtn = `<a class="link-btn alt" href="${JR_DELAY_OFFICIAL}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3L2 20h20L12 3zm0 6v5m0 3v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      JR西日本 公式運行情報</a>`;

  const others = (related || []).map(s =>
    `<button class="near-other" data-name="${esc(s.name)}">${esc(s.name)}${s.km != null ? ` <small>約${(s.km * 1.25).toFixed(1)}km</small>` : ''}</button>`).join('');

  // 周辺検索の中心: GPSがあれば現在地、無ければ駅座標
  const center = (main.km != null && STATIONS['現在地']) ? STATIONS['現在地'] : STATIONS[main.name];
  const POI = [['スーパー', 'スーパーマーケット'], ['コンビニ', 'コンビニ'], ['カフェ', 'カフェ'], ['飲食店', 'レストラン'], ['ATM', 'ATM'], ['トイレ', 'トイレ']];
  const poiBtns = center ? POI.map(([label, q]) =>
    `<a class="poi-btn" href="${gmapNearbyUrl(q, center)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('') : '';

  const updateBtn = main.km != null
    ? '<button id="near-update" class="link-btn alt"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 12a9 9 0 11-3-6.7M21 4v4h-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>現在地と運行情報を更新</button>'
    : '<button id="near-update" class="link-btn alt"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 12a9 9 0 11-3-6.7M21 4v4h-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>運行情報を更新</button>';

  $('#near-body').innerHTML = `
    <div class="near-main">
      <div class="near-dist">${main.km != null ? `現在地から 約${(main.km * 1.25).toFixed(1)}km ・ 徒歩約${Math.max(1, Math.round(main.km * 1.25 / 4.8 * 60) + 1)}分` : '駅情報'} ・ 現在は<b>${esc(facing)}</b>が基本</div>
      <div class="near-name">${esc(main.name)}</div>
    </div>
    ${updateBtn}
    <div class="near-lines">${lineRows || '<p class="card-sub">路線情報なし</p>'}</div>
    <div class="near-links">${ttBtn}${delayBtn}</div>
    ${poiBtns ? `<div class="near-others-label">周辺を探す(Googleマップ・徒歩時間も表示)</div><div class="poi-row">${poiBtns}</div>` : ''}
    <div class="near-set-row">
      <button class="secondary-btn" data-set="origin" data-name="${esc(main.name)}">出発地に設定</button>
      <button class="secondary-btn" data-set="dest" data-name="${esc(main.name)}">目的地に設定</button>
    </div>
    ${others ? `<div class="near-others-label">${main.km != null ? '他の近隣駅' : 'マイ駅を切り替え'}</div><div class="near-others">${others}</div>` : ''}
    <p class="demo-note" style="padding:2px 2px 4px">運行状況はJR西日本「列車走行位置」の実データ(種別・方向別の走行本数・遅延)です。正確な始発・終電・次の発車時刻は公式時刻表でご確認ください(無料の時刻表データが無いためアプリ内には表示していません)。周辺検索・徒歩時間はGoogleマップで表示します。JR以外はリアルタイム情報がありません。</p>`;

  const upd = $('#near-update');
  if (upd) upd.addEventListener('click', async () => {
    upd.disabled = true; upd.style.opacity = '.6';
    if (main.km != null) { try { await locate(); } catch {} }
    await fetchLiveJRDelays().catch(() => {});
    await loadFeedDelays().catch(() => {});
    if (main.km != null) {
      const near = nearestStations(STATIONS['現在地'], 4, 9999);
      if (near.length) renderStationCard(near[0], near.slice(1));
    } else {
      renderStationCard(main, related);
    }
    toast('最新の運行情報に更新しました');
  });
  $$('#near-body [data-set]').forEach(b => b.addEventListener('click', e => {
    const t = e.currentTarget;
    $(t.dataset.set === 'origin' ? '#input-origin' : '#input-dest').value = t.dataset.name;
    $('#near-modal').classList.add('hidden');
    if (currentTab() !== 'nav') switchTab('nav');
    toast(`${t.dataset.set === 'origin' ? '出発地' : '目的地'}を${t.dataset.name}に設定しました`);
  }));
  $$('#near-body .near-other').forEach(b => b.addEventListener('click', () => {
    const all = [main, ...(related || [])];
    const s = all.find(x => x.name === b.dataset.name);
    renderStationCard(s, all.filter(x => x.name !== s.name));
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
  $('#view-seg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state.resultView = b.dataset.v;
    $$('#view-seg button').forEach(x => x.classList.toggle('on', x === b));
    if (state.lastSearch && state.routes.length) renderResults();
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
  $('#btn-alarm').addEventListener('click', () => {
    if (!state.current) return;
    const last = state.current.legs[state.current.legs.length - 1];
    const dest = last.stations[last.stations.length - 1];
    if (isVirtual(dest)) { toast('住所指定の目的地にはアラームを設定できません(駅を指定してください)'); return; }
    armAlarm(dest);
  });
  $('#btn-gmap-map').addEventListener('click', openGmaps);
  $('#btn-locate').addEventListener('click', locateOnMap);
  $('#btn-jr-live').addEventListener('click', openJRLive);
  $('#btn-rail-status').addEventListener('click', toggleRailStatus);
  $('#btn-parking').addEventListener('click', toggleParking);
  $('#btn-tourist').addEventListener('click', () => setTimeout(showTouristSpots, 100));
  $('#jr-done').addEventListener('click', () => { $('#jr-modal').classList.add('hidden'); stopJRTimer(); });
  $('#jr-modal').addEventListener('click', e => { if (e.target.id === 'jr-modal') { $('#jr-modal').classList.add('hidden'); stopJRTimer(); } });

  // 遅延
  $('#btn-delay-add').addEventListener('click', addDelay);

  // フリーパスモーダル
  $('#btn-near').addEventListener('click', showNearStation);
  $('#near-done').addEventListener('click', () => $('#near-modal').classList.add('hidden'));
  $('#near-modal').addEventListener('click', e => { if (e.target.id === 'near-modal') $('#near-modal').classList.add('hidden'); });

  $('#btn-pass').addEventListener('click', () => $('#pass-modal').classList.remove('hidden'));
  $('#pass-done').addEventListener('click', () => $('#pass-modal').classList.add('hidden'));
  $('#pass-modal').addEventListener('click', e => {
    if (e.target.id === 'pass-modal') $('#pass-modal').classList.add('hidden');
  });

  // 設定
  $('#menu-clear-delays').addEventListener('click', () => {
    store.delays = [];
    renderDelays();
    toast('遅延情報をすべて削除しました');
  });
  $('#menu-clear-drive').addEventListener('click', () => {
    store.driveLogs = [];
    renderDriveLogs();
    toast('ドライブログをすべて削除しました');
  });
  $('#menu-reset').addEventListener('click', () => {
    ['nn_delays', 'nn_pass', 'nn_history', 'nn_alarm', 'nn_drivelogs', 'nn_theme', 'nn_mapstyle', 'nn_lastinputs', 'nn_parked'].forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  // テーマ
  applyTheme(store.theme);
  $$('#theme-seg button').forEach(x => x.classList.toggle('on', x.dataset.v === store.theme));
  $('#theme-seg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    store.theme = b.dataset.v;
    applyTheme(b.dataset.v);
    $$('#theme-seg button').forEach(x => x.classList.toggle('on', x === b));
  });
  // 地図スタイル
  $('#map-style').value = store.mapStyle;
  $('#map-style').addEventListener('change', e => { ensureMap(); setMapStyle(e.target.value); });

  renderDelays();
  renderPassUI();
  renderMyStations();
  updateHeader();
  loadFeedDelays();
  if (store.alarm && STATIONS[store.alarm]) armAlarm(store.alarm); // 移動中のリロードでも再開

  // ドライブタブのハブ
  $('#drive-route').addEventListener('click', () => {
    switchTab('nav'); showScreen('search');
    state.mode = 'car';
    $$('.mode-btn').forEach(x => x.classList.toggle('on', x.dataset.mode === 'car'));
    toast('移動手段を「自動車」にしました。出発地・目的地を入れて検索してください');
  });
  $('#drive-parking').addEventListener('click', () => {
    switchTab('map');
    setTimeout(() => { if (!parkingOn) toggleParking(); }, 350);
  });
  $('#drive-rest').addEventListener('click', () => setTimeout(showRestSpots, 100));
  $('#park-save').addEventListener('click', saveParked);
  renderParkStatus();

  // ドライブログ
  $('#drive-toggle').addEventListener('click', () => drive.recording ? stopDrive() : startDrive());
  $('#drive-hwy').addEventListener('click', () => { drive.hwy = !drive.hwy; renderDrivePanel(); });
  $('#drive-vehicle').addEventListener('change', () => { drive.vehicle = $('#drive-vehicle').value; renderDrivePanel(); });
  $('#drive-map').addEventListener('click', () => {
    const last = store.driveLogs[0];
    if (last && last.track) showDriveTrack(last.track);
    else if (drive.track.length) showDriveTrack(decimate(drive.track, 200));
    else toast('表示できる走行ログがありません');
  });
  renderDrivePanel();
  renderDriveLogs();

  // 前回の検索入力を復元(無ければデモ用の初期値)
  const li = (() => { try { return JSON.parse(localStorage.getItem('nn_lastinputs') || 'null'); } catch { return null; } })();
  if (li && li.origin) {
    $('#input-origin').value = li.origin;
    $('#input-dest').value = li.dest || '';
    (li.vias || []).forEach(v => addViaRow(v));
    if (li.mode) { state.mode = li.mode; $$('.mode-btn').forEach(x => x.classList.toggle('on', x.dataset.mode === li.mode)); }
  } else {
    $('#input-origin').value = '梅田';
    $('#input-dest').value = '三宮';
  }

  // オフライン検知
  const offBar = $('#offline-bar');
  const updateOnline = () => offBar.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  // PWA(Service Worker)。新バージョン公開時に自動で最新へ更新する。
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    let refreshing = false;
    const hadController = !!navigator.serviceWorker.controller;
    // 新しいSWが有効化されたら最新版へリロード(初回インストール時は不要)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing || !hadController) return;
      refreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.update().catch(() => {});                                  // 起動時に更新確認
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); // 以降1時間ごと
    }).catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);

// Robot Trading — UI mobile (WebView). Sinyal analisa saja, tidak mengeksekusi order.
import { SYMBOL_RE, normalize, analyzeSymbol, scan as scanAll } from './data.js';
import { $, $$, esc, act, LABEL, fmt, pct, date, clock, ago, store } from './ui/util.js';
import { ICON } from './ui/icons.js?v=1.4.0';
import * as F from './fundamental.js?v=1.4.0';
import BT from './fundamental_backtest.js?v=1.4.0';
import { loadSentiment } from './hyperliquid.js?v=1.4.0';
import { hlCardHTML, hlSignalHTML } from './ui/hl.js?v=1.4.0';

const VERSION = '1.4.0';
const MAX_WATCHLIST = 100;
const K = { watchlist: 'rt.watchlist.v1', settings: 'rt.settings.v1', scan: 'rt.scan.v1' };

const DEFAULT_WATCHLIST = [
  ...['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'ANTM', 'GOTO'].map(symbol => ({ symbol, market: 'saham' })),
  ...['BTC', 'ETH', 'SOL', 'BNB', 'XRP'].map(symbol => ({ symbol, market: 'crypto' })),
];
const DEFAULT_SETTINGS = { interval: '1d', strategy: 'trend', atr_stop: '3', ma200: false, auto: false, chartMode: 'line' };

const INTERVALS = [
  { v: '1h', chip: '1J', name: '1 Jam' },
  { v: '4h', chip: '4J', name: '4 Jam' },
  { v: '1d', chip: 'Harian', name: 'Harian' },
  { v: '1wk', chip: 'Mingguan', name: 'Mingguan' },
];
const STRATEGIES = {
  trend: { name: 'Tren (EMA Cross)', desc: 'BUY saat EMA20 memotong ke atas EMA50, SELL saat memotong ke bawah atau kena trailing stop.' },
  dip: { name: 'Beli saat Koreksi', desc: 'BUY saat RSI turun di bawah 35 tapi harga masih di atas EMA200, SELL saat RSI di atas 55 atau kena stop.' },
  score: { name: 'Skor Gabungan', desc: 'BUY/SELL dari skor gabungan tren, MACD, RSI, Bollinger & volume, plus trailing stop.' },
  turtle: { name: 'Turtle (Breakout)', desc: 'Aturan Turtle Traders: beli saat harga menembus tertinggi 20 candle, jual saat tembus terendah 10 candle.' },
};
const STOPS = [
  { v: '2', chip: '2× ATR', name: 'ketat' },
  { v: '3', chip: '3× ATR', name: 'normal' },
  { v: '4', chip: '4× ATR', name: 'longgar' },
];
const NEAR_RE = /segera|mendekati|mulai turun/i;
const AVATAR = ['#1d4ed8', '#0e7490', '#047857', '#b45309', '#b91c1c', '#6d28d9', '#be185d', '#3730a3', '#0f766e', '#a16207'];

// ---------------------------------------------------------------- simbol & penyimpanan
function validSym(s, market) {
  try {
    const m = new RegExp(SYMBOL_RE.source).exec(s);
    if (!m || m.index !== 0 || m[0] !== s) return false;
    normalize(s, market); // melempar error kalau tidak valid
    return true;
  } catch { return false; }
}
function canon(symbol, market) {
  try { return normalize(String(symbol), market); } catch { return String(symbol).toUpperCase(); }
}
const keyOf = (symbol, market) => market + ':' + canon(symbol, market);

function loadWatchlist() {
  const raw = store.get(K.watchlist, null);
  const src = Array.isArray(raw) ? raw : DEFAULT_WATCHLIST;
  const seen = new Set(), out = [];
  for (const it of src) {
    if (!it || typeof it.symbol !== 'string' || !['saham', 'crypto'].includes(it.market)) continue;
    const symbol = it.symbol.trim().toUpperCase();
    if (!validSym(symbol, it.market)) continue;
    const k = keyOf(symbol, it.market);
    if (seen.has(k)) continue;
    seen.add(k); out.push({ symbol, market: it.market });
    if (out.length >= MAX_WATCHLIST) break;
  }
  return out;
}
function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(store.get(K.settings, {}) || {}) };
  if (!INTERVALS.some(i => i.v === s.interval)) s.interval = DEFAULT_SETTINGS.interval;
  if (!STRATEGIES[s.strategy]) s.strategy = DEFAULT_SETTINGS.strategy;
  s.atr_stop = String(s.atr_stop);
  if (!STOPS.some(x => x.v === s.atr_stop)) s.atr_stop = DEFAULT_SETTINGS.atr_stop;
  s.ma200 = s.ma200 === true;
  s.auto = s.auto === true;
  if (s.chartMode !== 'candle') s.chartMode = 'line';
  return s;
}

// ---------------------------------------------------------------- state
const state = {
  tab: 'signal',
  watchlist: loadWatchlist(),
  settings: loadSettings(),
  rows: new Map(),       // keyOf -> baris hasil scan
  rowsSig: '',
  lastScan: 0,
  scanning: false, scanSeq: 0, scanDone: 0, scanTotal: 0,
  filter: 'all', edit: false, addMarket: 'saham',
  current: null,         // { symbol, market }
  chartInterval: null,
  data: null, dataAt: 0, detailError: null, detailLoading: false, selSeq: 0,
  showAllTrades: false,
  mktView: 'watch',      // 'watch' | 'fund' (segmen di tab Pasar)
  fund: { rows: new Map(), loading: false, done: 0, total: 0, seq: 0, filter: 'all', sort: 'score', dir: -1 },
  fundCur: { key: null, data: null, error: null, loading: false, seq: 0 }, // kartu Fundamental di tab Chart
  hl: { data: null, error: null, errorAt: 0, loading: false, listOpen: false }, // posisi trader top Hyperliquid (crypto)
  wsort: { k: null, dir: 1 }, // urutan tabel daftar pantau (desktop); k null = urutan asli
};
// Layout desktop (>= 1024px): sidebar + grid lebar. Ponsel/APK tetap memakai layout satu kolom.
const DESK_MQ = window.matchMedia ? window.matchMedia('(min-width: 1024px)') : null;
let desk = !!(DESK_MQ && DESK_MQ.matches);
const optsOf = () => ({ strategy: state.settings.strategy, atr_stop: state.settings.atr_stop, ...(state.settings.ma200 ? { ma200: true } : {}) });
const sigOf = () => `${state.settings.interval}|${state.settings.strategy}|${state.settings.atr_stop}|${state.settings.ma200 ? 'ma200' : ''}`;
const saveSettings = () => store.set(K.settings, state.settings);
const saveWatchlist = () => store.set(K.watchlist, state.watchlist);
function saveScanCache() {
  store.set(K.scan, { sig: state.rowsSig, at: state.lastScan, rows: [...state.rows.values()] });
}
(function restoreScanCache() {
  const c = store.get(K.scan, null);
  if (!c || c.sig !== sigOf() || !Array.isArray(c.rows)) return;
  for (const r of c.rows) if (r && r.market && (r.input || r.symbol)) state.rows.set(keyOf(r.input || r.symbol, r.market), r);
  state.rowsSig = c.sig;
  state.lastScan = Number(c.at) || 0;
})();

const rowFor = it => state.rows.get(keyOf(it.symbol, it.market));
const ivName = v => (INTERVALS.find(i => i.v === v) || INTERVALS[2]).name;
const isIntraday = iv => iv === '1h' || iv === '4h';

// ---------------------------------------------------------------- ui kecil
function avatar(sym, cls = '') {
  const s = String(sym || '?').toUpperCase();
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="avatar ${cls}" style="--av:${AVATAR[h % AVATAR.length]}">${esc(s.replace(/[^A-Z0-9]/g, '').slice(0, 2) || '?')}</span>`;
}
const mkTag = m => `<span class="mk">${m === 'crypto' ? 'CRYPTO' : 'IDX'}</span>`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function setSpin(on) {
  for (const b of [$('#refreshBtn'), $('#scanFab'), $('#sideScan')]) {
    b.classList.toggle('spinning', on);
    b.setAttribute('aria-busy', on ? 'true' : 'false');
  }
}

function greeting() {
  const h = new Date().getHours();
  if (h >= 4 && h < 11) return 'Selamat pagi';
  if (h >= 11 && h < 15) return 'Selamat siang';
  if (h >= 15 && h < 18) return 'Selamat sore';
  return 'Selamat malam';
}
const freshCount = () => [...state.rows.values()].filter(r => !r.error && (r.action === 'BUY' || r.action === 'SELL')).length;

// ---------------------------------------------------------------- navigasi (history -> tombol back Android)
const TAB_TITLE = { signal: 'Sinyal', market: 'Pasar', chart: 'Chart', more: 'Lainnya' };
function showTab(tab) {
  const prev = state.tab;
  state.tab = tab;
  document.body.dataset.tab = tab;
  $('#topTitle').textContent = TAB_TITLE[tab] || '';
  $('#greet').textContent = tab === 'market' ? (state.mktView === 'fund' ? 'Peringkat fundamental' : 'Daftar pantau') : tab === 'more' ? 'Pengaturan & bantuan' : greeting() + '!';
  for (const v of $$('.view')) v.hidden = v.dataset.tab !== tab;
  for (const b of $$('.tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (prev === 'chart' && tab !== 'chart') stopLive();
  if (prev !== tab) window.scrollTo(0, 0);
  render(tab);
  if (tab === 'chart' && state.current && !state.detailLoading && (!state.data || Date.now() - state.dataAt > 60000)) loadDetail();
}

function navigate(tab, extra = {}) {
  const st = { tab, ...extra };
  history.pushState(st, '');
  showTab(tab);
}

function openSymbol(symbol, market, { push = true } = {}) {
  const same = state.current && keyOf(state.current.symbol, state.current.market) === keyOf(symbol, market)
    && state.chartInterval === state.settings.interval;
  state.current = { symbol, market };
  state.chartInterval = state.settings.interval;
  state.showAllTrades = false;
  if (!same) { state.data = null; state.detailError = null; stopLive(); }
  if (push) history.pushState({ tab: 'chart', symbol, market }, '');
  if (!same || !state.data) loadDetail(); // sebelum showTab agar tidak memuat dua kali
  showTab('chart');
}

window.addEventListener('popstate', e => {
  if (!$('#sheet').hidden) closeSheetNow();
  const s = e.state || { tab: 'signal' };
  if (s.tab === 'chart' && s.symbol && s.market &&
      (!state.current || keyOf(state.current.symbol, state.current.market) !== keyOf(s.symbol, s.market))) {
    openSymbol(s.symbol, s.market, { push: false });
  } else {
    showTab(['signal', 'market', 'chart', 'more'].includes(s.tab) ? s.tab : 'signal');
  }
  if (afterSheet) { const f = afterSheet; afterSheet = null; f(); }
});

// ---------------------------------------------------------------- bottom sheet
let sheetHandlers = {}, afterSheet = null;
function openSheet(html, handlers) {
  sheetHandlers = handlers || {};
  const sh = $('#sheet');
  sh.innerHTML = `<div class="grab"></div>${html}`;
  sh.hidden = false;
  $('#sheetBackdrop').hidden = false;
  history.pushState({ ...(history.state || { tab: state.tab }), sheet: true }, '');
  const f = sh.querySelector('button'); if (f) f.focus({ preventScroll: true });
}
function closeSheetNow() {
  $('#sheet').hidden = true;
  $('#sheetBackdrop').hidden = true;
  $('#sheet').innerHTML = '';
  sheetHandlers = {};
}
function closeSheet(then) {
  if ($('#sheet').hidden) { if (then) then(); return; }
  afterSheet = then || null;
  history.back(); // popstate menutup sheet lalu menjalankan `then`
}
$('#sheet').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const fn = sheetHandlers[b.dataset.act];
  closeSheet(fn ? () => fn(b) : null);
});
$('#sheetBackdrop').addEventListener('click', () => closeSheet());

function confirmRemove(symbol, market) {
  openSheet(`<h3>Hapus ${esc(symbol)}?</h3>
    <p>${esc(symbol)} (${market === 'crypto' ? 'Crypto' : 'Saham'}) akan dihapus dari daftar pantauan.</p>
    <div class="acts"><button class="btn" data-act="cancel" type="button">Batal</button>
    <button class="btn danger" data-act="ok" type="button">${ICON.trash} Hapus</button></div>`,
  { ok: () => removeItem(symbol, market) });
}

function openPicker() {
  if (!state.watchlist.length) return navigate('market');
  openSheet(`<h3>Pilih aset</h3><p>Pilih aset untuk membuka chart & sinyalnya.</p>
    <div class="picker-grid" style="max-height:50vh;overflow:auto">${pickButtons('pick')}</div>`,
  { pick: b => openSymbol(b.dataset.s, b.dataset.m) });
}
function pickButtons(actName) {
  return state.watchlist.map(w => `<button type="button" class="pick" data-act="${actName}" data-s="${esc(w.symbol)}" data-m="${esc(w.market)}">
    ${avatar(w.symbol)}<span>${esc(w.symbol)}</span></button>`).join('');
}

// ---------------------------------------------------------------- scan
async function runScan(items = null) {
  if (!state.watchlist.length) { render(state.tab); return; }
  const partial = !!items;
  const list = (items || state.watchlist).map(w => ({ symbol: w.symbol, market: w.market }));
  const sig = sigOf();
  if (!partial) {
    if (state.rowsSig !== sig) state.rows.clear(); // pengaturan berubah: hasil lama tidak relevan
    state.scanSeq++;
    state.scanning = true; state.scanDone = 0; state.scanTotal = list.length;
    setSpin(true);
    render(state.tab);
  }
  const seq = state.scanSeq;
  state.rowsSig = sig;
  const accept = row => seq === state.scanSeq && sig === sigOf() && row && row.market;
  try {
    const rows = await scanAll(list, state.settings.interval, optsOf(), row => {
      if (!accept(row)) return;
      state.rows.set(keyOf(row.input || row.symbol, row.market), row);
      if (!partial) state.scanDone++;
      scheduleRender();
    });
    if (seq !== state.scanSeq || sig !== sigOf()) return;
    for (const r of rows || []) if (accept(r)) state.rows.set(keyOf(r.input || r.symbol, r.market), r);
    if (!partial) state.lastScan = Date.now();
    saveScanCache();
  } catch (e) {
    if (seq === state.scanSeq) toast('Scan gagal: ' + (e && e.message ? e.message : 'kesalahan tidak dikenal'));
  } finally {
    if (!partial && seq === state.scanSeq) { state.scanning = false; setSpin(false); }
    scheduleRender();
  }
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; if (state.tab !== 'chart' && state.tab !== 'more') render(state.tab); updateTabBadge(); paintSide(); });
}

function refreshAll() {
  if (!state.scanning) runScan();
  if (state.tab === 'chart' && state.current) loadDetail(true);
}

function updateTabBadge() {
  const n = freshCount();
  const bell = $('#bellBtn');
  bell.classList.toggle('has-new', n > 0);
  bell.setAttribute('aria-label', n ? `Lihat ${n} sinyal baru` : 'Sinyal baru (belum ada)');
  for (const tab of $$('.tab[data-tab="signal"]')) {
    let dot = tab.querySelector('.dot-n');
    if (!n) { if (dot) dot.remove(); tab.removeAttribute('aria-label'); continue; }
    if (!dot) { dot = document.createElement('span'); dot.className = 'dot-n'; tab.appendChild(dot); }
    dot.textContent = n > 9 ? '9+' : String(n);
    tab.setAttribute('aria-label', `Sinyal, ${n} sinyal baru`);
  }
}

// sidebar desktop: status scan, update terakhir, ringkasan pengaturan
function paintSide() {
  if (!desk) return;
  const st = state.settings;
  const txt = $('#sideScanTxt'), prog = $('#sideProg');
  txt.textContent = state.scanning ? `Memindai ${state.scanDone}/${state.scanTotal}` : 'Scan sinyal';
  prog.hidden = !state.scanning;
  prog.firstElementChild.style.width = `${state.scanTotal ? Math.round(state.scanDone / state.scanTotal * 100) : 0}%`;
  $('#sideFoot').innerHTML = `
    <div class="side-upd"><span>Update terakhir</span><b class="mono">${state.lastScan ? esc(clock(state.lastScan)) : '–'}</b></div>
    <div class="chips">
      <span class="chip">TF <b>${esc(ivName(st.interval))}</b></span>
      <span class="chip"><b>${esc(STRATEGIES[st.strategy].name)}</b></span>
      <span class="chip">Stop <b>${esc(st.atr_stop)}× ATR</b></span>
      <span class="chip${st.ma200 ? ' on' : ''}">MA200 <b>${st.ma200 ? 'aktif' : 'mati'}</b></span>
    </div>
    <button type="button" class="link side-set" data-tab-go="more">Ubah pengaturan</button>`;
}

// ---------------------------------------------------------------- baris aset
// perubahan harga sejak sinyal terakhir (null kalau belum ada sinyal)
const sinceSig = r => (r && !r.error && r.last_signal && r.last_signal.price ? (r.price / r.last_signal.price - 1) * 100 : null);
function chgPill(v) {
  if (v == null || isNaN(v)) return '<span class="chg flat">–</span>';
  const n = Number(v);
  return `<span class="chg ${n >= 0 ? 'pos' : 'neg'}">${n >= 0 ? '▲' : '▼'} ${Math.abs(n).toFixed(2)}%</span>`;
}

function assetRow(it, { edit = false } = {}) {
  const r = rowFor(it);
  const s = esc(it.symbol), m = esc(it.market);
  let sub, right;
  if (!r) {
    sub = state.scanning ? '<span class="skel" style="width:110px"></span>' : 'Belum di-scan';
    right = state.scanning
      ? '<span class="skel" style="width:70px;height:12px"></span><span class="badge LOAD">···</span>'
      : '<span class="badge LOAD">—</span>';
  } else if (r.error) {
    sub = `<span class="neg">${esc(r.error)}</span>`;
    right = '<span class="badge ERR">ERROR</span>';
  } else {
    const ls = r.last_signal;
    const ch = sinceSig(r);
    // perubahan % sejak sinyal terakhir ditaruh di baris bawah agar kolom kanan tetap ramping
    sub = ls ? `${ch == null ? '' : `<span class="row-ch">${pct(ch)}</span> · `}${esc(ls.type)} ${esc(ago(ls.time))}` : esc(r.name);
    const a = act(r.action);
    right = `<span class="row-px">${fmt(r.price, r.currency)}</span><span class="badge ${a}">${a}</span>`;
  }
  if (edit) right = `<button type="button" class="row-del" data-del="${s}" data-m="${m}" aria-label="Hapus ${s}">${ICON.trash}</button>`;
  return `<div class="row" role="button" tabindex="0" data-s="${s}" data-m="${m}" aria-label="${s}${r && !r.error ? ', sinyal ' + esc(act(r.action)) : ''}">
    ${avatar(it.symbol)}
    <div class="row-main"><div class="row-t"><span class="sym">${s}</span>${mkTag(it.market)}</div><div class="row-s">${sub}</div></div>
    <div class="row-r">${right}</div></div>`;
}

// kartu kecil daftar pantau (gulir horizontal di Beranda)
function watchCard(it) {
  const r = rowFor(it);
  const s = esc(it.symbol), m = esc(it.market);
  const sel = state.current && keyOf(state.current.symbol, state.current.market) === keyOf(it.symbol, it.market);
  let name, px, bot;
  if (!r) {
    name = it.market === 'crypto' ? 'Crypto' : 'Saham IDX';
    px = state.scanning ? '<span class="skel" style="width:84px;height:16px"></span>' : '–';
    bot = `<span class="badge LOAD">${state.scanning ? '···' : '—'}</span>`;
  } else if (r.error) {
    name = it.market === 'crypto' ? 'Crypto' : 'Saham IDX';
    px = '–';
    bot = '<span class="badge ERR">ERROR</span>';
  } else {
    const a = act(r.action);
    name = r.name || it.symbol;
    px = fmt(r.price, r.currency);
    bot = `<span class="badge ${a}">${a}</span>${chgPill(sinceSig(r))}`;
  }
  return `<button type="button" class="wcard${sel ? ' sel' : ''}" data-s="${s}" data-m="${m}" aria-label="Buka chart ${s}">
    <span class="wc-top">${avatar(it.symbol, 'sm')}<span class="wc-id"><b>${s}</b><span>${esc(name)}</span></span></span>
    <span class="wc-px mono">${px}</span>
    <span class="wc-bot">${bot}</span></button>`;
}

// ---------------------------------------------------------------- tab Sinyal
function renderSignal() {
  const view = $('#view-signal');
  const items = state.watchlist.map(it => ({ it, r: rowFor(it) }));
  const ok = items.filter(x => x.r && !x.r.error);
  const by = a => ok.filter(x => x.r.action === a);
  const fresh = [...by('BUY'), ...by('SELL')];
  const hold = by('HOLD');
  const near = by('WAIT').filter(x => NEAR_RE.test(String(x.r.advice || '')));
  const errs = items.filter(x => x.r && x.r.error).length;
  const st = state.settings;

  const counts = ['BUY', 'SELL', 'HOLD', 'WAIT'].map(a => [a, by(a).length]);
  const peak = Math.max(1, ...counts.map(c => c[1]));
  const bars = counts.map(([a, n]) => `
    <div class="bar ${a}">
      <div class="bar-track"><i style="height:${n ? Math.max(14, Math.round(n / peak * 100)) : 6}%"></i></div>
      <b>${n}</b><span>${a}</span>
    </div>`).join('');

  const status = state.scanning
    ? `<span class="scan-txt">Memindai <b class="mono">${state.scanDone}/${state.scanTotal}</b></span>`
    : state.lastScan ? `Update <b class="mono">${esc(clock(state.lastScan))}</b>` : 'Belum di-scan';

  const section = (id, title, list, emptyText, hint = '') => `
    <div class="section-h" id="${id}"><h2>${title}</h2>${list.length ? `<span class="count">${list.length}</span>` : hint}</div>
    ${list.length
      ? `<div class="list">${list.map(x => assetRow(x.it)).join('')}</div>`
      : `<div class="empty">${emptyText}</div>`}`;

  const loadingFirst = state.scanning && !ok.length;
  const cryptoItems = state.watchlist.filter(it => it.market === 'crypto');
  if (cryptoItems.length && !state.scanning) ensureHl(); // dimuat setelah scan selesai agar start tetap cepat
  const skeleton = `<div class="list">${state.watchlist.slice(0, 3).map(it => assetRow(it)).join('')}</div>`;

  const hero = `
    <div class="hero">
      <div class="hero-top">
        <div class="hero-k">Sinyal hari ini</div>
        <div class="hero-time">${status}</div>
      </div>
      <div class="hero-main">
        <div class="hero-big"><span class="mono">${fresh.length}</span><small>sinyal baru</small></div>
        <div class="bars" role="img" aria-label="BUY ${counts[0][1]}, SELL ${counts[1][1]}, HOLD ${counts[2][1]}, WAIT ${counts[3][1]}">${bars}</div>
      </div>
      ${state.scanning ? `<div class="progress" aria-hidden="true"><i style="width:${state.scanTotal ? Math.round(state.scanDone / state.scanTotal * 100) : 0}%"></i></div>` : ''}
      <div class="chips">
        <span class="chip">TF <b>${esc(ivName(st.interval))}</b></span>
        <span class="chip"><b>${esc(STRATEGIES[st.strategy].name)}</b></span>
        <span class="chip">Stop <b>${esc(st.atr_stop)}× ATR</b></span>
        ${st.ma200 ? '<span class="chip on"><b>MA200</b></span>' : ''}
      </div>
    </div>`;

  if (desk) {
    view.innerHTML = signalDeskHTML({ hero, fresh, hold, near, cryptoItems, loadingFirst, section, errs });
    return;
  }
  view.innerHTML = `
    ${hero}

    <div class="cta">
      <button type="button" class="pill primary" data-q="scan">${ICON.refresh}Scan</button>
      <button type="button" class="pill" data-q="add">${ICON.plus}Tambah aset</button>
    </div>

    <div class="panel">
      <div class="grab" aria-hidden="true"></div>
      <div class="section-h first"><h2>Daftar Pantau</h2><button type="button" class="link" data-q="add">${ICON.plus}Tambah</button></div>
      ${state.watchlist.length
        ? `<div class="wscroll" role="list">${state.watchlist.map(it => watchCard(it)).join('')}</div>`
        : '<div class="empty"><b>Daftar pantauan kosong</b>Tambahkan saham atau crypto di tab Pasar.</div>'}
      ${!state.watchlist.length
        ? ''
        : loadingFirst
          ? `<div class="section-h" id="sec-new"><h2>Sinyal baru</h2><span class="hint">memindai…</span></div>${skeleton}`
          : section('sec-new', 'Sinyal baru', fresh,
            '<b>Belum ada sinyal baru</b>Tidak ada BUY atau SELL di candle terakhir. Cek lagi nanti.')
            + section('sec-hold', 'Sedang dipegang', hold, 'Tidak ada posisi yang sedang dipegang.')
            + section('sec-near', 'Hampir sinyal', near, 'Belum ada aset yang mendekati sinyal BUY.')
            + hlSignalHTML({ hl: state.hl, items: cryptoItems, avatar })}
      ${errs ? `<p class="note" style="text-align:center">${errs} simbol gagal dimuat — lihat tab Pasar.</p>` : ''}
    </div>`;
}

// Dasbor desktop: grid 12 kolom (hero + sinyal baru + sentimen, daftar pantau, dipegang + hampir sinyal)
function signalDeskHTML({ hero, fresh, hold, near, cryptoItems, loadingFirst, section, errs }) {
  const box = (cls, inner) => `<section class="dcard ${cls}">${inner}</section>`;
  const wl = state.watchlist;
  const skel = `<div class="list">${wl.slice(0, 3).map(it => assetRow(it)).join('')}</div>`;
  const hl = cryptoItems.length
    ? hlSignalHTML({ hl: state.hl, items: cryptoItems, avatar })
    : `<div class="section-h first" id="sec-hl"><h2>Sentimen trader top</h2><span class="hint">Hyperliquid</span></div>
       <div class="empty"><b>Belum ada crypto</b>Tambahkan koin (mis. BTC) ke daftar pantau untuk melihat posisi 50 trader top Hyperliquid.</div>`;
  const newSec = !wl.length
    ? `<div class="section-h first" id="sec-new"><h2>Sinyal baru</h2></div><div class="empty"><b>Daftar pantauan kosong</b>Tambahkan saham atau crypto dulu.</div>`
    : loadingFirst
      ? `<div class="section-h first" id="sec-new"><h2>Sinyal baru</h2><span class="hint">memindai…</span></div>${skel}`
      : section('sec-new', 'Sinyal baru <small>BUY / SELL</small>', fresh, '<b>Belum ada sinyal baru</b>Tidak ada BUY atau SELL di candle terakhir. Cek lagi nanti.');
  return `<div class="dgrid">
    <div class="d-hero">${hero}</div>
    ${box('d-new', newSec)}
    ${box('d-hl', hl)}
    ${box('d-watch', `<div class="section-h first"><h2>Daftar Pantau <span class="count">${wl.length}</span></h2>
        <div class="d-acts"><button type="button" class="btn" data-q="market">Lihat tabel</button><button type="button" class="btn primary-soft" data-q="add">${ICON.plus}Tambah aset</button></div></div>
      ${wl.length
        ? `<div class="wgrid" role="list">${wl.map(it => watchCard(it)).join('')}</div>`
        : '<div class="empty"><b>Daftar pantauan kosong</b>Tambahkan saham atau crypto di tab Pasar.</div>'}
      ${errs ? `<p class="note">${errs} simbol gagal dimuat — lihat tab Pasar.</p>` : ''}`)}
    ${box('d-hold', wl.length && !loadingFirst ? section('sec-hold', 'Sedang dipegang', hold, 'Tidak ada posisi yang sedang dipegang.') : `<div class="section-h first"><h2>Sedang dipegang</h2></div>${loadingFirst ? skel : '<div class="empty">Tidak ada posisi yang sedang dipegang.</div>'}`)}
    ${box('d-near', wl.length && !loadingFirst ? section('sec-near', 'Hampir sinyal', near, 'Belum ada aset yang mendekati sinyal BUY.') : `<div class="section-h first"><h2>Hampir sinyal</h2></div>${loadingFirst ? skel : '<div class="empty">Belum ada aset yang mendekati sinyal BUY.</div>'}`)}
  </div>`;
}

function goAdd() {
  navigate('market');
  setTimeout(() => {
    const f = $('#addSym');
    if (!f) return;
    $('#addForm').scrollIntoView({ block: 'center' });
    f.focus({ preventScroll: true });
  }, 60);
}

$('#view-signal').addEventListener('click', e => {
  const q = e.target.closest('[data-q]');
  if (q) {
    if (q.dataset.q === 'scan') return refreshAll();
    if (q.dataset.q === 'add') return goAdd();
    if (q.dataset.q === 'market') { state.mktView = 'watch'; return navigate('market'); }
  }
  const row = e.target.closest('.row, .wcard');
  if (row) openSymbol(row.dataset.s, row.dataset.m);
});

// ---------------------------------------------------------------- tab Pasar
function renderMarketShell() {
  if (desk) return renderMarketShellDesk();
  $('#view-market').innerHTML = `
    <h1 class="page-h">Pasar</h1>
    <div class="seg mview" role="group" aria-label="Tampilan pasar" id="mktView">
      <button type="button" data-v="watch">Daftar Pantau</button><button type="button" data-v="fund">Peringkat Fundamental</button>
    </div>
    <div id="mktWatch">
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Filter pasar" id="mktFilter">
        <button type="button" data-f="all">Semua</button><button type="button" data-f="saham">Saham</button><button type="button" data-f="crypto">Crypto</button>
      </div>
      <button type="button" class="btn" id="editBtn" aria-pressed="false">Ubah</button>
    </div>
    <div class="panel">
    <div class="grab" aria-hidden="true"></div>
    <div class="section-h first"><h2 id="mktTitle">Daftar pantauan</h2><span class="hint" id="mktHint">Tekan lama untuk hapus</span></div>
    <div id="mktList"></div>
    <form class="add-card" id="addForm" autocomplete="off" novalidate>
      <h3>Tambah aset</h3>
      <label class="field">${ICON.search}<input type="text" id="addSym" placeholder="Kode, mis. BBCA atau BTC" maxlength="20" autocapitalize="characters" spellcheck="false" enterkeyhint="done" aria-label="Kode simbol"></label>
      <div class="add-row">
        <div class="seg" role="group" aria-label="Jenis pasar" id="addMkt">
          <button type="button" data-m="saham">Saham</button><button type="button" data-m="crypto">Crypto</button>
        </div>
        <button type="submit" class="pill primary">${ICON.plus}Tambah</button>
      </div>
      <div class="form-err" id="addErr" role="alert" hidden></div>
      <p class="note" style="margin-bottom:0">Saham IDX cukup 4 huruf (BBCA). Crypto cukup kodenya (BTC → BTCUSDT).</p>
    </form>
    </div>
    </div>
    <div id="mktFund" hidden>${fundShellHTML()}</div>`;
}

// Pasar versi desktop: toolbar (filter + form tambah + ubah) di atas tabel lebar yang bisa diurutkan
function renderMarketShellDesk() {
  $('#view-market').innerHTML = `
    <div class="mk-head">
      <div class="seg mview" role="group" aria-label="Tampilan pasar" id="mktView">
        <button type="button" data-v="watch">Daftar Pantau</button><button type="button" data-v="fund">Peringkat Fundamental</button>
      </div>
    </div>
    <div id="mktWatch">
      <div class="dcard mk-card">
        <div class="mk-tools">
          <div class="seg" role="group" aria-label="Filter pasar" id="mktFilter">
            <button type="button" data-f="all">Semua</button><button type="button" data-f="saham">Saham</button><button type="button" data-f="crypto">Crypto</button>
          </div>
          <form class="add-inline" id="addForm" autocomplete="off" novalidate>
            <label class="field">${ICON.search}<input type="text" id="addSym" placeholder="Tambah kode, mis. BBCA atau BTC" maxlength="20" autocapitalize="characters" spellcheck="false" enterkeyhint="done" aria-label="Kode simbol"></label>
            <div class="seg" role="group" aria-label="Jenis pasar" id="addMkt">
              <button type="button" data-m="saham">Saham</button><button type="button" data-m="crypto">Crypto</button>
            </div>
            <button type="submit" class="pill primary">${ICON.plus}Tambah</button>
          </form>
          <button type="button" class="btn" id="editBtn" aria-pressed="false">Ubah</button>
        </div>
        <div class="form-err" id="addErr" role="alert" hidden></div>
        <div class="section-h"><h2 id="mktTitle">Daftar pantauan</h2><span class="hint" id="mktHint"></span></div>
        <div id="mktList"></div>
        <p class="note">Saham IDX cukup 4 huruf (BBCA). Crypto cukup kodenya (BTC → BTCUSDT). Klik judul kolom untuk mengurutkan, klik baris untuk membuka chart.</p>
      </div>
    </div>
    <div id="mktFund" hidden>${fundShellHTML()}</div>`;
}

// tombol judul kolom yang bisa diurutkan (aria-sort di <th>)
function sortTh(label, key, cur, attr, cls = '') {
  const on = cur.k === key;
  const sort = on ? (cur.dir > 0 ? 'ascending' : 'descending') : 'none';
  return `<th scope="col" class="${cls}" aria-sort="${sort}"><button type="button" class="th-btn" ${attr}="${esc(key)}">${label}<span class="th-ar" aria-hidden="true">${on ? (cur.dir > 0 ? '▲' : '▼') : '↕'}</span></button></th>`;
}
const ACT_ORDER = { BUY: 0, SELL: 1, HOLD: 2, WAIT: 3 };
const WSORT = {
  sym: { v: (it) => it.symbol, dir: 1 },
  market: { v: (it) => it.market, dir: 1 },
  price: { v: (it, r) => (r && !r.error ? r.price : null), dir: -1 },
  action: { v: (it, r) => (r && !r.error ? ACT_ORDER[act(r.action)] : null), dir: 1 },
  since: { v: (it, r) => sinceSig(r), dir: -1 },
  last: { v: (it, r) => (r && !r.error && r.last_signal ? r.last_signal.time : null), dir: -1 },
  score: { v: (it, r) => (r && !r.error && r.score != null ? Number(r.score) : null), dir: -1 },
};
// urutkan dengan nilai kosong selalu di bawah
function sortBy(list, val, dir) {
  return list.map((x, i) => [x, val(x), i]).sort((a, b) => {
    const na = a[1] == null || Number.isNaN(a[1]), nb = b[1] == null || Number.isNaN(b[1]);
    if (na || nb) return na === nb ? a[2] - b[2] : na ? 1 : -1;
    const c = typeof a[1] === 'string' ? a[1].localeCompare(b[1]) : a[1] - b[1];
    return c * dir || a[2] - b[2];
  }).map(x => x[0]);
}

function watchTableHTML(list) {
  const ws = state.wsort;
  const sorted = ws.k && WSORT[ws.k] ? sortBy(list, it => WSORT[ws.k].v(it, rowFor(it)), ws.dir) : list;
  const th = (l, k, c) => sortTh(l, k, ws, 'data-ws', c);
  const body = sorted.map(it => {
    const r = rowFor(it), s = esc(it.symbol), m = esc(it.market);
    const ok = r && !r.error;
    const name = ok ? r.name : r && r.error ? r.error : state.scanning ? '' : 'Belum di-scan';
    const load = !r && state.scanning;
    const ls = ok ? r.last_signal : null;
    const a = ok ? act(r.action) : null;
    const score = ok && r.score != null ? Number(r.score) : null;
    return `<tr class="trow" tabindex="0" data-s="${s}" data-m="${m}" aria-label="${s}${ok ? ', sinyal ' + esc(a) : ''}${state.edit ? '' : ', buka chart'}">
      <td><div class="t-asset">${avatar(it.symbol, 'sm')}<div class="t-id"><b>${s}</b><span class="${r && r.error ? 'neg' : ''}">${load ? '<span class="skel" style="width:110px"></span>' : esc(name)}</span></div></div></td>
      <td>${mkTag(it.market)}</td>
      <td class="num r">${ok ? `<b>${fmt(r.price, r.currency)}</b> <small class="muted">${esc(r.currency || '')}</small>` : load ? '<span class="skel" style="width:70px"></span>' : '<span class="muted">–</span>'}</td>
      <td>${ok ? `<span class="badge ${a}">${a}</span>` : r && r.error ? '<span class="badge ERR">ERROR</span>' : `<span class="badge LOAD">${load ? '···' : '—'}</span>`}</td>
      <td class="r">${ok ? chgPill(sinceSig(r)) : '<span class="muted">–</span>'}</td>
      <td>${ls ? `<span class="t-last"><b class="${ls.type === 'BUY' ? 'pos' : 'neg'}">${esc(ls.type)}</b> ${esc(date(ls.time, isIntraday(state.settings.interval)))}<small class="muted">${esc(ago(ls.time))} · @ <span class="mono">${fmt(ls.price, r.currency)}</span></small></span>` : '<span class="muted">–</span>'}</td>
      <td class="r">${score == null ? '<span class="muted">–</span>' : `<span class="t-score"><span class="mono ${score > 0 ? 'pos' : score < 0 ? 'neg' : ''}">${score > 0 ? '+' : ''}${esc(score)}</span><i class="t-meter"><i style="left:${Math.max(0, Math.min(100, (score + 100) / 2))}%"></i></i></span>`}</td>
      <td class="r">${state.edit
        ? `<button type="button" class="row-del sm" data-del="${s}" data-m="${m}" aria-label="Hapus ${s}">${ICON.trash}</button>`
        : `<span class="t-go" aria-hidden="true">${ICON.chev}</span>`}</td>
    </tr>`;
  }).join('');
  return `<div class="tscroll"><table class="dtable wtable">
    <thead><tr>${th('Aset', 'sym')}${th('Pasar', 'market')}${th('Harga', 'price', 'r')}${th('Sinyal', 'action')}${th('Sejak sinyal', 'since', 'r')}${th('Sinyal terakhir', 'last')}${th('Skor indikator', 'score', 'r')}<th scope="col" class="r">${state.edit ? 'Hapus' : 'Aksi'}</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function renderMarket() {
  for (const b of $$('#mktView button')) b.setAttribute('aria-pressed', String(b.dataset.v === state.mktView));
  $('#mktWatch').hidden = state.mktView !== 'watch';
  $('#mktFund').hidden = state.mktView !== 'fund';
  if (state.mktView === 'fund') return renderFund();
  for (const b of $$('#mktFilter button')) b.setAttribute('aria-pressed', String(b.dataset.f === state.filter));
  for (const b of $$('#addMkt button')) b.setAttribute('aria-pressed', String(b.dataset.m === state.addMarket));
  const eb = $('#editBtn');
  eb.textContent = state.edit ? 'Selesai' : 'Ubah';
  eb.setAttribute('aria-pressed', String(state.edit));
  eb.classList.toggle('on', state.edit);
  const list = state.watchlist.filter(w => state.filter === 'all' || w.market === state.filter);
  $('#mktTitle').textContent = `Daftar pantauan (${list.length})`;
  $('#mktHint').textContent = desk ? (state.edit ? 'Klik ikon tempat sampah untuk hapus' : '') : state.edit ? 'Ketuk ikon untuk hapus' : 'Tekan lama untuk hapus';
  $('#mktList').innerHTML = list.length
    ? desk ? watchTableHTML(list) : `<div class="list">${list.map(it => assetRow(it, { edit: state.edit })).join('')}</div>`
    : `<div class="empty"><b>Belum ada aset</b>${state.filter === 'all' ? 'Tambahkan kode saham atau crypto di bawah.' : 'Tidak ada aset di kategori ini.'}</div>`;
}

const mv = $('#view-market');
mv.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  const mvb = e.target.closest('#mktView [data-v]');
  if (mvb) {
    if (mvb.dataset.v === state.mktView) return;
    state.mktView = mvb.dataset.v === 'fund' ? 'fund' : 'watch';
    $('#greet').textContent = state.mktView === 'fund' ? 'Peringkat fundamental' : 'Daftar pantau';
    return renderMarket();
  }
  if (state.mktView === 'fund') return fundClick(e);
  const f = e.target.closest('#mktFilter [data-f]');
  if (f) { state.filter = f.dataset.f; return renderMarket(); }
  const m = e.target.closest('#addMkt [data-m]');
  if (m) { state.addMarket = m.dataset.m; return renderMarket(); }
  if (e.target.closest('#editBtn')) { state.edit = !state.edit; return renderMarket(); }
  const wsb = e.target.closest('[data-ws]');
  if (wsb) {
    const k = wsb.dataset.ws;
    if (!WSORT[k]) return;
    const ws = state.wsort;
    if (ws.k !== k) { ws.k = k; ws.dir = WSORT[k].dir; } else if (ws.dir === WSORT[k].dir) ws.dir = -ws.dir; else ws.k = null; // klik ke-3: urutan asli
    return renderMarket();
  }
  const del = e.target.closest('[data-del]');
  if (del) return confirmRemove(del.dataset.del, del.dataset.m);
  const row = e.target.closest('.row, .trow');
  if (row && !state.edit) openSymbol(row.dataset.s, row.dataset.m);
});
mv.addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#addSym'), err = $('#addErr');
  const symbol = input.value.trim().toUpperCase(), market = state.addMarket;
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  err.hidden = true;
  if (!symbol) return fail('Isi kode simbol dulu.');
  if (!validSym(symbol, market)) return fail('Kode simbol tidak valid (huruf/angka, maks 20 karakter).');
  if (state.watchlist.some(w => keyOf(w.symbol, w.market) === keyOf(symbol, market))) return fail(`${symbol} sudah ada di daftar.`);
  if (state.watchlist.length >= MAX_WATCHLIST) return fail(`Daftar pantauan maksimal ${MAX_WATCHLIST} simbol.`);
  const item = { symbol, market };
  state.watchlist.push(item);
  saveWatchlist();
  input.value = '';
  input.blur();
  if (state.filter !== 'all' && state.filter !== market) state.filter = 'all';
  renderMarket();
  toast(`${symbol} ditambahkan`);
  runScan([item]);
});
mv.addEventListener('input', e => { if (e.target.id === 'addSym') $('#addErr').hidden = true; });

function removeItem(symbol, market) {
  const k = keyOf(symbol, market);
  state.watchlist = state.watchlist.filter(w => keyOf(w.symbol, w.market) !== k);
  state.rows.delete(k);
  saveWatchlist();
  saveScanCache();
  if (state.current && keyOf(state.current.symbol, state.current.market) === k) {
    state.current = null; state.data = null; stopLive();
  }
  render(state.tab);
  updateTabBadge();
  toast(`${symbol} dihapus`);
}

// tekan lama pada baris -> konfirmasi hapus (tanpa swipe)
let pressTimer = 0, pressEl = null, pressXY = null, suppressClick = false;
function cancelPress() {
  clearTimeout(pressTimer);
  if (pressEl) pressEl.classList.remove('pressing');
  pressEl = null;
}
mv.addEventListener('pointerdown', e => {
  const row = e.target.closest('#mktList .row');
  if (!row || state.edit || e.target.closest('[data-del]')) return;
  cancelPress();
  pressEl = row; pressXY = [e.clientX, e.clientY];
  row.classList.add('pressing');
  pressTimer = setTimeout(() => {
    const r = pressEl; cancelPress();
    if (!r) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 700);
    if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) try { navigator.vibrate(15); } catch { /* abaikan */ }
    confirmRemove(r.dataset.s, r.dataset.m);
  }, 550);
});
mv.addEventListener('pointermove', e => {
  if (pressEl && pressXY && Math.hypot(e.clientX - pressXY[0], e.clientY - pressXY[1]) > 10) cancelPress();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => mv.addEventListener(t, cancelPress));
mv.addEventListener('contextmenu', e => { if (e.target.closest('.row')) e.preventDefault(); });

// enter/spasi pada baris (role=button) untuk keyboard
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && (e.target.classList.contains('row') || e.target.classList.contains('trow'))) {
    e.preventDefault(); e.target.click();
  }
});

// ---------------------------------------------------------------- fundamental (laporan keuangan)
const SUBS = [
  { k: 'quality', name: 'Kualitas', w: '35%' },
  { k: 'growth', name: 'Pertumbuhan', w: '25%' },
  { k: 'value', name: 'Valuasi', w: '25%' },
  { k: 'safety', name: 'Keamanan', w: '15%' },
];
const FSORTS = [{ v: 'score', name: 'Skor' }, ...SUBS.map(s => ({ v: s.k, name: s.name }))];
const pctTxt = (v, d = 1) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d).replace('.', ',')}%`);

// 45 saham besar + saham (IDX) di daftar pantau, kode tanpa .JK
function fundUniverse() {
  const out = [...F.UNIVERSE];
  for (const w of state.watchlist) {
    if (w.market !== 'saham') continue;
    const t = F.tickerOf(canon(w.symbol, 'saham'));
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function fundShellHTML() {
  return `
    <div class="hero plain fund-hero">
      <div class="hero-top"><div class="hero-k">Peringkat Fundamental</div><button type="button" class="link" data-fq="reload">${ICON.refresh}Muat ulang</button></div>
      <p class="note" style="margin-top:6px">Skor 0–100 dari laporan keuangan tahunan: kualitas laba, pertumbuhan, valuasi, dan keamanan utang. 45 saham besar (mirip LQ45, bukan daftar resmi) + saham di daftar pantau Anda.</p>
      <div id="fundHead"></div>
    </div>
    <div class="fund-warn"><b>Bukan ramalan harga.</b> Skor menilai kesehatan perusahaan, bukan memastikan sahamnya naik setahun ke depan. ${esc(btOneLiner())}</div>
    ${desk ? '<div class="fund-filters">' : ''}<div class="toolbar" style="margin-top:14px">
      <div class="seg" role="group" aria-label="Filter sektor" id="fundFilter">
        <button type="button" data-ff="all">Semua</button><button type="button" data-ff="bank">Bank</button><button type="button" data-ff="nonbank">Non-bank</button>
      </div>
    </div>
    <div class="fchips" role="group" aria-label="Urutkan menurut" id="fundSort">
      <span class="fchips-l">Urut:</span>${FSORTS.map(s => `<button type="button" data-fs="${s.v}">${esc(s.name)}</button>`).join('')}
    </div>${desk ? '</div>' : ''}
    <div class="panel" style="margin-top:12px">
      <div class="grab" aria-hidden="true"></div>
      <div id="fundList"></div>
    </div>
    <div class="group" style="margin-top:12px">
      <details class="acc"><summary>Seberapa bisa dipercaya? ${ICON.down}</summary><div class="acc-b">${btHTML()}</div></details>
      <details class="acc"><summary>Cara menghitung skor ${ICON.down}</summary><div class="acc-b">${methodHTML()}</div></details>
    </div>
    <p class="note" style="text-align:center;padding:0 8px">Data laporan keuangan: Yahoo Finance (tahunan, ±4 tahun terakhir). Bukan saran investasi.</p>`;
}

function btOneLiner() {
  const s = BT && BT.summary;
  if (!s || !s.cohorts) return '';
  const beat = s.avgTop > s.avgAll;
  const full = (BT.cohorts || []).filter(c => !c.partial);
  const span = full.length ? ` (${full[0].entry.slice(0, 4)}–${full[full.length - 1].exit.slice(0, 4)})` : '';
  return `Uji historis ${s.cohorts} tahun${span}: 10 saham skor tertinggi rata-rata ${pctTxt(s.avgTop)}/thn vs semua ${pctTxt(s.avgAll)} — ${beat ? 'sedikit lebih baik, tapi sampelnya kecil' : 'justru KALAH dari rata-rata'}.`;
}

const mon = d => new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { month: 'short', year: '2-digit', timeZone: 'UTC' });
function btHTML() {
  if (!BT || !Array.isArray(BT.cohorts)) return '<p>Hasil uji historis belum tersedia.</p>';
  const s = BT.summary || {};
  const rows = BT.cohorts.map(c => `
    <div class="tr bt${c.partial ? ' partial' : ''}" role="row">
      <span role="cell"><b>FY${esc(c.fy)}</b><small>${esc(mon(c.entry))} → ${esc(mon(c.exit))}${c.partial ? ` · berjalan ${esc(c.months)} bln` : ''}</small></span>
      <span role="cell" class="mono">${pctTxt(c.avgTop)}</span>
      <span role="cell" class="mono">${pctTxt(c.avgBottom)}</span>
      <span role="cell" class="mono">${pctTxt(c.avgAll)}</span>
      <span role="cell" class="mono">${c.spearman == null ? '–' : esc(c.spearman.toFixed(2).replace('.', ','))}</span>
    </div>`).join('');
  const verdict = s.avgSpearman != null && s.avgSpearman > 0.1 && s.avgTop > s.avgAll
    ? 'Ada sedikit hubungan positif antara skor dan kenaikan harga, tapi sampelnya terlalu kecil untuk diandalkan.'
    : 'Di periode ini skor fundamental <b>tidak</b> berhasil memilih saham yang naik lebih tinggi — saham berskor tinggi rata-rata malah kalah dari saham berskor rendah. Harga saham juga digerakkan harga komoditas, suku bunga, sentimen, dan ekspektasi yang belum tercermin di laporan.';
  return `
    <p>Kami menguji skor ini ke belakang: untuk tiap tahun buku, skor dihitung <b>hanya</b> dari laporan s/d tahun itu, lalu saham "dibeli" ±1 Mei tahun berikutnya (saat laporan tahunan sudah terbit) dan dilihat hasil harganya 12 bulan kemudian.</p>
    <div class="ttable" role="table" aria-label="Hasil uji historis skor fundamental">
      <div class="tr bt th" role="row"><span role="columnheader">Kohort</span><span role="columnheader">Top 10</span><span role="columnheader">Bawah 10</span><span role="columnheader">Semua</span><span role="columnheader">Korelasi</span></div>
      ${rows}
    </div>
    <p style="margin-top:10px"><b>Rata-rata ${esc(s.cohorts)} kohort penuh:</b> top 10 ${pctTxt(s.avgTop)}, bawah 10 ${pctTxt(s.avgBottom)}, semua ${pctTxt(s.avgAll)}. Korelasi peringkat skor ↔ return ${s.avgSpearman == null ? '–' : esc(s.avgSpearman.toFixed(2).replace('.', ','))} (1 = sempurna, 0 = tidak ada hubungan, negatif = berlawanan). Top 10 mengalahkan rata-rata semua saham di ${esc(s.topBeatAllCohorts)} dari ${esc(s.cohorts)} kohort; rata-rata ${esc(Math.round((s.avgHitRate || 0) * 100))}% saham top 10 naik lebih tinggi dari rata-rata.</p>
    <p>${verdict}</p>
    <p><b>Keterbatasan:</b></p>
    <ul>
      <li>Hanya ${esc(s.cohorts)} kohort tahunan dan ±45 saham — sampel sangat kecil, hasil bisa kebetulan.</li>
      <li>Return hanya dari harga, <b>belum termasuk dividen</b> (saham bank & batu bara membagi dividen besar).</li>
      <li>Daftar saham adalah daftar besar <b>hari ini</b> (bias survivorship): saham yang dulu besar lalu jatuh tidak ikut diuji.</li>
      <li>Yahoo hanya memberi ±4 tahun laporan, jadi kohort FY2022 dinilai tanpa data pertumbuhan; angka lama bisa sudah direvisi.</li>
      <li>Kohort berjalan (belum 12 bulan) tidak dihitung dalam rata-rata.</li>
    </ul>
    <p class="note">Dihitung ${esc(BT.generated)} oleh tests_js/fundamental_backtest.mjs.</p>`;
}

function methodHTML() {
  return `
    <p>Skor = <b>Kualitas 35%</b> + <b>Pertumbuhan 25%</b> + <b>Valuasi 25%</b> + <b>Keamanan 15%</b>. Tiap komponen dinilai 0–100 dengan garis lurus di antara dua ambang (di bawah ambang bawah = 0, di atas ambang atas = 100).</p>
    <ul>
      <li><b>Kualitas</b>: ROE (laba inti ÷ rata-rata ekuitas) 0%→20%, margin laba inti 0%→20%, arus kas operasi ÷ laba inti 0,5→1,2x (laba didukung uang kas?). Ekuitas negatif/sangat kecil: ROE tidak dipakai, diganti ROA 0%→10%. ROE sangat tinggi (mis. UNVR) tetap dinilai maksimal 100. Bank: ROE 0%→20% dan ROA 0%→2,5%.</li>
      <li><b>Pertumbuhan</b>: pertumbuhan pendapatan per tahun -5%→15%, pertumbuhan laba inti per tahun -10%→20% (masih rugi = 0, dari rugi/basis sangat kecil jadi laba = "turnaround", dibatasi 70), dan berapa tahun laba naik. Tahun yang tidak sebanding (tahun hilang, atau ada operasi dihentikan/dipisah seperti ADRO 2022→2023) dilewati, bukan dihitung sebagai penurunan.</li>
      <li><b>Valuasi</b>: PER 30x→8x (makin murah makin tinggi), PBV 5x→1x, PEG (PER ÷ pertumbuhan laba inti) 2,5→0,5 — hanya bila laba tumbuh ≥ 3%/thn, selain itu nilai rendah. PER memakai laba inti. Perusahaan rugi: PER & PEG = 0. Ambang dipilih di sekitar sebaran saham besar IDX (PER umumnya 8–20x).</li>
      <li><b>Keamanan</b>: utang ÷ ekuitas (DER) 2x→0,3x dan berapa tahun laba positif. Bank: DER tidak dipakai (utang bank = dana nasabah); diganti modal ÷ aset 8%→16%.</li>
    </ul>
    <p><b>Laba inti</b>: laba bersih bisa naik-turun karena pos sekali waktu (laba jual anak usaha, impairment) atau operasi yang dihentikan. Kami pakai: laba dari operasi berlanjut − pos tak biasa (data Yahoo). Angka "normalized income" Yahoo hanya dipakai kalau tandanya sama dan selisihnya wajar (≤ 50% pos tak biasa + 5% laba); kalau tidak (mis. GOTO 2023), dipakai hitungan kami sendiri. Khusus bank, pos "tak biasa" positif yang muncul tiap tahun (pemulihan kredit) dianggap rutin. Pertumbuhan &gt;200%, ekuitas kecil, tahun hilang, perubahan jumlah saham besar, dan laporan USD diberi tanda ⚠/catatan.</p>
    <p>PER memakai laba inti 12 bulan terakhir (TTM) bila tersedia, kalau tidak laba tahunan terakhir. Laporan dalam USD (mis. ADRO, ITMG, INCO, AMMN) dikonversi ke rupiah dengan kurs USD/IDR terkini. Komponen tanpa data dilewati; sub-skor tanpa data sama sekali diberi 50 (netral).</p>
    <p><b>Label:</b> ≥75 Fundamental kuat · 60–74 Cukup baik · 45–59 Biasa · &lt;45 Lemah.</p>`;
}

const bandCls = key => ({ strong: 'f-strong', good: 'f-good', avg: 'f-avg', weak: 'f-weak' }[key] || 'f-avg');

function startFund(fresh = false) {
  const f = state.fund;
  const list = fundUniverse();
  const seq = ++f.seq;
  if (fresh) f.rows.clear();
  const todo = [];
  for (const t of list) {
    if (!fresh && f.rows.has(t) && !f.rows.get(t).error) continue;
    const hit = fresh ? null : F.cachedFundamental(t);
    if (hit) f.rows.set(t, hit); else todo.push(t);
  }
  f.total = list.length;
  f.done = list.length - todo.length;
  if (!todo.length) { f.loading = false; return; }
  f.loading = true;
  F.loadMany(todo, (t, res, err) => {
    if (seq !== f.seq) return;
    f.rows.set(t, res || { ticker: t, error: err || 'Gagal memuat.' });
    f.done++;
    scheduleRender();
  }, { concurrency: 4, fresh }).finally(() => {
    if (seq !== f.seq) return;
    f.loading = false;
    scheduleRender();
  });
}

function renderFund() {
  const f = state.fund;
  const list = fundUniverse();
  if (!f.loading && list.some(t => !f.rows.has(t))) startFund();
  for (const b of $$('#fundFilter button')) b.setAttribute('aria-pressed', String(b.dataset.ff === f.filter));
  for (const b of $$('#fundSort button')) b.setAttribute('aria-pressed', String(b.dataset.fs === f.sort && f.dir < 0));
  const rows = list.map(t => f.rows.get(t)).filter(Boolean);
  const ok = rows.filter(r => !r.error), errs = rows.filter(r => r.error);
  $('#fundHead').innerHTML = f.loading
    ? `<div class="fund-prog"><span class="scan-txt">Memuat laporan keuangan <b class="mono">${f.done}/${f.total}</b></span></div>
       <div class="progress" aria-hidden="true"><i style="width:${f.total ? Math.round(f.done / f.total * 100) : 0}%"></i></div>`
    : `<div class="fund-prog">${ok.length} saham dinilai${errs.length ? ` · <span class="neg">${errs.length} gagal</span>` : ''}${ok.length ? ` · data ${esc(clock(Math.min(...ok.map(r => r.at))))}, disimpan 24 jam` : ''}</div>`;
  const byFilter = r => f.filter === 'all' || (f.filter === 'bank' ? r.bank : !r.bank);
  if (desk) {
    const shownErr = errs.filter(r => f.filter === 'all' || (f.filter === 'bank' ? F.isBank(r.ticker) : !F.isBank(r.ticker)));
    const pending = f.loading ? list.filter(t => !f.rows.has(t)).filter(t => f.filter === 'all' || (f.filter === 'bank' ? F.isBank(t) : !F.isBank(t))) : [];
    const shown = ok.filter(byFilter);
    $('#fundList').innerHTML = shown.length || shownErr.length || pending.length
      ? fundTableHTML(shown, shownErr, pending)
      : '<div class="empty"><b>Belum ada data</b>Klik Muat ulang untuk mengambil laporan keuangan.</div>';
    return;
  }
  const sortKey = FSORTS.some(s => s.v === f.sort) ? f.sort : 'score'; // kolom khusus tabel desktop -> skor
  const key = r => (sortKey === 'score' ? r.score : (r.sub || {})[sortKey]) ?? -1;
  const shown = ok.filter(byFilter).sort((a, b) => key(b) - key(a) || b.score - a.score || a.ticker.localeCompare(b.ticker));
  const shownErr = errs.filter(r => f.filter === 'all' || (f.filter === 'bank' ? F.isBank(r.ticker) : !F.isBank(r.ticker)));
  const pending = f.loading ? list.filter(t => !f.rows.has(t)).filter(t => f.filter === 'all' || (f.filter === 'bank' ? F.isBank(t) : !F.isBank(t))) : [];
  const row = (r, i) => {
    const t = esc(r.ticker), bc = bandCls(r.band && r.band.key);
    const val = sortKey === 'score' ? r.score : (r.sub || {})[sortKey];
    return `<div class="row frow" role="button" tabindex="0" data-s="${t}" data-m="saham" aria-label="Peringkat ${i + 1}, ${t}, skor ${esc(r.score)}, ${esc(r.band && r.band.label)}">
      <span class="frank mono">${i + 1}</span>
      ${avatar(r.ticker)}
      <div class="row-main"><div class="row-t"><span class="sym">${t}</span><span class="mk sec">${esc(r.sector)}</span>${warnChip(r)}</div><div class="row-s">${esc(r.reason)}</div></div>
      <div class="row-r"><span class="fscore ${bc}">${esc(val)}</span><span class="fband">${sortKey === 'score' ? esc(r.band && r.band.label) : esc((FSORTS.find(s => s.v === sortKey) || {}).name)}</span></div></div>`;
  };
  const errRow = r => `<div class="row frow" role="button" tabindex="0" data-s="${esc(r.ticker)}" data-m="saham" aria-label="${esc(r.ticker)}, gagal dimuat">
      <span class="frank mono">–</span>${avatar(r.ticker)}
      <div class="row-main"><div class="row-t"><span class="sym">${esc(r.ticker)}</span><span class="mk sec">${esc(F.sectorOf(r.ticker))}</span></div><div class="row-s neg">${esc(r.error)}</div></div>
      <div class="row-r"><span class="badge ERR">ERROR</span></div></div>`;
  const skel = t => `<div class="row frow"><span class="frank mono">·</span>${avatar(t)}<div class="row-main"><div class="row-t"><span class="sym">${esc(t)}</span></div><div class="row-s"><span class="skel" style="width:150px"></span></div></div><div class="row-r"><span class="badge LOAD">···</span></div></div>`;
  $('#fundList').innerHTML = shown.length || shownErr.length || pending.length
    ? `<div class="list">${shown.map(row).join('')}${pending.slice(0, 6).map(skel).join('')}${shownErr.map(errRow).join('')}</div>
       ${pending.length > 6 ? `<p class="note" style="text-align:center">+${pending.length - 6} saham lagi sedang dimuat…</p>` : ''}`
    : '<div class="empty"><b>Belum ada data</b>Ketuk Muat ulang untuk mengambil laporan keuangan.</div>';
}

// tabel peringkat fundamental (desktop)
const nigOf = m => (m.core <= 0 || m.turnaround ? null : m.niCagr != null ? m.niCagr : m.niYoY);
const FCOLS = {
  ticker: { v: r => r.ticker, dir: 1 },
  sector: { v: r => r.sector || '', dir: 1 },
  score: { v: r => r.score, dir: -1 },
  ...Object.fromEntries(SUBS.map(s => [s.k, { v: r => ((r.missing || []).includes(s.k) ? null : (r.sub || {})[s.k]), dir: -1 }])),
  roe: { v: r => (r.metrics || {}).roe, dir: -1 },
  nig: { v: r => nigOf(r.metrics || {}), dir: -1 },
  per: { v: r => (r.metrics || {}).per, dir: 1 },
  pbv: { v: r => (r.metrics || {}).pbv, dir: 1 },
  warn: { v: r => warnFlags(r).length, dir: -1 },
};
const xTxt = v => (v == null || !Number.isFinite(v) ? '–' : `${v >= 100 ? v.toFixed(0) : v.toFixed(1).replace('.', ',')}x`);
function subCell(v, miss) {
  if (miss || v == null) return '<td class="r"><span class="muted">–</span></td>';
  const bc = bandCls(F.bandOf(v).key);
  return `<td class="r"><span class="t-sub ${bc}"><b class="mono">${esc(v)}</b><i><i style="width:${Math.max(2, Math.min(100, Number(v) || 0))}%"></i></i></span></td>`;
}
function fundTableHTML(shown, errRows, pending) {
  const f = state.fund;
  const col = FCOLS[f.sort] ? f.sort : 'score';
  const base = shown.slice().sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker)); // tie-break: skor
  const sorted = sortBy(base, FCOLS[col].v, f.dir || -1);
  const cur = { k: col, dir: f.dir || -1 };
  const th = (l, k, c = '') => sortTh(l, k, cur, 'data-ft', c);
  const rows = sorted.map((r, i) => {
    const m = r.metrics || {}, t = esc(r.ticker), bc = bandCls(r.band && r.band.key);
    const nig = nigOf(m);
    const nigTxt = m.core <= 0 ? '<span class="neg">rugi</span>' : m.turnaround ? '<span class="muted">turnaround</span>' : nig == null ? '<span class="muted">–</span>' : `<span class="${nig >= 0 ? 'pos' : 'neg'}">${pctTxt(nig, 0)}</span>`;
    return `<tr class="trow" tabindex="0" data-s="${t}" data-m="saham" aria-label="Peringkat ${i + 1}, ${t}, skor ${esc(r.score)}, buka chart">
      <td class="t-rank mono">${i + 1}</td>
      <td><div class="t-asset">${avatar(r.ticker, 'sm')}<div class="t-id"><b>${t}</b><span>${esc(r.name || '')}</span></div></div></td>
      <td><span class="mk sec">${esc(r.sector)}</span></td>
      <td class="r"><span class="fscore ${bc}" title="${esc(r.band && r.band.label)}">${esc(r.score)}</span></td>
      ${SUBS.map(s => subCell((r.sub || {})[s.k], (r.missing || []).includes(s.k))).join('')}
      <td class="r mono">${m.roeNA ? '<span class="muted">n/a</span>' : m.roe == null ? '<span class="muted">–</span>' : esc((m.roe * 100).toFixed(1).replace('.', ',') + '%')}</td>
      <td class="r mono">${nigTxt}</td>
      <td class="r mono">${m.loss ? '<span class="neg">rugi</span>' : esc(xTxt(m.per))}</td>
      <td class="r mono">${esc(xTxt(m.pbv))}</td>
      <td class="c">${warnChip(r) || '<span class="muted">–</span>'}</td>
    </tr>`;
  }).join('');
  const errs = errRows.map(r => `<tr class="trow" tabindex="0" data-s="${esc(r.ticker)}" data-m="saham" aria-label="${esc(r.ticker)}, gagal dimuat">
      <td class="t-rank mono">–</td><td><div class="t-asset">${avatar(r.ticker, 'sm')}<div class="t-id"><b>${esc(r.ticker)}</b><span class="neg">${esc(r.error)}</span></div></div></td>
      <td><span class="mk sec">${esc(F.sectorOf(r.ticker))}</span></td><td class="r"><span class="badge ERR">ERROR</span></td><td colspan="9"></td></tr>`).join('');
  const skel = pending.slice(0, 6).map(t => `<tr><td class="t-rank mono">·</td><td><div class="t-asset">${avatar(t, 'sm')}<div class="t-id"><b>${esc(t)}</b><span><span class="skel" style="width:120px"></span></span></div></div></td><td colspan="11"><span class="skel" style="width:60%"></span></td></tr>`).join('');
  return `<div class="tscroll"><table class="dtable ftable">
    <thead><tr><th scope="col" class="t-rank">#</th>${th('Saham', 'ticker')}${th('Sektor', 'sector')}${th('Skor', 'score', 'r')}${SUBS.map(s => th(s.name, s.k, 'r')).join('')}${th('ROE', 'roe', 'r')}${th('Laba inti tumbuh', 'nig', 'r')}${th('PER', 'per', 'r')}${th('PBV', 'pbv', 'r')}${th('⚠', 'warn', 'c')}</tr></thead>
    <tbody>${rows}${skel}${errs}</tbody></table></div>
    ${pending.length > 6 ? `<p class="note" style="text-align:center">+${pending.length - 6} saham lagi sedang dimuat…</p>` : ''}`;
}

function fundClick(e) {
  const f = state.fund;
  const ft = e.target.closest('[data-ft]');
  if (ft) {
    const k = ft.dataset.ft;
    if (!FCOLS[k]) return;
    if (f.sort === k) f.dir = -(f.dir || -1); else { f.sort = k; f.dir = FCOLS[k].dir; }
    return renderFund();
  }
  const ff = e.target.closest('[data-ff]');
  if (ff) { f.filter = ff.dataset.ff; return renderFund(); }
  const fs = e.target.closest('[data-fs]');
  if (fs) { f.sort = FSORTS.some(s => s.v === fs.dataset.fs) ? fs.dataset.fs : 'score'; f.dir = -1; return renderFund(); }
  if (e.target.closest('[data-fq="reload"]')) { startFund(true); return renderFund(); }
  const row = e.target.closest('.frow[data-s], .trow[data-s]');
  if (row) openSymbol(row.dataset.s, 'saham');
}

// ---- kartu Fundamental di tab Chart (saham saja)
function ensureFundCur(symbol, fresh = false) {
  const fc = state.fundCur;
  const key = F.yahooSym(canon(symbol, 'saham'));
  if (fc.key === key && (fc.data || fc.loading || fc.error)) return;
  const seq = ++fc.seq;
  fc.key = key; fc.error = null;
  fc.data = fresh ? null : F.cachedFundamental(key);
  if (fc.data) return paintFundCard();
  fc.loading = true;
  paintFundCard();
  F.loadFundamental(key, { fresh }).then(r => {
    if (seq !== fc.seq) return;
    fc.data = r;
    state.fund.rows.set(r.ticker, r);
  }).catch(e => {
    if (seq !== fc.seq) return;
    fc.error = e && e.message ? e.message : 'Gagal memuat laporan keuangan.';
  }).finally(() => {
    if (seq !== fc.seq) return;
    fc.loading = false;
    paintFundCard();
  });
}
function paintFundCard() {
  const el = $('#fundCard');
  if (el && state.tab === 'chart') el.innerHTML = fundCardHTML();
}

// angka besar ringkas: 1,2 T (triliun), 450 M (miliar), 12 jt
function big(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const [d, u] = a >= 1e12 ? [1e12, ' T'] : a >= 1e9 ? [1e9, ' M'] : a >= 1e6 ? [1e6, ' jt'] : [1, ''];
  const x = v / d;
  return x.toLocaleString('id-ID', { maximumFractionDigits: Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2 }) + u;
}

// Bar per tahun. key = seri utama (padat, berlabel); ghost = seri pembanding (garis tepi, mis. laba dilaporkan).
function miniBars(years, key, title, color, ghost = null) {
  const vals = years.flatMap(y => [y[key], ghost ? y[ghost] : null]).filter(v => v != null && Number.isFinite(v));
  if (!vals.length) return '';
  const W = 160, H = 96, top = 14, bot = 16, plot = H - top - bot;
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const span = max - min || 1;
  const y0 = top + (max / span) * plot;
  const n = years.length, slot = W / n, bw = Math.min(ghost ? 14 : 26, slot * (ghost ? 0.36 : 0.55));
  const rect = (v, x, solid) => {
    const h = Math.max(1.5, Math.abs(v) / span * plot), yTop = v >= 0 ? y0 - h : y0;
    const c = v < 0 ? 'var(--sell)' : color;
    return [`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" ${solid ? `fill="${c}"` : `fill="none" stroke="${c}" stroke-width="1.2" stroke-dasharray="2 2"`}/>`, yTop];
  };
  const bars = years.map((y, i) => {
    const v = y[key], g = ghost ? y[ghost] : null, cx = slot * i + slot / 2;
    let out = `<text x="${cx}" y="${H - 3}" text-anchor="middle" class="mb-x">${esc(String(y.fy).slice(2))}</text>`;
    const tip = `FY${y.fy}: ${big(v)}${ghost ? ` (dilaporkan ${big(g)})` : ''}`;
    if (g != null && Number.isFinite(g)) out += rect(g, cx - bw - 1, false)[0];
    if (v != null && Number.isFinite(v)) {
      const [r, yTop] = rect(v, ghost ? cx + 1 : cx - bw / 2, true);
      const lx = ghost ? cx + 1 + bw / 2 : cx;
      out += `<g>${r}<title>${esc(tip)}</title></g><text x="${lx.toFixed(1)}" y="${(v < 0 ? y0 - 3 : yTop - 3).toFixed(1)}" text-anchor="middle" class="mb-v">${esc(big(v))}</text>`;
    }
    return out;
  }).join('');
  return `<figure class="mbar"><figcaption>${esc(title)}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)} per tahun: ${esc(years.map(y => `FY${y.fy} ${big(y[key])}${ghost ? ` (dilaporkan ${big(y[ghost])})` : ''}`).join(', '))}">
      <line x1="0" x2="${W}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="rgba(255,255,255,.14)"/>${bars}</svg></figure>`;
}

// chip ⚠ + daftar peringatan data (flags dari fundamental.js)
const warnFlags = r => ((r && r.metrics && r.metrics.flags) || []).filter(f => f.level === 'warn');
function warnChip(r) {
  const w = warnFlags(r);
  if (!w.length) return '';
  const txt = w.map(f => f.text).join(' ');
  return `<span class="fwarn" title="${esc(txt)}" aria-label="Peringatan data: ${esc(txt)}">⚠${w.length > 1 ? esc(w.length) : ''}</span>`;
}

function flagsHTML(m) {
  const fl = (m && m.flags) || [];
  if (!fl.length) return '';
  return `<details class="fflags"${fl.some(f => f.level === 'warn') ? ' open' : ''}><summary>${fl.some(f => f.level === 'warn') ? '⚠ ' : ''}Catatan data (${esc(fl.length)}) ${ICON.down}</summary>
    <ul>${fl.map(f => `<li class="${f.level === 'warn' ? 'w' : ''}">${esc(f.text)}</li>`).join('')}</ul></details>`;
}

function fundCardHTML() {
  const fc = state.fundCur;
  const same = state.current && fc.key === F.yahooSym(canon(state.current.symbol, 'saham'));
  const r = same ? fc.data : null;
  if (same && fc.error && !r) {
    return `<div class="card fund"><h3>Analisa fundamental</h3><p class="note" style="margin-top:0">Data laporan keuangan tidak tersedia: ${esc(fc.error)}</p>
      <button type="button" class="pill ghost more-trades" data-c="fundretry">${ICON.refresh}Coba lagi</button></div>`;
  }
  if (!r) {
    return `<div class="card fund"><h3>Analisa fundamental</h3><span class="skel" style="width:45%;height:28px"></span><br><br>
      <span class="skel" style="width:90%"></span><br><br><span class="skel" style="width:75%"></span></div>`;
  }
  const m = r.metrics || {}, bc = bandCls(r.band && r.band.key);
  const a = state.data ? act(state.data.action) : null;
  const subs = SUBS.map(s => {
    const v = (r.sub || {})[s.k], miss = (r.missing || []).includes(s.k);
    return `<div class="fsub"><span>${esc(s.name)} <small>${esc(s.w)}</small></span>
      <div class="fsub-bar"><i class="${bc}" style="width:${Math.max(2, Math.min(100, Number(v) || 0))}%"></i></div>
      <b class="mono">${miss ? '–' : esc(v)}</b></div>`;
  }).join('');
  const kv = (r.verdicts || []).map(x => `<div class="kv fkv t-${esc(x.tone)}"><div class="k">${esc(x.label)}</div><div class="v mono">${esc(x.value)}</div><div class="fv">${esc(x.verdict)}</div></div>`).join('');
  const years = Array.isArray(m.years) ? m.years : [];
  const curNote = m.currency && r.priceCurrency && m.currency !== r.priceCurrency
    ? ` Laporan dalam ${esc(m.currency)}; valuasi dikonversi ke ${esc(r.priceCurrency)} (kurs ${esc(fmt(m.fx > 1 ? m.fx : m.fx ? 1 / m.fx : null, 'IDR'))}).` : '';
  const missNote = (r.missing || []).length ? ` Sub-skor tanpa data (–) dihitung netral 50.` : '';
  return `<div class="card fund">
    <div class="fund-top">
      <div><div class="sig-lbl">Analisa fundamental</div>
        <div class="fund-big"><b class="${bc}-t">${esc(r.score)}</b><small>/100</small></div>
        <div class="fund-band ${bc}-t">${esc(r.band && r.band.label)}</div></div>
      <div class="fund-ring ${bc}" style="--p:${Math.max(0, Math.min(100, Number(r.score) || 0))}" aria-hidden="true"><span>${esc(r.sector)}</span></div>
    </div>
    <p class="fund-reason">${esc(r.reason)} ${warnChip(r)}</p>
    <div class="fsubs">${subs}</div>
    <div class="kv-grid" style="margin-top:14px">${kv}</div>
    ${years.length ? `<div class="mbars">${miniBars(years, 'rev', `Pendapatan (${m.currency || ''})`, 'var(--blue)')}${miniBars(years, 'core', `Laba inti (${m.currency || ''})`, 'var(--buy)', 'ni')}</div>
      <p class="note mb-legend"><span><i class="lg-solid"></i> Laba inti (tanpa pos sekali waktu)</span><span><i class="lg-ghost"></i> Laba bersih (dilaporkan)</span></p>` : ''}
    <p class="note">Laba inti = laba dari usaha yang berlanjut, tanpa pos sekali waktu (jual aset/anak usaha, impairment, dll.). Semua rasio & skor memakai laba inti.</p>
    ${flagsHTML(m)}
    <p class="note">Data: laporan keuangan tahunan s/d FY${esc(m.fy)} (Yahoo Finance)${m.ttm ? `, laba 12 bln s/d ${esc(m.ttmDate)} untuk PER` : ''}. Harga ${esc(fmt(m.price, r.priceCurrency))}.${curNote}${missNote}</p>
    ${a ? `<div class="fund-tech"><span>Sinyal teknikal saat ini:</span><span class="badge ${a}">${a}</span><span class="muted">${esc(LABEL[a])} · ${esc(ivName(state.data.interval))}</span></div>
      <p class="note" style="margin-top:6px">Fundamental = pilih saham apa. Teknikal = kapan beli/jual.</p>` : ''}
    <p class="note">Skor menilai laporan keuangan, <b>bukan ramalan harga</b>.</p>
    <button type="button" class="pill ghost more-trades" data-c="fundrank">Lihat peringkat & uji historisnya</button>
  </div>`;
}

// ---------------------------------------------------------------- tab Chart
async function loadDetail(fresh = false) {
  const cur = state.current;
  if (!cur) return;
  const seq = ++state.selSeq;
  state.detailLoading = true;
  state.detailError = null;
  if (state.tab === 'chart') {
    const d = $('#detail');
    if (d && state.data) d.classList.add('loading-veil'); else renderChart();
  }
  try {
    const d = await analyzeSymbol(cur.symbol, cur.market, state.chartInterval, optsOf(), { fresh, withCandles: true });
    if (seq !== state.selSeq) return;
    state.data = d;
    state.dataAt = Date.now();
  } catch (e) {
    if (seq !== state.selSeq) return;
    stopLive();
    state.data = null;
    state.detailError = e && e.message ? e.message : 'Gagal memuat data.';
  } finally {
    if (seq === state.selSeq) {
      state.detailLoading = false;
      if (state.tab === 'chart') renderChart();
    }
  }
}

function chartHead(title, sub, withMenu) {
  return `<div class="det-head">
      <button type="button" class="icon-btn round" data-c="back" aria-label="Kembali">${ICON.back}</button>
      <div class="det-title"><h1>${title}</h1>${sub ? `<div class="name">${sub}</div>` : ''}</div>
      ${withMenu ? `<button type="button" class="icon-btn round" data-c="switch" aria-label="Ganti aset">${ICON.dots}</button>` : '<span class="det-sp"></span>'}
    </div>`;
}

function renderChart() {
  const view = $('#view-chart');
  const cur = state.current;
  if (!cur) {
    stopLive(); destroyCharts();
    view.innerHTML = `
      ${chartHead('Chart', 'Pilih aset', false)}
      <div class="hero plain">
        <div class="hero-k">Chart & analisa</div>
        <p class="note" style="margin-top:6px">Pilih salah satu aset untuk melihat sinyal, chart, rencana posisi, dan hasil backtest.</p>
      </div>
      ${state.watchlist.length
        ? `<div class="picker-grid">${pickButtons('pick')}</div>`
        : '<div class="empty" style="margin-top:14px"><b>Daftar pantauan kosong</b>Tambahkan aset di tab Pasar.</div>'}`;
    return;
  }
  const d = state.data;
  const scanRow = rowFor(cur);
  const name = d ? d.name : scanRow && !scanRow.error ? scanRow.name : '';
  const iv = state.chartInterval;

  let priceHtml;
  if (d) {
    const ls = (d.signals || [])[(d.signals || []).length - 1];
    const ch = ls && ls.price ? (d.price / ls.price - 1) * 100 : null;
    priceHtml = `<div class="price-line"><span class="price-sym">${esc(cur.symbol)} =</span><span class="price-big" id="livePrice">${fmt(d.price, d.currency)}</span>
      <span class="price-cur">${esc(d.currency)}</span>
      ${d.market === 'crypto' ? '<span class="live off" id="liveBadge"><i></i><span>MENYAMBUNG…</span></span>' : ''}</div>
      <div class="price-chg">${ls ? `<span id="liveChg">${chgPill(ch)}</span><span>sejak ${esc(ls.type)} ${esc(date(ls.time, isIntraday(d.interval)))}</span>` : '<span>Belum ada sinyal di periode ini</span>'}</div>
      <div class="price-note">${d.market === 'crypto'
        ? `Sinyal dari candle yang sudah close (${esc(date(d.time, isIntraday(d.interval)))}).`
        : `Candle terakhir ${esc(date(d.time, isIntraday(d.interval)))} · tertunda ±15 menit`}</div>`;
  } else {
    priceHtml = `<div class="price-line"><span class="skel" style="width:200px;height:34px"></span></div>`;
  }

  let body;
  if (state.detailError) {
    body = `<div class="err-card"><b>${esc(cur.symbol)}</b>: ${esc(state.detailError)}</div>
      <button type="button" class="pill" style="width:100%;margin-top:10px" data-c="retry">${ICON.refresh}Coba lagi</button>`;
  } else if (!d) {
    body = `<div class="card"><span class="skel" style="width:40%;height:14px"></span><br><br><span class="skel" style="width:90%"></span><br><br><span class="skel" style="width:70%"></span></div>
      <div class="card" style="height:300px"></div>`;
  } else {
    body = detailHTML(d);
  }

  stopLive(); destroyCharts();
  const sub = `${esc(name || (cur.market === 'crypto' ? 'Crypto' : 'Saham'))} · ${cur.market === 'crypto' ? 'CRYPTO' : 'IDX'}`;
  if (desk) view.innerHTML = chartDeskHTML({ cur, d, name, iv, priceHtml });
  else view.innerHTML = `
    ${chartHead(esc(cur.symbol), sub, true)}
    <div class="seg tf" role="group" aria-label="Timeframe chart">
      ${INTERVALS.map(i => `<button type="button" data-iv="${i.v}" aria-pressed="${i.v === iv}">${i.chip}</button>`).join('')}
    </div>
    ${priceHtml}
    <div id="detail" class="${state.detailLoading && d ? 'loading-veil' : ''}">${body}</div>`;

  if (d && !state.detailError) {
    drawCharts(d);
    startLive(d);
  }
  if (cur.market === 'saham') ensureFundCur(cur.symbol);
  if (cur.market === 'crypto' && d && !state.detailError) ensureHl();
}

// Chart versi desktop: kiri = header + chart tinggi, kanan (sticky) = sinyal & analisa, bawah = riwayat
function chartDeskHTML({ cur, d, name, iv, priceHtml }) {
  const tfBar = `<div class="seg tf" role="group" aria-label="Timeframe chart">
      ${INTERVALS.map(i => `<button type="button" data-iv="${i.v}" aria-pressed="${i.v === iv}">${i.chip}</button>`).join('')}
    </div>`;
  const head = `<div class="c-head">
      <div class="c-id">${avatar(cur.symbol)}<div class="c-title"><h1>${esc(cur.symbol)} ${mkTag(cur.market)}</h1>
        <div class="name">${esc(name || (cur.market === 'crypto' ? 'Crypto' : 'Saham IDX'))}</div></div></div>
      <button type="button" class="btn" data-c="switch">${ICON.dots}Ganti aset</button>
    </div>${priceHtml}`;
  const veil = state.detailLoading && d ? ' loading-veil' : '';
  if (state.detailError) {
    return `<div id="detail" class="cdesk"><div class="c-top"><div class="c-main">${head}
      <div class="card c-tf">${tfBar}</div>
      <div class="err-card"><b>${esc(cur.symbol)}</b>: ${esc(state.detailError)}</div>
      <button type="button" class="pill" style="margin-top:12px" data-c="retry">${ICON.refresh}Coba lagi</button></div></div></div>`;
  }
  if (!d) {
    const sk = w => `<div class="card"><span class="skel" style="width:40%;height:14px"></span><br><br><span class="skel" style="width:${w}%"></span><br><br><span class="skel" style="width:70%"></span></div>`;
    return `<div id="detail" class="cdesk"><div class="c-top">
      <div class="c-main">${head}<div class="card chart-card"><div class="chart-bar">${tfBar}</div><div class="c-chart-skel"></div></div></div>
      <aside class="c-side">${sk(90)}${sk(80)}${sk(60)}</aside></div></div>`;
  }
  const P = detailParts(d, { tfBar });
  return `<div id="detail" class="cdesk${veil}">
    <div class="c-top">
      <div class="c-main">${head}${P.chart}</div>
      <aside class="c-side" aria-label="Sinyal dan analisa ${esc(cur.symbol)}">${P.sig}${P.gauge}${P.plan}${P.reasons}${P.fund}${P.hl}${P.backtest}</aside>
    </div>
    <div class="c-full">${tradesDeskHTML(d)}${P.foot}</div>
  </div>`;
}

function tradesDeskHTML(d) {
  const cur = d.currency, iv = isIntraday(d.interval);
  const trades = (d.trades || []).slice().reverse();
  const shown = state.showAllTrades ? trades : trades.slice(0, 12);
  const body = shown.map((t, i) => `<tr>
      <td class="t-rank mono">${trades.length - i}</td>
      <td>${esc(date(t.entry_time, iv))}</td>
      <td class="r mono"><b>${fmt(t.entry_price, cur)}</b></td>
      <td>${t.open ? '<span class="muted">Belum jual · sekarang</span>' : esc(date(t.exit_time, iv))}</td>
      <td class="r mono"><b>${fmt(t.exit_price, cur)}</b></td>
      <td class="r">${chgPill(t.return_pct)}</td>
      <td class="r">${t.open ? '<span class="badge HOLD">PEGANG</span>' : `<span class="badge ${Number(t.return_pct) >= 0 ? 'BUY' : 'SELL'}">${Number(t.return_pct) >= 0 ? 'UNTUNG' : 'RUGI'}</span>`}</td>
    </tr>`).join('');
  return `<div class="card">
    <div class="section-h first"><h2>Riwayat sinyal BUY → SELL <span class="count">${trades.length}</span></h2><span class="hint">${esc((STRATEGIES[(d.params || {}).strategy] || {}).name || '')} · ${esc(ivName(d.interval))}</span></div>
    ${trades.length ? `<div class="tscroll"><table class="dtable htable" aria-label="Riwayat sinyal">
      <thead><tr><th scope="col" class="t-rank">#</th><th scope="col">Tanggal beli</th><th scope="col" class="r">Harga beli</th><th scope="col">Tanggal jual</th><th scope="col" class="r">Harga jual</th><th scope="col" class="r">Hasil</th><th scope="col" class="r">Status</th></tr></thead>
      <tbody>${body}</tbody></table></div>` : '<div class="empty">Belum ada trade di periode ini.</div>'}
    ${trades.length > shown.length ? `<button type="button" class="pill ghost more-trades" data-c="alltrades">Tampilkan semua (${trades.length})</button>` : ''}
  </div>`;
}

// ---- kartu Posisi Trader Top Hyperliquid (crypto saja; sentimen read-only)
function ensureHl(fresh = false) {
  const h = state.hl;
  if (h.loading) return;
  if (!fresh && h.data && Date.now() - h.data.at < 5 * 60e3) return;
  if (!fresh && h.error && Date.now() - h.errorAt < 60e3) return;
  h.loading = true;
  if (fresh) { h.error = null; paintHl(); }
  loadSentiment(50, { fresh }).then(r => { h.data = r; h.error = null; })
    .catch(e => { h.error = e && e.message ? e.message : 'Gagal memuat data Hyperliquid.'; h.errorAt = Date.now(); })
    .finally(() => { h.loading = false; paintHl(); });
}
function hlCard() {
  const d = state.data;
  try {
    return hlCardHTML({ hl: state.hl, symbol: state.current.symbol, action: d && d.action, price: d && d.price, currency: d && d.currency, listOpen: state.hl.listOpen });
  } catch (e) {
    return `<div class="card hl"><h3>Posisi Trader Top Hyperliquid</h3><p class="note">Tidak bisa ditampilkan: ${esc(e && e.message)}</p></div>`;
  }
}
function paintHl() {
  const el = $('#hlCard');
  if (el && state.tab === 'chart') el.innerHTML = hlCard();
  if (state.tab === 'signal') scheduleRender();
}

function detailParts(d, { tfBar = '' } = {}) {
  const cur = d.currency, p = d.plan || {}, b = d.backtest || {}, n = d.indicators_now || {};
  const params = d.params || {};
  const a = act(d.action);
  const iv = isIntraday(d.interval);
  const holding = a === 'HOLD' || a === 'BUY';
  const signals = d.signals || [];
  const lastSig = signals[signals.length - 1];
  const score = Number(d.score) || 0;
  const strat = {
    trend: STRATEGIES.trend.desc,
    dip: STRATEGIES.dip.desc,
    score: `BUY saat skor ≥ ${esc(params.buy_threshold)}, SELL saat skor ≤ ${esc(params.sell_threshold)} atau kena trailing stop.`,
    turtle: STRATEGIES.turtle.desc,
  }[params.strategy] || '';
  const isTurtle = params.strategy === 'turtle', showMa200 = params.ma200 === true;
  const ma200Note = showMa200 && params.strategy !== 'dip' ? ' Filter MA200 aktif: BUY hanya saat harga di atas MA200.' : '';
  const trades = (d.trades || []).slice().reverse();
  const shown = state.showAllTrades ? trades : trades.slice(0, 8);

  return {
    sig: `
    <div class="sig ${a}">
      <div class="sig-top">
        <div><div class="sig-lbl">Sinyal sekarang · ${esc(ivName(d.interval))}</div>
          <div class="sig-big">${a}<small>${LABEL[a]}</small></div></div>
        <span class="score-pill" aria-label="Skor ${score}">${score > 0 ? '+' : ''}${esc(score)}</span>
      </div>
      <p>${esc(d.advice)}</p>
      ${lastSig ? `<div class="last">Sinyal terakhir: <b>${esc(lastSig.type)}</b> ${esc(date(lastSig.time, iv))} @ <b class="mono">${fmt(lastSig.price, cur)}</b><br>${esc(lastSig.reason)}</div>` : ''}
    </div>`,
    fund: `
    ${d.market === 'saham' ? `<div id="fundCard">${fundCardHTML()}</div>` : ''}`,
    hl: `
    ${d.market === 'crypto' ? `<div id="hlCard">${hlCard()}</div>` : ''}`,
    gauge: `
    <div class="card">
      <div class="gauge-head"><span>Kondisi pasar (skor indikator)</span><b>${score > 0 ? '+' : ''}${esc(score)}</b></div>
      <div class="gauge-bar" role="meter" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${score}" aria-label="Skor indikator">
        <div class="gauge-pin" style="left:${Math.max(0, Math.min(100, (score + 100) / 2))}%"></div></div>
      <div class="gauge-ticks"><span>-100 Bearish</span><span>0</span><span>Bullish +100</span></div>
    </div>`,
    chart: `
    <div class="card chart-card">
      <div class="chart-bar">
        ${tfBar}
        <div class="seg mode" role="group" aria-label="Jenis chart">
          <button type="button" data-mode="line" aria-pressed="${state.settings.chartMode === 'line'}">${ICON.line}Garis</button>
          <button type="button" data-mode="candle" aria-pressed="${state.settings.chartMode === 'candle'}">${ICON.candle}Candle</button>
        </div>
        <button type="button" class="toggle-sm" id="bbToggle" aria-pressed="${bbOn}">Bollinger</button>
      </div>
      <div class="legend">
        <span><i style="background:${C.ema20}"></i>EMA20</span><span><i style="background:${C.ema50}"></i>EMA50</span><span><i style="background:${C.ema200};height:2px"></i>EMA200</span>
        ${showMa200 ? `<span><i style="background:${C.sma200};height:2px"></i>MA200</span>` : ''}
        ${isTurtle ? '<span><i class="dash"></i>Donchian 20/10</span>' : ''}
      </div>
      <div id="priceChart"></div>
      <div class="sub-label">Skor per candle (hijau bullish, merah bearish)</div>
      <div id="scoreChart"></div>
      <div class="strat-note"><b style="color:var(--text)">${esc((STRATEGIES[params.strategy] || {}).name || 'Strategi')}:</b> ${strat}${ma200Note}</div>
    </div>`,
    plan: `
    <div class="card">
      <h3>${holding ? 'Rencana posisi (sedang pegang)' : 'Acuan risiko — jika sinyal BUY muncul'}</h3>
      <div class="kv-grid">
        <div class="kv"><div class="k">${holding ? 'Harga beli' : 'Harga close terakhir'}</div><div class="v mono">${fmt(p.entry, cur)}</div></div>
        <div class="kv"><div class="k">Stop loss</div><div class="v mono neg">${fmt(p.stop_loss, cur)}</div></div>
        ${p.target_1 == null
          ? `<div class="kv wide"><div class="k">Kapan jual</div><div class="v txt">${params.strategy === 'dip'
            ? 'Saat RSI naik di atas 55 (harga pulih), atau harga close di bawah stop loss (stop tetap, tidak ikut naik).'
            : isTurtle ? 'Saat close menembus terendah 10 candle, atau kena stop loss tetap (tidak ikut naik).'
            : 'Saat sinyal SELL muncul, atau harga close di bawah stop loss (stop ikut naik mengikuti harga tertinggi).'}</div></div>`
          : `<div class="kv"><div class="k">Target 1 (1R)</div><div class="v mono pos">${fmt(p.target_1, cur)}</div></div>
             <div class="kv"><div class="k">Target 2 (2R)</div><div class="v mono pos">${fmt(p.target_2, cur)}</div></div>`}
      </div>
      <p class="note">Pasang stop loss di aplikasi broker/exchange Anda. Aplikasi ini tidak mengeksekusi order.</p>
    </div>`,
    reasons: `
    <div class="card">
      <h3>Alasan</h3>
      <ul class="reasons">${(d.reasons || []).map(r => {
        const c = r.dir === '+' ? 'p' : r.dir === '-' ? 'm' : 'n';
        return `<li><span class="ic ${c}">${r.dir === '+' ? '▲' : r.dir === '-' ? '▼' : '•'}</span><span>${esc(r.text)}</span></li>`;
      }).join('') || '<li class="muted">Tidak ada catatan.</li>'}</ul>
      <p class="note mono" style="font-size:11.5px">RSI ${n.rsi == null ? '–' : esc(Number(n.rsi).toFixed(1))} · EMA20 ${fmt(n.ema20, cur)} · EMA50 ${fmt(n.ema50, cur)} · ATR ${fmt(n.atr, cur)}</p>
    </div>`,
    backtest: `
    <div class="card">
      <h3>Backtest strategi ini</h3>
      <div class="kv-grid">
        <div class="kv"><div class="k">Hasil strategi</div><div class="v mono">${pct(b.strategy_return)}</div></div>
        <div class="kv"><div class="k">Beli & tahan</div><div class="v mono">${pct(b.buy_hold_return)}</div></div>
        <div class="kv"><div class="k">Win rate</div><div class="v mono">${b.win_rate == null ? '–' : esc(b.win_rate) + '%'}</div></div>
        <div class="kv"><div class="k">Jumlah trade</div><div class="v mono">${esc(b.trades ?? '–')}</div></div>
        <div class="kv"><div class="k">Rata-rata/trade</div><div class="v mono">${pct(b.avg_return)}</div></div>
        <div class="kv"><div class="k">Max drawdown</div><div class="v mono neg">${b.max_drawdown == null ? '–' : '-' + esc(b.max_drawdown) + '%'}</div></div>
        <div class="kv"><div class="k">Terbaik</div><div class="v mono">${pct(b.best)}</div></div>
        <div class="kv"><div class="k">Terburuk</div><div class="v mono">${pct(b.worst)}</div></div>
      </div>
      <p class="note">Dari data di chart, sudah termasuk biaya ${esc(params.fee_pct)}% per transaksi, asumsi beli/jual di harga close candle sinyal. Hasil masa lalu tidak menjamin hasil ke depan.</p>
    </div>`,
    trades: `
    <div class="card">
      <h3>Riwayat sinyal BUY → SELL (${trades.length})</h3>
      ${trades.length ? `<div class="ttable" role="table" aria-label="Riwayat sinyal">
        <div class="tr th" role="row"><span role="columnheader">Beli</span><span role="columnheader">Jual</span><span role="columnheader">Hasil</span></div>
        ${shown.map(t => `
        <div class="tr" role="row">
          <span role="cell"><b class="mono">${fmt(t.entry_price, cur)}</b><small>${esc(date(t.entry_time, iv))}</small></span>
          <span role="cell">${t.open ? `<b class="mono">${fmt(t.exit_price, cur)}</b><small>Belum jual · sekarang</small>` : `<b class="mono">${fmt(t.exit_price, cur)}</b><small>${esc(date(t.exit_time, iv))}</small>`}</span>
          <span role="cell" class="res">${t.open ? '<span class="badge HOLD">PEGANG</span>' : ''}${chgPill(t.return_pct)}</span>
        </div>`).join('')}
      </div>` : '<div class="empty">Belum ada trade di periode ini.</div>'}
      ${trades.length > shown.length ? `<button type="button" class="pill ghost more-trades" data-c="alltrades">Tampilkan semua (${trades.length})</button>` : ''}
    </div>`,
    foot: `
    <p class="note" style="text-align:center;padding:0 8px">Alat bantu analisa teknikal, bukan saran investasi. Data saham Yahoo Finance (tertunda ±15 menit), crypto Binance.</p>`,
  };
}

function detailHTML(d) {
  const P = detailParts(d);
  return `
${P.sig}
${P.fund}
${P.hl}
${P.gauge}
${P.chart}
${P.plan}
${P.reasons}
${P.backtest}
${P.trades}
${P.foot}`;
}

$('#view-chart').addEventListener('click', e => {
  const pick = e.target.closest('[data-act="pick"]');
  if (pick) return openSymbol(pick.dataset.s, pick.dataset.m);
  const ivb = e.target.closest('[data-iv]');
  if (ivb) {
    if (ivb.dataset.iv === state.chartInterval) return;
    state.chartInterval = ivb.dataset.iv;
    state.data = null; state.showAllTrades = false;
    stopLive();
    return loadDetail();
  }
  const mb = e.target.closest('[data-mode]');
  if (mb) {
    if (mb.dataset.mode === state.settings.chartMode) return;
    state.settings.chartMode = mb.dataset.mode === 'candle' ? 'candle' : 'line';
    saveSettings();
    for (const b of $$('#view-chart [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.settings.chartMode));
    if (state.data && charts.length) {
      const range = charts[0].timeScale().getVisibleLogicalRange();
      drawCharts(state.data, range);
    }
    return;
  }
  const c = e.target.closest('[data-c]');
  if (!c) return;
  if (c.dataset.c === 'back') {
    if (history.state && history.state.tab === 'chart') return history.back();
    return navigate('signal');
  }
  if (c.dataset.c === 'switch') return openPicker();
  if (c.dataset.c === 'retry') return loadDetail(true);
  if (c.dataset.c === 'fundretry') { state.fundCur.key = null; return ensureFundCur(state.current.symbol, true); }
  if (c.dataset.c === 'fundrank') { state.mktView = 'fund'; return navigate('market'); }
  if (c.dataset.c === 'hlretry') return ensureHl(true);
  if (c.dataset.c === 'alltrades') {
    state.showAllTrades = true;
    const y = window.scrollY; renderChart(); window.scrollTo(0, y);
  }
});

$('#view-chart').addEventListener('toggle', e => { if (e.target.id === 'hlList') state.hl.listOpen = e.target.open; }, true);

// ---------------------------------------------------------------- lightweight-charts
const C = {
  blue: '#1ea7fd', buy: '#16c784', sell: '#f6465d',
  ema20: '#f0b90b', ema50: '#a78bfa', ema200: '#94a3b8', sma200: '#f472b6', dc: 'rgba(95,200,180,.8)',
};
// priceSeries: seri harga yang terlihat (area "Garis" atau candlestick); glowSeries: garis lebar di bawah area
let charts = [], priceSeries = null, glowSeries = null, chartMode = 'line', shiftFn = t => t, bbOn = false;
function destroyCharts() {
  charts.forEach(c => { try { c.remove(); } catch { /* sudah dihapus */ } });
  charts = []; priceSeries = null; glowSeries = null;
}
function drawCharts(d, keepRange = null) {
  destroyCharts();
  if (!window.LightweightCharts || !Array.isArray(d.candles) || !d.candles.length) return;
  const intraday = isIntraday(d.interval);
  // intraday: geser ke jam lokal; harian/mingguan: tanggal UTC sudah benar
  const sh = t => (intraday ? t - new Date(t * 1000).getTimezoneOffset() * 60 : t);
  const base = {
    layout: { background: { color: 'transparent' }, textColor: '#8b95a5', fontFamily: 'system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(255,255,255,.035)' }, horzLines: { color: 'rgba(255,255,255,.035)' } },
    rightPriceScale: { borderVisible: false, minimumWidth: 68 },
    timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false, rightOffset: 3 },
    crosshair: {
      mode: 0,
      vertLine: { color: 'rgba(30,167,253,.16)', width: 8, style: 0, labelBackgroundColor: '#1270b8' },
      horzLine: { color: 'rgba(30,167,253,.55)', width: 1, style: 2, labelBackgroundColor: '#1270b8' },
    },
    // biarkan geser vertikal men-scroll halaman, bukan chart
    handleScroll: { mouseWheel: false, vertTouchDrag: false, horzTouchDrag: true, pressedMouseMove: true },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
    autoSize: true,
  };
  const pf = { type: 'custom', formatter: v => fmt(v, d.currency), minMove: d.currency === 'IDR' ? 1 : 0.00000001 };
  const mode = state.settings.chartMode;

  const chart = LightweightCharts.createChart($('#priceChart'), base);
  let main, glow = null;
  if (mode === 'candle') {
    main = chart.addCandlestickSeries({
      upColor: C.buy, downColor: C.sell, borderVisible: false,
      wickUpColor: C.buy, wickDownColor: C.sell, priceFormat: pf,
    });
    main.setData(d.candles.map(c => ({ ...c, time: sh(c.time) })));
  } else {
    const closes = d.candles.map(c => ({ time: sh(c.time), value: c.close }));
    glow = chart.addLineSeries({ color: 'rgba(30,167,253,.22)', lineWidth: 4, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf });
    glow.setData(closes);
    main = chart.addAreaSeries({
      lineColor: C.blue, lineWidth: 2, topColor: 'rgba(30,167,253,.32)', bottomColor: 'rgba(30,167,253,0)',
      crosshairMarkerBackgroundColor: C.blue, crosshairMarkerBorderColor: '#05070b', crosshairMarkerRadius: 5,
      priceLineColor: C.blue, priceFormat: pf,
    });
    main.setData(closes);
  }
  const series = d.series || {};
  const line = (key, color, extra = {}) => {
    const s = chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf, ...extra });
    s.setData((series[key] || []).map(x => ({ ...x, time: sh(x.time) })));
    return s;
  };
  line('ema20', C.ema20, { lineWidth: 1.5 }); line('ema50', C.ema50, { lineWidth: 1.5 }); line('ema200', C.ema200, { lineWidth: 1 });
  const params = d.params || {};
  if (params.ma200 === true && series.sma200) line('sma200', C.sma200, { lineWidth: 1 });
  if (params.strategy === 'turtle' && series.dc_upper) {
    line('dc_upper', C.dc, { lineWidth: 1, lineStyle: 2 });
    line('dc_lower', C.dc, { lineWidth: 1, lineStyle: 2 });
  }
  const bb = [
    line('bb_upper', 'rgba(139,149,165,.55)', { lineWidth: 1, lineStyle: 2, visible: bbOn }),
    line('bb_lower', 'rgba(139,149,165,.55)', { lineWidth: 1, lineStyle: 2, visible: bbOn }),
  ];
  const tg = $('#bbToggle');
  if (tg) tg.onclick = () => {
    bbOn = tg.getAttribute('aria-pressed') !== 'true';
    tg.setAttribute('aria-pressed', String(bbOn));
    bb.forEach(s => s.applyOptions({ visible: bbOn }));
  };

  // marker BUY/SELL & garis stop selalu di seri harga yang sedang tampil
  main.setMarkers((d.signals || []).map(s => s.type === 'BUY'
    ? { time: sh(s.time), position: 'belowBar', color: C.buy, shape: 'arrowUp', text: 'BUY' }
    : { time: sh(s.time), position: 'aboveBar', color: C.sell, shape: 'arrowDown', text: 'SELL' }));
  if ((d.action === 'HOLD' || d.action === 'BUY') && d.plan && d.plan.stop_loss != null)
    main.createPriceLine({ price: d.plan.stop_loss, color: C.sell, lineStyle: 2, lineWidth: 1, title: 'Stop' });

  const sc = LightweightCharts.createChart($('#scoreChart'), {
    ...base, layout: { ...base.layout, attributionLogo: false },
    rightPriceScale: { borderVisible: false, minimumWidth: 68, scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: { ...base.timeScale, visible: false },
  });
  const hist = sc.addHistogramSeries({ priceFormat: { type: 'price', precision: 0, minMove: 1 }, priceLineVisible: false, lastValueVisible: false });
  // bar pemanasan diisi whitespace agar indeks kedua chart sama (zoom sinkron)
  const byTime = new Map((d.scores || []).map(s => [s.time, s.value]));
  hist.setData(d.candles.map(c => byTime.has(c.time)
    ? { time: sh(c.time), value: byTime.get(c.time), color: byTime.get(c.time) >= 0 ? 'rgba(22,199,132,.6)' : 'rgba(246,70,93,.6)' }
    : { time: sh(c.time) }));

  let syncing = false;
  const sync = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (syncing || !r) return;
    syncing = true; b.timeScale().setVisibleLogicalRange(r); syncing = false;
  });
  sync(chart, sc); sync(sc, chart);
  const n = d.candles.length;
  // layar sempit: tampilkan ±90 candle terakhir, sisanya bisa digeser
  chart.timeScale().setVisibleLogicalRange(keepRange || { from: Math.max(0, n - (desk ? 180 : 90)), to: n + 3 });
  charts = [chart, sc];
  priceSeries = main; glowSeries = glow; chartMode = mode; shiftFn = sh;
}

// ---------------------------------------------------------------- live crypto (WebSocket Binance)
let liveWs = null, liveRetry = 0, liveReload = 0;
function stopLive() {
  clearTimeout(liveRetry);
  clearTimeout(liveReload);
  if (liveWs) { liveWs.onclose = null; liveWs.onmessage = null; try { liveWs.close(); } catch { /* abaikan */ } liveWs = null; }
}
function startLive(d) {
  stopLive();
  if (d.market !== 'crypto' || !Array.isArray(d.candles) || !d.candles.length) return;
  const iv = { '1h': '1h', '4h': '4h', '1d': '1d', '1wk': '1w' }[d.interval];
  if (!iv || !/^[A-Z0-9]+$/.test(String(d.symbol))) return;
  const lastClosed = d.candles[d.candles.length - 1].time;
  const badge = on => {
    const b = $('#liveBadge');
    if (b) { b.classList.toggle('off', !on); b.lastElementChild.textContent = on ? 'LIVE' : 'TERPUTUS'; }
  };
  let ws;
  try { ws = new WebSocket(`wss://data-stream.binance.vision/ws/${d.symbol.toLowerCase()}@kline_${iv}`); }
  catch { badge(false); return; }
  liveWs = ws;
  ws.onopen = () => badge(true);
  ws.onmessage = m => {
    if (state.data !== d || !priceSeries) return; // simbol / timeframe sudah berganti
    let k;
    try { k = JSON.parse(m.data).k; } catch { return; }
    if (!k) return;
    const t = k.t / 1000;
    if (t <= lastClosed) return;
    const bar = { time: shiftFn(t), open: +k.o, high: +k.h, low: +k.l, close: +k.c };
    if (chartMode === 'candle') {
      // candle berjalan digambar pudar: belum dipakai untuk sinyal
      priceSeries.update({
        ...bar,
        color: bar.close >= bar.open ? 'rgba(22,199,132,.45)' : 'rgba(246,70,93,.45)',
        wickColor: 'rgba(139,149,165,.7)',
      });
    } else {
      priceSeries.update({ time: bar.time, value: bar.close });
      if (glowSeries) glowSeries.update({ time: bar.time, value: bar.close });
    }
    const el = $('#livePrice'); if (el) el.textContent = fmt(bar.close, d.currency);
    const ls = (d.signals || [])[(d.signals || []).length - 1];
    const ce = $('#liveChg'); if (ce && ls && ls.price) ce.innerHTML = chgPill((bar.close / ls.price - 1) * 100);
    if (k.x) { // candle close -> ambil data baru (tanpa cache) & hitung ulang sinyal
      stopLive();
      liveReload = setTimeout(() => { if (state.data === d && state.tab === 'chart') loadDetail(true); }, 3000);
    }
  };
  ws.onclose = () => {
    badge(false);
    if (liveWs === ws) liveRetry = setTimeout(() => { if (state.data === d && state.tab === 'chart') startLive(d); }, 5000);
  };
}

// ---------------------------------------------------------------- tab Lainnya
function renderMore() {
  const st = state.settings;
  const guideOpen = $('#guide') ? $('#guide').open : desk; // desktop: kolom bantuan langsung terbuka
  $('#view-more').innerHTML = `
    <h1 class="page-h">Lainnya</h1>
    ${desk ? '<div class="more-grid"><div class="more-col">' : ''}
    <div class="section-h"><h2>Pengaturan analisa</h2></div>
    <div class="group">
      <div class="set">
        <div class="set-t">Timeframe default</div>
        <div class="set-d">Panjang satu candle untuk scan & chart.</div>
        <div class="seg" role="group" aria-label="Timeframe default">
          ${INTERVALS.map(i => `<button type="button" data-set="interval" data-v="${i.v}" aria-pressed="${i.v === st.interval}">${i.chip}</button>`).join('')}
        </div>
      </div>
      <div class="set">
        <div class="set-t">Strategi</div>
        <div class="opt-list" role="radiogroup" aria-label="Strategi">
          ${Object.entries(STRATEGIES).map(([v, s]) => `
            <button type="button" class="opt" role="radio" data-set="strategy" data-v="${v}" aria-checked="${v === st.strategy}">
              <span class="dot"></span><span><b>${esc(s.name)}</b><span>${esc(s.desc)}</span></span></button>`).join('')}
        </div>
      </div>
      <div class="set">
        <div class="set-t">Jarak stop loss</div>
        <div class="set-d">Kelipatan ATR (rata-rata gerak harian). Kecil = ketat, besar = longgar.</div>
        <div class="seg" role="group" aria-label="Jarak stop loss">
          ${STOPS.map(s => `<button type="button" data-set="atr_stop" data-v="${s.v}" aria-pressed="${s.v === st.atr_stop}">${s.chip}</button>`).join('')}
        </div>
      </div>
      <div class="set">
        <button type="button" class="set-row" role="switch" data-set="ma200" aria-checked="${st.ma200}">
          <span><span class="set-t" style="display:block">Filter MA200</span><span class="set-d" style="display:block">Hanya beli kalau harga di atas rata-rata 200 candle — dipakai manajer investasi untuk menghindari pasar turun.</span></span>
          <span class="switch" aria-hidden="true"></span>
        </button>
      </div>
      <div class="set">
        <button type="button" class="set-row" role="switch" data-set="auto" aria-checked="${st.auto}">
          <span><span class="set-t" style="display:block">Auto refresh</span><span class="set-d" style="display:block">Scan ulang otomatis tiap 60 detik selama aplikasi terbuka.</span></span>
          <span class="switch" aria-hidden="true"></span>
        </button>
      </div>
    </div>

    ${desk ? '</div><div class="more-col">' : ''}
    <div class="section-h"><h2>Bantuan</h2></div>
    <div class="group">
      <details class="acc" id="guide" ${guideOpen ? 'open' : ''}>
        <summary>Cara pakai ${ICON.down}</summary>
        <div class="acc-b">
          <div class="def">
            <span class="badge BUY">BUY</span><span>Sinyal beli baru muncul di candle terakhir. Pertimbangkan masuk dan langsung pasang stop loss.</span>
            <span class="badge SELL">SELL</span><span>Sinyal jual baru muncul. Kalau sedang pegang, pertimbangkan keluar.</span>
            <span class="badge HOLD">HOLD</span><span>Masih dalam posisi sejak BUY sebelumnya. Tahan sampai SELL atau kena stop.</span>
            <span class="badge WAIT">WAIT</span><span>Belum ada posisi. Tunggu sinyal BUY — jangan kejar harga.</span>
          </div>
          <p style="margin-top:14px"><b>Kapan cek?</b></p>
          <ul>
            <li>Crypto (timeframe Harian): setelah <b>07:00 WIB</b>, saat candle harian Binance close.</li>
            <li>Saham IDX: setelah <b>16:30 WIB</b>, setelah bursa tutup.</li>
            <li>Timeframe 1J/4J: setiap candle close; crypto di tab Chart bergerak live.</li>
          </ul>
          <p style="margin-top:10px"><b>Setelah sinyal BUY</b></p>
          <ul>
            <li>Pasang stop loss di aplikasi broker/exchange sesuai angka di kartu Rencana posisi.</li>
            <li>Untuk strategi Tren & Skor, stop ikut naik (trailing). Cek berkala dan perbarui stop loss di broker.</li>
            <li>Aplikasi ini hanya memberi sinyal — tidak membeli atau menjual apa pun.</li>
          </ul>
          <p style="margin-top:10px"><b>Fundamental vs teknikal</b></p>
          <p><b>Fundamental</b> (Pasar › Peringkat Fundamental, dan kartu Fundamental di Chart) membaca laporan keuangan: untung tidak, tumbuh tidak, utangnya aman tidak, harganya mahal tidak. Gunanya untuk <b>memilih saham apa</b>. <b>Teknikal</b> (sinyal BUY/SELL) membaca gerak harga untuk menentukan <b>kapan beli atau jual</b>. Skor fundamental bukan ramalan harga — hasil uji historisnya (jujur, apa adanya) ada di Peringkat Fundamental › <i>Seberapa bisa dipercaya?</i> Pakai sebagai saringan awal, lalu gabungkan dengan sinyal teknikal dan pertimbangan Anda sendiri.</p>
          <p style="margin-top:10px"><b>Turtle & Filter MA200</b></p>
          <p>Strategi <b>Turtle</b> meniru aturan Turtle Traders: BUY saat close menembus harga tertinggi 20 candle sebelumnya, SELL saat close jatuh di bawah terendah 10 candle atau kena stop loss tetap. <b>Filter MA200</b> menahan sinyal BUY selama harga di bawah rata-rata 200 candle, supaya tidak membeli saat tren besar turun (tidak berlaku untuk strategi Beli saat Koreksi, yang sudah memakai EMA200).</p>
          <p style="margin-top:10px"><b>Posisi trader top Hyperliquid (crypto)</b></p>
          <p>Di Chart crypto ada kartu yang menunjukkan berapa dari 50 trader paling untung di bursa Hyperliquid sedang <b>long</b> (bertaruh naik) atau <b>short</b> (bertaruh turun) di koin itu, lalu dibandingkan dengan sinyal robot. Daftar trader diperbarui harian; posisinya diambil live dan hanya dibaca — aplikasi tidak memakai dompet atau kunci apa pun. Ini <b>sentimen pelengkap, bukan sinyal</b>. Catatan:</p>
          <ul>
            <li>"Top" dipilih dari laba masa lalu — bisa karena beruntung atau memakai leverage tinggi.</li>
            <li>Bias seleksi: pemenang terbaru biasanya memang sedang berposisi searah gerak harga terakhir.</li>
            <li>Posisi short bisa sekadar lindung nilai (hedge) atas aset lain, bukan pandangan turun.</li>
            <li>Beberapa akun paus menguasai sebagian besar nilai posisi, jadi patokan utamanya <b>jumlah trader</b>, nilai posisi hanya pelengkap.</li>
            <li>Belum terbukti meningkatkan hasil. Riwayatnya dicatat setiap hari untuk diuji secara jujur nanti.</li>
            <li>Hanya untuk crypto yang diperdagangkan di Hyperliquid.</li>
          </ul>
        </div>
      </details>
      <details class="acc">
        <summary>Penafian ${ICON.down}</summary>
        <div class="disclaimer" style="padding-top:0">AInalyzer Trading adalah alat bantu analisa teknikal & fundamental, <b>bukan saran investasi</b>. Sinyal dihitung otomatis dari indikator (EMA, RSI, ATR, Bollinger) dan bisa salah. Skor fundamental dihitung dari laporan keuangan Yahoo Finance (bisa terlambat, direvisi, atau keliru) dan tidak menjamin saham mana pun akan naik. Hasil backtest masa lalu tidak menjamin hasil ke depan. Data saham dari Yahoo Finance (bisa tertunda ±15 menit), crypto dari Binance. Keputusan dan risiko sepenuhnya di tangan Anda.</div>
      </details>
    </div>
    ${desk ? '</div></div>' : ''}
    <div class="version">AInalyzer Trading v${VERSION} · ${state.watchlist.length} aset dipantau</div>`;
}

$('#view-more').addEventListener('click', e => {
  const b = e.target.closest('[data-set]');
  if (!b) return;
  const key = b.dataset.set;
  if (key === 'auto') {
    state.settings.auto = !state.settings.auto;
    saveSettings(); setupAuto(); renderMore();
    return toast(state.settings.auto ? 'Auto refresh aktif (60 dtk)' : 'Auto refresh mati');
  }
  if (key === 'ma200') {
    state.settings.ma200 = !state.settings.ma200;
    saveSettings(); renderMore(); settingsChanged();
    return toast(state.settings.ma200 ? 'Filter MA200 aktif' : 'Filter MA200 mati');
  }
  const v = b.dataset.v;
  if (state.settings[key] === v) return;
  state.settings[key] = v;
  saveSettings();
  renderMore();
  if (key === 'interval') state.chartInterval = v;
  settingsChanged();
});

let settingsTimer = 0;
function settingsChanged() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    state.scanning = false; // scan lama diabaikan lewat scanSeq
    runScan();
    if (state.current) { state.data = null; stopLive(); state.dataAt = 0; }
  }, 350);
}

// ---------------------------------------------------------------- render & init
function render(tab) {
  paintSide();
  if (tab === 'signal') renderSignal();
  else if (tab === 'market') renderMarket();
  else if (tab === 'chart') renderChart();
  else if (tab === 'more') renderMore();
}

let autoTimer = 0;
function setupAuto() {
  clearInterval(autoTimer);
  if (!state.settings.auto) return;
  autoTimer = setInterval(() => {
    if (document.hidden || state.scanning) return; // lewati kalau scan sebelumnya belum selesai
    runScan();
    if (state.tab === 'chart' && state.current && state.current.market !== 'crypto' && !state.detailLoading) loadDetail();
  }, 60000);
}

$('#refreshBtn').innerHTML = ICON.refresh;
$('#bellBtn').innerHTML = ICON.bell + '<i class="bell-dot" aria-hidden="true"></i>';
for (const el of $$('[data-icon]')) el.innerHTML = ICON[el.dataset.icon] || '';
for (const b of $$('.tab')) b.addEventListener('click', () => {
  if (b.dataset.tab === state.tab) return window.scrollTo({ top: 0, behavior: 'smooth' });
  navigate(b.dataset.tab, b.dataset.tab === 'chart' && state.current ? { ...state.current } : {});
});
$('#refreshBtn').addEventListener('click', refreshAll);
$('#scanFab').addEventListener('click', refreshAll);
$('#sideScan').addEventListener('click', refreshAll);
$('#sideFoot').addEventListener('click', e => { if (e.target.closest('[data-tab-go="more"]') && state.tab !== 'more') navigate('more'); });

// ---------------------------------------------------------------- pencarian simbol (desktop)
let searchHits = [], searchSel = -1;
function searchCandidates() {
  const out = [], seen = new Set();
  for (const w of state.watchlist) {
    const k = keyOf(w.symbol, w.market);
    if (seen.has(k)) continue;
    seen.add(k);
    const r = rowFor(w);
    out.push({ symbol: w.symbol, market: w.market, name: r && !r.error ? r.name : '', watched: true, r });
  }
  for (const t of F.UNIVERSE) {
    const k = keyOf(t, 'saham');
    if (seen.has(k)) continue;
    seen.add(k);
    const fr = state.fund.rows.get(t);
    out.push({ symbol: t, market: 'saham', name: fr && !fr.error ? fr.name : F.sectorOf(t), watched: false });
  }
  return out;
}
function runSearch() {
  const inp = $('#searchIn'), box = $('#searchRes');
  const q = inp.value.trim().toUpperCase();
  if (!q) { closeSearch(false); return; }
  const all = searchCandidates();
  const score = c => (c.symbol === q ? 0 : c.symbol.startsWith(q) ? 1 : c.symbol.includes(q) ? 2 : String(c.name || '').toUpperCase().includes(q) ? 3 : 9);
  searchHits = all.map(c => [c, score(c)]).filter(x => x[1] < 9).sort((a, b) => a[1] - b[1] || (b[0].watched - a[0].watched)).slice(0, 8).map(x => x[0]);
  if (!all.some(c => c.symbol.startsWith(q))) { // simbol di luar daftar: tawarkan buka chart langsung
    for (const m of ['saham', 'crypto']) if (validSym(q, m)) searchHits.push({ symbol: q, market: m, name: '', watched: false, adhoc: true });
  }
  searchSel = searchHits.length ? 0 : -1;
  box.innerHTML = searchHits.length
    ? searchHits.map((c, i) => {
      const a = c.r && !c.r.error ? act(c.r.action) : null;
      return `<button type="button" class="sres-i" role="option" id="sres-${i}" data-i="${i}" aria-selected="${i === searchSel}">
        ${avatar(c.symbol, 'sm')}<span class="sres-id"><b>${esc(c.symbol)}</b><span>${c.adhoc ? `Buka chart ${c.market === 'crypto' ? 'crypto' : 'saham IDX'} (tidak ada di daftar)` : esc(c.name || '')}</span></span>
        ${mkTag(c.market)}${a ? `<span class="badge ${a}">${a}</span>` : c.watched ? '' : '<span class="sres-tag">Universe</span>'}</button>`;
    }).join('')
    : '<div class="sres-empty">Tidak ada simbol yang cocok.</div>';
  box.hidden = false;
  inp.setAttribute('aria-expanded', 'true');
  inp.setAttribute('aria-activedescendant', searchSel >= 0 ? 'sres-0' : '');
}
function closeSearch(clear = true) {
  const inp = $('#searchIn'), box = $('#searchRes');
  box.hidden = true; box.innerHTML = '';
  inp.setAttribute('aria-expanded', 'false');
  inp.removeAttribute('aria-activedescendant');
  searchHits = []; searchSel = -1;
  if (clear) inp.value = '';
}
function pickSearch(i) {
  const c = searchHits[i];
  if (!c) return;
  closeSearch();
  $('#searchIn').blur();
  openSymbol(c.symbol, c.market);
}
$('#searchIn').addEventListener('input', runSearch);
$('#searchIn').addEventListener('focus', () => { if ($('#searchIn').value.trim()) runSearch(); });
$('#searchIn').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!searchHits.length) return;
    e.preventDefault();
    searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length;
    for (const b of $$('#searchRes .sres-i')) b.setAttribute('aria-selected', String(Number(b.dataset.i) === searchSel));
    $('#searchIn').setAttribute('aria-activedescendant', 'sres-' + searchSel);
    const cur = $('#sres-' + searchSel); if (cur) cur.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pickSearch(searchSel >= 0 ? searchSel : 0);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if ($('#searchIn').value) closeSearch(); else $('#searchIn').blur();
  }
});
$('#searchRes').addEventListener('mousedown', e => e.preventDefault()); // jaga fokus input saat klik hasil
$('#searchRes').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) pickSearch(Number(b.dataset.i)); });
$('#searchIn').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('#searchIn')) closeSearch(false); }, 120));

// pintasan keyboard: "/" fokus ke pencarian (desktop), Esc menutup sheet/modal
document.addEventListener('keydown', e => {
  const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if (e.key === '/' && desk && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && $('#sheet').hidden) {
    e.preventDefault();
    $('#searchIn').focus();
  } else if (e.key === 'Escape' && !$('#sheet').hidden) {
    e.preventDefault();
    closeSheet();
  }
});

// ganti layout saat melewati 1024px (mis. jendela di-resize): render ulang ke wadah yang sesuai
function onDeskChange(e) {
  if (!!e.matches === desk) return;
  desk = !!e.matches;
  closeSearch();
  renderMarketShell();
  render(state.tab);
  updateTabBadge();
}
if (DESK_MQ) {
  if (DESK_MQ.addEventListener) DESK_MQ.addEventListener('change', onDeskChange);
  else if (DESK_MQ.addListener) DESK_MQ.addListener(onDeskChange);
}
$('#bellBtn').addEventListener('click', () => {
  if (state.tab !== 'signal') navigate('signal');
  const sec = $('#sec-new');
  if (sec) sec.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopLive(); return; }
  if (state.tab === 'chart' && state.data) startLive(state.data);
});

renderMarketShell();
history.replaceState({ tab: 'signal' }, '');
showTab('signal');
updateTabBadge();
setupAuto();
runScan();

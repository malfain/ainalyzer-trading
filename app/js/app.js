// Robot Trading — UI mobile (WebView). Sinyal analisa saja, tidak mengeksekusi order.
import { SYMBOL_RE, normalize, analyzeSymbol, scan as scanAll } from './data.js';
import { $, $$, esc, act, LABEL, fmt, pct, date, clock, ago, store } from './ui/util.js';
import { ICON } from './ui/icons.js?v=1.1.0';

const VERSION = '1.1.0';
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
};
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
  for (const b of [$('#refreshBtn'), $('#scanFab')]) {
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
function showTab(tab) {
  const prev = state.tab;
  state.tab = tab;
  document.body.dataset.tab = tab;
  $('#greet').textContent = tab === 'market' ? 'Daftar pantau' : tab === 'more' ? 'Pengaturan & bantuan' : greeting() + '!';
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
  openSheet(`<h3>Pilih aset</h3><p>Ketuk aset untuk membuka chart & sinyalnya.</p>
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
  raf = requestAnimationFrame(() => { raf = 0; if (state.tab !== 'chart' && state.tab !== 'more') render(state.tab); updateTabBadge(); });
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
  const tab = $('.tab[data-tab="signal"]');
  let dot = tab.querySelector('.dot-n');
  if (!n) { if (dot) dot.remove(); tab.removeAttribute('aria-label'); return; }
  if (!dot) { dot = document.createElement('span'); dot.className = 'dot-n'; tab.appendChild(dot); }
  dot.textContent = n > 9 ? '9+' : String(n);
  tab.setAttribute('aria-label', `Sinyal, ${n} sinyal baru`);
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
  const skeleton = `<div class="list">${state.watchlist.slice(0, 3).map(it => assetRow(it)).join('')}</div>`;

  view.innerHTML = `
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
    </div>

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
            + section('sec-near', 'Hampir sinyal', near, 'Belum ada aset yang mendekati sinyal BUY.')}
      ${errs ? `<p class="note" style="text-align:center">${errs} simbol gagal dimuat — lihat tab Pasar.</p>` : ''}
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
  }
  const row = e.target.closest('.row, .wcard');
  if (row) openSymbol(row.dataset.s, row.dataset.m);
});

// ---------------------------------------------------------------- tab Pasar
function renderMarketShell() {
  $('#view-market').innerHTML = `
    <h1 class="page-h">Pasar</h1>
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
    </div>`;
}

function renderMarket() {
  for (const b of $$('#mktFilter button')) b.setAttribute('aria-pressed', String(b.dataset.f === state.filter));
  for (const b of $$('#addMkt button')) b.setAttribute('aria-pressed', String(b.dataset.m === state.addMarket));
  const eb = $('#editBtn');
  eb.textContent = state.edit ? 'Selesai' : 'Ubah';
  eb.setAttribute('aria-pressed', String(state.edit));
  eb.classList.toggle('on', state.edit);
  const list = state.watchlist.filter(w => state.filter === 'all' || w.market === state.filter);
  $('#mktTitle').textContent = `Daftar pantauan (${list.length})`;
  $('#mktHint').textContent = state.edit ? 'Ketuk ikon untuk hapus' : 'Tekan lama untuk hapus';
  $('#mktList').innerHTML = list.length
    ? `<div class="list">${list.map(it => assetRow(it, { edit: state.edit })).join('')}</div>`
    : `<div class="empty"><b>Belum ada aset</b>${state.filter === 'all' ? 'Tambahkan kode saham atau crypto di bawah.' : 'Tidak ada aset di kategori ini.'}</div>`;
}

const mv = $('#view-market');
mv.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  const f = e.target.closest('#mktFilter [data-f]');
  if (f) { state.filter = f.dataset.f; return renderMarket(); }
  const m = e.target.closest('#addMkt [data-m]');
  if (m) { state.addMarket = m.dataset.m; return renderMarket(); }
  if (e.target.closest('#editBtn')) { state.edit = !state.edit; return renderMarket(); }
  const del = e.target.closest('[data-del]');
  if (del) return confirmRemove(del.dataset.del, del.dataset.m);
  const row = e.target.closest('.row');
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
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('row')) {
    e.preventDefault(); e.target.click();
  }
});

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
        <p class="note" style="margin-top:6px">Ketuk salah satu aset untuk melihat sinyal, chart, rencana posisi, dan hasil backtest.</p>
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
  view.innerHTML = `
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
}

function detailHTML(d) {
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

  return `
    <div class="sig ${a}">
      <div class="sig-top">
        <div><div class="sig-lbl">Sinyal sekarang · ${esc(ivName(d.interval))}</div>
          <div class="sig-big">${a}<small>${LABEL[a]}</small></div></div>
        <span class="score-pill" aria-label="Skor ${score}">${score > 0 ? '+' : ''}${esc(score)}</span>
      </div>
      <p>${esc(d.advice)}</p>
      ${lastSig ? `<div class="last">Sinyal terakhir: <b>${esc(lastSig.type)}</b> ${esc(date(lastSig.time, iv))} @ <b class="mono">${fmt(lastSig.price, cur)}</b><br>${esc(lastSig.reason)}</div>` : ''}
    </div>

    <div class="card">
      <div class="gauge-head"><span>Kondisi pasar (skor indikator)</span><b>${score > 0 ? '+' : ''}${esc(score)}</b></div>
      <div class="gauge-bar" role="meter" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${score}" aria-label="Skor indikator">
        <div class="gauge-pin" style="left:${Math.max(0, Math.min(100, (score + 100) / 2))}%"></div></div>
      <div class="gauge-ticks"><span>-100 Bearish</span><span>0</span><span>Bullish +100</span></div>
    </div>

    <div class="card chart-card">
      <div class="chart-bar">
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
    </div>

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
    </div>

    <div class="card">
      <h3>Alasan</h3>
      <ul class="reasons">${(d.reasons || []).map(r => {
        const c = r.dir === '+' ? 'p' : r.dir === '-' ? 'm' : 'n';
        return `<li><span class="ic ${c}">${r.dir === '+' ? '▲' : r.dir === '-' ? '▼' : '•'}</span><span>${esc(r.text)}</span></li>`;
      }).join('') || '<li class="muted">Tidak ada catatan.</li>'}</ul>
      <p class="note mono" style="font-size:11.5px">RSI ${n.rsi == null ? '–' : esc(Number(n.rsi).toFixed(1))} · EMA20 ${fmt(n.ema20, cur)} · EMA50 ${fmt(n.ema50, cur)} · ATR ${fmt(n.atr, cur)}</p>
    </div>

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
    </div>

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
    </div>
    <p class="note" style="text-align:center;padding:0 8px">Alat bantu analisa teknikal, bukan saran investasi. Data saham Yahoo Finance (tertunda ±15 menit), crypto Binance.</p>`;
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
  if (c.dataset.c === 'alltrades') {
    state.showAllTrades = true;
    const y = window.scrollY; renderChart(); window.scrollTo(0, y);
  }
});

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
  chart.timeScale().setVisibleLogicalRange(keepRange || { from: Math.max(0, n - 90), to: n + 3 });
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
  const guideOpen = $('#guide') ? $('#guide').open : false;
  $('#view-more').innerHTML = `
    <h1 class="page-h">Lainnya</h1>
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
          <p style="margin-top:10px"><b>Turtle & Filter MA200</b></p>
          <p>Strategi <b>Turtle</b> meniru aturan Turtle Traders: BUY saat close menembus harga tertinggi 20 candle sebelumnya, SELL saat close jatuh di bawah terendah 10 candle atau kena stop loss tetap. <b>Filter MA200</b> menahan sinyal BUY selama harga di bawah rata-rata 200 candle, supaya tidak membeli saat tren besar turun (tidak berlaku untuk strategi Beli saat Koreksi, yang sudah memakai EMA200).</p>
        </div>
      </details>
      <details class="acc">
        <summary>Penafian ${ICON.down}</summary>
        <div class="disclaimer" style="padding-top:0">AInalyzer Trading adalah alat bantu analisa teknikal, <b>bukan saran investasi</b>. Sinyal dihitung otomatis dari indikator (EMA, RSI, ATR, Bollinger) dan bisa salah. Hasil backtest masa lalu tidak menjamin hasil ke depan. Data saham dari Yahoo Finance (bisa tertunda ±15 menit), crypto dari Binance. Keputusan dan risiko sepenuhnya di tangan Anda.</div>
      </details>
    </div>
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

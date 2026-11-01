// Posisi trader top Hyperliquid — indikator sentimen READ-ONLY (crypto saja).
// Daftar trader dibuat harian oleh tool/hl_top.py (GitHub Actions → branch `data`);
// posisi diambil live dari API publik Hyperliquid. Tidak ada order, dompet, atau kunci.
import { store } from './ui/util.js';

export const TOP_URL = 'https://raw.githubusercontent.com/malfain/ainalyzer-trading/data/hl_top.json';
export const INFO_URL = 'https://api.hyperliquid.xyz/info';
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const MOSTLY = 0.65;      // ≥65% trader di satu sisi = "mayoritas"
export const MIN_TRADERS = 3;    // di bawah ini: data kurang
export const MAX_ROWS = 15;
const LIST_KEY = 'rt.hltop.v1';
const LIST_TTL = 6 * 3600e3;
const SENT_TTL = 5 * 60e3;
const TIMEOUT = 15000;
const CONCURRENCY = 5;
const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC'];

const num = v => {
  const x = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(x) ? x : null;
};
export const validAddr = a => typeof a === 'string' && ADDR_RE.test(a);
export const shortAddr = a => (validAddr(a) ? a.slice(0, 6) + '…' + a.slice(-4) : '');

// Pasangan Binance (BTC, BTCUSDT, ETH/USDT, 1000PEPE) → nama koin Hyperliquid (BTC, kPEPE).
// `known` (Set/array/objek nama koin) dipakai untuk memilih exact lalu "k"+koin.
export function coinFor(symbol, known = null) {
  let s = String(symbol || '').trim().toUpperCase().replaceAll('/', '').replaceAll('-', '');
  for (const q of QUOTES) if (s.endsWith(q) && s.length > q.length) { s = s.slice(0, -q.length); break; }
  if (!s) return null;
  const cands = [s, 'k' + s];
  if (/^1000\w+/.test(s)) cands.unshift('k' + s.slice(4));
  if (!known) return cands[0];
  const has = Array.isArray(known) ? c => known.includes(c)
    : known instanceof Set ? c => known.has(c) : c => Object.hasOwn(known, c);
  return cands.find(has) || null;
}

// ---------------------------------------------------------------- daftar trader
function cleanList(j) {
  if (!j || !Array.isArray(j.traders)) return null;
  const traders = j.traders.filter(t => t && validAddr(t.a)).map(t => ({
    a: t.a.toLowerCase(), n: typeof t.n === 'string' && t.n ? t.n.slice(0, 40) : null,
    av: num(t.av), pm: num(t.pm), rm: num(t.rm), pa: num(t.pa), ra: num(t.ra),
  }));
  if (!traders.length) return null;
  const t = Date.parse(j.updated);
  return { updated: Number.isFinite(t) ? new Date(t).toISOString() : null, criteria: String(j.criteria || ''), traders };
}

let listMem = null; // { at, data, src }
export async function loadTopList({ fetchFn = globalThis.fetch, fresh = false } = {}) {
  if (!fresh && listMem && Date.now() - listMem.at < LIST_TTL) return listMem;
  const cached = store.get(LIST_KEY, null);
  if (!fresh && cached && Date.now() - cached.at < LIST_TTL) {
    const data = cleanList(cached.data);
    if (data) return (listMem = { at: cached.at, data, src: 'cache' });
  }
  try {
    const r = await withTimeout(signal => fetchFn(TOP_URL, { signal, cache: 'no-cache' }));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.json();
    const data = cleanList(raw);
    if (!data) throw new Error('format daftar tidak valid');
    store.set(LIST_KEY, { at: Date.now(), data: raw });
    return (listMem = { at: Date.now(), data, src: 'github' });
  } catch {
    // daftar online belum ada / gagal: pakai cache lama, lalu cadangan bawaan
    const old = cached && cleanList(cached.data);
    if (old) return (listMem = { at: Date.now(), data: old, src: 'cache' });
    const snap = (await import('./hl_top_snapshot.js?v=1.3.0')).default;
    return (listMem = { at: Date.now(), data: cleanList(snap), src: 'bawaan' });
  }
}

// ---------------------------------------------------------------- posisi live
async function withTimeout(fn, ms = TIMEOUT) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  const to = new Promise((_, rej) => { timer = setTimeout(() => { if (ctl) ctl.abort(); rej(new Error('timeout')); }, ms); });
  try { return await Promise.race([fn(ctl && ctl.signal), to]); } finally { clearTimeout(timer); }
}

export async function fetchState(addr, fetchFn = globalThis.fetch) {
  if (!validAddr(addr)) throw new Error('alamat tidak valid');
  const r = await withTimeout(signal => fetchFn(INFO_URL, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: addr }),
  }));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const median = xs => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// states: [{ trader:{a,n,rm,...}, state: clearinghouseState | null }]
export function aggregate(states) {
  const coins = {};
  let ok = 0;
  for (const { trader, state } of states) {
    if (!state || !Array.isArray(state.assetPositions)) continue;
    ok++;
    for (const ap of state.assetPositions) {
      const p = ap && ap.position;
      if (!p || typeof p.coin !== 'string' || p.coin.includes(':')) continue;
      const szi = num(p.szi), val = num(p.positionValue), entry = num(p.entryPx);
      if (!szi || val == null) continue;
      const c = coins[p.coin] || (coins[p.coin] = { coin: p.coin, rows: [] });
      c.rows.push({
        a: trader.a, n: trader.n || null, side: szi > 0 ? 'long' : 'short',
        size: Math.abs(szi), usd: Math.abs(val), entry,
        upnl: num(p.unrealizedPnl), lev: num(p.leverage && p.leverage.value), roi30: num(trader.rm),
      });
    }
  }
  for (const c of Object.values(coins)) Object.assign(c, summarize(c.rows));
  return { ok, total: states.length, coins };
}

export function summarize(rows) {
  const side = s => rows.filter(r => r.side === s);
  const L = side('long'), S = side('short');
  const sum = (xs, f) => xs.reduce((t, r) => t + (f(r) || 0), 0);
  // rata-rata entry tertimbang ukuran posisi (= harga rata-rata gabungan sisi itu)
  const wEntry = xs => {
    const w = xs.filter(r => r.entry != null && r.size > 0);
    const q = sum(w, r => r.size);
    return q > 0 ? sum(w, r => r.entry * r.size) / q : null;
  };
  const lv = sum(L, r => r.usd), sv = sum(S, r => r.usd), tot = lv + sv;
  const sorted = rows.slice().sort((a, b) => b.usd - a.usd);
  const top3 = sum(sorted.slice(0, 3), r => r.usd);
  const n = rows.length;
  return {
    long: L.length, short: S.length, n, lv, sv,
    lEntry: wEntry(L), sEntry: wEntry(S),
    medLev: median(rows.map(r => r.lev)),
    upnl: sum(rows, r => r.upnl),
    whale: n > MIN_TRADERS && tot > 0 && top3 / tot > 0.6,
    top3Share: tot > 0 ? top3 / tot : 0,
    rows: sorted,
  };
}

// Mayoritas berdasarkan JUMLAH trader (nilai posisi didominasi paus → sekunder).
export function stance(c) {
  const n = c ? c.long + c.short : 0;
  if (n < MIN_TRADERS) return { side: 'few', n, longPct: 0, shortPct: 0 };
  const longPct = c.long / n, shortPct = c.short / n;
  return { side: longPct >= MOSTLY ? 'long' : shortPct >= MOSTLY ? 'short' : 'mixed', n, longPct, shortPct };
}

// Bandingkan dengan aksi robot: { tone: 'ok'|'warn'|'neutral', text }
export function interpret(action, st) {
  if (!st || st.side === 'few') return { tone: 'neutral', text: 'Data trader top kurang untuk dibandingkan.' };
  const maj = st.side === 'long' ? 'mayoritas long' : st.side === 'short' ? 'mayoritas short' : 'campuran';
  if (action === 'BUY') {
    if (st.side === 'long') return { tone: 'ok', text: 'Sejalan — sinyal BELI dan trader top ' + maj + '.' };
    if (st.side === 'short') return { tone: 'warn', text: 'Bertentangan — hati-hati. Sinyal BELI, tapi trader top ' + maj + '.' };
    return { tone: 'neutral', text: 'Campuran — trader top tidak kompak; sinyal BELI tidak terkonfirmasi.' };
  }
  if (action === 'SELL') {
    if (st.side === 'short') return { tone: 'ok', text: 'Sejalan — sinyal JUAL dan trader top ' + maj + '.' };
    if (st.side === 'long') return { tone: 'warn', text: 'Bertentangan — hati-hati. Sinyal JUAL, tapi trader top ' + maj + '.' };
    return { tone: 'neutral', text: 'Campuran — trader top tidak kompak; sinyal JUAL tidak terkonfirmasi.' };
  }
  return { tone: 'neutral', text: `Robot sedang ${action === 'HOLD' ? 'TAHAN' : 'TUNGGU'}; trader top ${maj}. Pakai sebagai konteks, bukan pemicu.` };
}

let sentMem = null, sentInflight = null;
export async function loadSentiment(n = 50, { fetchFn = globalThis.fetch, fresh = false } = {}) {
  if (!fresh && sentMem && sentMem.n === n && Date.now() - sentMem.at < SENT_TTL) return sentMem;
  if (!fresh && sentInflight) return sentInflight;
  const run = (async () => {
    const list = await loadTopList({ fetchFn });
    const traders = list.data.traders.slice(0, n);
    const states = await pool(traders, CONCURRENCY, async trader => {
      try { return { trader, state: await fetchState(trader.a, fetchFn) }; } catch { return { trader, state: null }; }
    });
    const agg = aggregate(states);
    if (!agg.ok) throw new Error('Semua akun gagal dimuat dari Hyperliquid.');
    return (sentMem = { ...agg, n, at: Date.now(), updated: list.data.updated, src: list.src });
  })();
  sentInflight = run;
  try { return await run; } finally { if (sentInflight === run) sentInflight = null; }
}

export const _reset = () => { listMem = null; sentMem = null; sentInflight = null; };

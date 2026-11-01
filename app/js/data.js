// Ambil data candle: saham dari Yahoo Finance, crypto dari Binance (endpoint publik).
// Port 1:1 dari data.py + bagian server.py (FEES, PARAM_RANGES, params_from, run_analysis, _scan).

import { analyze } from "./analyzer.js";

export const FEES = Object.freeze({ saham: 0.2, crypto: 0.1 }); // % per transaksi
export const PARAM_RANGES = Object.freeze({
  atr_stop: [0.5, 10],
  buy_threshold: [-100, 100],
  sell_threshold: [-100, 100],
});
// Sama dengan re.fullmatch(r"[A-Z0-9][A-Z0-9.\-/=^]{0,19}")
export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-/=^]{0,19}$/;

export const CACHE_SECONDS = 60;
// interval UI -> [yahoo interval, yahoo range]
export const YAHOO_INTERVALS = Object.freeze({
  "1h": ["60m", "730d"],
  "4h": ["60m", "730d"], // Yahoo tidak punya 4 jam; dirakit per sesi bursa dari candle 1 jam
  "1d": ["1d", "5y"],
  "1wk": ["1wk", "10y"], // range=max membuat Yahoo diam-diam mengirim candle bulanan
});
export const BINANCE_INTERVALS = Object.freeze({ "1h": "1h", "4h": "4h", "1d": "1d", "1wk": "1w" });
export const BINANCE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const QUOTES = ["USDT", "USDC", "FDUSD", "BTC"];

const _cache = new Map();
const now = () => Date.now() / 1000;
const floorDiv = (a, b) => Math.floor(a / b);
const pyMod = (a, b) => ((a % b) + b) % b;

// ---------------------------------------------------------------- HTTP

let platformReady = false;
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("flutterInAppWebViewPlatformReady", () => { platformReady = true; });
}

function waitPlatformReady(timeoutMs = 3000) {
  if (platformReady) return Promise.resolve();
  return new Promise((resolve) => {
    // setelah menyerah sekali, panggilan berikutnya tidak menunggu 3 detik lagi
    const done = () => { platformReady = true; clearTimeout(timer); window.removeEventListener("flutterInAppWebViewPlatformReady", done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener("flutterInAppWebViewPlatformReady", done);
  });
}

function httpError(status, statusText = "") {
  const err = new Error(`HTTP Error ${status}${statusText ? `: ${statusText}` : ""}`);
  err.status = status;
  return err;
}

/** GET JSON lewat handler native Flutter (tanpa CORS) bila ada, atau fetch() biasa. */
export async function httpGetJson(url) {
  const w = typeof window !== "undefined" ? window : null;
  if (w && w.flutter_inappwebview) {
    await waitPlatformReady();
    let r = await w.flutter_inappwebview.callHandler("httpGet", url);
    if (typeof r === "string") r = JSON.parse(r);
    if (!r || !r.status) throw new Error((r && r.error) || "Gagal terhubung ke server data.");
    if (r.status >= 400) throw httpError(r.status);
    return JSON.parse(r.body);
  }
  const opts = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(15000) } : {};
  // Preview di browser lewat server.py (/app/): Yahoo memblokir CORS, jadi lewat perantara /proxy.
  // Di APK jalur native di atas yang dipakai; di Node (test) tidak ada `location`.
  // Website publik (GitHub Pages): perantara Cloudflare Worker dari config.js (window.AINALYZER_YAHOO_PROXY).
  const isYahoo = /^https:\/\/query[12]\.finance\.yahoo\.com\//.test(url);
  const local = typeof location !== "undefined" && location.pathname.startsWith("/app/");
  const remote = typeof window !== "undefined" && window.AINALYZER_YAHOO_PROXY;
  const proxy = !isYahoo ? null : local ? "/proxy" : remote || null;
  const r = await fetch(proxy ? `${proxy}?url=${encodeURIComponent(url)}` : url, opts);
  if (r.status >= 400) throw httpError(r.status, r.statusText);
  return r.json();
}

// ---------------------------------------------------------------- simbol & parameter

export function normalize(symbol, market) {
  let s = String(symbol).trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw new Error("Kode simbol tidak valid (huruf/angka, maks 20 karakter).");
  if (market === "crypto") {
    s = s.replaceAll("/", "").replaceAll("-", "");
    if (!QUOTES.some((q) => s.endsWith(q) && s.length > q.length)) s += "USDT";
  } else if (market === "saham") {
    // Kode 4 huruf (BBCA) dianggap saham IDX; saham luar pakai kode Yahoo lengkap
    if (!s.includes(".") && s.length === 4 && /^[A-Z]+$/.test(s)) s += ".JK";
  }
  return s;
}

// float() Python: terima "2", " 2.5 ", "1e3", "1_000", "inf", "nan"; tolak "0x10", "".
const PY_FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i;
function pyFloat(v) {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (!PY_FLOAT_RE.test(s)) return NaN;
  const t = s.replace(/_/g, "").toLowerCase();
  if (t.endsWith("nan")) return NaN;
  if (t.endsWith("inf") || t.endsWith("infinity")) return t.startsWith("-") ? -Infinity : Infinity;
  return Number(t);
}

/** Validasi parameter dari UI, sama dengan server.params_from. opts: objek biasa (nilai string/angka). */
export function paramsFrom(opts, market) {
  const q = opts || {};
  const p = { fee_pct: Object.hasOwn(FEES, market) ? FEES[market] : 0.2 };
  if (["trend", "score", "dip", "turtle"].includes(q.strategy)) p.strategy = q.strategy;
  if (q.ma200 === "1" || q.ma200 === "true" || q.ma200 === true) p.ma200 = true;
  for (const [key, [lo, hi]] of Object.entries(PARAM_RANGES)) {
    const raw = q[key];
    if (raw === undefined || raw === null || raw === "" || raw === false) continue;
    const v = pyFloat(raw);
    if (!(Number.isFinite(v) && lo <= v && v <= hi)) throw new Error(`${key} harus angka antara ${lo} dan ${hi}.`);
    p[key] = v;
  }
  return p;
}

// ---------------------------------------------------------------- ambil data

export async function fetchMarket(symbol, market, interval = "1d", { fresh = false } = {}) {
  const sym = normalize(symbol, market);
  const key = JSON.stringify([sym, market, interval]);
  const hit = _cache.get(key);
  if (hit && !fresh && now() - hit[0] < CACHE_SECONDS) return hit[1];
  const result = market === "crypto" ? await binance(sym, interval) : await yahoo(sym, interval);
  const t = now();
  for (const [k, [ts]] of _cache) if (t - ts >= CACHE_SECONDS) _cache.delete(k); // buang entri kedaluwarsa
  _cache.set(key, [t, result]);
  return result;
}

async function yahoo(sym, interval) {
  if (!Object.hasOwn(YAHOO_INTERVALS, interval)) {
    throw new Error(`Interval ${interval} tidak tersedia untuk saham. Pilih: ${Object.keys(YAHOO_INTERVALS).join(", ")}`);
  }
  const [yi, yr] = YAHOO_INTERVALS[interval];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${yr}&interval=${yi}`;
  let data;
  try {
    data = await httpGetJson(url);
  } catch (e) {
    if (e.status === 404) throw new Error(`Simbol ${sym} tidak ditemukan di Yahoo Finance.`);
    throw e;
  }
  let res = (data.chart || {}).result;
  if (!res || !res.length) throw new Error(`Simbol ${sym} tidak ditemukan.`);
  res = res[0];
  const meta = res.meta || {};
  const q = ((res.indicators || {}).quote || [{}])[0];
  const cols = ["open", "high", "low", "close", "volume"].map((k) => q[k] || []);
  let candles = [];
  (res.timestamp || []).forEach((t, i) => {
    const [o, h, l, c, v] = cols.map((col) => (i < col.length ? col[i] : null));
    if ([o, h, l, c].some((x) => x === null || x === undefined)) return;
    candles.push({ time: t, open: o, high: h, low: l, close: c, volume: v || 0 });
  });
  if (!candles.length) throw new Error(`Tidak ada data harga untuk ${sym}.`);
  const gmt = "gmtoffset" in meta ? meta.gmtoffset : 0;
  if (interval === "4h") candles = groupSessions(candles, gmt);
  candles = dropForming(candles, interval, meta, gmt);
  if (interval === "1h" || interval === "4h") candles = candles.slice(-1500);
  return {
    symbol: sym,
    name: meta.shortName || meta.longName || sym,
    currency: "currency" in meta ? meta.currency : "",
    market: "saham",
    interval,
    candles,
  };
}

function sessionKey(t, gmtoffset) {
  const local = t + gmtoffset;
  return [floorDiv(local, 86400), floorDiv(pyMod(local, 86400), 3600) < 12]; // [hari, sesi pagi?]
}
const sameKey = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Candle "4 jam" saham = satu sesi bursa: sesi 1 (pagi, sebelum 12:00) dan sesi 2 (siang). */
export function groupSessions(candles, gmtoffset) {
  const out = [];
  let bucket = [];
  for (const c of candles) {
    if (bucket.length && !sameKey(sessionKey(c.time, gmtoffset), sessionKey(bucket[0].time, gmtoffset))) {
      out.push(merge(bucket));
      bucket = [];
    }
    bucket.push(c);
  }
  if (bucket.length) out.push(merge(bucket));
  return out;
}

/** Buang candle yang masih berjalan supaya sinyal tidak muncul lalu hilang (repaint). nowSec untuk tes. */
export function dropForming(candles, interval, meta, gmtoffset, nowSec = now()) {
  if (!candles.length) return candles;
  const t = nowSec;
  const last = candles[candles.length - 1].time;
  const reg = (meta.currentTradingPeriod || {}).regular || {};
  const start = "start" in reg ? reg.start : 0, end = "end" in reg ? reg.end : 0;
  const marketOpen = start <= t && t < end;
  let forming;
  if (interval === "1wk") {
    // Yahoo kadang menambah baris "live" terpisah (bukan Senin 00:00) -> buang.
    // Candle minggu berjalan baru dianggap selesai setelah bursa tutup hari Jumat.
    const closeSod = reg.end ? pyMod(reg.end + gmtoffset, 86400) : 86400;
    return candles.filter((c) => pyMod(floorDiv(c.time + gmtoffset, 86400) + 3, 7) === 0
      && pyMod(c.time + gmtoffset, 86400) === 0
      && c.time + 4 * 86400 + closeSod <= t);
  } else if (interval === "1d") {
    forming = marketOpen && last >= reg.start - 3 * 3600;
  } else if (interval === "4h") {
    forming = marketOpen && sameKey(sessionKey(last, gmtoffset), sessionKey(t, gmtoffset));
  } else {
    forming = marketOpen && last + 3600 > t;
  }
  return forming ? candles.slice(0, -1) : candles;
}

function merge(b) {
  let volume = 0;
  for (const c of b) volume += c.volume;
  return {
    time: b[0].time, open: b[0].open, high: Math.max(...b.map((c) => c.high)),
    low: Math.min(...b.map((c) => c.low)), close: b[b.length - 1].close, volume,
  };
}

async function binance(sym, interval) {
  if (!Object.hasOwn(BINANCE_INTERVALS, interval)) {
    throw new Error(`Interval ${interval} tidak tersedia untuk crypto. Pilih: ${Object.keys(BINANCE_INTERVALS).join(", ")}`);
  }
  const path = "/api/v3/klines?" + new URLSearchParams({ symbol: sym, interval: BINANCE_INTERVALS[interval], limit: "1000" });
  let rows, lastErr = null, ok = false;
  for (const host of BINANCE_HOSTS) {
    try {
      rows = await httpGetJson(host + path);
      ok = true;
      break;
    } catch (e) {
      if (e.status === 400) throw new Error(`Pair ${sym} tidak ada di Binance.`);
      lastErr = e; // coba host berikutnya
    }
  }
  if (!ok) throw new Error(`Gagal ambil data Binance: ${lastErr && lastErr.message}`);
  let candles = rows.map((r) => ({
    time: Math.trunc(r[0] / 1000), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
    close: Number(r[4]), volume: Number(r[5]),
  }));
  // buang candle yang belum close agar sinyal tidak "berubah-ubah"
  if (rows.length && rows[rows.length - 1][6] > now() * 1000) candles = candles.slice(0, -1);
  const quote = QUOTES.find((q) => sym.endsWith(q)) || "";
  return {
    symbol: sym,
    name: quote ? sym.slice(0, -quote.length) + "/" + quote : sym,
    currency: quote,
    market: "crypto",
    interval,
    candles,
  };
}

// ---------------------------------------------------------------- analisa (pengganti server.py)

/** Sama dengan server.run_analysis. */
export async function analyzeSymbol(symbol, market, interval = "1d", opts = {}, { fresh = false, withCandles = true } = {}) {
  const d = await fetchMarket(symbol, market, interval, { fresh });
  const res = analyze(d.candles, paramsFrom(opts, market));
  for (const k of ["symbol", "name", "currency", "market", "interval"]) res[k] = d[k];
  if (withCandles) {
    res.candles = d.candles;
  } else {
    res.last_signal = res.signals.length ? res.signals[res.signals.length - 1] : null;
    for (const k of ["signals", "scores", "series", "trades"]) delete res[k];
  }
  return res;
}

const SCAN_KEYS = ["symbol", "name", "market", "currency", "action", "score", "price", "time", "advice", "backtest", "last_signal"];

/** Sama dengan server._scan: items [{symbol, market}], paralel 6, onResult(row) per item selesai. */
export async function scan(items, interval = "1d", opts = {}, onResult = null) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      let row;
      try {
        const r = await analyzeSymbol(item.symbol, item.market, interval, opts, { withCandles: false });
        row = {};
        for (const k of SCAN_KEYS) row[k] = r[k];
        row.input = item.symbol;
      } catch (e) {
        row = { input: item.symbol, symbol: item.symbol, market: item.market, error: e && e.message !== undefined ? e.message : String(e) };
      }
      out[idx] = row;
      if (onResult) {
        try { onResult(row, idx); } catch { /* callback UI tidak boleh menghentikan scan */ }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
  return out;
}

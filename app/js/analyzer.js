// Mesin analisa: indikator teknikal, skor sinyal, titik BUY/SELL, dan backtest.
// Port 1:1 dari analyzer.py — hasil harus identik secara numerik dengan versi Python.
// Input: array candle {time, open, high, low, close, volume}, urut dari lama ke baru.

// ---------------------------------------------------------------- helper paritas Python

// Nilai desimal eksak sebuah double: |x| = D / 10^s (D BigInt).
function exactDecimal(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const bexp = hi >>> 20;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (bexp === 0) e = -1074;
  else { m |= 1n << 52n; e = bexp - 1075; }
  if (e >= 0) return { D: m << BigInt(e), s: 0 };
  return { D: m * 5n ** BigInt(-e), s: -e };
}

// round-half-even dari D/10^s ke n desimal -> integer N (nilai N/10^n)
function roundDec(D, s, n) {
  if (s <= n) return D * 10n ** BigInt(n - s);
  const div = 10n ** BigInt(s - n);
  let q = D / div;
  const r = D % div, half = div / 2n;
  if (r > half || (r === half && (q & 1n) === 1n)) q += 1n;
  return q;
}

const negative = (x) => x < 0 || Object.is(x, -0);

/** Python round(x, n) (n >= 0) — dibulatkan dari nilai biner eksak, banker's rounding. */
export function pyRound(x, n = 0) {
  if (!Number.isFinite(x) || x === 0) return x;
  const { D, s } = exactDecimal(x);
  const v = Number(`${roundDec(D, s, n)}e-${n}`);
  return negative(x) ? -v : v;
}

/** Python format(x, '.nf') / '+.nf' */
export function fmtF(x, n, plus = false) {
  const sign = negative(x) ? "-" : plus ? "+" : "";
  if (x === 0) return sign + (0).toFixed(n);
  const { D, s } = exactDecimal(x);
  let ds = roundDec(D, s, n).toString();
  if (n > 0) {
    ds = ds.padStart(n + 1, "0");
    ds = ds.slice(0, -n) + "." + ds.slice(-n);
  }
  return sign + ds;
}

/** Python format(x, 'g') (presisi 6) */
export function fmtG(x, p = 6) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const sign = negative(x) ? "-" : "";
  if (x === 0) return sign + "0";
  const { D, s } = exactDecimal(x);
  const L = D.toString().length;
  let exp = L - 1 - s;
  let N = D;
  if (L > p) {
    N = roundDec(D, L - p, 0);
    if (N.toString().length > p) { N /= 10n; exp += 1; }
  }
  const ds = N.toString().replace(/0+$/, "") || "0";
  let out;
  if (exp >= -4 && exp < p) {
    if (exp >= 0) {
      const ip = ds.slice(0, exp + 1).padEnd(exp + 1, "0");
      const fp = ds.slice(exp + 1);
      out = fp ? `${ip}.${fp}` : ip;
    } else {
      out = "0." + "0".repeat(-exp - 1) + ds;
    }
  } else {
    const mant = ds.length > 1 ? `${ds[0]}.${ds.slice(1)}` : ds;
    out = `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return sign + out;
}

/** Python repr(float) */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return negative(x) ? "-0.0" : "0.0";
  const [mant, e] = Math.abs(x).toExponential().split("e");
  const ds = mant.replace(".", "");
  const exp = Number(e);
  const sign = x < 0 ? "-" : "";
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const ip = ds.slice(0, exp + 1).padEnd(exp + 1, "0");
      return `${sign}${ip}.${ds.slice(exp + 1) || "0"}`;
    }
    return `${sign}0.${"0".repeat(-exp - 1)}${ds}`;
  }
  const m = ds.length > 1 ? `${ds[0]}.${ds.slice(1)}` : ds;
  return `${sign}${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** Python sum() atas float (Python >= 3.12 memakai penjumlahan terkompensasi Neumaier). */
export function pySum(values) {
  let hi = 0, lo = 0;
  for (const x of values) {
    const t = hi + x;
    if (Math.abs(hi) >= Math.abs(x)) lo += (hi - t) + x;
    else lo += (x - t) + hi;
    hi = t;
  }
  return lo && Number.isFinite(lo) ? hi + lo : hi;
}

// ---------------------------------------------------------------- indikator

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    if (prev === null) {
      if (i + 1 >= period) {
        const window = values.slice(i + 1 - period, i + 1);
        if (window.every((x) => x !== null && x !== undefined)) {
          prev = pySum(window) / period;
          out[i] = prev;
        }
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let total = 0.0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
    if (i >= period) total -= values[i - period];
    if (i + 1 >= period) out[i] = total / period;
  }
  return out;
}

function rsiValue(avgG, avgL) {
  if (avgL === 0) return avgG > 0 ? 100.0 : 50.0;
  return 100 - 100 / (1 + avgG / avgL);
}

/** RSI versi Wilder. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0.0, losses = 0.0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gains += Math.max(d, 0);
    losses += Math.max(-d, 0);
  }
  let avgG = gains / period, avgL = losses / period;
  out[period] = rsiValue(avgG, avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiValue(avgG, avgL);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = ef.map((a, i) => (a !== null && es[i] !== null ? a - es[i] : null));
  const sig = ema(line, signal);
  const hist = line.map((a, i) => (a !== null && sig[i] !== null ? a - sig[i] : null));
  return [line, sig, hist];
}

export function bollinger(closes, period = 20, mult = 2.0) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i + 1 - period, i + 1);
    const sd = Math.sqrt(pySum(window.map((x) => { const d = x - mid[i]; return d * d; })) / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return [mid, upper, lower];
}

export function atr(candles, period = 14) {
  const trs = [];
  candles.forEach((c, i) => {
    if (i === 0) trs.push(c.high - c.low);
    else {
      const pc = candles[i - 1].close;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
    }
  });
  const out = new Array(candles.length).fill(null);
  if (trs.length < period) return out;
  let prev = pySum(trs.slice(0, period)) / period;
  out[period - 1] = prev;
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

// ---------------------------------------------------------------- skor

export const DEFAULTS = Object.freeze({
  // "trend": BUY saat EMA20 memotong ke atas EMA50, SELL saat memotong ke bawah / kena trailing stop.
  // "score": BUY/SELL berdasarkan skor gabungan RSI+MACD+Bollinger+tren.
  // "dip":   beli saat koreksi (RSI < 35) selama harga di atas EMA200, jual saat RSI > 55 atau kena stop tetap.
  // "turtle": aturan Turtle Traders: BUY saat close menembus tertinggi 20 candle sebelumnya,
  //          SELL saat close menembus terendah 10 candle sebelumnya atau kena stop tetap.
  strategy: "trend",
  // Filter MA200 (SMA 200 candle): BUY hanya kalau harga di atas MA200 (tidak berlaku untuk "dip").
  ma200: false,
  buy_threshold: 50,
  sell_threshold: -50,
  atr_stop: 3.0,
  fee_pct: 0.2,
});

export const WARMUP = 50;
export const DIP_BUY_RSI = 35;
export const DIP_SELL_RSI = 55;

/** Skor -100..+100 untuk bar ke-i, plus alasan yang bisa dibaca manusia. Mengembalikan [skor, [[dir, teks], ...]]. */
export function scoreBar(i, close, ind) {
  const e20 = ind.ema20[i], e50 = ind.ema50[i];
  const r = ind.rsi[i];
  const h = ind.hist[i], hPrev = ind.hist.at(i - 1);
  const m = ind.macd[i], s = ind.signal[i];
  const up = ind.bb_upper[i], lo = ind.bb_lower[i];
  const vol = ind.volume[i], volAvg = ind.vol_avg[i];
  if ([e20, e50, r, h, hPrev, up, lo].some((v) => v === null || v === undefined)) return [0, []];

  let score = 0;
  const why = [];

  // 1. Tren (bobot 30)
  if (close > e50 && e20 > e50) {
    score += 30;
    why.push(["+", "Tren naik: harga & EMA20 di atas EMA50"]);
  } else if (close < e50 && e20 < e50) {
    score -= 30;
    why.push(["-", "Tren turun: harga & EMA20 di bawah EMA50"]);
  } else if (close > e50) {
    score += 10;
    why.push(["+", "Harga di atas EMA50 (tren mulai membaik)"]);
  } else {
    score -= 10;
    why.push(["-", "Harga di bawah EMA50 (tren melemah)"]);
  }

  // 2. Momentum MACD (bobot 25)
  const crossedUp = h > 0 && hPrev <= 0;
  const crossedDn = h < 0 && hPrev >= 0;
  if (crossedUp) {
    score += 25;
    why.push(["+", "MACD baru cross ke atas garis sinyal"]);
  } else if (crossedDn) {
    score -= 25;
    why.push(["-", "MACD baru cross ke bawah garis sinyal"]);
  } else if (m > s) {
    score += h > hPrev ? 15 : 5;
    why.push(["+", "MACD di atas sinyal" + (h > hPrev ? " & menguat" : " tapi melambat")]);
  } else {
    score -= h < hPrev ? 15 : 5;
    why.push(["-", "MACD di bawah sinyal" + (h < hPrev ? " & melemah" : " tapi mulai pulih")]);
  }

  // 3. RSI (bobot 25)
  if (r < 30) {
    score += 25;
    why.push(["+", `RSI ${fmtF(r, 0)}: jenuh jual (oversold)`]);
  } else if (r < 45) {
    score += 10;
    why.push(["+", `RSI ${fmtF(r, 0)}: masih murah`]);
  } else if (r > 75) {
    score -= 25;
    why.push(["-", `RSI ${fmtF(r, 0)}: jenuh beli (overbought)`]);
  } else if (r > 65) {
    score -= 10;
    why.push(["-", `RSI ${fmtF(r, 0)}: mulai mahal`]);
  } else {
    why.push(["=", `RSI ${fmtF(r, 0)}: netral`]);
  }

  // 4. Bollinger Bands (bobot 20)
  const width = up - lo;
  const pctB = width > 0 ? (close - lo) / width : 0.5;
  if (pctB < 0) {
    score += 20;
    why.push(["+", "Harga tembus di bawah Bollinger bawah"]);
  } else if (pctB < 0.2) {
    score += 10;
    why.push(["+", "Harga dekat Bollinger bawah"]);
  } else if (pctB > 1) {
    score -= 20;
    why.push(["-", "Harga tembus di atas Bollinger atas"]);
  } else if (pctB > 0.8) {
    score -= 10;
    why.push(["-", "Harga dekat Bollinger atas"]);
  }

  // 5. Volume sebagai penguat arah
  if (volAvg && vol && vol > 1.5 * volAvg && score !== 0) {
    score = score * 1.2;
    why.push([score > 0 ? "+" : "-", `Volume ${fmtF(vol / volAvg, 1)}x rata-rata, menguatkan sinyal`]);
  }

  return [Math.max(-100, Math.min(100, pyRound(score))), why];
}

export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);
  const [line, sig, hist] = macd(closes);
  const [, bbUp, bbLo] = bollinger(closes);
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    sma200: sma(closes, 200),
    dc_upper: rolling(candles, "high", 20, Math.max), // tertinggi 20 candle SEBELUMNYA (tanpa candle ini)
    dc_lower: rolling(candles, "low", 10, Math.min), // terendah 10 candle sebelumnya
    rsi: rsi(closes),
    macd: line,
    signal: sig,
    hist,
    bb_upper: bbUp,
    bb_lower: bbLo,
    atr: atr(candles),
    volume: volumes,
    vol_avg: sma(volumes, 20),
  };
}

function rolling(candles, key, n, fn) {
  const out = new Array(candles.length).fill(null);
  for (let i = n; i < candles.length; i++) {
    let v = candles[i - n][key];
    for (let j = i - n + 1; j < i; j++) v = fn(v, candles[j][key]);
    out[i] = v;
  }
  return out;
}

// ---------------------------------------------------------------- sinyal + backtest

// Ambang yang diberikan lewat params (paramsFrom / server.params_from) bertipe float di Python,
// sehingga tercetak "60.0"; nilai default di DEFAULTS bertipe int ("50").
const fmtThreshold = (params, key, v) =>
  params && params[key] !== undefined && Number.isFinite(v) ? pyFloatRepr(v) : String(v);

export function analyze(candles, params = null) {
  const p = { ...DEFAULTS, ...(params || {}) };
  if (candles.length < WARMUP + 5) {
    throw new Error(`Data terlalu sedikit (${candles.length} candle), butuh minimal ${WARMUP + 5}.`);
  }

  const ind = computeIndicators(candles);
  const scores = new Array(candles.length).fill(0);
  const signals = [];
  const trades = [];

  let holding = false;
  let entry = null, peak = null, fixedStop = null, entryTime = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i];
    const [sc] = scoreBar(i, c.close, ind);
    scores[i] = sc;
    const a = ind.atr[i] || 0;

    const e20 = ind.ema20[i], e50 = ind.ema50[i];
    const golden = e20 > e50 && ind.ema20[i - 1] <= ind.ema50[i - 1];

    if (!holding) {
      let buyReason;
      if (p.strategy === "trend") {
        buyReason = golden ? "EMA20 memotong ke atas EMA50 (awal tren naik)" : null;
      } else if (p.strategy === "dip") {
        const e200 = ind.ema200[i], r = ind.rsi[i];
        const dip = e200 !== null && c.close > e200 && r !== null && r < DIP_BUY_RSI;
        buyReason = dip ? `Koreksi di tren naik: RSI ${fmtF(r, 0)} < ${DIP_BUY_RSI}, harga di atas EMA200` : null;
      } else if (p.strategy === "turtle") {
        const up = ind.dc_upper[i];
        buyReason = up !== null && c.close > up ? `Breakout Turtle: close menembus tertinggi 20 candle (${fmtG(up)})` : null;
      } else {
        buyReason = sc >= p.buy_threshold
          ? `Skor gabungan ${sc} >= ${fmtThreshold(params, "buy_threshold", p.buy_threshold)}` : null;
      }
      if (buyReason && p.ma200 && p.strategy !== "dip") {
        const s200 = ind.sma200[i];
        buyReason = s200 !== null && c.close > s200 ? buyReason + ", harga di atas MA200" : null;
      }
      if (buyReason) {
        holding = true;
        entry = c.close; peak = c.close; entryTime = c.time;
        fixedStop = c.close - p.atr_stop * a;
        signals.push({ time: c.time, type: "BUY", price: c.close, score: sc, reason: buyReason });
      }
      continue;
    }

    peak = Math.max(peak, c.close);
    // strategi dip & turtle memakai stop tetap dari harga beli; strategi lain trailing stop dari harga tertinggi
    const fixed = p.strategy === "dip" || p.strategy === "turtle";
    const stop = fixed ? fixedStop : peak - p.atr_stop * a;
    let reason = null;
    if (p.strategy === "trend" && e20 < e50) {
      reason = "EMA20 memotong ke bawah EMA50 (tren berbalik turun)";
    } else if (p.strategy === "dip" && (ind.rsi[i] || 0) > DIP_SELL_RSI) {
      reason = `RSI ${fmtF(ind.rsi[i], 0)} > ${DIP_SELL_RSI}: harga sudah pulih, ambil untung`;
    } else if (p.strategy === "turtle" && ind.dc_lower[i] !== null && c.close < ind.dc_lower[i]) {
      reason = `Close menembus terendah 10 candle (${fmtG(ind.dc_lower[i])}): tren selesai`;
    } else if (p.strategy === "score" && sc <= p.sell_threshold) {
      reason = `Skor gabungan ${sc} <= ${fmtThreshold(params, "sell_threshold", p.sell_threshold)}`;
    } else if (c.close < stop && fixed) {
      reason = `Kena stop loss ${fmtG(p.atr_stop)}x ATR dari harga beli`;
    } else if (c.close < stop) {
      reason = `Kena trailing stop ${fmtG(p.atr_stop)}x ATR (proteksi)`;
    }
    if (reason) {
      holding = false;
      signals.push({ time: c.time, type: "SELL", price: c.close, score: sc, reason });
      trades.push(trade(entryTime, entry, c.time, c.close, p.fee_pct));
    }
  }

  const maxDd = maxDrawdown(candles, signals, p.fee_pct / 100);

  const lastI = candles.length - 1;
  const last = candles[lastI];
  const [lastScore, reasons] = scoreBar(lastI, last.close, ind);
  const lastAtr = ind.atr[lastI] || 0;

  let openTrade = null;
  if (holding) {
    openTrade = trade(entryTime, entry, last.time, last.close, p.fee_pct);
    openTrade.open = true;
  }

  const e20 = ind.ema20[lastI], e50 = ind.ema50[lastI];
  const gap = e50 ? (e20 / e50 - 1) * 100 : null;
  const pe20 = ind.ema20[lastI - 1], pe50 = ind.ema50[lastI - 1];
  const closingIn = gap !== null && pe50 && gap > (pe20 / pe50 - 1) * 100;
  const e200 = ind.ema200[lastI], rNow = ind.rsi[lastI];
  const dipCtx = e200 === null || rNow === null ? null : [last.close > e200, rNow];
  const s200 = ind.sma200[lastI], up20 = ind.dc_upper[lastI];
  const filterCtx = { ma200: p.ma200 && p.strategy !== "dip", sma200: s200, dc_upper: up20 };
  const [action, advice] = currentAction(signals, holding, last, lastScore, p, e20 > e50, gap, closingIn, dipCtx,
    filterCtx);
  const risk = p.atr_stop * lastAtr;
  let plan;
  if (holding) {
    let sl;
    if (p.strategy === "turtle") { // keluar di stop tetap ATAU terendah 10 candle, mana yang lebih dulu kena
      const low10 = ind.dc_lower[lastI];
      sl = low10 !== null ? Math.max(fixedStop, low10) : fixedStop;
    } else {
      sl = p.strategy === "dip" ? fixedStop : peak - risk;
    }
    plan = { entry, stop_loss: pyRound(sl, 8), target_1: null, target_2: null };
  } else {
    plan = {
      entry: last.close,
      stop_loss: pyRound(last.close - risk, 8),
      target_1: pyRound(last.close + risk, 8),
      target_2: pyRound(last.close + 2 * risk, 8),
    };
  }

  const series = {};
  for (const k of ["ema20", "ema50", "ema200", "sma200", "dc_upper", "dc_lower", "bb_upper", "bb_lower"]) {
    series[k] = [];
    candles.forEach((c, i) => {
      if (ind[k][i] !== null) series[k].push({ time: c.time, value: r8(ind[k][i]) });
    });
  }

  return {
    action,
    advice,
    score: lastScore,
    reasons: reasons.map(([d, t]) => ({ dir: d, text: t })),
    price: last.close,
    time: last.time,
    plan,
    indicators_now: {
      rsi: r8(ind.rsi[lastI]),
      ema20: r8(ind.ema20[lastI]),
      ema50: r8(ind.ema50[lastI]),
      macd_hist: r8(ind.hist[lastI]),
      atr: r8(lastAtr),
    },
    signals,
    scores: candles.slice(WARMUP).map((c, j) => ({ time: c.time, value: scores[j + WARMUP] })),
    series,
    backtest: backtestStats(trades, openTrade, candles[WARMUP].close, last.close, maxDd),
    trades: openTrade ? [...trades, openTrade] : trades,
    params: p,
  };
}

function currentAction(signals, holding, last, score, p, trendUp, gap, closingIn, dipCtx = null, filterCtx = null) {
  const lastSig = signals.length ? signals[signals.length - 1] : null;
  const fresh = lastSig && lastSig.time === last.time;
  if (fresh && lastSig.type === "BUY") return ["BUY", "Sinyal BELI baru muncul di candle terakhir."];
  if (fresh && lastSig.type === "SELL") return ["SELL", `Sinyal JUAL baru muncul: ${lastSig.reason.toLowerCase()}.`];
  if (holding) {
    const pnl = (last.close / lastSig.price - 1) * 100;
    return ["HOLD", `Masih dalam posisi sejak sinyal BUY di ${fmtG(lastSig.price)} (${fmtF(pnl, 1, true)}%). Tahan, tunggu sinyal SELL.`];
  }
  const f = filterCtx || {};
  if (f.ma200) {
    if (f.sma200 === null || f.sma200 === undefined) {
      return ["WAIT", "Filter MA200 aktif, tapi data belum cukup (butuh 200 candle)."];
    }
    if (last.close <= f.sma200) {
      return ["WAIT", `Harga di bawah MA200 (${fmtG(f.sma200)}) — filter MA200 menahan sinyal BUY `
        + "sampai tren besar kembali naik."];
    }
  }
  if (p.strategy === "turtle") {
    const up = f.dc_upper;
    if (up === null || up === undefined) return ["WAIT", "Tunggu harga menembus tertinggi 20 candle."];
    const dist = (up / last.close - 1) * 100;
    if (dist <= 2) {
      return ["WAIT", `Harga tinggal ${fmtF(dist, 1)}% di bawah titik breakout (${fmtG(up)}) — sinyal BUY bisa segera muncul.`];
    }
    return ["WAIT", `Tunggu breakout: BUY muncul kalau close menembus tertinggi 20 candle (${fmtG(up)}).`];
  }
  if (p.strategy === "trend" && trendUp) {
    return ["WAIT", "Tren sedang naik, tapi sinyal BUY-nya sudah lewat / sudah keluar karena stop. "
      + "Tunggu sinyal BUY berikutnya — jangan kejar harga."];
  }
  if (p.strategy === "trend" && closingIn && gap > -1.5) {
    return ["WAIT", `EMA20 tinggal ${fmtF(Math.abs(gap), 1)}% di bawah EMA50 — sinyal BUY bisa segera muncul, pantau terus.`];
  }
  if (p.strategy === "dip") {
    if (dipCtx === null) return ["WAIT", "Data belum cukup untuk EMA200 (butuh 200 candle)."];
    const [above, r] = dipCtx;
    if (!above) return ["WAIT", "Harga di bawah EMA200 (tren besar turun). Strategi ini tidak beli di kondisi begini."];
    if (r < 45) return ["WAIT", `Tren besar naik dan RSI ${fmtF(r, 0)} mulai turun — BUY muncul kalau RSI di bawah ${DIP_BUY_RSI}.`];
    return ["WAIT", `Tren besar naik. Tunggu koreksi sampai RSI di bawah ${DIP_BUY_RSI} (sekarang ${fmtF(r, 0)}).`];
  }
  if (p.strategy === "score" && score >= p.buy_threshold * 0.7) {
    return ["WAIT", "Belum ada posisi. Skor mendekati area beli — pantau terus."];
  }
  return ["WAIT", "Belum ada posisi. Tunggu sampai muncul sinyal BUY."];
}

function trade(tIn, pIn, tOut, pOut, feePct) {
  const gross = pOut / pIn - 1;
  const f = 1 - feePct / 100;
  const net = (1 + gross) * (f * f) - 1;
  return { entry_time: tIn, entry_price: pIn, exit_time: tOut, exit_price: pOut, return_pct: pyRound(net * 100, 2) };
}

/** Penurunan modal terdalam, dinilai di setiap close (termasuk saat posisi masih terbuka). */
function maxDrawdown(candles, signals, fee) {
  const sig = new Map();
  for (const s of signals) sig.set(s.time, s);
  let realized = 1.0, peak = 1.0, maxDd = 0.0, entry = null;
  const f = 1 - fee, f2 = f * f;
  for (const c of candles) {
    const s = sig.get(c.time);
    if (s && s.type === "BUY") entry = c.close;
    const equity = entry !== null ? realized * (c.close / entry) * f2 : realized;
    if (s && s.type === "SELL") { realized = equity; entry = null; }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return maxDd;
}

function backtestStats(trades, openTrade, firstPrice, lastPrice, maxDd) {
  const closed = trades.map((t) => t.return_pct);
  let equity = 1.0;
  for (const r of openTrade ? [...closed, openTrade.return_pct] : closed) equity *= 1 + r / 100;
  const wins = closed.filter((r) => r > 0);
  const n = closed.length;
  return {
    trades: n,
    win_rate: n ? pyRound(wins.length / n * 100, 1) : null,
    avg_return: n ? pyRound(pySum(closed) / n, 2) : null,
    best: n ? Math.max(...closed) : null,
    worst: n ? Math.min(...closed) : null,
    strategy_return: pyRound((equity - 1) * 100, 2),
    buy_hold_return: pyRound((lastPrice / firstPrice - 1) * 100, 2),
    max_drawdown: pyRound(maxDd * 100, 2),
  };
}

const r8 = (v) => (v === null || v === undefined ? null : pyRound(v, 8));

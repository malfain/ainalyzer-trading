// Analisa fundamental (laporan keuangan) + skor 0–100 untuk saham.
// Tidak menyentuh mesin sinyal teknikal; hanya memakai httpGetJson dari data.js (jalur Yahoo yang sama:
// handler native di APK, /proxy di preview lokal, Cloudflare Worker di website).
//
// Skor ini MENILAI kesehatan/valuasi/pertumbuhan dari laporan keuangan — BUKAN ramalan harga.
// Tidak ada alat yang bisa menjamin saham mana yang naik setahun ke depan.

import { httpGetJson } from './data.js';

// ---------------------------------------------------------------- daftar saham

// "45 saham besar (mirip LQ45, bukan daftar resmi)"
export const UNIVERSE = [
  'BBCA', 'BBRI', 'BMRI', 'BBNI', 'BRIS', 'ARTO', 'TLKM', 'EXCL', 'ISAT', 'TOWR', 'TBIG', 'ASII', 'UNTR', 'UNVR', 'ICBP',
  'INDF', 'KLBF', 'CPIN', 'AMRT', 'ACES', 'MAPI', 'ERAA', 'ADRO', 'PTBA', 'ITMG', 'HRUM', 'ANTM', 'INCO', 'MDKA', 'TINS',
  'MBMA', 'AMMN', 'MEDC', 'PGAS', 'AKRA', 'ESSA', 'BRPT', 'TPIA', 'INKP', 'SMGR', 'INTP', 'JSMR', 'GOTO', 'BUKA', 'EMTK',
];

// Bank: rasio utang (DER) dan arus kas operasi tidak bermakna -> dinilai dengan ROE, ROA & modal/aset.
export const BANKS = new Set([
  'BBCA', 'BBRI', 'BMRI', 'BBNI', 'BRIS', 'ARTO', 'BBTN', 'BDMN', 'BNGA', 'NISP', 'PNBN', 'BJTM', 'BJBR', 'MEGA', 'BTPS',
  'AGRO', 'BBYB', 'BNLI', 'BBKP', 'BBHI', 'BANK', 'MAYA', 'BNII', 'BSIM', 'BACA', 'BGTG', 'BINA', 'NOBU', 'AMAR', 'BBSI',
]);

export const SECTOR = {
  BBCA: 'Bank', BBRI: 'Bank', BMRI: 'Bank', BBNI: 'Bank', BRIS: 'Bank', ARTO: 'Bank',
  TLKM: 'Telko', EXCL: 'Telko', ISAT: 'Telko', TOWR: 'Menara', TBIG: 'Menara',
  ASII: 'Otomotif', UNTR: 'Alat berat', UNVR: 'Konsumer', ICBP: 'Konsumer', INDF: 'Konsumer', KLBF: 'Kesehatan',
  CPIN: 'Pakan ternak', AMRT: 'Ritel', ACES: 'Ritel', MAPI: 'Ritel', ERAA: 'Ritel',
  ADRO: 'Batu bara', PTBA: 'Batu bara', ITMG: 'Batu bara', HRUM: 'Batu bara',
  ANTM: 'Tambang', INCO: 'Tambang', MDKA: 'Tambang', TINS: 'Tambang', MBMA: 'Tambang', AMMN: 'Tambang',
  MEDC: 'Migas', PGAS: 'Migas', AKRA: 'Energi', ESSA: 'Kimia', BRPT: 'Kimia', TPIA: 'Kimia', INKP: 'Kertas',
  SMGR: 'Semen', INTP: 'Semen', JSMR: 'Jalan tol', GOTO: 'Teknologi', BUKA: 'Teknologi', EMTK: 'Media',
};

/** Kode tampilan (tanpa .JK) dari kode apa pun. */
export const tickerOf = s => String(s || '').toUpperCase().replace(/\.JK$/, '');
export const yahooSym = s => {
  const t = String(s || '').trim().toUpperCase();
  return !t.includes('.') && /^[A-Z]{4}$/.test(t) ? t + '.JK' : t;
};
export const isBank = s => BANKS.has(tickerOf(s));
export const sectorOf = s => SECTOR[tickerOf(s)] || (isBank(s) ? 'Bank' : 'Lainnya');

// ---------------------------------------------------------------- data Yahoo

export const TYPES = [
  'annualTotalRevenue', 'annualNetIncome', 'annualNetIncomeCommonStockholders', 'annualStockholdersEquity',
  'annualTotalAssets', 'annualTotalDebt', 'annualOperatingCashFlow', 'annualFreeCashFlow', 'annualCashDividendsPaid',
  'annualOrdinarySharesNumber', 'annualShareIssued', 'annualDilutedAverageShares',
  'quarterlyNetIncome', 'quarterlyStockholdersEquity', 'quarterlyOrdinarySharesNumber', 'trailingNetIncome',
];
export const PERIOD1 = 1420070400; // 2015-01-01 (Yahoo biasanya hanya memberi ±4 tahun terakhir)

export function timeseriesUrl(sym, period2 = Math.floor(Date.now() / 1000)) {
  const s = encodeURIComponent(sym);
  return `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${s}`
    + `?symbol=${s}&type=${TYPES.join(',')}&period1=${PERIOD1}&period2=${period2}`;
}

/** JSON timeseries Yahoo -> { tipe: [{date:'YYYY-MM-DD', value, cur}] } terurut naik, entri null dibuang. */
export function parseTimeseries(json) {
  const out = {};
  const results = (((json || {}).timeseries || {}).result) || [];
  for (const res of results) {
    const type = res && res.meta && Array.isArray(res.meta.type) ? res.meta.type[0] : null;
    if (!type || !Array.isArray(res[type])) continue;
    const arr = [];
    for (const e of res[type]) {
      const v = e && e.reportedValue ? Number(e.reportedValue.raw) : NaN;
      if (!e || typeof e.asOfDate !== 'string' || !Number.isFinite(v)) continue;
      arr.push({ date: e.asOfDate, value: v, cur: e.currencyCode || null });
    }
    arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (arr.length) out[type] = arr;
  }
  return out;
}

// ---------------------------------------------------------------- hitung metrik

const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
const num = v => (v == null || !Number.isFinite(v) ? null : v);
const avg2 = (a, b) => (a != null && b != null ? (a + b) / 2 : a);

/**
 * Metrik dari timeseries. Hanya data dengan tanggal <= asOf yang dipakai (untuk uji historis tanpa "mengintip").
 * opts: { price, fx, asOf, bank } — fx = kurs mata uang laporan -> mata uang harga (1 kalau sama, null kalau tak ada).
 */
export function computeMetrics(series, { price = null, fx = 1, asOf = null, bank = false } = {}) {
  const pick = type => (series[type] || []).filter(e => !asOf || e.date <= asOf);
  const niArr = pick('annualNetIncome').length ? pick('annualNetIncome') : pick('annualNetIncomeCommonStockholders');
  const byDate = arr => new Map(arr.map(e => [e.date, e.value]));
  const rev = byDate(pick('annualTotalRevenue')), eq = byDate(pick('annualStockholdersEquity'));
  const assets = byDate(pick('annualTotalAssets')), debt = byDate(pick('annualTotalDebt'));
  const ocf = byDate(pick('annualOperatingCashFlow')), div = byDate(pick('annualCashDividendsPaid'));
  const sharesA = pick('annualOrdinarySharesNumber').length ? pick('annualOrdinarySharesNumber')
    : pick('annualShareIssued').length ? pick('annualShareIssued') : pick('annualDilutedAverageShares');

  const yrs = niArr.slice(-4); // maks 4 tahun buku terakhir
  const m = { bank, years: [], currency: null, n: yrs.length };
  if (!yrs.length) return m;
  m.currency = yrs[yrs.length - 1].cur || null;
  m.years = yrs.map(e => ({ fy: Number(e.date.slice(0, 4)), date: e.date, ni: e.value, rev: num(rev.get(e.date)) }));
  const L = m.years[m.years.length - 1], P = m.years.length > 1 ? m.years[m.years.length - 2] : null;
  const F = m.years[0];
  m.fy = L.fy; m.fyDate = L.date;
  m.ni = L.ni; m.rev = L.rev;

  const eqL = num(eq.get(L.date)), eqP = P ? num(eq.get(P.date)) : null;
  const asL = num(assets.get(L.date)), asP = P ? num(assets.get(P.date)) : null;
  const eqAvg = avg2(eqL, eqP), asAvg = avg2(asL, asP);
  m.equity = eqL;
  m.roe = eqAvg != null && eqAvg > 0 ? L.ni / eqAvg : null;
  m.roa = asAvg != null && asAvg > 0 ? L.ni / asAvg : null;
  m.margin = L.rev != null && L.rev > 0 ? L.ni / L.rev : null;
  const ocfL = num(ocf.get(L.date));
  m.ocfNi = !bank && ocfL != null && L.ni > 0 ? ocfL / L.ni : null;
  const debtL = num(debt.get(L.date));
  m.der = !bank && debtL != null && eqL != null && eqL > 0 ? debtL / eqL : null;
  m.eqAssets = eqL != null && asL != null && asL > 0 ? eqL / asL : null;

  // pertumbuhan
  const span = m.years.length - 1;
  m.revYoY = P && P.rev > 0 && L.rev != null ? L.rev / P.rev - 1 : null;
  m.niYoY = P && P.ni > 0 ? L.ni / P.ni - 1 : null;
  m.revCagr = span >= 1 && F.rev > 0 && L.rev > 0 ? (L.rev / F.rev) ** (1 / span) - 1 : null;
  m.niCagr = span >= 1 && F.ni > 0 && L.ni > 0 ? (L.ni / F.ni) ** (1 / span) - 1 : null;
  m.turnaround = span >= 1 && F.ni <= 0 && L.ni > 0;
  m.pairs = span;
  m.growYears = m.years.reduce((n, y, i) => n + (i > 0 && y.ni > m.years[i - 1].ni ? 1 : 0), 0);
  m.posYears = m.years.filter(y => y.ni > 0).length;

  // laba 12 bulan terakhir (TTM): trailingNetIncome > 4 kuartal berurutan > tahunan
  m.niTtm = L.ni; m.ttmDate = L.date; m.ttm = false;
  const tr = pick('trailingNetIncome').filter(e => e.date > L.date && days(L.date, e.date) < 400);
  const q = pick('quarterlyNetIncome').slice(-4);
  if (tr.length) {
    const t = tr[tr.length - 1];
    m.niTtm = t.value; m.ttmDate = t.date; m.ttm = true;
  } else if (q.length === 4 && q[3].date > L.date && q.every((e, i) => i === 0 || Math.abs(days(q[i - 1].date, e.date) - 91) <= 12)) {
    m.niTtm = q.reduce((s, e) => s + e.value, 0); m.ttmDate = q[3].date; m.ttm = true;
  }
  const qEq = pick('quarterlyStockholdersEquity').filter(e => e.date > L.date);
  m.equityNow = qEq.length ? qEq[qEq.length - 1].value : eqL;
  const qSh = pick('quarterlyOrdinarySharesNumber').filter(e => e.date > L.date);
  const lastShares = qSh.length ? qSh[qSh.length - 1] : sharesA[sharesA.length - 1];
  m.shares = lastShares ? lastShares.value : null;
  const divL = num(div.get(L.date));

  // valuasi (perlu harga + kurs bila laporan beda mata uang dengan harga)
  m.price = num(price); m.fx = num(fx);
  m.per = m.pbv = m.divYield = m.peg = null;
  m.loss = m.niTtm <= 0;
  if (m.price > 0 && m.fx > 0 && m.shares > 0) {
    const eps = (m.niTtm * m.fx) / m.shares;
    m.eps = eps;
    m.per = eps > 0 ? m.price / eps : null;
    const bvps = m.equityNow != null ? (m.equityNow * m.fx) / m.shares : null;
    m.pbv = bvps > 0 ? m.price / bvps : null;
    m.divYield = divL != null ? (Math.abs(divL) * m.fx) / (m.shares * m.price) : null;
    const g = m.niCagr != null ? m.niCagr : m.niYoY;
    m.growthForPeg = g;
    m.peg = m.per != null && g != null && g > 0 ? m.per / (g * 100) : null;
  }
  return m;
}

// ---------------------------------------------------------------- skor
// Ambang sederhana & transparan (garis lurus di antara dua titik, dijepit 0..100):
//  Kualitas 35%  non-bank: ROE 0%→0 .. 20%→100 (bobot 50%), margin bersih 0%→0 .. 20%→100 (25%),
//                arus kas operasi / laba 0,5→0 .. 1,2→100 (25%).
//                bank: ROE 0%→0 .. 20%→100 (60%), ROA 0%→0 .. 2,5%→100 (40%).
//  Pertumbuhan 25%  pendapatan CAGR -5%→0 .. 15%→100 (35%), laba CAGR -10%→0 .. 20%→100 (45%;
//                dari rugi ke laba = 70, masih rugi = 0), porsi tahun laba naik (20%).
//  Valuasi 25%   PER 30x→0 .. 8x→100 (40%), PBV 5x→0 .. 1x→100 (30%), PEG 2,5→0 .. 0,5→100 (30%;
//                laba turun = 20). Rugi: PER & PEG = 0. Ambang dipilih di sekitar sebaran saham besar IDX
//                (median PER ±12–15x, PBV ±1,5–2x).
//  Keamanan 15%  non-bank: DER 2x→0 .. 0,3x→100 (60%), porsi tahun laba positif (40%).
//                bank: porsi tahun laba positif (50%), modal/aset 8%→0 .. 16%→100 (50%).
// Komponen yang datanya kosong dilewati (bobot dibagi ulang). Sub-skor tanpa data = 50 (netral) & ditandai.

export const WEIGHTS = { quality: 0.35, growth: 0.25, value: 0.25, safety: 0.15 };
export const lin = (x, lo, hi) => (x == null || !Number.isFinite(x) ? null : Math.max(0, Math.min(1, (x - lo) / (hi - lo))) * 100);
function wavg(parts) {
  let s = 0, w = 0;
  for (const [v, wt] of parts) if (v != null) { s += v * wt; w += wt; }
  return w ? s / w : null;
}

export function scoreMetrics(m) {
  if (!m || !m.n) return null;
  const loss = m.ni <= 0;
  const quality = m.bank
    ? wavg([[loss ? 0 : lin(m.roe, 0, 0.2), 0.6], [loss ? 0 : lin(m.roa, 0, 0.025), 0.4]])
    : wavg([[loss ? 0 : lin(m.roe, 0, 0.2), 0.5], [loss ? 0 : lin(m.margin, 0, 0.2), 0.25], [lin(m.ocfNi, 0.5, 1.2), 0.25]]);
  let growth = null;
  if (m.pairs >= 1) {
    const revG = m.revCagr != null ? m.revCagr : m.revYoY;
    const niG = m.ni <= 0 ? 0 : m.niCagr != null ? lin(m.niCagr, -0.1, 0.2) : m.turnaround ? 70 : null;
    growth = wavg([[lin(revG, -0.05, 0.15), 0.35], [niG, 0.45], [(m.growYears / m.pairs) * 100, 0.2]]);
  }
  let value = null;
  if (m.price > 0 && m.fx > 0 && m.shares > 0) {
    const perS = m.loss ? 0 : lin(m.per, 30, 8);
    const pegS = m.loss ? 0 : m.peg != null ? lin(m.peg, 2.5, 0.5) : m.growthForPeg != null && m.growthForPeg <= 0 ? 20 : null;
    value = wavg([[perS, 0.4], [lin(m.pbv, 5, 1), 0.3], [pegS, 0.3]]);
  }
  const posShare = (m.posYears / m.n) * 100;
  const safety = m.bank
    ? wavg([[posShare, 0.5], [lin(m.eqAssets, 0.08, 0.16), 0.5]])
    : wavg([[lin(m.der, 2, 0.3), 0.6], [posShare, 0.4]]);
  const sub = { quality, growth, value, safety };
  const missing = Object.keys(sub).filter(k => sub[k] == null);
  for (const k of missing) sub[k] = 50;
  let total = 0;
  for (const k of Object.keys(WEIGHTS)) total += sub[k] * WEIGHTS[k];
  for (const k of Object.keys(sub)) sub[k] = Math.round(sub[k]);
  const score = Math.round(total);
  return { score, sub, missing, band: bandOf(score) };
}

export function bandOf(score) {
  if (score >= 75) return { key: 'strong', label: 'Fundamental kuat' };
  if (score >= 60) return { key: 'good', label: 'Cukup baik' };
  if (score >= 45) return { key: 'avg', label: 'Biasa' };
  return { key: 'weak', label: 'Lemah' };
}

// ---------------------------------------------------------------- teks penjelasan

const p0 = v => `${(v * 100).toFixed(0)}%`;
const p1 = v => `${(v * 100).toFixed(1).replace('.', ',')}%`;
const x1 = v => `${v >= 100 ? v.toFixed(0) : v.toFixed(1).replace('.', ',')}x`;
const sgn = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;

/** Daftar metrik kunci dengan vonis bahasa awam. tone: good | ok | bad | na */
export function verdicts(m) {
  if (!m || !m.n) return [];
  const out = [];
  const add = (key, label, value, verdict, tone) => out.push({ key, label, value, verdict, tone });
  if (m.ni <= 0) add('roe', 'ROE', 'rugi', 'Perusahaan rugi di tahun buku terakhir', 'bad');
  else if (m.roe != null) {
    const r = m.roe;
    add('roe', 'ROE', p0(r), r >= 0.15 ? 'Sangat baik (>15%)' : r >= 0.1 ? 'Baik (10–15%)' : r >= 0.05 ? 'Cukup (5–10%)' : 'Lemah (<5%)',
      r >= 0.1 ? 'good' : r >= 0.05 ? 'ok' : 'bad');
  }
  if (m.bank) {
    if (m.roa != null) add('roa', 'ROA', p1(m.roa), m.roa >= 0.02 ? 'Sangat baik untuk bank (>2%)' : m.roa >= 0.015 ? 'Baik (1,5–2%)' : m.roa >= 0.01 ? 'Cukup (1–1,5%)' : 'Lemah (<1%)',
      m.roa >= 0.015 ? 'good' : m.roa >= 0.01 ? 'ok' : 'bad');
  } else if (m.margin != null) {
    const g = m.margin;
    add('margin', 'Margin laba', p1(g), g >= 0.15 ? 'Sangat tebal (>15%)' : g >= 0.08 ? 'Sehat (8–15%)' : g > 0.03 ? 'Tipis (3–8%)' : g > 0 ? 'Sangat tipis (<3%)' : 'Rugi',
      g >= 0.08 ? 'good' : g > 0.03 ? 'ok' : 'bad');
  }
  if (m.ocfNi != null) add('ocf', 'Kas operasi / laba', x1(m.ocfNi), m.ocfNi >= 1 ? 'Laba didukung uang kas' : m.ocfNi >= 0.7 ? 'Sebagian besar jadi kas' : 'Laba belum banyak jadi kas',
    m.ocfNi >= 1 ? 'good' : m.ocfNi >= 0.7 ? 'ok' : 'bad');
  const revG = m.revCagr != null ? m.revCagr : m.revYoY;
  if (revG != null) {
    const yrs = m.revCagr != null ? ` (rata-rata ${m.pairs} thn)` : ' (1 thn)';
    add('revg', 'Pendapatan', sgn(revG) + (m.revCagr != null ? '/thn' : ''), (revG >= 0.1 ? 'Tumbuh cepat' : revG >= 0.03 ? 'Tumbuh' : revG >= -0.03 ? 'Stagnan' : 'Turun') + yrs,
      revG >= 0.03 ? 'good' : revG >= -0.03 ? 'ok' : 'bad');
  }
  if (m.ni <= 0) add('nig', 'Laba bersih', 'rugi', 'Masih rugi di tahun buku terakhir', 'bad');
  else if (m.niCagr != null) {
    const g = m.niCagr;
    add('nig', 'Laba bersih', `${sgn(g)}/thn`, (g >= 0.1 ? 'Tumbuh cepat' : g >= 0.03 ? 'Tumbuh' : g >= -0.03 ? 'Stagnan' : 'Turun') + ` (rata-rata ${m.pairs} thn)`,
      g >= 0.03 ? 'good' : g >= -0.03 ? 'ok' : 'bad');
  } else if (m.turnaround) add('nig', 'Laba bersih', 'baru untung', 'Dari rugi menjadi laba', 'ok');
  if (m.n >= 2) add('cons', 'Tahun laba', `${m.posYears}/${m.n}`, m.posYears === m.n
    ? (m.growYears === m.pairs ? `Laba selalu positif & naik ${m.pairs} thn` : m.growYears === 0 ? 'Laba positif, tapi tidak pernah naik' : `Laba selalu positif, naik ${m.growYears} dari ${m.pairs} thn`)
    : m.posYears === 0 ? `Rugi di semua ${m.n} thn` : 'Pernah rugi', m.posYears === m.n ? (m.growYears === m.pairs ? 'good' : 'ok') : 'bad');
  if (m.bank) add('der', 'DER', '—', 'Tidak dipakai untuk bank (utang = dana nasabah)', 'na');
  else if (m.der != null) add('der', 'Utang / ekuitas (DER)', x1(m.der), m.der <= 0.5 ? 'Sangat aman (<0,5x)' : m.der <= 1 ? 'Aman (0,5–1x)' : m.der <= 2 ? 'Waspada (1–2x)' : 'Berisiko (>2x)',
    m.der <= 1 ? 'good' : m.der <= 2 ? 'ok' : 'bad');
  if (m.bank && m.eqAssets != null) add('car', 'Modal / aset', p1(m.eqAssets), m.eqAssets >= 0.14 ? 'Permodalan tebal' : m.eqAssets >= 0.1 ? 'Permodalan cukup' : 'Permodalan tipis',
    m.eqAssets >= 0.14 ? 'good' : m.eqAssets >= 0.1 ? 'ok' : 'bad');
  if (m.price > 0 && m.fx > 0 && m.shares > 0) {
    if (m.loss) add('per', 'PER', 'rugi', 'Tidak bermakna (laba 12 bln ≤ 0)', 'bad');
    else if (m.per != null && m.per > 100) add('per', `PER${m.ttm ? ' (TTM)' : ''}`, '>100x', 'Laba sangat kecil, PER tidak bermakna', 'bad');
    else if (m.per != null) add('per', `PER${m.ttm ? ' (TTM)' : ''}`, x1(m.per), m.per < 10 ? 'Murah (<10x)' : m.per <= 15 ? 'Wajar (10–15x)' : m.per <= 25 ? 'Agak mahal (15–25x)' : 'Mahal (>25x)',
      m.per <= 15 ? 'good' : m.per <= 25 ? 'ok' : 'bad');
    if (m.pbv != null) add('pbv', 'PBV', x1(m.pbv), m.pbv <= 1 ? 'Di bawah nilai buku' : m.pbv <= 2 ? 'Wajar (1–2x)' : m.pbv <= 4 ? 'Premium (2–4x)' : 'Mahal (>4x)',
      m.pbv <= 2 ? 'good' : m.pbv <= 4 ? 'ok' : 'bad');
    if (m.peg != null) add('peg', 'PEG', x1(m.peg).replace('x', ''), m.peg <= 1 ? 'Murah dibanding pertumbuhannya' : m.peg <= 2 ? 'Wajar dibanding pertumbuhan' : 'Mahal dibanding pertumbuhan',
      m.peg <= 1 ? 'good' : m.peg <= 2 ? 'ok' : 'bad');
    if (m.divYield != null) add('dy', 'Dividen yield', p1(m.divYield), m.divYield >= 0.05 ? 'Tinggi (>5%)' : m.divYield >= 0.025 ? 'Lumayan (2,5–5%)' : m.divYield > 0 ? 'Kecil' : 'Tidak bagi dividen',
      m.divYield >= 0.025 ? 'good' : m.divYield > 0 ? 'ok' : 'na');
    else add('dy', 'Dividen yield', '0%', 'Tidak ada dividen tercatat', 'na');
  }
  return out;
}

/** Satu baris alasan singkat, mis. "ROE 21% · laba tumbuh 3 thn · PER 10x". */
export function reasonLine(m) {
  if (!m || !m.n) return 'Data laporan keuangan tidak tersedia';
  const parts = [];
  parts.push(m.ni <= 0 ? `rugi FY${m.fy}` : m.roe != null ? `ROE ${p0(m.roe)}` : m.margin != null ? `margin ${p0(m.margin)}` : 'laba positif');
  if (m.ni > 0 && m.pairs >= 2 && m.growYears === m.pairs) parts.push(`laba tumbuh ${m.pairs} thn`);
  else if (m.ni > 0 && m.turnaround) parts.push('baru untung');
  else if (m.ni > 0 && m.niYoY != null) parts.push(m.niYoY >= 0 ? `laba ${sgn(m.niYoY)}` : `laba turun ${Math.abs(m.niYoY * 100).toFixed(0)}%`);
  if (m.price > 0) {
    if (m.loss && m.ni > 0) parts.push('rugi 12 bln');
    else if (!m.loss && m.per != null) parts.push(m.per > 100 ? 'PER >100x' : `PER ${x1(m.per)}`);
    if (m.bank && m.pbv != null) parts.push(`PBV ${x1(m.pbv)}`);
    else if (!m.bank && m.der != null && m.der > 1.5) parts.push(`DER ${x1(m.der)}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------- ambil data (aplikasi)

const CACHE_KEY = 'rt.fund.v1';
const CACHE_MS = 24 * 3600 * 1000;
const mem = new Map();
let fxMem = null; // { at, rate } USD -> IDR

function readStore() {
  try { const o = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function writeStore(sym, val) {
  try {
    const o = readStore();
    o[sym] = val;
    for (const k of Object.keys(o)) if (!o[k] || Date.now() - o[k].at > CACHE_MS) delete o[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(o));
  } catch { /* penyimpanan penuh / diblokir */ }
}

async function quote(sym) {
  const d = await httpGetJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`);
  const res = d && d.chart && d.chart.result && d.chart.result[0];
  if (!res) throw new Error(`Harga ${tickerOf(sym)} tidak ditemukan.`);
  const meta = res.meta || {};
  let price = num(meta.regularMarketPrice);
  if (!(price > 0)) {
    const c = ((((res.indicators || {}).quote || [{}])[0]).close || []).filter(v => v != null);
    price = c.length ? c[c.length - 1] : null;
  }
  return { price, currency: meta.currency || null, name: meta.shortName || meta.longName || '' };
}

/** Kurs mata uang laporan -> mata uang harga. Hanya USD<->IDR yang didukung (cukup untuk saham IDX). */
export async function fxRate(from, to) {
  if (!from || !to || from === to) return 1;
  if (!((from === 'USD' && to === 'IDR') || (from === 'IDR' && to === 'USD'))) return null;
  if (!fxMem || Date.now() - fxMem.at > 3600 * 1000) {
    const q = await quote('IDR=X');
    if (!(q.price > 0)) return null;
    fxMem = { at: Date.now(), rate: q.price };
  }
  return from === 'USD' ? fxMem.rate : 1 / fxMem.rate;
}

/** Ringkasan fundamental satu saham (dicache 24 jam di memori + localStorage). */
export async function loadFundamental(symbol, { fresh = false } = {}) {
  const sym = yahooSym(symbol);
  if (!fresh) {
    const hit = mem.get(sym) || readStore()[sym];
    if (hit && Date.now() - hit.at < CACHE_MS && hit.v === 1) { mem.set(sym, hit); return hit; }
  }
  const [json, q] = await Promise.all([httpGetJson(timeseriesUrl(sym)), quote(sym)]);
  const series = parseTimeseries(json);
  const bank = isBank(sym);
  const repCur = ((series.annualNetIncome || series.annualNetIncomeCommonStockholders || [])[0] || {}).cur || q.currency;
  const fx = await fxRate(repCur, q.currency).catch(() => null);
  const m = computeMetrics(series, { price: q.price, fx, bank });
  if (!m.n) throw new Error('Laporan keuangan tidak tersedia di Yahoo Finance.');
  const s = scoreMetrics(m);
  const out = {
    v: 1, at: Date.now(), symbol: sym, ticker: tickerOf(sym), name: q.name, sector: sectorOf(sym), bank,
    priceCurrency: q.currency, metrics: m, ...s, reason: reasonLine(m), verdicts: verdicts(m),
  };
  mem.set(sym, out);
  writeStore(sym, out);
  return out;
}

/** Muat banyak saham paralel (default 4). onEach(symbol, result|null, error|null). */
export async function loadMany(symbols, onEach, { concurrency = 4, fresh = false } = {}) {
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const sym = symbols[next++];
      try { const r = await loadFundamental(sym, { fresh }); onEach && onEach(sym, r, null); }
      catch (e) { onEach && onEach(sym, null, e && e.message ? e.message : String(e)); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
}

/** Hasil cache yang masih segar (tanpa jaringan), untuk tampilan awal. */
export function cachedFundamental(symbol) {
  const sym = yahooSym(symbol);
  const hit = mem.get(sym) || readStore()[sym];
  return hit && Date.now() - hit.at < CACHE_MS && hit.v === 1 ? hit : null;
}

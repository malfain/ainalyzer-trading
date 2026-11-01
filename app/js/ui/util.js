// Helper kecil tanpa dependensi: escaping, format angka/tanggal, localStorage aman.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// Escape SEMUA string dari data/pengguna sebelum masuk innerHTML.
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');

export const ACTIONS = ['BUY', 'SELL', 'HOLD', 'WAIT'];
export const act = a => (ACTIONS.includes(a) ? a : 'WAIT'); // aman dipakai sebagai nama class
export const LABEL = { BUY: 'BELI', SELL: 'JUAL', HOLD: 'TAHAN', WAIT: 'TUNGGU' };

export function fmt(v, cur) {
  if (v == null || isNaN(v)) return '–';
  const a = Math.abs(v);
  const d = cur === 'IDR' ? 0 : a === 0 || a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8;
  return Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function pct(v) {
  if (v == null || isNaN(v)) return '<span class="muted">–</span>';
  const n = Number(v);
  return `<span class="${n >= 0 ? 'pos' : 'neg'}">${n >= 0 ? '+' : ''}${n.toFixed(2)}%</span>`;
}

export function date(t, withTime) {
  const o = { day: '2-digit', month: 'short', year: '2-digit' };
  if (withTime) Object.assign(o, { hour: '2-digit', minute: '2-digit' });
  return new Date(t * 1000).toLocaleString('id-ID', o);
}

export function clock(ms) {
  return new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

export function ago(t) {
  const s = Date.now() / 1000 - t, d = Math.floor(s / 86400);
  if (d >= 1) return d + ' hari lalu';
  const h = Math.floor(s / 3600);
  return h >= 1 ? h + ' jam lalu' : 'baru saja';
}

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* penyimpanan penuh / diblokir */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* abaikan */ }
  },
};

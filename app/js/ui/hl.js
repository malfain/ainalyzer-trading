// Tampilan "Posisi Trader Top Hyperliquid" (kartu di tab Chart + ringkasan di tab Sinyal).
import { esc, act, fmt, LABEL } from './util.js';
import { ICON } from './icons.js?v=1.3.0';
import { coinFor, stance, interpret, shortAddr, validAddr, MAX_ROWS, MIN_TRADERS } from '../hyperliquid.js?v=1.3.0';

// $ ringkas: 1,2 M (miliar), 450 jt, 12 rb
export function usd(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const [d, u] = a >= 1e12 ? [1e12, ' T'] : a >= 1e9 ? [1e9, ' M'] : a >= 1e6 ? [1e6, ' jt'] : a >= 1e3 ? [1e3, ' rb'] : [1, ''];
  const x = a / d;
  return (v < 0 ? '-$' : '$') + x.toLocaleString('id-ID', { maximumFractionDigits: x >= 100 ? 0 : x >= 10 ? 1 : 2 }) + u;
}
const pctTxt = x => Math.round(x * 100) + '%';
const listDate = iso => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';
};
const vsPrice = (entry, price) => {
  if (entry == null || !price) return '';
  const d = (price / entry - 1) * 100;
  return `<small class="muted">harga ${d >= 0 ? '+' : ''}${d.toFixed(1).replace('.', ',')}% dari entry</small>`;
};

function bar(c, small = false) {
  const n = c.long + c.short;
  const l = n ? Math.round(c.long / n * 100) : 50;
  return `<div class="hl-bar${small ? ' sm' : ''}" role="img" aria-label="${esc(c.long)} long, ${esc(c.short)} short">
    <i class="l" style="width:${l}%"></i><i class="s" style="width:${100 - l}%"></i></div>`;
}

const footer = (s, extra = '') => `<p class="note hl-foot">Daftar trader diperbarui ${esc(listDate(s.updated))}${s.src === 'bawaan' ? ' (cadangan bawaan)' : ''} · posisi live dari Hyperliquid · ${esc(s.ok)}/${esc(s.n)} akun${extra}</p>`;

// hl = { loading, error, data } ; data = hasil loadSentiment()
export function hlCardHTML({ hl, symbol, action, price, currency, listOpen }) {
  const head = '<h3>Posisi Trader Top Hyperliquid</h3>';
  if (hl.error && !hl.data) {
    return `<div class="card hl">${head}<p class="note" style="margin-top:0">Gagal memuat posisi: ${esc(hl.error)}</p>
      <button type="button" class="pill ghost more-trades" data-c="hlretry">${ICON.refresh}Coba lagi</button></div>`;
  }
  const s = hl.data;
  if (!s) {
    return `<div class="card hl">${head}<span class="skel" style="width:100%;height:12px"></span><br><br>
      <span class="skel" style="width:80%"></span><br><br><span class="skel" style="width:60%"></span>
      <p class="note">Memuat posisi 50 trader top…</p></div>`;
  }
  const coin = coinFor(symbol, s.coins) || coinFor(symbol);
  const c = s.coins[coin];
  const st = stance(c);
  if (st.side === 'few') {
    return `<div class="card hl">${head}<p class="hl-head">${st.n
      ? `Data kurang (hanya ${esc(st.n)} trader top punya posisi di ${esc(coin)}).`
      : `Data kurang — belum ada trader top yang punya posisi di ${esc(coin)}.`}</p>${footer(s)}</div>`;
  }
  const a = act(action);
  const tot = c.lv + c.sv;
  const valSide = c.sv > c.lv ? 'short' : 'long';
  const valShare = tot ? Math.max(c.lv, c.sv) / tot : 0;
  const it = interpret(a, st);
  const rows = c.rows.slice(0, MAX_ROWS).filter(r => validAddr(r.a)).map(r => `
    <div class="tr hl-tr" role="row">
      <span role="cell"><b>${esc(r.n || shortAddr(r.a))}</b><small class="mono">${r.n ? esc(shortAddr(r.a)) + ' · ' : ''}ROI 30 hari ${r.roi30 == null ? '–' : esc(pctTxt(r.roi30))}</small></span>
      <span role="cell"><b class="mono">${esc(usd(r.usd))}</b><small>entry <span class="mono">${fmt(r.entry, currency)}</span></small></span>
      <span role="cell" class="res"><span class="badge ${r.side === 'long' ? 'BUY' : 'SELL'}">${r.side === 'long' ? 'LONG' : 'SHORT'}</span>
        <small class="mono ${r.upnl >= 0 ? 'pos' : 'neg'}">${esc(usd(r.upnl))}${r.lev ? ' · ' + esc(r.lev) + '×' : ''}</small></span>
    </div>`).join('');
  return `<div class="card hl">
    ${head}
    ${bar(c)}
    <div class="hl-legend"><span class="pos">${esc(pctTxt(st.longPct))} long</span><span class="neg">${esc(pctTxt(st.shortPct))} short</span></div>
    <p class="hl-head"><b>${esc(c.long)} long · ${esc(c.short)} short</b> dari ${esc(st.n)} trader top yang punya posisi di ${esc(coin)}</p>
    <p class="note" style="margin-top:4px">Nilai posisi: ${esc(pctTxt(valShare))} ${valSide} (${esc(usd(tot))})${c.whale ? ' — didominasi beberapa akun besar' : ''}</p>
    <div class="kv-grid" style="margin-top:12px">
      <div class="kv"><div class="k">Rata-rata entry long</div><div class="v mono">${fmt(c.lEntry, currency)}</div>${vsPrice(c.lEntry, price)}</div>
      <div class="kv"><div class="k">Rata-rata entry short</div><div class="v mono">${fmt(c.sEntry, currency)}</div>${vsPrice(c.sEntry, price)}</div>
      <div class="kv"><div class="k">Leverage median</div><div class="v mono">${c.medLev == null ? '–' : esc(String(c.medLev).replace('.', ',')) + '×'}</div></div>
      <div class="kv"><div class="k">Total uPnL</div><div class="v mono ${c.upnl >= 0 ? 'pos' : 'neg'}">${esc(usd(c.upnl))}</div></div>
    </div>
    <div class="hl-int t-${esc(it.tone)}"><span class="badge ${a}">${a}</span><span>${esc(it.text)}</span></div>
    <details class="fflags hl-more" id="hlList"${listOpen ? ' open' : ''}><summary>Posisi teratas di ${esc(coin)} (${esc(Math.min(MAX_ROWS, c.rows.length))}) ${ICON.down}</summary>
      <div class="ttable" role="table" aria-label="Posisi trader top">${rows}</div></details>
    <p class="note">Sentimen, bukan sinyal: "top" dipilih dari laba masa lalu, short bisa berupa hedge. Robot tetap ${esc(LABEL[a])}.</p>
    ${footer(s)}
  </div>`;
}

// Ringkasan di tab Sinyal untuk koin crypto di daftar pantau
export function hlSignalHTML({ hl, items, avatar }) {
  if (!items.length) return '';
  const head = `<div class="section-h" id="sec-hl"><h2>Sentimen trader top</h2><span class="hint">Hyperliquid</span></div>`;
  if (hl.error && !hl.data) return `${head}<div class="empty">Posisi trader top gagal dimuat: ${esc(hl.error)}</div>`;
  const s = hl.data;
  if (!s) return `${head}<div class="list">${items.slice(0, 3).map(() => '<div class="row"><span class="skel" style="width:100%;height:12px"></span></div>').join('')}</div>`;
  const rows = items.map(it => {
    const coin = coinFor(it.symbol, s.coins) || coinFor(it.symbol);
    const c = s.coins[coin];
    const st = stance(c);
    const sym = esc(it.symbol);
    const right = st.side === 'few'
      ? `<span class="muted hl-few">data kurang (${esc(st.n)})</span>`
      : `${bar(c, true)}<span class="hl-cnt mono"><span class="pos">${esc(c.long)}L</span> · <span class="neg">${esc(c.short)}S</span></span>`;
    const sub = st.side === 'few' ? `Kurang dari ${MIN_TRADERS} trader top berposisi`
      : st.side === 'mixed' ? 'Campuran' : `Mayoritas ${st.side} (${esc(pctTxt(st.side === 'long' ? st.longPct : st.shortPct))})`;
    return `<div class="row" role="button" tabindex="0" data-s="${sym}" data-m="crypto" aria-label="${sym}, trader top ${esc(sub)}">
      ${avatar(it.symbol)}
      <div class="row-main"><div class="row-t"><span class="sym">${sym}</span>${coin !== it.symbol ? `<span class="mk">${esc(coin)}</span>` : ''}</div><div class="row-s">${sub}</div></div>
      <div class="row-r hl-r">${right}</div></div>`;
  }).join('');
  return `${head}<div class="list">${rows}</div>${footer(s, ' · hitungan trader, bukan nilai')}`;
}

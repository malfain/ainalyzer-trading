// Ikon SVG inline (stroke = currentColor) agar tetap jalan offline.
const svg = (body, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  signal: svg('<path d="M3 12h3.5l2.5-6 4 12 2.5-6H21"/>'),
  market: svg('<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="1.4" fill="currentColor" stroke="none"/>'),
  chart: svg('<path d="M7 4v3M7 15v5M17 3v4M17 13v7"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="15" y="7" width="4" height="6" rx="1"/>'),
  more: svg('<circle cx="6" cy="6" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/><circle cx="12" cy="12" r="1.6"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  coin: svg('<circle cx="12" cy="12" r="8"/><path d="M9.5 9h4a1.75 1.75 0 0 1 0 3.5h-4h4.5a1.75 1.75 0 0 1 0 3.5h-4.5V9M11 7.5V9M11 16v1.5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  chev: svg('<path d="M9 6l6 6-6 6"/>', 18),
  down: svg('<path d="M6 9l6 6 6-6"/>', 18),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', 20),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 18),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>', 20),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>', 22),
  dots: svg('<circle cx="12" cy="5.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/>', 22),
  line: svg('<path d="M3 17l5-5 4 3 8-9"/>', 18),
  candle: svg('<path d="M8 4v3M8 15v5M16 6v3M16 16v3"/><rect x="6" y="7" width="4" height="8" rx="1"/><rect x="14" y="9" width="4" height="7" rx="1"/>', 18),
  bot: svg('<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/><path d="M9.5 16.2h5"/>', 20),
};

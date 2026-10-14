/* Logicop — jeu d'icônes commun (24 × 24, trait 2, angles francs, dans l'esprit géométrique de la charte BM). */
(function () {
  'use strict';
  const P = {
    forklift: '<path d="M17 3v16h5"/><path d="M2 15.5v-5h9l2 2v3z"/><path d="M4 10.5V5h4.5l2 5.5"/><path d="M13 8.5h4"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="11" cy="18.5" r="2"/>',
    truck: '<path d="M2 6h12v10H2z"/><path d="M14 9h4l3 3.5V16h-7"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    documents: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 15.5h6M9 19h3"/>',
    qrcode: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z"/><path d="M6 6h1v1H6zM17 6h1v1h-1zM6 17h1v1H6z"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h1M20 14h1"/>',
    chart: '<path d="M3 21h18"/><path d="M6 17v-5M10.5 17V8M15 17v-7M19.5 17V4"/>',
    tag: '<path d="M3 3h8.5l9.5 9.5-8.5 8.5L3 11.5z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
    clipboard: '<path d="M5 4.5h14V21H5z"/><path d="M9 2.5h6v3.5H9z"/><path d="M8.5 13.5l2.5 2.5 4.5-5"/>',
    catalogue: '<path d="M3 3h7v7H3zM3 14h7v7H3zM14 3h7v7h-7z"/><circle cx="17" cy="17" r="3"/><path d="M19.2 19.2L22 22"/>',
    prompt: '<path d="M3 4h18v12H9l-6 5z"/><path d="M7 8.5h10M7 12h6"/>',
    convert: '<path d="M4 3h8l4 4v4"/><path d="M12 3v4h4"/><path d="M4 3v18h6"/><path d="M13 14h8v7h-8zM13 17.5h8M17 14v7"/>',
    arrow: '<path d="M4 12h15M13 6l6 6-6 6"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
    lock: '<path d="M5 11h14v10H5z"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    copy: '<path d="M8 8h12v13H8z"/><path d="M4 16V3h12"/>',
    video: '<path d="M3 6h13v12H3z"/><path d="M16 10l5-3v10l-5-3"/>'
  };
  const GRIP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="4" width="3" height="3"/><rect x="14" y="4" width="3" height="3"/><rect x="7" y="10.5" width="3" height="3"/><rect x="14" y="10.5" width="3" height="3"/><rect x="7" y="17" width="3" height="3"/><rect x="14" y="17" width="3" height="3"/></svg>';

  /** Renvoie le SVG de l'icône `name` (chaîne vide si inconnue). */
  window.logicopIcon = function (name) {
    if (name === 'grip') return GRIP;
    const p = P[name];
    if (!p) return '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">' + p + '</svg>';
  };
})();

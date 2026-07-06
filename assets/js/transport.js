/* Logicop — Prix de transport. Géocode une ville via l'API adresse.data.gouv.fr,
   puis détermine la zone (polygone KML) et affiche le tarif configuré par l'admin. */

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);

  const toolTitle = el('toolTitle');
  const toolBrandLogo = el('toolBrandLogo');
  const toolDesc = el('toolDesc');
  const notFoundStep = el('notFoundStep');
  const mainSteps = el('mainSteps');
  const mapFrame = el('mapFrame');
  const searchInput = el('searchInput');
  const resultCard = el('resultCard');
  const resultVille = el('resultVille');
  const resultZone = el('resultZone');
  const resultPrix = el('resultPrix');
  const btnCopy = el('btnCopy');
  const copyConfirm = el('copyConfirm');
  const searchStatus = el('searchStatus');

  const adminPanel = el('adminPanel');
  const zonesBody = el('zonesBody');
  const btnSaveConfig = el('btnSaveConfig');
  const saveStatus = el('saveStatus');

  const state = {
    tool: null,
    polygons: null,
    prices: {},
    isAdmin: false,
  };

  // ── Point-in-polygon (ray casting) ─────────────────────────────────
  function pointInPolygon(lng, lat, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function polyArea(poly) {
    let area = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      area += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    }
    return Math.abs(area / 2);
  }

  const CITY_ZONES = [
    { zone: 'Lucé - Luisant', cities: ['lucé', 'luce', 'luisant'] },
    { zone: 'Chartres Agglo', cities: ['chartres', 'mainvilliers', 'lèves', 'leves', 'le coudray', 'champhol'] },
  ];

  function normalize(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

  function findCityZone(cityName) {
    const n = normalize(cityName);
    for (const cz of CITY_ZONES) {
      if (cz.cities.some((c) => n === normalize(c))) return cz.zone;
    }
    return null;
  }

  function findZone(lng, lat, city) {
    const cityZone = findCityZone(city || '');
    if (cityZone) return cityZone;

    if (!state.polygons) return null;
    let best = null;
    let bestArea = Infinity;
    for (const [zoneName, polys] of Object.entries(state.polygons)) {
      for (const poly of polys) {
        if (pointInPolygon(lng, lat, poly)) {
          const area = polyArea(poly);
          if (area < bestArea) { bestArea = area; best = zoneName; }
        }
      }
    }
    return best;
  }

  // ── Géocodage via API adresse.data.gouv.fr ─────────────────────────
  let debounceTimer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { resultCard.hidden = true; searchStatus.textContent = ''; return; }
    debounceTimer = setTimeout(() => geocodeAndFind(q), 300);
  });

  async function geocodeAndFind(query) {
    resultCard.hidden = true;
    searchStatus.className = 'status show';
    searchStatus.textContent = 'Recherche en cours…';
    try {
      const resp = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=1`);
      const data = await resp.json();
      if (!data.features || !data.features.length) {
        searchStatus.className = 'status show warn';
        searchStatus.textContent = 'Aucune ville trouvée pour cette recherche.';
        return;
      }
      const feature = data.features[0];
      const [lng, lat] = feature.geometry.coordinates;
      const label = feature.properties.label;

      const city = feature.properties.city || '';
      const zone = findZone(lng, lat, city);
      if (!zone) {
        searchStatus.className = 'status show warn';
        searchStatus.textContent = `${label} (${lng.toFixed(4)}, ${lat.toFixed(4)}) — aucune zone trouvée. ${state.polygons ? Object.keys(state.polygons).length + ' zones chargées' : 'ZONES NON CHARGÉES'}`;
        return;
      }

      const price = state.prices[zone];
      resultVille.textContent = label;
      resultZone.textContent = zone;
      if (price !== undefined && price !== '') {
        resultPrix.textContent = price + ' €';
      } else {
        resultPrix.textContent = 'Non configuré';
      }
      resultCard.hidden = false;
      searchStatus.textContent = '';
      searchStatus.className = 'status';
      copyConfirm.hidden = true;
    } catch (err) {
      console.error(err);
      searchStatus.className = 'status show err';
      searchStatus.textContent = 'Erreur lors de la recherche : ' + err.message;
    }
  }

  btnCopy.addEventListener('click', async () => {
    const price = resultPrix.textContent;
    try {
      await navigator.clipboard.writeText(price);
      copyConfirm.hidden = false;
      setTimeout(() => { copyConfirm.hidden = true; }, 2000);
    } catch { /* fallback silencieux */ }
  });

  // ── Admin : tarifs par zone ────────────────────────────────────────
  function renderZonePrices() {
    zonesBody.innerHTML = '';
    const polyZones = Object.keys(state.polygons || {}).sort((a, b) => (parseInt(a.match(/\d+/)) || 0) - (parseInt(b.match(/\d+/)) || 0));
    const cityZoneNames = CITY_ZONES.map((cz) => cz.zone);
    const zoneNames = [...cityZoneNames, ...polyZones];
    zoneNames.forEach((name) => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = name;
      tdName.style.fontWeight = '600';

      const tdPrice = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = state.prices[name] || '';
      input.placeholder = '0';
      input.addEventListener('input', () => { state.prices[name] = input.value.trim(); });
      tdPrice.appendChild(input);

      tr.append(tdName, tdPrice);
      zonesBody.appendChild(tr);
    });
  }

  function showSaveStatus(type, msg) {
    saveStatus.className = 'status show ' + type;
    saveStatus.textContent = msg;
  }

  btnSaveConfig.addEventListener('click', async () => {
    const config = { ...state.tool.config, prices: state.prices };
    const { error } = await supabaseClient.from('tools')
      .update({ config, updated_at: new Date().toISOString() })
      .eq('id', state.tool.id);
    if (error) { showSaveStatus('err', 'Erreur : ' + error.message); return; }
    state.tool.config = config;
    showSaveStatus('ok', 'Tarifs enregistrés.');
  });

  // ── Init ────────────────────────────────────────────────────────────
  (async function init() {
    const session = await requireSession('../pages/login.html');
    if (!session) return;
    renderNavAccount('navAccount', '../pages/');

    const profile = await loadCurrentProfile();
    state.isAdmin = !!(profile && profile.is_admin);

    const toolId = new URLSearchParams(location.search).get('tool');
    if (!toolId) { notFoundStep.hidden = false; return; }

    const { data: tool, error } = await supabaseClient.from('tools').select('*').eq('id', toolId).single();
    if (error || !tool) { notFoundStep.hidden = false; return; }

    state.tool = tool;
    toolTitle.textContent = tool.name;
    toolDesc.textContent = tool.description || '';

    if (tool.config.mapUrl) {
      mapFrame.src = tool.config.mapUrl;
    }

    state.prices = tool.config.prices || {};

    state.polygons = window.TRANSPORT_ZONES || null;
    if (!state.polygons) {
      const s = el('searchStatus');
      s.className = 'status show err';
      s.textContent = 'Erreur : données de zones non chargées.';
    }

    if (state.isAdmin) {
      adminPanel.hidden = false;
      renderZonePrices();
    }

    mainSteps.hidden = false;
  })();
})();

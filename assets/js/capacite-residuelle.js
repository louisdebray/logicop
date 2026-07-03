/* Logicop — Capacité résiduelle (chariot élévateur). Outil autonome, sans configuration
   admin : la fiche matériel PDF a toujours la même mise en page chez le fabricant, donc
   l'extraction et le calcul sont fixes (portage direct du script Python d'origine). */

(function () {
  'use strict';

  const Engine = window.DevisEngine;
  const el = (id) => document.getElementById(id);

  const toolTitle = el('toolTitle');
  const toolDesc = el('toolDesc');
  const notFoundStep = el('notFoundStep');
  const mainSteps = el('mainSteps');
  const sourceFile = el('sourceFile');
  const extractStatus = el('extractStatus');
  const fieldsGrid = el('fieldsGrid');
  const cdgVoulu = el('cdgVoulu');
  const btnCalculate = el('btnCalculate');
  const categorie = el('categorie');
  const catAutoHint = el('catAutoHint');
  const fourches = el('fourches');
  const calcStatus = el('calcStatus');
  const resultCard = el('resultCard');
  const resultText = el('resultText');

  const FIELDS = [
    ['marque', 'Marque'],
    ['modele', 'Modèle'],
    ['serie', 'Numéro de série'],
    ['cap_nominale', 'Capacité nominale (kg)'],
    ['q_ref', 'Capacité résiduelle de référence (kg)'],
    ['cdg_ref', 'CDG de référence (mm)'],
    ['h_ref', 'Hauteur de référence (mm)'],
    ['x', 'Côte x (mm)'],
    ['s', 'Épaisseur fourches S (mm)'],
  ];

  // Abattement (kg) selon catégorie et type de fourches.
  const ABATTEMENT = {
    'Chariot 1,5T à 2,9T à 500mm': { 'Fourches standard': 100, 'Fourches longues': 180 },
    'Chariot 3T à 5T à 500mm': { 'Fourches standard': 150, 'Fourches longues': 340 },
    'Chariot 5T et plus à 600mm': { 'Fourches standard': 242, 'Fourches longues': 420 },
  };

  const state = { fields: {}, resultQ: null };

  function showExtractStatus(type, msg) {
    extractStatus.className = 'status show ' + type;
    extractStatus.textContent = msg;
  }
  function showCalcStatus(type, msg) {
    calcStatus.className = 'status show ' + type;
    calcStatus.textContent = msg;
  }

  function renderFieldsGrid() {
    fieldsGrid.innerHTML = '';
    fieldsGrid.hidden = false;
    FIELDS.forEach(([key, label]) => {
      const div = document.createElement('div');
      div.className = 'field';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      lbl.htmlFor = 'f_' + key;
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'f_' + key;
      input.value = state.fields[key] === undefined || state.fields[key] === null ? '' : state.fields[key];
      input.addEventListener('input', () => { state.fields[key] = input.value; });
      div.append(lbl, input);
      fieldsGrid.appendChild(div);
    });
  }

  function cleanInt(s) {
    return parseInt(String(s).replace(/\s/g, ''), 10);
  }

  /** Reproduit extract_data_from_pdf() du script d'origine : mêmes regex, appliquées sur le
   *  texte du PDF une fois les retours à la ligne et espaces multiples aplatis en un seul
   *  espace (le texte des fiches matériel a une mise en page fixe d'un fabricant à l'autre). */
  function extractDataFromText(rawText) {
    const result = { marque: null, modele: null, serie: null, cap_nominale: null, q_ref: null, cdg_ref: null, h_ref: null, x: null, s: null };
    let text = rawText.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ');

    let m = text.match(/marque\s*:?\s*([A-Za-zÀ-ÿ0-9\-]+)/i);
    if (m) result.marque = m[1].trim();

    m = text.match(/mod[eè]le\s*:?\s*([A-Za-z0-9\-]+)/i);
    if (m) result.modele = m[1].trim();

    m = text.match(/(?:num[eé]ro\s+de\s+s[eé]rie|n[°º]\s*(?:de\s*)?s[eé]rie|n[°º]\s*serie)\s*:?\s*([A-Za-z0-9\-]+)/i);
    if (m) result.serie = m[1].trim();

    const capRe = /([\d][\d\s]*)\s*kg\s+[àa]\s+([\d][\d\s]*)\s*mm\s+de\s+(?:(?!\d+\s*kg).){0,60}?centre\s+de\s+gravit[eé]\s+et\s+[àa]\s+([\d][\d\s]*)\s*mm\s+de\s+haut/gi;
    let bestH = -1, cm;
    while ((cm = capRe.exec(text))) {
      const q = cleanInt(cm[1]), cdg = cleanInt(cm[2]), h = cleanInt(cm[3]);
      if (h > bestH) { bestH = h; result.q_ref = q; result.cdg_ref = cdg; result.h_ref = h; }
    }

    m = text.match(/capacit[eé]\s+de\s+levage\s*:?\s*([\d][\d\s]*(?:[,.]\d+)?)\s*kg/i);
    if (m) result.cap_nominale = cleanInt(m[1].replace(/[,.].*$/, '').replace(/\s/g, ''));

    m = text.match(/c[oô]te\s+x\s*:?\s*([\d]+(?:[,.]\d+)?)\s*mm/i);
    if (m) result.x = parseFloat(m[1].replace(',', '.'));

    m = text.match(/[eé]paisseur\s+fourches?\s*[Ss]?\s*:?\s*([\d]+(?:[,.]\d+)?)\s*mm/i);
    if (m) result.s = parseFloat(m[1].replace(',', '.'));

    return result;
  }

  function computeQ(qRef, cdgRef, cdgVoulu, x, s) {
    const denom = cdgVoulu + x - s;
    if (denom === 0) throw new Error('Le dénominateur (CDG voulu + x − S) est nul.');
    return (qRef * (cdgRef + x)) / denom;
  }

  function categoryFromCapacity(qKg) {
    if (qKg <= 2900) return 'Chariot 1,5T à 2,9T à 500mm';
    if (qKg <= 5000) return 'Chariot 3T à 5T à 500mm';
    return 'Chariot 5T et plus à 600mm';
  }

  sourceFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showExtractStatus('', '');
    try {
      const buf = await file.arrayBuffer();
      const lines = await Engine.getPdfLines(buf);
      const data = extractDataFromText(lines.join('\n'));
      state.fields = data;
      renderFieldsGrid();

      const capForCat = data.cap_nominale || data.q_ref;
      if (capForCat) {
        categorie.value = categoryFromCapacity(capForCat);
        catAutoHint.textContent = '✓ détectée automatiquement';
        catAutoHint.style.color = 'var(--ok)';
      } else {
        catAutoHint.textContent = 'non détectée — à choisir manuellement';
        catAutoHint.style.color = 'var(--accent)';
      }

      const missing = FIELDS.filter(([key]) => data[key] === null || data[key] === undefined || data[key] === '').map(([, label]) => label);
      if (missing.length) {
        showExtractStatus('warn', `Données non extraites (à saisir manuellement) : ${missing.join(', ')}.`);
      } else {
        showExtractStatus('ok', 'Toutes les données ont été extraites.');
      }
    } catch (err) {
      console.error(err);
      showExtractStatus('err', 'Erreur lors de la lecture du PDF : ' + err.message);
    }
  });

  function getFloat(key, label) {
    const raw = String(state.fields[key] ?? '').trim().replace(',', '.');
    if (!raw) throw new Error(`La valeur « ${label} » est manquante.`);
    const n = parseFloat(raw);
    if (isNaN(n)) throw new Error(`La valeur « ${label} » est invalide.`);
    return n;
  }

  function adjustedResult() {
    if (state.resultQ === null) return null;
    const abat = (ABATTEMENT[categorie.value] || {})[fourches.value] || 0;
    return state.resultQ - abat;
  }

  function refreshResult() {
    const q = adjustedResult();
    if (q === null) return;
    resultText.textContent = `${q.toFixed(0)} kg`;
    resultCard.hidden = false;
  }

  categorie.addEventListener('change', refreshResult);
  fourches.addEventListener('change', refreshResult);

  btnCalculate.addEventListener('click', () => {
    state.resultQ = null;
    resultCard.hidden = true;
    showCalcStatus('', '');
    try {
      const qRef = getFloat('q_ref', 'Capacité résiduelle de référence');
      const cdgRef = getFloat('cdg_ref', 'CDG de référence');
      const x = getFloat('x', 'Côte x');
      const s = getFloat('s', 'Épaisseur fourches S');
      const cdgVoluRaw = cdgVoulu.value.trim().replace(',', '.');
      if (!cdgVoluRaw) throw new Error('Veuillez saisir le CDG voulu.');
      const cdgV = parseFloat(cdgVoluRaw);
      if (isNaN(cdgV)) throw new Error('Le CDG voulu est invalide.');

      state.resultQ = computeQ(qRef, cdgRef, cdgV, x, s);
      refreshResult();
    } catch (err) {
      showCalcStatus('err', err.message);
    }
  });

  // ── Init ────────────────────────────────────────────────────────────
  (async function init() {
    const session = await requireSession('../pages/login.html');
    if (!session) return;
    renderNavAccount('navAccount', '../pages/');

    const toolId = new URLSearchParams(location.search).get('tool');
    if (!toolId) { notFoundStep.hidden = false; return; }

    const { data: tool, error } = await supabaseClient.from('tools').select('*').eq('id', toolId).single();
    if (error || !tool) { notFoundStep.hidden = false; return; }

    toolTitle.textContent = tool.name;
    toolDesc.textContent = tool.description || '';

    mainSteps.hidden = false;
  })();
})();

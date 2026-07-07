/* Logicop — moteur d'extraction et de génération, partagé entre la page d'entraînement (admin)
   et la page d'exécution (client). Ne touche à aucun élément du DOM : ne prend et ne retourne
   que des données, pour rester utilisable dans les deux contextes. */

window.DevisEngine = (function () {
  'use strict';

  const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

  /** pdf.js est chargé en module ES (voir la balise <script type="module"> des pages) : il peut
   *  ne pas encore être attaché à window au moment où ce fichier s'exécute. On attend qu'il le
   *  soit avant la première utilisation réelle (toujours déclenchée par une action utilisateur,
   *  donc bien après le chargement de la page dans la pratique). */
  async function ensurePdfjs() {
    let tries = 0;
    while (!window.pdfjsLib && tries < 100) {
      await new Promise((r) => setTimeout(r, 50));
      tries++;
    }
    if (!window.pdfjsLib) throw new Error('La librairie de lecture PDF (pdf.js) ne s\'est pas chargée.');
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    }
    return pdfjsLib;
  }

  const FIELDS = [
    { key: 'desc', label: 'Désignation produit', defaultSrcCol: 'A', defaultDestCol: 'A', numeric: false },
    { key: 'qty', label: 'Quantité', defaultSrcCol: '', defaultDestCol: '', numeric: true },
    { key: 'ht', label: 'Tarif HT', defaultSrcCol: 'B', defaultDestCol: 'B', numeric: true },
    { key: 'ttc', label: 'Tarif TTC', defaultSrcCol: '', defaultDestCol: '', numeric: true },
    { key: 'remise', label: 'Remise', defaultSrcCol: '', defaultDestCol: '', numeric: true },
  ];

  const ROLE_OPTIONS = [
    { key: 'ignore', label: 'Ignorer cette ligne' },
    { key: 'desc', label: 'Désignation (fusionner dans la ligne en cours)' },
    { key: 'desc_row', label: 'Nouvelle ligne (option / caractéristique)' },
    { key: 'qty', label: 'Quantité' },
    { key: 'ht', label: 'Tarif HT' },
    { key: 'ttc', label: 'Tarif TTC' },
    { key: 'remise', label: 'Remise' },
  ];

  // ── Utilitaires génériques ────────────────────────────────────────────
  function colToIndex(letter) {
    letter = String(letter || '').trim().toUpperCase();
    if (!letter) return NaN;
    let n = 0;
    for (const ch of letter) {
      const code = ch.charCodeAt(0) - 64;
      if (code < 1 || code > 26) return NaN;
      n = n * 26 + code;
    }
    return n;
  }

  function parseFrenchNumber(s) {
    if (s === null || s === undefined) return null;
    if (typeof s === 'number') return s;
    s = String(s).trim();
    if (!s) return null;
    s = s.replace(/[€$%]/g, '').replace(/\s/g, '');
    if (s.includes(',') && s.includes('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.includes(',')) {
      s = s.replace(',', '.');
    }
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Correspondance "stricte" : `keyword` agit comme un label sur cette ligne
   *  ("Keyword : valeur" ou "Keyword 1234 €"), ou bien le mot-clé contient déjà un ":"
   *  (l'utilisateur a copié le libellé complet) auquel cas on cherche cette phrase telle quelle. */
  function strictKeywordMatch(line, keyword) {
    keyword = keyword.trim();
    if (!keyword) return false;
    if (keyword.includes(':')) return line.toLowerCase().includes(keyword.toLowerCase());
    return new RegExp(escapeRegex(keyword) + '\\s*(?::|\\s+(?=[-\\d]))', 'i').test(line);
  }
  /** Correspondance "libre" : le mot-clé apparaît n'importe où sur la ligne (mot entier). */
  function looseKeywordMatch(line, keyword) {
    keyword = keyword.trim();
    if (!keyword) return false;
    const esc = escapeRegex(keyword);
    const startsWord = /^[\wÀ-ÿ]/.test(keyword);
    const endsWord = /[\wÀ-ÿ]$/.test(keyword);
    const pattern = (startsWord ? '\\b' : '') + esc + (endsWord ? '\\b' : '');
    return new RegExp(pattern, 'i').test(line);
  }
  /** Bascule automatiquement en mode libre si le mode strict ne trouve rien dans l'exemple. */
  function keywordMatches(line, keyword, sampleLines) {
    if (sampleLines && sampleLines.some((l) => strictKeywordMatch(l, keyword))) {
      return strictKeywordMatch(line, keyword);
    }
    return looseKeywordMatch(line, keyword);
  }

  // ── Extraction PDF : reconstruction du texte avec gestion des colonnes ────
  const COLUMN_MATCH_THRESHOLD = 80;

  async function getPdfLines(arrayBuffer) {
    const pdfjsLib = await ensurePdfjs();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const lines = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5], w: it.width || 0 }));

      const rows = [];
      items.forEach((it) => {
        let row = rows.find((r) => Math.abs(r.y - it.y) < 2);
        if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
        row.items.push(it);
      });
      rows.sort((a, b) => b.y - a.y);
      rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));

      const openFields = []; // { anchorX, lastY, text }
      const closeField = (idx) => { lines.push(openFields[idx].text); };

      const nearestOpenField = (x, y, requireRecent) => {
        let idx = -1, best = COLUMN_MATCH_THRESHOLD;
        openFields.forEach((f, i) => {
          if (requireRecent && Math.abs(f.lastY - y) > 20) return;
          const d = Math.abs(f.anchorX - x);
          if (d < best) { best = d; idx = i; }
        });
        return idx;
      };

      for (const row of rows) {
        const segments = [];
        let cur = { items: [] };
        row.items.forEach((it) => {
          if (/:$/.test(it.str) && cur.items.length > 0) {
            segments.push(cur);
            cur = { items: [it] };
          } else {
            cur.items.push(it);
          }
        });
        segments.push(cur);

        const hasLabel = segments.some((s) => /:$/.test(s.items[0].str));

        if (hasLabel) {
          segments.forEach((seg) => {
            const text = seg.items.map((i) => i.str).join(' ');
            const anchorX = seg.items.length > 1 ? seg.items[1].x : seg.items[0].x;
            const idx = nearestOpenField(anchorX, row.y, false);
            if (idx >= 0) {
              closeField(idx);
              openFields[idx] = { anchorX, lastY: row.y, text };
            } else {
              openFields.push({ anchorX, lastY: row.y, text });
            }
          });
        } else {
          const text = row.items.map((i) => i.str).join(' ');
          const idx = nearestOpenField(row.items[0].x, row.y, true);
          if (idx >= 0) {
            openFields[idx].text += ' ' + text;
            openFields[idx].lastY = row.y;
          } else {
            lines.push(text);
          }
        }
      }
      openFields.forEach((f) => lines.push(f.text));
    }

    return lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  // ── Extraction Excel / CSV (SheetJS) ───────────────────────────────────
  function extractExcel(workbook, config) {
    if (!workbook) return { items: [], error: 'Aucun fichier importé.' };
    const ws = workbook.Sheets[config.sheetName] || workbook.Sheets[workbook.SheetNames[0]];
    if (!ws || !ws['!ref']) return { items: [], error: 'Feuille vide ou illisible.' };

    const range = XLSX.utils.decode_range(ws['!ref']);
    const maxRow = range.e.r + 1;
    const startRow = config.startRow || 1;
    const endRow = config.endRow || maxRow;
    const autoStop = !config.endRow;

    const getCellValue = (r, colIdx) => {
      const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: colIdx - 1 })];
      return cell ? cell.v : undefined;
    };

    const items = [];
    for (let r = startRow; r <= endRow; r++) {
      const row = { excluded: false };
      let hasDesc = false, hasPrice = false;
      for (const f of config.fields) {
        const colIdx = colToIndex(config.cols[f.key]);
        if (!colIdx) continue;
        const raw = getCellValue(r, colIdx);
        if (f.key === 'desc') {
          row.desc = raw === undefined ? '' : String(raw);
          if (row.desc) hasDesc = true;
        } else if (f.key === 'qty') {
          row.qty = raw === undefined ? '' : raw;
        } else {
          const num = raw === undefined ? null : parseFrenchNumber(raw);
          row[f.key] = num === null ? '' : num;
          if (num !== null) hasPrice = true;
        }
      }
      if (!hasDesc && !hasPrice) {
        if (autoStop) break;
        continue;
      }
      items.push(row);
    }
    return { items };
  }

  // ── Extraction CESAB (T-Order Report) : structure fixe, pas de règles ──
  // Contrairement aux autres devis, un rapport CESAB a une mise en page toujours identique
  // (référence en B14, tarif global en H15, sections TRUCK/BATTERY/CHARGER repérées par un
  // mot-clé en colonne B) : on la lit directement plutôt que de faire deviner des règles.
  function cesabCell(ws, colLetter, row) {
    const cell = ws[colLetter + row];
    return cell ? cell.v : undefined;
  }
  function cesabMaxRow(ws) {
    if (!ws['!ref']) return 0;
    return XLSX.utils.decode_range(ws['!ref']).e.r + 1;
  }
  function findCesabSectionRows(ws, maxRow) {
    let truckRow = null, batteryRow = null, chargerRow = null;
    for (let r = 1; r <= maxRow; r++) {
      const val = cesabCell(ws, 'B', r);
      if (val === 'TRUCK' && truckRow === null) truckRow = r;
      if (val === 'BATTERY' && batteryRow === null) batteryRow = r;
      if (val === 'CHARGER' && chargerRow === null) chargerRow = r;
    }
    return { truckRow, batteryRow, chargerRow };
  }
  function cleanCesabLabel(label) {
    return String(label || '').trim().replace(/^\([^)]+\)\s*/, '');
  }
  function parseCesabEquipmentSection(ws, startRow, endRow, kind) {
    let voltage = null, amperes = null, bfs = false, transferPrice = null, pastHeader = false;
    for (let r = startRow + 1; r < endRow; r++) {
      const bVal = cesabCell(ws, 'B', r);
      const eVal = cesabCell(ws, 'E', r);
      if (!bVal) continue;
      const bStr = String(bVal).trim();

      if (/\bProduct\b|\bQuantity\b|\bELP\b/i.test(bStr)) { pastHeader = true; continue; }

      if (pastHeader && transferPrice === null && eVal !== undefined && eVal !== null) {
        const n = parseFloat(eVal);
        if (!isNaN(n)) transferPrice = n;
      }

      if (/\bvolt/i.test(bStr)) {
        const m = bStr.match(/(\d+)\s*[Vv]\b/);
        if (m && voltage === null) voltage = parseInt(m[1], 10);
      }

      if (kind === 'battery') {
        const m = bStr.match(/(\d+)\s*[Aa]h\b/);
        if (m && amperes === null) amperes = parseInt(m[1], 10);
      } else {
        const m = bStr.match(/^[Aa]mp[eè]re?\s+(?:[a-zA-Z]+\s+)?(\d+)/);
        if (m && amperes === null) amperes = parseInt(m[1], 10);
      }

      if (kind === 'battery' && /\bBFS\b/i.test(bStr)) {
        if (!/\b(?:Non|No|Aucun|none|without)\b/i.test(bStr)) bfs = true;
      }
    }
    const parts = [];
    if (voltage) parts.push(voltage + 'V');
    if (amperes) parts.push(amperes + (kind === 'battery' ? 'Ah' : 'A'));
    const prefix = kind === 'battery' ? 'Batterie' : 'Chargeur';
    let label = parts.length ? prefix + ' ' + parts.join(' / ') : prefix;
    if (kind === 'battery' && bfs) label += ' BFS';
    return { label, price: transferPrice !== null ? transferPrice : 0 };
  }

  /** Retourne { items, ref, globalPrice } — items suit le même format "un article principal
   *  (référence + tarif global) + une ligne par option/batterie/chargeur (sans prix)" que le
   *  mode "Un seul article" des autres outils, pour réutiliser `generateExcel` tel quel. */
  function parseCesabExcel(workbook, sheetName) {
    const ws = workbook.Sheets[sheetName || workbook.SheetNames[0]];
    if (!ws || !ws['!ref']) return null;
    const maxRow = cesabMaxRow(ws);
    const ref = cesabCell(ws, 'B', 14);
    const globalPrice = cesabCell(ws, 'H', 15);

    const { truckRow, batteryRow, chargerRow } = findCesabSectionRows(ws, maxRow);
    if (truckRow === null) return null;

    const endTruck = batteryRow || (maxRow + 1);
    const refStr = ref ? String(ref).trim() : '';
    const truckOptions = [];
    for (let r = truckRow + 3; r < endTruck; r++) {
      const bVal = cesabCell(ws, 'B', r);
      if (!bVal) continue;
      if (/\bProduct\b|\bQuantity\b/i.test(String(bVal))) continue;
      const label = cleanCesabLabel(bVal);
      // La première ligne d'options répète souvent le modèle déjà donné en référence (ex :
      // "Modèle P320" alors que la référence B14 est déjà "P320") — inutile de le redire.
      if (refStr && new RegExp('^Mod[eè]le\\s+' + escapeRegex(refStr) + '$', 'i').test(label)) continue;
      truckOptions.push(label);
    }

    const endBattery = chargerRow || (maxRow + 1);
    const battery = batteryRow ? parseCesabEquipmentSection(ws, batteryRow, endBattery, 'battery') : { label: 'Batterie', price: 0 };
    const charger = chargerRow ? parseCesabEquipmentSection(ws, chargerRow, maxRow + 1, 'charger') : { label: 'Chargeur', price: 0 };

    const mainRecord = { excluded: false, desc: ref ? String(ref) : '', ht: globalPrice === undefined ? '' : globalPrice };
    const optionRows = [];
    truckOptions.forEach((label) => optionRows.push({ excluded: false, desc: label, ht: '' }));
    optionRows.push({ excluded: false, desc: battery.label, ht: '' });
    optionRows.push({ excluded: false, desc: charger.label, ht: '' });

    return { items: [mainRecord, ...optionRows], ref, globalPrice, battery, charger };
  }

  // ── Extraction BYD (Excel protégé par mot de passe) ────────────────────
  function parseBydExcel(workbook) {
    // Trouver la feuille française
    let ws = null;
    for (const name of workbook.SheetNames) {
      const s = workbook.Sheets[name];
      if (!s['!ref']) continue;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 12; c++) {
          const cell = s[XLSX.utils.encode_cell({ r, c })];
          if (cell && typeof cell.v === 'string' &&
              (/formulaire/i.test(cell.v) || /prix net/i.test(cell.v) || /caractéristiques/i.test(cell.v))) {
            ws = s;
          }
        }
      }
      if (ws) break;
    }
    if (!ws) {
      for (let i = workbook.SheetNames.length - 1; i >= 0; i--) {
        const s = workbook.Sheets[workbook.SheetNames[i]];
        if (s['!ref'] && XLSX.utils.decode_range(s['!ref']).e.r > 5) { ws = s; break; }
      }
    }
    if (!ws) return null;

    const range = XLSX.utils.decode_range(ws['!ref']);
    function cellVal(r, c) {
      const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c })];
      return cell ? cell.v : null;
    }
    function cellStr(r, c) {
      const v = cellVal(r, c);
      return v != null ? String(v).replace(/\n/g, ' ').trim() : '';
    }

    // Nom du modèle depuis C1 ou D1
    let modelName = cellStr(1, 2) || cellStr(1, 3);
    if (modelName) {
      const fm = modelName.match(/^(.+?)\s*(?:formulaire|order form|bestellformular)/i);
      if (fm) modelName = fm[1].trim();
    }

    const items = [];
    const stopWords = /inclus à la livraison|compris à la livraison|concessionnaire|on-truck items|dealer name|gerätelieferumfang|händlername/i;
    let finalPrice = '';

    // Première passe : détecter les catégories et marquer les lignes actives (G/H/I)
    const categories = [];
    let currentCat = null;

    for (let r = 4; r <= range.e.r + 1; r++) {
      const a = cellStr(r, 0);

      // Chercher "Prix final" AVANT le break sur stopWords (même ligne possible)
      for (let c = 8; c <= 11; c++) {
        const v = cellStr(r, c);
        if (/prix final|prix net final/i.test(v)) {
          for (let pc = c + 1; pc <= 11; pc++) {
            const pv = cellVal(r, pc);
            if (typeof pv === 'number') { finalPrice = pv; break; }
          }
          if (finalPrice === '') {
            const below = cellVal(r + 1, c);
            if (typeof below === 'number') finalPrice = below;
          }
        }
      }

      if (a && stopWords.test(a)) break;

      if (a) {
        currentCat = { aText: a, rows: [] };
        categories.push(currentCat);
      }
      if (!currentCat) continue;

      // Collecter descriptions (C/D/E/F) et vérifier G/H/I
      var descs = [];
      for (let fc = 2; fc <= 5; fc++) {
        const d = cellStr(r, fc).replace(/^\s+/, '');
        if (d) descs.push(d);
      }
      var hasGHI = false;
      var ghiCount = 0;
      for (let pi = 0; pi < 3; pi++) {
        const pVal = cellVal(r, 6 + pi);
        if (pVal != null && typeof pVal === 'number') {
          if (pVal !== 0 || descs.length > 1) { hasGHI = true; ghiCount++; }
        }
      }
      currentCat.rows.push({ r, descs, hasGHI, ghiCount });
    }

    // Construire le résultat
    if (modelName) {
      items.push({ excluded: false, desc: modelName, ht: '' });
    }

    // Extraire le nom court de la catégorie (avant la parenthèse ou le retour ligne)
    function catPrefix(aText) {
      var t = aText.replace(/\n/g, ' ').trim();
      var m = t.match(/^(batterie|siège|siege|chargeur)/i);
      return m ? m[1] : t.replace(/\s*\(.*/, '').trim();
    }

    for (const cat of categories) {
      var prefix = catPrefix(cat.aText);
      var needsPrefix = /batterie|siège|siege|charg/i.test(prefix);
      var addedDescs = [];

      // Toujours ajouter le standard (décoché)
      items.push({ excluded: true, desc: cat.aText.replace(/\n/g, ' '), ht: '', _doubt: true, _catLabel: prefix });

      // Toutes les options de la catégorie (décochées)
      for (var row of cat.rows) {
        for (var desc of row.descs) {
          if (addedDescs.includes(desc)) continue;
          addedDescs.push(desc);
          var finalDesc = needsPrefix ? prefix + ' : ' + desc : desc;
          items.push({ excluded: true, desc: finalDesc, ht: '', _doubt: true, _catLabel: prefix });
        }
      }
    }

    if (finalPrice !== '') {
      if (typeof finalPrice === 'number') finalPrice = Math.round(finalPrice * 100) / 100;
      items.push({ excluded: false, desc: 'Prix final', ht: finalPrice });
    }

    return { items };
  }

  // ── Extraction EP (PDF structure fixe) ─────────────────────────────────
  function parseEpPdf(lines) {
    const items = [];
    function extractPrice(str) {
      // Cherche le prix en partant de la fin : nombre (avec espaces milliers) + €
      // On itère de droite à gauche pour trouver le "vrai" prix, pas un nombre dans la desc.
      // Le prix est toujours le dernier token numérique avant €.
      const euroIdx = str.lastIndexOf('€');
      if (euroIdx < 0) return null;
      const before = str.slice(0, euroIdx).trimEnd();
      // Extraire le prix : dernier bloc = chiffres (et espaces milliers) en fin de string
      // "Largeur de fourches 570 0" → "0"
      // "DS3 Li 1 793" → "1 793"
      // "Batterie 230AH 80V 0" → "0"
      // "Hauteur du mât T4800 1 190" → "1 190"
      const pm = before.match(/((?:^|\s)(\d{1,3}(?:\s\d{3})*(?:,\d+)?))$/);
      if (!pm) return null;
      const priceRaw = pm[2] || pm[1];
      const desc = before.slice(0, before.length - pm[1].length).trim();
      return { price: parseFrenchNumber(priceRaw.trim()) || '', desc };
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (/^Chassis\s+/i.test(trimmed)) {
        const r = extractPrice(trimmed.replace(/^Chassis\s+/i, ''));
        if (r) items.push({ excluded: false, desc: r.desc, ht: r.price });
        continue;
      }

      if (/^Option\s*:\s*/i.test(trimmed)) {
        const content = trimmed.replace(/^Option\s*:\s*/i, '');
        if (/OPTIONAL\s+SELECTION/i.test(content)) {
          const desc = content.replace(/\s*OPTIONAL\s+SELECTION\s*/i, '').trim();
          if (desc) items.push({ excluded: false, desc, ht: 0 });
        } else {
          const r = extractPrice(content);
          if (r) items.push({ excluded: false, desc: r.desc, ht: r.price });
        }
        continue;
      }

      if (/^Co[uû]ts?\s+de\s+transport/i.test(trimmed)) {
        const r = extractPrice(trimmed);
        if (r) items.push({ excluded: false, desc: 'Coût de transport', ht: r.price });
        continue;
      }
    }
    return { items };
  }

  // ── Extraction PDF : moteur de règles ──────────────────────────────────
  const EXCLUDE_RE = /\b(total|tva|sous[\s-]?total|net\s*[àa]\s*payer|acompte|escompte|frais\s+de\s+port|prix\s+sp[ée]cial|prix\s+unitaire|prix\s+net|prix\s+brut)\b/i;
  // Groupé + décimales (22 009,20 / 1.234,56) | Groupé entier (18 341) | Décimal simple (650,00) | Entier (500)
  // Les deux premières variantes (regroupement par espace/point) exigent qu'aucune lettre ne
  // précède immédiatement le premier chiffre : sans ça, un code produit finissant par un chiffre
  // collé au prix par un simple espace (ex : "Support document A4 318,40") se ferait absorber
  // dans le prix ("4 318,40" au lieu de "318,40"), comme un vrai regroupement de milliers.
  const NUM_RE = '((?:(?<![\\wÀ-ÿ])-?\\d{1,3}(?:[ .]\\d{3})*,\\d{1,2})|(?:(?<![\\wÀ-ÿ])-?\\d{1,3}(?:[ .]\\d{3})+)|-?\\d+[.,]\\d{1,2}|-?\\d+)';

  function findNumberOnLine(line) {
    const m = line.match(new RegExp(NUM_RE + '\\s*(?:€|EUR)?\\s*(?:HT|TTC)?\\s*$', 'i')) ||
              line.match(new RegExp(NUM_RE));
    return m ? parseFrenchNumber(m[1]) : null;
  }
  function stripKeyword(line, keyword) {
    const re = new RegExp(escapeRegex(keyword), 'i');
    return line.replace(re, '').replace(/^[\s:.\-–]+/, '').trim();
  }
  function findGenericPrice(line, tags) {
    if (tags.ttc) {
      const m = line.match(new RegExp(NUM_RE + '\\s*(?:€|EUR)?\\s*TTC\\s*$', 'i'));
      if (m) return { role: 'ttc', value: parseFrenchNumber(m[1]), matchIndex: m.index };
    }
    if (tags.ht) {
      const m = line.match(new RegExp(NUM_RE + '\\s*(?:€|EUR)?\\s*HT\\s*$', 'i'));
      if (m) return { role: 'ht', value: parseFrenchNumber(m[1]), matchIndex: m.index };
    }
    return null;
  }
  /** Certains PDF rendent la puce "-" comme un item de texte séparé du reste de la ligne (décalage
   *  vertical infime mais suffisant pour ne pas être regroupé par `getPdfLines`) : la puce se
   *  retrouve alors seule sur sa propre ligne, et la ligne suivante ne commence donc plus par
   *  "-", ce qui la fait passer inaperçue pour la capture d'options. On recolle une ligne
   *  composée uniquement du marqueur à la ligne suivante avant toute analyse. */
  function mergeLoneBulletLines(lines, marker) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === marker && i + 1 < lines.length) {
        out.push(marker + ' ' + lines[i + 1]);
        i++;
      } else {
        out.push(lines[i]);
      }
    }
    return out;
  }

  function blankRecord(fieldKeys) {
    const r = { excluded: false };
    fieldKeys.forEach((k) => { r[k] = ''; });
    return r;
  }

  /** Une valeur "globale" (ex : une remise unique pour tout le devis) est répétée sur chaque
   *  ligne de résultat qui ne l'a pas déjà — elle apparaît alors "en face de chaque produit",
   *  comme n'importe quel autre champ, sans avoir besoin d'une cellule à part dans le modèle. */
  function broadcastDocumentFields(items, documentFields) {
    Object.entries(documentFields).forEach(([key, value]) => {
      items.forEach((item) => {
        if (item[key] === '' || item[key] === undefined) item[key] = value;
      });
    });
  }

  /** Mode "Plusieurs articles" : chaque ligne détectée (mot-clé ou prix générique dans la
   *  zone) démarre une nouvelle ligne de résultat.
   *  Retourne { items, documentFields } : documentFields contient les valeurs marquées
   *  "globales" dans une règle mot-clé (ex : une remise unique pour tout le devis, à écrire
   *  une seule fois dans le modèle plutôt que répétée sur chaque ligne). */
  function applyTableRules(lines, cfg) {
    const items = [];
    const documentFields = {};
    let current = null;
    let inZone = !cfg.boundStart;

    const pushCurrent = () => { if (current) { items.push(current); current = null; } };

    for (const line of lines) {
      if (!line) continue;

      // Le bornage ne sert qu'à cadrer la détection GÉNÉRIQUE de prix ci-dessous ; les règles
      // mot-clé, elles, s'appliquent sur tout le document (une valeur comme la remise apparaît
      // souvent APRÈS la fin du tableau d'articles).
      let isBoundaryLine = false;
      if (cfg.boundStart && !inZone && line.toLowerCase().includes(cfg.boundStart.toLowerCase())) {
        inZone = true;
        isBoundaryLine = true;
      }
      if (cfg.boundEnd && inZone && line.toLowerCase().includes(cfg.boundEnd.toLowerCase())) {
        inZone = false;
        isBoundaryLine = true;
      }
      if (isBoundaryLine) continue;

      let matched = false;
      for (const rule of cfg.keywordRules) {
        if (!rule.keyword || rule.role === 'ignore') continue;
        if (!keywordMatches(line, rule.keyword, lines)) continue;
        matched = true;
        if (rule.role === 'desc' || rule.role === 'desc_row') {
          const label = rule.keepLabel ? line : (stripKeyword(line, rule.keyword) || line);
          pushCurrent();
          current = blankRecord(cfg.allFieldKeys);
          current.desc = label;
        } else {
          let num = findNumberOnLine(line);
          if (num !== null && rule.divideBy100) num /= 100;
          if (num !== null) {
            if (rule.global) {
              documentFields[rule.role] = num;
            } else {
              if (!current) current = blankRecord(cfg.allFieldKeys);
              current[rule.role] = num;
            }
          }
        }
        break;
      }
      if (matched) continue;

      if (cfg.excludeTotals && EXCLUDE_RE.test(line)) continue;

      if (inZone && (cfg.generic.ht || cfg.generic.ttc)) {
        const found = findGenericPrice(line, cfg.generic);
        if (found) {
          let label = line.slice(0, found.matchIndex).replace(/[-–:]\s*$/, '').trim();
          if (cfg.stripTrailingQty) label = label.replace(/\s+\d{1,2}$/, '').trim();
          if (label) {
            pushCurrent();
            current = blankRecord(cfg.allFieldKeys);
            current.desc = label;
            current[found.role] = found.value;
          } else if (current) {
            current[found.role] = found.value;
          }
        }
      }
    }
    pushCurrent();
    broadcastDocumentFields(items, documentFields);
    return { items, documentFields };
  }

  /** Mode "Un seul article" : une ligne principale (désignation fusionnée + prix), suivie
   *  d'une ligne par option/caractéristique — reproduit le format des anciens modèles Excel
   *  (chariot + batterie + chargeur + options, chacun sur sa propre ligne sans prix). */
  function applyFicheRules(lines, cfg) {
    if (cfg.captureBullets) lines = mergeLoneBulletLines(lines, cfg.bulletMarker || '-');
    const mainRecord = blankRecord(cfg.allFieldKeys);
    const optionRows = [];
    const documentFields = {};
    let inZone = !cfg.boundStart;

    const pushOption = (label) => {
      const row = blankRecord(cfg.allFieldKeys);
      row.desc = label;
      optionRows.push(row);
    };

    for (const line of lines) {
      if (!line) continue;

      let isBoundaryLine = false;
      if (cfg.boundStart && !inZone && line.toLowerCase().includes(cfg.boundStart.toLowerCase())) {
        inZone = true;
        isBoundaryLine = true;
      }
      if (cfg.boundEnd && inZone && line.toLowerCase().includes(cfg.boundEnd.toLowerCase())) {
        inZone = false;
        isBoundaryLine = true;
      }
      if (isBoundaryLine) continue;

      let matched = false;
      for (const rule of cfg.keywordRules) {
        if (!rule.keyword || rule.role === 'ignore') continue;
        if (!keywordMatches(line, rule.keyword, lines)) continue;
        matched = true;
        if (rule.role === 'desc') {
          const label = rule.keepLabel ? line : (stripKeyword(line, rule.keyword) || line);
          mainRecord.desc = mainRecord.desc ? mainRecord.desc + ' / ' + label : label;
        } else if (rule.role === 'desc_row') {
          const label = rule.keepLabel ? line : (stripKeyword(line, rule.keyword) || line);
          const parts = rule.splitComma
            ? label.split(',').map((s) => s.trim()).filter(Boolean)
            : [label];
          parts.forEach(pushOption);
        } else {
          let num = findNumberOnLine(line);
          if (num !== null && rule.divideBy100) num /= 100;
          if (num !== null) {
            if (rule.global) documentFields[rule.role] = num;
            else mainRecord[rule.role] = num;
          }
        }
        break;
      }
      if (matched) continue;

      if (cfg.excludeTotals && EXCLUDE_RE.test(line)) continue;

      if (cfg.captureBullets) {
        const marker = cfg.bulletMarker || '-';
        const re = new RegExp('^' + escapeRegex(marker) + '\\s*(.+)');
        const m = line.match(re);
        if (m && m[1].trim()) pushOption(m[1].trim());
      }
    }

    const items = [];
    const hasMain = cfg.allFieldKeys.some((k) => String(mainRecord[k] || '').trim());
    if (hasMain) items.push(mainRecord);
    items.push(...optionRows);
    return { items, documentFields };
  }

  /** Mode "Plusieurs chariots" : comme "Un seul article", mais un PDF peut contenir plusieurs
   *  fiches à la suite (ex : plusieurs chariots dans un même devis) — chacune finira sur sa
   *  propre feuille Excel. Une règle mot-clé porte le marqueur `endsRecord: true` (typiquement
   *  le prix "Total HT" de fin de chariot) : dès qu'elle matche, la fiche en cours est bouclée
   *  et une nouvelle fiche démarre à la ligne suivante. Une fiche sans déclencheur explicite en
   *  fin de document est abandonnée plutôt que remontée à moitié construite. */
  function applyMultiFicheRules(lines, cfg) {
    if (cfg.captureBullets) lines = mergeLoneBulletLines(lines, cfg.bulletMarker || '-');
    const fiches = [];
    let mainRecord = blankRecord(cfg.allFieldKeys);
    let optionRows = [];
    let hasContent = false;

    const pushOption = (label) => {
      const row = blankRecord(cfg.allFieldKeys);
      row.desc = label;
      optionRows.push(row);
      hasContent = true;
    };
    const finalizeFiche = () => {
      const hasMain = cfg.allFieldKeys.some((k) => String(mainRecord[k] || '').trim());
      const items = [];
      if (hasMain) items.push(mainRecord);
      items.push(...optionRows);
      if (items.length) fiches.push(items);
      mainRecord = blankRecord(cfg.allFieldKeys);
      optionRows = [];
      hasContent = false;
    };

    for (const line of lines) {
      if (!line) continue;

      let matched = false;
      for (const rule of cfg.keywordRules) {
        if (!rule.keyword || rule.role === 'ignore') continue;
        if (!keywordMatches(line, rule.keyword, lines)) continue;
        matched = true;
        if (rule.role === 'desc') {
          const label = rule.keepLabel ? line : (stripKeyword(line, rule.keyword) || line);
          mainRecord.desc = mainRecord.desc ? mainRecord.desc + ' / ' + label : label;
          hasContent = true;
        } else if (rule.role === 'desc_row') {
          const label = rule.keepLabel ? line : (stripKeyword(line, rule.keyword) || line);
          const parts = rule.splitComma
            ? label.split(',').map((s) => s.trim()).filter(Boolean)
            : [label];
          parts.forEach(pushOption);
        } else {
          let num = findNumberOnLine(line);
          if (num !== null && rule.divideBy100) num /= 100;
          if (num !== null) {
            mainRecord[rule.role] = num;
            hasContent = true;
          }
          if (rule.endsRecord) finalizeFiche();
        }
        break;
      }
      if (matched) continue;

      if (cfg.excludeTotals && EXCLUDE_RE.test(line)) continue;

      if (cfg.captureBullets) {
        const marker = cfg.bulletMarker || '-';
        const re = new RegExp('^' + escapeRegex(marker) + '\\s*(.+)');
        const m = line.match(re);
        if (m && m[1].trim()) pushOption(m[1].trim());
      }
    }
    // Pas de finalisation automatique en fin de document : une fiche incomplète (sans son
    // déclencheur de fin) est délibérément abandonnée, comme dans le script d'origine.

    return { fiches, documentFields: {} };
  }

  function applyPdfRules(lines, cfg) {
    if (cfg.recordMode === 'single') return applyFicheRules(lines, cfg);
    if (cfg.recordMode === 'multi') return applyMultiFicheRules(lines, cfg);
    return applyTableRules(lines, cfg);
  }

  /** Détermine les champs (FIELDS) réellement utilisés par une config, pour n'afficher/
   *  n'écrire que les colonnes pertinentes. */
  function usedFieldKeys(cfg) {
    const used = new Set(['desc']);
    (cfg.keywordRules || []).forEach((r) => used.add(r.role === 'desc_row' ? 'desc' : r.role));
    if (cfg.generic && cfg.generic.ht) used.add('ht');
    if (cfg.generic && cfg.generic.ttc) used.add('ttc');
    if (cfg.captureBullets) used.add('desc');
    used.delete('ignore');
    return used;
  }

  /** Duplique la dernière ligne du tableau `extra` fois, en insérant les copies juste après
   *  (les lignes situées plus bas — totaux, etc. — sont donc repoussées d'autant).
   *
   *  ws.duplicateRow() plante (« Shared Formula master must exist... ») dès que la ligne à
   *  dupliquer contient une formule partagée qui n'est pas elle-même la formule maîtresse —
   *  très courant dans les modèles Excel réels (ex : $C$3 recopié sur toutes les lignes). On
   *  commence donc par "dé-partager" toutes les formules de la feuille (en relisant le texte
   *  déjà résolu de chaque cellule, y compris les esclaves, via `cell.formula`).
   *
   *  ws.duplicateRow() décale bien les lignes et leur contenu, mais PAS les références à
   *  l'intérieur des formules : les nouvelles lignes gardent verbatim la formule de la ligne
   *  copiée (ex : "B16*(1-C16)" collé tel quel sur les lignes 17 ET 18), et les formules des
   *  lignes repoussées plus bas gardent leurs anciennes références de ligne (ex : "D17-D18"
   *  au lieu de "D19-D20"). On corrige donc ça nous-mêmes après coup. */
  /** Convertit toutes les formules partagées d'une feuille en formules "normales" indépendantes
   *  (même texte, relu via `cell.formula` qui le résout correctement y compris pour une cellule
   *  esclave). Indispensable avant TOUTE écriture manuelle dans une cellule qui pourrait faire
   *  partie d'un groupe de formule partagée : écrire une valeur brute dans une cellule maîtresse
   *  (ou dupliquer une ligne) en laissant les esclaves intacts casse le groupe et fait boucler
   *  ExcelJS indéfiniment à l'enregistrement plutôt que de lever une erreur propre. */
  function unshareAllFormulas(ws) {
    ws.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.value && typeof cell.value === 'object' && cell.value.sharedFormula) {
          const resolved = cell.formula;
          if (resolved) cell.value = { formula: resolved };
        }
      });
    });
  }

  /** ws.duplicateRow() décale bien le contenu des cellules fusionnées situées sous la ligne
   *  dupliquée, mais PAS la définition de la fusion elle-même (elle reste enregistrée à
   *  l'ancienne position, ex : "C17:C19" alors que ce bloc est maintenant à "C19:C21") — au
   *  moment d'enregistrer le fichier, cette fusion devenue incohérente est silencieusement
   *  perdue et les cellules apparaissent défusionnées. On la recrée nous-mêmes à sa vraie place. */
  function shiftMergeRange(rangeStr, lastRow, extra) {
    const m = rangeStr.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) return null;
    const [, c1, r1, c2, r2] = m;
    const row1 = parseInt(r1, 10);
    if (row1 <= lastRow) return null; // fusion au-dessus (ou sur) la zone dupliquée : inchangée
    const row2 = parseInt(r2, 10);
    return `${c1}${row1 + extra}:${c2}${row2 + extra}`;
  }

  function duplicateRowManually(ws, modelRowNum, lastRow, extra) {
    const totalRowsBefore = ws.rowCount;
    const mergesBefore = (ws.model.merges || []).slice();
    const modelHeight = ws.getRow(modelRowNum).height || 15;
    ws.duplicateRow(lastRow, extra, true);
    for (let k = 1; k <= extra; k++) {
      ws.getRow(lastRow + k).height = modelHeight;
    }

    // Deux passes séparées : si on décalait une fusion à la fois (dé-fusionner l'ancienne
    // position puis refusionner la nouvelle), la nouvelle position de l'une pouvait coïncider
    // avec l'ancienne position d'une autre pas encore traitée — la refusion de la première se
    // faisait alors écraser par la dé-fusion de la seconde. En séparant "tout dé-fusionner"
    // puis "tout refusionner", ce genre de collision entre anciennes et nouvelles positions
    // ne peut plus se produire.
    const toShift = mergesBefore
      .map((rangeStr) => ({ rangeStr, shifted: shiftMergeRange(rangeStr, lastRow, extra) }))
      .filter((m) => m.shifted);
    toShift.forEach(({ rangeStr }) => {
      // ws.unMergeCells() ne suffit pas toujours : après duplicateRow(), certaines cellules
      // ne sont déjà plus "isMerged" au niveau cellule, mais le registre interne _merges garde
      // quand même l'ancienne entrée (clé = adresse de la cellule en haut à gauche) — laissée
      // telle quelle, elle chevauche la nouvelle position et bloque le remerge ("Cannot merge
      // already merged cells"). On la supprime donc directement du registre en plus.
      try { ws.unMergeCells(rangeStr); } catch { /* déjà absente, sans importance */ }
      const masterAddr = rangeStr.split(':')[0];
      if (ws._merges) delete ws._merges[masterAddr];
    });
    toShift.forEach(({ shifted }) => {
      try { ws.mergeCells(shifted); } catch { /* plage déjà fusionnée, sans importance */ }
    });

    const rowRefRe = /(\$?[A-Z]{1,3}\$?)(\d+)/g;

    // Lignes nouvellement créées : remplace la référence à la ligne modèle par la ligne réelle.
    for (let k = 1; k <= extra; k++) {
      const r = lastRow + k;
      ws.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
        if (cell.formula) {
          const fixed = cell.formula.replace(rowRefRe, (m, colPart, rowPart) =>
            parseInt(rowPart, 10) === lastRow ? colPart + r : m);
          cell.value = { formula: fixed };
        }
      });
    }

    // Lignes repoussées plus bas (totaux...) : toute référence >= à l'ancienne dernière ligne
    // doit être décalée du nombre de lignes ajoutées.
    for (let r = lastRow + extra + 1; r <= totalRowsBefore + extra; r++) {
      ws.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
        if (cell.formula) {
          const fixed = cell.formula.replace(rowRefRe, (m, colPart, rowPart) => {
            const rn = parseInt(rowPart, 10);
            return rn >= lastRow ? colPart + (rn + extra) : m;
          });
          cell.value = { formula: fixed };
        }
      });
    }
  }

  // ── Génération du fichier Excel de destination (ExcelJS) ────────────────
  /**
   * @param {ArrayBuffer} templateArrayBuffer
   * @param {object} opts { sheetName, startRow, destCols:[{key,col,numeric}], items,
   *                         enableDuplicate, dupModelRow, dupLastRow,
   *                         documentFields: {key:value}, fixedCells: {key:"C3"} }
   * @returns {Promise<{buffer: ArrayBuffer, warning: string}>}
   */
  async function generateExcel(templateArrayBuffer, opts) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateArrayBuffer);
    const ws = wb.getWorksheet(opts.sheetName);
    if (!ws) throw new Error('Feuille cible introuvable dans le modèle.');
    unshareAllFormulas(ws);

    const included = opts.items;
    let warning = '';
    if (opts.enableDuplicate) {
      const lastRow = parseInt(opts.dupLastRow, 10);
      const modelRowNum = parseInt(opts.dupModelRow, 10) || lastRow;
      if (lastRow) {
        const capacity = lastRow - opts.startRow + 1;
        const extra = included.length - capacity;
        if (extra > 0) {
          duplicateRowManually(ws, modelRowNum, lastRow, extra);
          warning = ` ${extra} ligne(s) supplémentaire(s) ont été créées à partir de la ligne ${modelRowNum} — vérifiez les formules situées sous le tableau.`;
        }
      }
    }

    included.forEach((item, idx) => {
      const r = opts.startRow + idx;
      opts.destCols.forEach((f) => {
        const raw = item[f.key];
        if (raw === '' || raw === undefined) return;
        const cellRef = `${f.col}${r}`;
        if (f.numeric) {
          const num = parseFrenchNumber(raw);
          ws.getCell(cellRef).value = num === null ? raw : num;
        } else {
          ws.getCell(cellRef).value = raw;
        }
      });
    });

    // Valeurs globales du devis (ex : une remise unique) : une seule cellule, jamais répétée.
    Object.entries(opts.fixedCells || {}).forEach(([key, cellRef]) => {
      if (!cellRef) return;
      const raw = (opts.documentFields || {})[key];
      if (raw === undefined || raw === '') return;
      const num = parseFrenchNumber(raw);
      ws.getCell(cellRef).value = num === null ? raw : num;
    });

    const buffer = await wb.xlsx.writeBuffer();
    return { buffer, warning };
  }

  /** Nom de feuille valide et unique : Excel limite à 31 caractères et interdit certains
   *  caractères, et deux feuilles ne peuvent pas porter le même nom — reproduit la logique de
   *  déduplication (`_make_sheet_name`) du script d'origine. */
  function makeSheetName(base, usedNames) {
    let name = String(base || 'Feuille').replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) name = 'Feuille';
    name = name.slice(0, 31);
    let candidate = name;
    let n = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      const suffix = '_' + n;
      candidate = name.slice(0, 31 - suffix.length) + suffix;
      n++;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  }

  /** Clone une feuille modèle (valeurs, styles, formules, fusions, largeurs de colonnes) dans
   *  une nouvelle feuille du même classeur — nécessaire pour générer "une feuille par chariot".
   *  On relit chaque formule via `cell.formula` (déjà dé-partagée en amont par
   *  `unshareAllFormulas`) plutôt que `cell.value` brut, pour éviter de copier une référence à
   *  une formule partagée qui n'existerait plus une fois isolée sur la nouvelle feuille. */
  function cloneWorksheet(wb, sourceWs, newName) {
    const srcModel = JSON.parse(JSON.stringify(sourceWs.model));
    srcModel.name = newName;
    srcModel.id = wb.worksheets.length + 1;
    const target = wb.addWorksheet(newName);
    target.model = srcModel;
    unshareAllFormulas(target);
    return target;
  }

  /**
   * Génère un classeur avec UNE FEUILLE PAR FICHE (ex : un chariot Hangcha par feuille), en
   * clonant la feuille modèle autant de fois que nécessaire. Chaque feuille reçoit ensuite le
   * même traitement que `generateExcel` (remplissage des colonnes, duplication de ligne si la
   * fiche a plus d'options que la capacité du modèle).
   * @param {ArrayBuffer} templateArrayBuffer
   * @param {object} opts { sheetName, startRow, destCols, fiches: [items[], ...],
   *                         sheetNameField, enableDuplicate, dupModelRow, dupLastRow }
   */
  async function generateExcelMulti(templateArrayBuffer, opts) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateArrayBuffer);
    const templateWs = wb.getWorksheet(opts.sheetName);
    if (!templateWs) throw new Error('Feuille modèle introuvable dans le modèle.');
    unshareAllFormulas(templateWs);

    const rowHeights = {};
    templateWs.eachRow({ includeEmpty: true }, (row, rn) => {
      rowHeights[rn] = row.height || 15;
    });

    const usedNames = new Set();
    let warning = '';

    const fillSheet = (ws, items) => {
      let included = items;
      if (opts.enableDuplicate) {
        const lastRow = parseInt(opts.dupLastRow, 10);
        const modelRowNum = parseInt(opts.dupModelRow, 10) || lastRow;
        if (lastRow) {
          const capacity = lastRow - opts.startRow + 1;
          const extra = included.length - capacity;
          if (extra > 0) {
            duplicateRowManually(ws, modelRowNum, lastRow, extra);
            warning = ` Des lignes supplémentaires ont été créées sur au moins une feuille — vérifiez les formules situées sous le tableau.`;
          }
        }
      }
      included.forEach((item, idx) => {
        const r = opts.startRow + idx;
        opts.destCols.forEach((f) => {
          const raw = item[f.key];
          if (raw === '' || raw === undefined) return;
          const cellRef = `${f.col}${r}`;
          if (f.numeric) {
            const num = parseFrenchNumber(raw);
            ws.getCell(cellRef).value = num === null ? raw : num;
          } else {
            ws.getCell(cellRef).value = raw;
          }
        });
      });
      const dataRowHeight = rowHeights[opts.startRow] || 15;
      ws.eachRow({ includeEmpty: true }, (row, rn) => {
        row.height = rowHeights[rn] || dataRowHeight;
      });
    };

    opts.fiches.forEach((items, i) => {
      const nameSource = (opts.sheetNameField && items[0] && items[0][opts.sheetNameField]) || `Feuille ${i + 1}`;
      const name = makeSheetName(nameSource, usedNames);
      const ws = i === 0 ? templateWs : cloneWorksheet(wb, templateWs, name);
      if (i === 0) ws.name = name;
      fillSheet(ws, items);
    });

    const buffer = await wb.xlsx.writeBuffer();
    return { buffer, warning };
  }

  function downloadBuffer(buffer, filename) {
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'Feuille de calcul.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return {
    FIELDS, ROLE_OPTIONS,
    colToIndex, parseFrenchNumber, escapeRegex,
    strictKeywordMatch, looseKeywordMatch, keywordMatches,
    getPdfLines, extractExcel, parseCesabExcel, parseEpPdf, parseBydExcel,
    findNumberOnLine, stripKeyword, findGenericPrice,
    applyTableRules, applyFicheRules, applyMultiFicheRules, applyPdfRules, usedFieldKeys,
    generateExcel, generateExcelMulti, downloadBuffer,
  };
})();

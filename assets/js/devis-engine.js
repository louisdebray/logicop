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

  // ── Extraction BYD (PDF imprimé depuis le formulaire Excel) ─────────────
  async function parseBydPdf(arrayBuffer) {
    var pdfjsLib = await ensurePdfjs();
    var doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    var page = await doc.getPage(1);
    var ops = await page.getOperatorList();
    var textContent = await page.getTextContent();
    var vp = page.getViewport({ scale: 1 });

    // 1) Identifier les images de checkboxes (petites images ~5x5)
    //    Deux images distinctes : cochée (moins fréquente) et décochée (plus fréquente)
    var imgPlacements = [];
    var ctm = [1, 0, 0, 1, 0, 0];
    var ctmStack = [];
    for (var i = 0; i < ops.fnArray.length; i++) {
      var fn = ops.fnArray[i];
      var args = ops.argsArray[i];
      if (fn === pdfjsLib.OPS.save) { ctmStack.push(ctm.slice()); }
      else if (fn === pdfjsLib.OPS.restore) { ctm = ctmStack.pop() || [1,0,0,1,0,0]; }
      else if (fn === pdfjsLib.OPS.transform) { ctm = multiplyMatrix(ctm, args); }
      else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintImageXObjectRepeat) {
        var w = Math.abs(ctm[0]), h = Math.abs(ctm[3]);
        if (w > 0 && w < 15 && h > 0 && h < 15) {
          var x = ctm[4], y = vp.height - ctm[5] - h;
          imgPlacements.push({ name: args[0], x: x, y: y, w: w, h: h });
        }
      }
    }

    // Compter chaque image par nom, ne garder que celles avec 2+ occurrences (vrais checkboxes)
    var nameCounts = {};
    imgPlacements.forEach(function(p) { nameCounts[p.name] = (nameCounts[p.name] || 0) + 1; });
    var names = Object.keys(nameCounts).filter(function(n) { return nameCounts[n] >= 2; });
    var checkedName = '';
    var allImgPlacements = imgPlacements.slice();
    if (names.length >= 2) {
      names.sort(function(a, b) { return nameCounts[b] - nameCounts[a]; });
      names = names.slice(0, 2);
      // Fallback fréquence (sera remplacé par détection modèle si possible)
      checkedName = nameCounts[names[0]] < nameCounts[names[1]] ? names[0] : names[1];
      console.log('BYD checkbox types:', JSON.stringify(nameCounts), 'frequency-guess=', checkedName);
      imgPlacements = imgPlacements.filter(function(p) { return p.name === names[0] || p.name === names[1]; });
    } else {
      imgPlacements = [];
    }

    // 2) Extraire le texte avec positions (convertir en coordonnées top-down)
    var textItems = textContent.items.map(function(it) {
      return { str: it.str, x: it.transform[4], y: vp.height - it.transform[5], w: it.width, h: it.height };
    }).filter(function(it) { return it.str.trim(); });

    // Regrouper le texte en lignes (par bandes de y ±4px)
    textItems.sort(function(a, b) { return a.y - b.y || a.x - b.x; });
    var textLines = [];
    var curLine = null;
    textItems.forEach(function(it) {
      if (!curLine || Math.abs(it.y - curLine.y) > 4) {
        curLine = { y: it.y, items: [] };
        textLines.push(curLine);
      }
      curLine.items.push(it);
    });

    // Construire les mots par ligne (fusionner les items proches)
    textLines.forEach(function(line) {
      line.items.sort(function(a, b) { return a.x - b.x; });
      var words = [];
      var cur = { text: '', x: 0, x1: 0 };
      line.items.forEach(function(it, j) {
        if (j === 0) { cur = { text: it.str, x: it.x, x1: it.x + it.w }; }
        else if (it.x - cur.x1 < 3) { var sep = (cur.text.slice(-1) !== ' ' && it.str[0] !== ' ' && it.x - cur.x1 > 0.5) ? ' ' : ''; cur.text += sep + it.str; cur.x1 = it.x + it.w; }
        else { if (cur.text.trim()) words.push({ text: cur.text.trim(), x: cur.x }); cur = { text: it.str, x: it.x, x1: it.x + it.w }; }
      });
      if (cur.text.trim()) words.push({ text: cur.text.trim(), x: cur.x });
      line.words = words;
      line.text = words.map(function(w) { return w.text; }).join(' ');
    });

    // 3) Détecter le nom du modèle
    var modelName = '';
    var modelY = -1;
    for (var li = 0; li < Math.min(textLines.length, 5); li++) {
      for (var wi = 0; wi < textLines[li].words.length; wi++) {
        var wt = textLines[li].words[wi].text;
        if (/formulaire|order form/i.test(wt)) {
          var fm = wt.match(/^(.+?)\s*(?:formulaire|order form|bestellformular)/i);
          modelName = fm ? fm[1].trim() : wt;
          break;
        }
      }
      if (modelName) break;
    }
    // Trouver la ligne de la référence (première ligne contenant le nom du modèle sans suffixe)
    var modelBase = modelName.replace(/\s*\(.*\)/, '').trim();
    var modelYTitle = -1;
    if (modelBase) {
      for (var mi = 0; mi < textLines.length; mi++) {
        var hasModel = textLines[mi].words.some(function(w) { return w.text.indexOf(modelBase) === 0; });
        if (!hasModel) continue;
        var hasFormulaire = /formulaire|order form/i.test(textLines[mi].text);
        if (!hasFormulaire) { modelY = textLines[mi].y; break; }
        else if (modelYTitle < 0) { modelYTitle = textLines[mi].y; }
      }
      if (modelY < 0) modelY = modelYTitle;
    }

    // 4) Trouver la zone d'arrêt et les catégories
    var stopY = Infinity;
    var items = [];
    var checkedDescs = [];

    textLines.forEach(function(line) {
      line.words.forEach(function(w) {
        if (/inclus à la livraison|compris à la livraison/i.test(w.text)) {
          if (line.y < stopY) stopY = line.y;
        }
      });
    });

    // Première colonne de checkbox = seuil pour séparer catégories / options
    var minCbX = 80;
    imgPlacements.forEach(function(p) { if (p.x < minCbX || minCbX === 80) minCbX = Math.min(minCbX, p.x); });

    // Catégories : texte à gauche des checkboxes
    var catLines = [];
    textLines.forEach(function(line) {
      if (line.y > stopY) return;
      var leftWords = line.words.filter(function(w) { return w.x < minCbX - 10; });
      if (leftWords.length > 0) {
        var catText = leftWords.map(function(w) { return w.text; }).join(' ');
        if (catText && !/^€|^-|^0%|^Prix|^Marge|^Equipements|^Caractéristiques/i.test(catText))
          catLines.push({ y: line.y, text: catText });
      }
    });

    // Copie avant fusion pour la détection des standards
    var catLinesRaw = catLines.map(function(c) { return { y: c.y, text: c.text }; });

    // Fusionner les catégories multi-lignes (lignes consécutives sans checkbox)
    for (var ci = catLines.length - 1; ci > 0; ci--) {
      var prev = catLines[ci - 1], cur = catLines[ci];
      var hasCbBetween = imgPlacements.some(function(p) { return p.y > prev.y - 3 && p.y < cur.y - 3; });
      if (!hasCbBetween && cur.y - prev.y < 20) {
        prev.text += ' ' + cur.text;
        catLines.splice(ci, 1);
      }
    }

    console.log('BYD final checkedName=', checkedName);
    console.log('BYD catLinesRaw:', catLinesRaw.map(function(c) { return 'y='+Math.round(c.y)+' "'+c.text+'"'; }));
    // Debug: chercher le texte chargeur dans toutes les textLines
    if (imgPlacements.length === 0) {
      var chargLines = textLines.filter(function(l) { return /charg/i.test(l.text) && l.y < stopY; });
      if (chargLines.length) console.log('BYD chargeur words:', chargLines.map(function(l) {
        return 'y='+Math.round(l.y)+' words=['+l.words.map(function(w){return '"'+w.text+'"@'+Math.round(w.x);}).join(', ')+']';
      }));
    }

    // 5) Pour chaque checkbox cochée, trouver le mot le plus proche à droite
    var checkedImgs = imgPlacements.filter(function(p) { return p.name === checkedName && p.y < stopY; });
    checkedImgs.sort(function(a, b) { return a.y - b.y; });
    console.log('BYD checked count:', checkedImgs.length);

    // Collecter les descriptions cochées avec leur position Y dans le texte
    var checkedEntries = [];
    checkedImgs.forEach(function(img) {
      // Trouver la textLine la plus proche de la checkbox (tolérance 12px)
      var bestLine = null, bestDist = 12;
      textLines.forEach(function(l) {
        var d = Math.abs(l.y - img.y);
        if (d < bestDist) { bestDist = d; bestLine = l; }
      });
      if (!bestLine) return;

      // Trouver la prochaine checkbox sur la même textLine (pour limiter la description)
      var nextCbX = Infinity;
      imgPlacements.forEach(function(p) {
        if (p === img || p.x <= img.x + 10) return;
        var pBest = null, pDist = 12;
        textLines.forEach(function(l) { var d = Math.abs(l.y - p.y); if (d < pDist) { pDist = d; pBest = l; } });
        if (pBest === bestLine) nextCbX = Math.min(nextCbX, p.x);
      });

      // Prendre les mots à droite de la checkbox, avant la prochaine checkbox, exclure prix/€/nombres purs
      var priceColX = 450;
      var rightWords = bestLine.words.filter(function(w) {
        if (w.x <= img.x - 5 || w.x >= nextCbX - 5 || w.x >= priceColX) return false;
        var t = w.text.trim();
        if (/€|^-$/.test(t)) return false;
        if (/^-?\s*[\d][\d\s.,]*$/.test(t)) return false;
        return true;
      }).sort(function(a, b) { return a.x - b.x; });

      var desc = rightWords.map(function(w) { return w.text; }).join(' ').trim();

      // Fallback : si rien sur la textLine principale, chercher sur les textLines voisines
      if (!desc) {
        var nearLines = textLines.filter(function(l) { return l !== bestLine && Math.abs(l.y - img.y) < 15; });
        nearLines.sort(function(a, b) { return Math.abs(a.y - img.y) - Math.abs(b.y - img.y); });
        console.log('BYD fallback for x='+Math.round(img.x)+' y='+Math.round(img.y)+' nextCbX='+Math.round(nextCbX)+' nearLines:', nearLines.map(function(nl) {
          return 'y='+Math.round(nl.y)+'(d='+Math.round(Math.abs(nl.y-img.y))+') words=['+nl.words.map(function(w){return w.text+'@'+Math.round(w.x);}).join('|')+']';
        }));
        nearLines.forEach(function(nl) {
          if (desc) return;
          // Ignorer les lignes plus proches d'un autre checkbox (texte d'une autre option)
          var myDist = Math.abs(nl.y - img.y);
          var closerCb = imgPlacements.some(function(p) {
            if (p === img || Math.abs(p.x - img.x) > 20 || Math.abs(p.y - img.y) < 4) return false;
            return Math.abs(p.y - nl.y) < myDist - 1;
          });
          if (closerCb) return;
          var rw = nl.words.filter(function(w) {
            if (w.x <= img.x - 5 || w.x >= nextCbX - 5 || w.x >= priceColX) return false;
            var t = w.text.trim();
            return !/€|^-$/.test(t) && !/^-?\s*[\d][\d\s.,]*$/.test(t);
          });
          if (rw.length) desc = rw.map(function(w) { return w.text; }).join(' ').trim();
        });
      }

      if (!desc || /^€|^-\s*€|^-$|^\d[\d\s,]*€/.test(desc)) return;
      var existing = checkedEntries.find(function(e) { return e.desc === desc; });
      if (!existing) checkedEntries.push({ desc: desc, imgY: img.y, lineY: bestLine.y });
    });

    // 6) Collecter tous les prix — formats : « € 31 905 », « € -42 », « 39 075 € », « € » + « 33 129 »
    var allPrices = [];
    textContent.items.forEach(function(it) {
      if (!/€/.test(it.str)) return;
      var iy = vp.height - it.transform[5];
      if (iy > stopY + 30) return;
      var m = it.str.match(/€\s*(-?\s*[\d\s.,]+)/) || it.str.match(/(-?[\d\s.,]+)\s*€/);
      var val;
      if (m) {
        var raw = m[1].replace(/\s/g, '').replace(/,.*$/, '');
        val = parseInt(raw, 10);
      } else if (it.str.trim() === '€') {
        // € seul : chercher un nombre juste à droite sur la même ligne
        var numItem = textContent.items.find(function(n) {
          if (!/^\s*-?\s*[\d][\d\s.,]*$/.test(n.str)) return false;
          var ny = vp.height - n.transform[5];
          return Math.abs(ny - iy) < 4 && n.transform[4] > it.transform[4] && n.transform[4] - it.transform[4] < 40;
        });
        if (!numItem) return;
        val = parseInt(numItem.str.replace(/\s/g, '').replace(/,.*$/, ''), 10);
      } else return;
      if (isNaN(val)) return;
      // Vérifier si un "-" isolé précède cet item (prix négatif avec tiret séparé)
      if (val > 0) {
        var hasMinus = textContent.items.some(function(d) {
          if (d.str.trim() !== '-') return false;
          var dy = vp.height - d.transform[5];
          return Math.abs(dy - iy) < 4 && d.transform[4] < it.transform[4] && it.transform[4] - d.transform[4] < 50;
        });
        if (hasMinus) val = -val;
      }
      allPrices.push({ y: iy, x: it.transform[4], val: val });
    });
    // Ne garder que la première colonne (x le plus petit par ligne y)
    allPrices.sort(function(a, b) { return a.y - b.y || a.x - b.x; });
    var seenPriceY = {};
    allPrices = allPrices.filter(function(p) {
      var key = Math.round(p.y);
      if (seenPriceY[key]) return false;
      seenPriceY[key] = true;
      return true;
    });

    function getNearestPrice(y) {
      var best = null, bestDist = 25;
      allPrices.forEach(function(p) {
        var d = Math.abs(p.y - y);
        if (d < bestDist) { bestDist = d; best = p; }
      });
      return best ? best.val : '';
    }

    // 7) Collecter tous les items avec position Y et prix
    var sortedItems = [];
    // Vérifier si "Commandes hydrauliques" existe dans le PDF
    var hasCommandesCat = textLines.some(function(l) { return l.words.some(function(w) { return /commandes\s*hydrauliques/i.test(w.text); }); });
    // Si pas de commandes hydrauliques, le prix de la référence va sur le modèle
    var modelLineY = hasCommandesCat ? -1 : modelY;
    if (modelName) sortedItems.push({ y: 0, lineY: modelLineY, excluded: false, desc: modelName, ht: '' });

    // Commandes hydrauliques / Roulabilité : checkbox si présentes, sinon texte descriptif
    var textCatYs = [];
    var textCats = [/commandes\s*hydrauliques/i, /roulabilit/i, /piping/i];
    textCats.forEach(function(re) {
      var catLine = textLines.find(function(l) { return re.test(l.text); });
      if (!catLine) return;
      // Vérifier s'il y a des checkboxes (toutes) dont la ligne texte la plus proche est celle-ci
      var lineAllCbs = allImgPlacements.filter(function(p) {
        if (Math.abs(p.y - catLine.y) >= 12) return false;
        var nearest = null, nd = 12;
        textLines.forEach(function(l) { var d = Math.abs(l.y - p.y); if (d < nd) { nd = d; nearest = l; } });
        return nearest === catLine;
      });
      if (lineAllCbs.length > 0) return; // checkboxes présentes → géré par la logique checkbox (cochées ou non)

      // Pas de checkbox du tout → prendre le texte descriptif
      var descParts = [];
      textContent.items.forEach(function(it) {
        var iy = vp.height - it.transform[5];
        if (Math.abs(iy - catLine.y) > 6) return;
        var ix = it.transform[4];
        if (ix < 90 || ix > 450 || !it.str.trim()) return;
        var st = it.str.trim();
        if (/€|^-$/.test(st) || /^-?\s*[\d][\d\s.,]*$/.test(st)) return;
        descParts.push({ x: ix, str: it.str });
      });
      descParts.sort(function(a, b) { return a.x - b.x; });
      var descWords = [];
      var curWord = '';
      var lastX1 = 0;
      descParts.forEach(function(p, i) {
        if (i === 0 || p.x - lastX1 > 5) {
          if (curWord.trim()) descWords.push(curWord.trim());
          curWord = p.str;
        } else {
          curWord += p.str;
        }
        lastX1 = p.x + (p.str.length * 3);
      });
      if (curWord.trim()) descWords.push(curWord.trim());
      if (descWords.length === 0) return;
      var desc = descWords.join(' ');
      if (desc.trim()) {
        sortedItems.push({ y: catLine.y, lineY: catLine.y, excluded: false, desc: desc.trim(), ht: '' });
        textCatYs.push(catLine.y);
      }
    });

    console.log('BYD checkedEntries:', checkedEntries.map(function(e) { return e.desc; }));
    checkedEntries.forEach(function(entry) {
      var descLineY = entry.lineY || 0;
      if (!descLineY) {
        var descLine = textLines.find(function(l) { return l.words.some(function(w) { return w.text === entry.desc; }); });
        if (!descLine) return;
        descLineY = descLine.y;
      }
      var cat = null;
      for (var ci = catLines.length - 1; ci >= 0; ci--) {
        if (catLines[ci].y <= descLineY + 3) { cat = catLines[ci]; break; }
      }
      var cleanDesc = entry.desc.replace(/^\*\s*/, '');
      var finalDesc = cleanDesc;
      var descIsCat = /^(batterie|siège|siege|chargeur|dosseret|fourches|garantie|cabine|mât|mat)/i.test(cleanDesc);
      if (!descIsCat && cat && /batterie|siège|siege|charg|dosseret/i.test(cat.text)) {
        var prefix = cat.text.match(/^(batterie|siège|siege|chargeur|dosseret[\s\w]*)/i);
        if (prefix) finalDesc = prefix[1].trim() + ' : ' + cleanDesc;
      }
      sortedItems.push({ y: descLineY, lineY: descLineY, excluded: false, desc: finalDesc, ht: '' });
    });

    // Catégories sans case cochée → texte standard
    var stdCategories = [
      { keyword: /dosseret/i },
      { keyword: /batterie/i },
      { keyword: /siège|siege/i },
      { keyword: /chargeur/i },
      { keyword: /fourches/i },
      { keyword: /garantie/i }
    ];
    stdCategories.forEach(function(sc) {
      var catEntry = catLinesRaw.find(function(c) { return sc.keyword.test(c.text); });
      if (!catEntry) {
        var tl = textLines.find(function(l) { return sc.keyword.test(l.text) && l.y < stopY; });
        if (tl) catEntry = { y: tl.y, text: tl.text };
      }
      if (!catEntry) return;
      var catIdx = catLinesRaw.indexOf(catEntry);
      // Pour les PDFs sans checkbox, ne pas ajouter de catégorie trouvée uniquement via textLines fallback
      if (catIdx < 0 && checkedImgs.length === 0) return;
      var nextCatY, prevCatY;
      if (catIdx >= 0) {
        nextCatY = catIdx < catLinesRaw.length - 1 ? catLinesRaw[catIdx + 1].y : stopY;
        prevCatY = catIdx > 0 ? catLinesRaw[catIdx - 1].y : 0;
      } else {
        // catEntry vient de textLines fallback — trouver bornes dans catLinesRaw par y
        prevCatY = 0; nextCatY = stopY;
        catLinesRaw.forEach(function(c) {
          if (c.y < catEntry.y && c.y > prevCatY) prevCatY = c.y;
          if (c.y > catEntry.y && c.y < nextCatY) nextCatY = c.y;
        });
      }
      var rangeStart = catEntry.y - Math.min(6, (catEntry.y - prevCatY) / 2);
      var hasChecked = checkedImgs.some(function(img) {
        if (img.y < rangeStart || img.y >= nextCatY) return false;
        // Vérifier que le desc de ce checkbox ne correspond pas à une AUTRE catégorie
        var entry = checkedEntries.find(function(e) { return Math.abs(e.imgY - img.y) < 3; });
        if (entry) {
          var otherCat = stdCategories.some(function(oc) { return oc !== sc && oc.keyword.test(entry.desc); });
          if (otherCat) return false;
        }
        return true;
      });
      var alreadyHasItem = sortedItems.some(function(si) { return sc.keyword.test(si.desc); });
      console.log('stdCat', sc.keyword.source, 'y=', catEntry.y, 'range=', rangeStart, '-', nextCatY, 'hasChecked=', hasChecked, 'alreadyHas=', alreadyHasItem, 'text=', catEntry.text);
      if (!hasChecked && !alreadyHasItem) {
        var stdText = catEntry.text;
        var stopKeywords = /^(batterie|siège|siege|chargeur|dosseret|fourches|cabine|options|garantie|mât|mat|attachement|accessoires|galets|roule|piping|demande)/i;
        for (var ri = catIdx >= 0 ? catIdx + 1 : catLinesRaw.length; ri < catLinesRaw.length; ri++) {
          if (catLinesRaw[ri].y - catLinesRaw[ri - 1].y > 20) break;
          if (stopKeywords.test(catLinesRaw[ri].text)) break;
          // Pour fourches : ne garder que les lignes descriptives (parenthèses, standard, dimensions)
          if (/fourches/i.test(stdText) && !/^\(|standard/i.test(catLinesRaw[ri].text)) break;
          // Chargeur : ne pas continuer (le header contient déjà le standard)
          if (/chargeur/i.test(stdText)) break;
          // Ignorer les lignes contenant des prix parasites
          if (/€/.test(catLinesRaw[ri].text)) break;
          stdText += ' ' + catLinesRaw[ri].text;
        }
        // Fourches : extraire juste "Fourches" + dimensions standard entre parenthèses
        if (/fourches/i.test(stdText)) {
          stdText = stdText.replace(/\s*\*.*$/, '').trim();
          var fm = stdText.match(/(fourches)\s.*?(\(\d+x\d+x\d+mm\s*standard\))/i);
          if (fm) stdText = fm[1] + ' ' + fm[2];
        }
        // Chargeur : extraire la bonne option
        if (/charg/i.test(stdText)) {
          // Pour PDFs sans checkbox : extraire l'option colonne 2 (non-standard sélectionnée)
          var chargTL = textLines.find(function(l) { return Math.abs(l.y - catEntry.y) < 3 && /charg/i.test(l.text); });
          if (chargTL && checkedImgs.length === 0) {
            var npW = chargTL.words.filter(function(w) {
              return !/€|^-$/.test(w.text.trim()) && !/^-?\s*[\d][\d\s.,]*$/.test(w.text.trim());
            }).sort(function(a, b) { return a.x - b.x; });
            // Détecter les colonnes par les gaps > 50px entre mots
            var cols = [{ start: 0, words: [] }];
            for (var wi = 0; wi < npW.length; wi++) {
              if (wi > 0 && npW[wi].x - npW[wi - 1].x > 50) {
                cols.push({ start: npW[wi].x, words: [] });
              }
              cols[cols.length - 1].words.push(npW[wi]);
            }
            if (cols.length >= 2) {
              var col2 = cols[1];
              var col2Text = col2.words.map(function(w) { return w.text; }).join(' ').trim();
              // Chercher continuation sur la ligne suivante dans la même colonne x
              var nextTL = textLines.find(function(l) { return l.y > chargTL.y && l.y < chargTL.y + 15; });
              if (nextTL) {
                var col3Start = cols.length >= 3 ? cols[2].start : 400;
                var nextW = nextTL.words.filter(function(w) {
                  return w.x >= col2.start - 20 && w.x < col3Start - 5 &&
                    !/€|^-$/.test(w.text.trim()) && !/^-?\s*[\d][\d\s.,]*$/.test(w.text.trim()) &&
                    !/^fourches|^\(/i.test(w.text.trim());
                });
                if (nextW.length) col2Text += ' ' + nextW.map(function(w) { return w.text; }).join(' ').trim();
              }
              stdText = 'Chargeur (' + col2Text + ')';
            }
          }
          // Pour PDFs avec checkbox : extraire la première parenthèse fermée
          if (checkedImgs.length > 0) {
            var cm = stdText.match(/(charg\w*)\s*(\([^)]*\))/i);
            if (cm) stdText = cm[1] + ' ' + cm[2];
          }
          // Si parenthèses non fermées, chercher le texte manquant
          var opens = (stdText.match(/\(/g) || []).length;
          var closes = (stdText.match(/\)/g) || []).length;
          if (opens > closes) {
            textLines.forEach(function(tl) {
              if (Math.abs(tl.y - catEntry.y) > 10) return;
              var m = tl.text.match(/embarqu[ée]\)/i);
              if (m) stdText += ' ' + m[0];
            });
          }
        }
        var sm = stdText.match(/(si[eè]ge\b.*)/i);
        if (sm) stdText = sm[1];
        // Nettoyer les prix parasites dans le texte standard
        stdText = stdText.replace(/\s*€[\s\d.,\-–—]*$/g, '').replace(/[.]\s*€.*$/g, '').replace(/\s*€\s*/g, ' ').trim();
        sortedItems.push({ y: catEntry.y, lineY: catEntry.y, excluded: false, desc: stdText, ht: '' });
      }
    });

    // Trier par Y (ordre du PDF) puis assigner les prix
    sortedItems.sort(function(a, b) { return a.y - b.y; });
    var assignedLines = {};
    var usedPriceIdxs = {};
    sortedItems.forEach(function(it) {
      if (it.lineY < 0) return;
      var lineKey = Math.round(it.lineY / 6);
      if (assignedLines[lineKey]) return;
      assignedLines[lineKey] = true;
      var best = null, bestDist = 25, bestIdx = -1;
      allPrices.forEach(function(p, pi) {
        if (usedPriceIdxs[pi]) return;
        var d = Math.abs(p.y - it.lineY);
        if (d < bestDist) { bestDist = d; best = p; bestIdx = pi; }
      });
      if (best) {
        it.ht = best.val;
        usedPriceIdxs[bestIdx] = true;
      }
    });
    sortedItems.forEach(function(it) { items.push({ excluded: false, desc: it.desc, ht: it.ht }); });

    return { items };
  }

  function multiplyMatrix(a, b) {
    return [
      a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1],
      a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3],
      a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5]
    ];
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
          continue;
        } else {
          const r = extractPrice(content);
          if (r) items.push({ excluded: false, desc: r.desc, ht: r.price });
        }
        continue;
      }

      if (/^(Co[uû]ts?\s+de\s+transport|Transport\s+Costs?)/i.test(trimmed)) {
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
    getPdfLines, extractExcel, parseCesabExcel, parseEpPdf, parseBydPdf,
    findNumberOnLine, stripKeyword, findGenericPrice,
    applyTableRules, applyFicheRules, applyMultiFicheRules, applyPdfRules, usedFieldKeys,
    generateExcel, generateExcelMulti, downloadBuffer,
  };
})();

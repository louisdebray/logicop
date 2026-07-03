/* Logicop — Éditeur d'outil (admin uniquement).
   Entraîne les règles d'extraction sur un devis exemple, configure le modèle Excel de
   destination, puis enregistre le tout dans Supabase (table `tools` + bucket `templates`). */

(function () {
  'use strict';

  const Engine = window.DevisEngine;
  const FIELDS = Engine.FIELDS;
  const ROLE_OPTIONS = Engine.ROLE_OPTIONS;

  const state = {
    toolId: new URLSearchParams(location.search).get('tool'),
    sourceKind: null,
    sourceFile: null,
    sourceWorkbook: null,
    pdfLines: [],
    keywordRules: [],
    items: [],
    documentFields: {},
    templateFile: null,
    templateArrayBuffer: null,
  };

  // ── Références DOM ──────────────────────────────────────────────────
  const el = (id) => document.getElementById(id);

  const pageTitle = el('pageTitle');
  const toolName = el('toolName');
  const toolDescription = el('toolDescription');

  const sourceFile = el('sourceFile');
  const isCesabSource = el('isCesabSource');
  const cesabPanel = el('cesabPanel');
  const excelOptions = el('excelOptions');
  const sourceSheet = el('sourceSheet');
  const srcStartRow = el('srcStartRow');
  const srcEndRow = el('srcEndRow');
  const excelColFields = el('excelColFields');
  const btnExtractExcel = el('btnExtractExcel');

  const pdfTrainPanel = el('pdfTrainPanel');
  const recordMode = el('recordMode');
  const excludeTotals = el('excludeTotals');
  const tableModeOptions = el('tableModeOptions');
  const singleModeOptions = el('singleModeOptions');
  const boundStart = el('boundStart');
  const boundEnd = el('boundEnd');
  const generic_ht = el('generic_ht');
  const generic_ttc = el('generic_ttc');
  const stripTrailingQty = el('stripTrailingQty');
  const captureBullets = el('captureBullets');
  const bulletMarker = el('bulletMarker');
  const keywordRulesEl = el('keywordRules');
  const btnAddKeywordRule = el('btnAddKeywordRule');
  const rawLinesPreview = el('rawLinesPreview');
  const btnTestRules = el('btnTestRules');
  const multiModeHint = el('multiModeHint');

  const itemsTable = el('itemsTable');
  const itemsHeadRow = el('itemsHeadRow');
  const itemsBody = el('itemsBody');
  const itemsActions = el('itemsActions');
  const itemsCount = el('itemsCount');
  const btnAddRow = el('btnAddRow');

  const templateFile = el('templateFile');
  const templateSheet = el('templateSheet');
  const mapStartRow = el('mapStartRow');
  const destColFields = el('destColFields');
  const enableDuplicate = el('enableDuplicate');
  const dupFields = el('dupFields');
  const dupModelRow = el('dupModelRow');
  const dupLastRow = el('dupLastRow');

  const outFileName = el('outFileName');
  const btnGenerate = el('btnGenerate');
  const btnSaveTool = el('btnSaveTool');
  const genStatus = el('genStatus');

  // ── Utilitaires ──────────────────────────────────────────────────────
  function showStatus(type, msg) {
    genStatus.className = 'status show ' + type;
    genStatus.textContent = msg;
  }

  function activeFields() {
    return FIELDS.filter((f) => {
      const box = el('field_' + f.key);
      return box && box.checked;
    });
  }

  // ── Champs dynamiques (colonnes source / destination) ────────────────
  function renderExcelColFields() {
    excelColFields.innerHTML = '';
    activeFields().forEach((f) => {
      const div = document.createElement('div');
      div.className = 'field';
      const label = document.createElement('label');
      label.textContent = 'Colonne — ' + f.label;
      label.htmlFor = 'srcCol_' + f.key;
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'srcCol_' + f.key;
      input.maxLength = 2;
      input.value = f.defaultSrcCol;
      div.append(label, input);
      excelColFields.appendChild(div);
    });
  }
  /** Un champ est "global" (une seule cellule fixe, ex: une remise unique du devis) si au
   *  moins une règle mot-clé le produit avec la case "Valeur globale" cochée. */
  function isGlobalField(key) {
    return state.keywordRules.some((r) => r.role === key && r.global);
  }

  function renderDestColFields() {
    destColFields.innerHTML = '';
    activeFields().forEach((f) => {
      const div = document.createElement('div');
      div.className = 'field';
      const label = document.createElement('label');
      label.textContent = 'Colonne — ' + f.label;
      label.htmlFor = 'mapCol_' + f.key;
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'mapCol_' + f.key;
      input.maxLength = 2;
      input.value = f.defaultDestCol;
      div.append(label, input);
      destColFields.appendChild(div);

      if (isGlobalField(f.key)) {
        const div2 = document.createElement('div');
        div2.className = 'field';
        const label2 = document.createElement('label');
        label2.textContent = 'Cellule fixe (optionnel) — ' + f.label;
        label2.htmlFor = 'mapCell_' + f.key;
        label2.title = "Laissez la colonne ci-contre pour répéter la valeur sur chaque ligne. Ne remplissez la cellule fixe que si votre modèle attend cette valeur à un seul endroit (ex : une formule qui s'applique à tout le tableau).";
        const input2 = document.createElement('input');
        input2.type = 'text';
        input2.id = 'mapCell_' + f.key;
        input2.maxLength = 6;
        input2.placeholder = 'ex : C3';
        div2.append(label2, input2);
        destColFields.appendChild(div2);
      }
    });
  }
  FIELDS.forEach((f) => {
    const box = el('field_' + f.key);
    if (box) {
      box.addEventListener('change', () => {
        renderExcelColFields();
        renderDestColFields();
        state.items = [];
        renderItems();
      });
    }
  });

  // ── Règles mot-clé (PDF) ───────────────────────────────────────────────
  function renderKeywordRules() {
    keywordRulesEl.innerHTML = '';
    state.keywordRules.forEach((rule, idx) => {
      const row = document.createElement('div');
      row.className = 'rule-row';

      const kwInput = document.createElement('input');
      kwInput.type = 'text';
      kwInput.placeholder = 'un mot court, ex : Voltage (pas la ligne entière)';
      kwInput.value = rule.keyword || '';
      kwInput.addEventListener('input', () => {
        rule.keyword = kwInput.value;
        refreshRawLinesHighlight();
      });

      const isNumericRole = (role) => ['qty', 'ht', 'ttc', 'remise'].includes(role);
      const isMultiMode = () => recordMode.value === 'multi';

      const roleSelect = document.createElement('select');
      ROLE_OPTIONS.forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.key;
        opt.textContent = r.label;
        roleSelect.appendChild(opt);
      });
      roleSelect.value = rule.role || 'ignore';
      roleSelect.addEventListener('change', () => {
        rule.role = roleSelect.value;
        splitLabel.hidden = rule.role !== 'desc_row';
        globalLabel.hidden = !isNumericRole(rule.role) || isMultiMode();
        divideLabel.hidden = !isNumericRole(rule.role);
        endsLabel.hidden = !isMultiMode() || !isNumericRole(rule.role);
        keepLabelLabel.hidden = !isLabelRole(rule.role);
        renderDestColFields();
      });

      const splitLabel = document.createElement('label');
      splitLabel.className = 'checkbox-line';
      splitLabel.style.flex = '0 0 auto';
      splitLabel.hidden = rule.role !== 'desc_row';
      const splitBox = document.createElement('input');
      splitBox.type = 'checkbox';
      splitBox.checked = !!rule.splitComma;
      splitBox.addEventListener('change', () => { rule.splitComma = splitBox.checked; });
      splitLabel.append(splitBox, document.createTextNode(' virgules'));

      const isLabelRole = (role) => role === 'desc' || role === 'desc_row';
      const keepLabelLabel = document.createElement('label');
      keepLabelLabel.className = 'checkbox-line';
      keepLabelLabel.style.flex = '0 0 auto';
      keepLabelLabel.title = "Écrit la ligne telle quelle (ex : « Type de mât : Triplex ») au lieu de retirer le mot-clé (« Triplex »)";
      keepLabelLabel.hidden = !isLabelRole(rule.role);
      const keepLabelBox = document.createElement('input');
      keepLabelBox.type = 'checkbox';
      keepLabelBox.checked = !!rule.keepLabel;
      keepLabelBox.addEventListener('change', () => { rule.keepLabel = keepLabelBox.checked; });
      keepLabelLabel.append(keepLabelBox, document.createTextNode(' garder l\'intitulé'));

      const globalLabel = document.createElement('label');
      globalLabel.className = 'checkbox-line';
      globalLabel.style.flex = '0 0 auto';
      globalLabel.title = 'Une seule valeur pour tout le devis (ex : une remise unique), au lieu d\'une valeur par ligne';
      globalLabel.hidden = !isNumericRole(rule.role) || isMultiMode();
      const globalBox = document.createElement('input');
      globalBox.type = 'checkbox';
      globalBox.checked = !!rule.global;
      globalBox.addEventListener('change', () => { rule.global = globalBox.checked; renderDestColFields(); });
      globalLabel.append(globalBox, document.createTextNode(' valeur globale'));

      const endsLabel = document.createElement('label');
      endsLabel.className = 'checkbox-line';
      endsLabel.style.flex = '0 0 auto';
      endsLabel.title = "Cette ligne marque la fin d'un chariot : dès qu'elle est détectée, le chariot en cours est bouclé sur sa propre feuille Excel et un nouveau chariot démarre à la ligne suivante.";
      endsLabel.hidden = !isMultiMode() || !isNumericRole(rule.role);
      const endsBox = document.createElement('input');
      endsBox.type = 'checkbox';
      endsBox.checked = !!rule.endsRecord;
      endsBox.addEventListener('change', () => { rule.endsRecord = endsBox.checked; });
      endsLabel.append(endsBox, document.createTextNode(' fin de chariot'));

      const divideLabel = document.createElement('label');
      divideLabel.className = 'checkbox-line';
      divideLabel.style.flex = '0 0 auto';
      divideLabel.title = 'Divise la valeur par 100 (ex : "42,40" devient 0,424 pour une cellule au format pourcentage)';
      divideLabel.hidden = !isNumericRole(rule.role);
      const divideBox = document.createElement('input');
      divideBox.type = 'checkbox';
      divideBox.checked = !!rule.divideBy100;
      divideBox.addEventListener('change', () => { rule.divideBy100 = divideBox.checked; });
      divideLabel.append(divideBox, document.createTextNode(' ÷100'));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        state.keywordRules.splice(idx, 1);
        renderKeywordRules();
        renderDestColFields();
      });

      row.append(kwInput, roleSelect, splitLabel, keepLabelLabel, globalLabel, divideLabel, endsLabel, delBtn);
      keywordRulesEl.appendChild(row);
    });
    refreshRawLinesHighlight();
  }
  btnAddKeywordRule.addEventListener('click', () => {
    state.keywordRules.push({ keyword: '', role: 'desc', splitComma: false, global: false, divideBy100: false, endsRecord: false, keepLabel: false });
    renderKeywordRules();
  });

  recordMode.addEventListener('change', () => {
    tableModeOptions.hidden = recordMode.value !== 'table';
    singleModeOptions.hidden = recordMode.value === 'table';
    multiModeHint.hidden = recordMode.value !== 'multi';
    renderKeywordRules();
  });

  // ── Tableau des résultats ───────────────────────────────────────────
  function renderItemsHeader() {
    itemsHeadRow.innerHTML = '';
    const thKeep = document.createElement('th');
    thKeep.style.width = '36px';
    itemsHeadRow.appendChild(thKeep);
    activeFields().forEach((f) => {
      const th = document.createElement('th');
      th.textContent = f.label;
      if (f.key !== 'desc') th.style.width = '120px';
      itemsHeadRow.appendChild(th);
    });
    const thDel = document.createElement('th');
    thDel.style.width = '40px';
    itemsHeadRow.appendChild(thDel);
  }

  function renderItems() {
    renderItemsHeader();
    itemsBody.innerHTML = '';
    const fields = activeFields();
    let lastFiche;

    state.items.forEach((item, idx) => {
      if (item._fiche !== undefined && item._fiche !== lastFiche) {
        lastFiche = item._fiche;
        const sep = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = fields.length + 2;
        td.style.cssText = 'font-weight:600; background:var(--paper-dim,#eee); padding:4px 8px;';
        td.textContent = `— Chariot ${item._fiche + 1} (feuille Excel séparée) —`;
        sep.appendChild(td);
        itemsBody.appendChild(sep);
      }
      const tr = document.createElement('tr');
      if (item.excluded) tr.classList.add('excluded');

      const tdKeep = document.createElement('td');
      const keepBox = document.createElement('input');
      keepBox.type = 'checkbox';
      keepBox.checked = !item.excluded;
      keepBox.title = 'Inclure cette ligne';
      keepBox.addEventListener('change', () => {
        item.excluded = !keepBox.checked;
        tr.classList.toggle('excluded', item.excluded);
        updateItemsCount();
      });
      tdKeep.appendChild(keepBox);
      tr.appendChild(tdKeep);

      fields.forEach((f) => {
        const td = document.createElement('td');
        if (f.numeric) td.className = 'num-cell';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = item[f.key] === undefined ? '' : item[f.key];
        input.addEventListener('input', () => { item[f.key] = input.value; });
        td.appendChild(input);
        tr.appendChild(td);
      });

      const tdDel = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = '✕';
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => {
        state.items.splice(idx, 1);
        renderItems();
      });
      tdDel.appendChild(delBtn);
      tr.appendChild(tdDel);

      itemsBody.appendChild(tr);
    });

    const hasItems = state.items.length > 0;
    itemsTable.hidden = !hasItems;
    itemsActions.hidden = !hasItems;
    updateItemsCount();
  }

  function updateItemsCount() {
    const kept = state.items.filter((i) => !i.excluded).length;
    itemsCount.textContent = `${kept} ligne(s) sélectionnée(s) sur ${state.items.length}`;
  }

  btnAddRow.addEventListener('click', () => {
    const row = { excluded: false };
    activeFields().forEach((f) => { row[f.key] = ''; });
    const last = state.items[state.items.length - 1];
    if (last && last._fiche !== undefined) row._fiche = last._fiche;
    state.items.push(row);
    renderItems();
  });

  // ── Aperçu des lignes brutes (PDF) ─────────────────────────────────────
  function suggestKeywordFromLine(line) {
    const m = line.match(/^(.*?)\s*:/);
    if (m && m[1].trim() && m[1].trim().length <= 40) return m[1].trim();
    return line.trim().split(/\s+/).slice(0, 2).join(' ');
  }

  /** Devine le rôle le plus probable pour une ligne cliquée, pour éviter le piège classique :
   *  laisser le rôle par défaut sur "Fusionner" alors que la ligne contient en fait un prix ou
   *  une remise, ce qui les ferait atterrir tels quels dans la désignation. */
  function suggestRoleFromLine(line) {
    if (/%/.test(line)) return 'remise';
    if (/\bTTC\b/i.test(line)) return 'ttc';
    if (/\bHT\b/i.test(line) || /\d[.,]\d{2}\s*(?:€|EUR)?\s*$/.test(line)) return 'ht';
    if (/^.{1,40}:/.test(line)) return 'desc_row';
    return 'desc';
  }

  function renderRawLinesPreview() {
    rawLinesPreview.innerHTML = '';
    state.pdfLines.forEach((line) => {
      const span = document.createElement('span');
      span.className = 'ln';
      span.textContent = line;
      span.title = 'Cliquer pour créer une règle mot-clé à partir de cette ligne';
      span.addEventListener('click', () => {
        const role = suggestRoleFromLine(line);
        const isPercent = role === 'remise';
        state.keywordRules.push({
          keyword: suggestKeywordFromLine(line),
          role,
          splitComma: /équipement/i.test(line),
          global: isPercent,
          divideBy100: isPercent,
          keepLabel: role === 'desc_row',
        });
        renderKeywordRules();
        const rows = keywordRulesEl.querySelectorAll('.rule-row');
        const last = rows[rows.length - 1];
        if (last) last.querySelector('select').focus();
        if (role !== 'desc') {
          showStatus('warn', `Règle créée avec le rôle « ${ROLE_OPTIONS.find(r => r.key === role)?.label} » (détecté automatiquement) — vérifiez qu'il convient avant d'enregistrer. Rappel : les lignes d'articles répétitives n'ont pas besoin de règle, elles sont déjà détectées automatiquement via « Tarif HT »/« Tarif TTC » ci-dessus.`);
        }
      });
      rawLinesPreview.appendChild(span);
    });
    refreshRawLinesHighlight();
  }

  function refreshRawLinesHighlight() {
    if (!rawLinesPreview.children.length) return;
    const keywords = state.keywordRules.map((r) => r.keyword).filter((k) => k && k.trim());
    Array.from(rawLinesPreview.children).forEach((span, i) => {
      const line = state.pdfLines[i] || span.textContent;
      const hit = keywords.some((kw) => Engine.keywordMatches(line, kw, state.pdfLines));
      span.classList.toggle('hit', hit);
    });
  }

  // ── Import du devis d'exemple ───────────────────────────────────────────
  sourceFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    genStatus.className = 'status';
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'pdf') {
      state.sourceKind = 'pdf';
      state.sourceFile = file;
      const buf = await file.arrayBuffer();
      state.pdfLines = await Engine.getPdfLines(buf);
      renderRawLinesPreview();
      excelOptions.hidden = true;
      cesabPanel.hidden = true;
      pdfTrainPanel.hidden = false;
    } else if (isCesabSource.checked) {
      state.sourceKind = 'cesab';
      const buf = await file.arrayBuffer();
      state.sourceWorkbook = XLSX.read(buf, { type: 'array' });
      pdfTrainPanel.hidden = true;
      excelOptions.hidden = true;
      cesabPanel.hidden = false;

      FIELDS.forEach((f) => {
        const box = el('field_' + f.key);
        if (box) box.checked = (f.key === 'desc' || f.key === 'ht');
      });

      const result = Engine.parseCesabExcel(state.sourceWorkbook);
      if (!result) {
        showStatus('err', "Impossible d'analyser ce fichier — vérifiez qu'il s'agit bien d'un rapport CESAB (T-Order).");
        state.items = [];
      } else {
        state.items = result.items;
        showStatus('ok', `Référence : ${result.ref || '?'} — Tarif global : ${result.globalPrice ?? '?'} — ${result.items.length} ligne(s).`);
      }
      renderDestColFields();
      renderItems();
    } else {
      state.sourceKind = 'excel';
      const buf = await file.arrayBuffer();
      state.sourceWorkbook = XLSX.read(buf, { type: 'array' });
      sourceSheet.innerHTML = '';
      state.sourceWorkbook.SheetNames.forEach((n) => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        sourceSheet.appendChild(opt);
      });
      pdfTrainPanel.hidden = true;
      cesabPanel.hidden = true;
      excelOptions.hidden = false;
      renderExcelColFields();
    }
  });

  btnExtractExcel.addEventListener('click', () => {
    const fields = activeFields();
    if (!fields.length) { showStatus('err', 'Cochez au moins un champ à extraire.'); return; }
    const cols = {};
    fields.forEach((f) => { cols[f.key] = el('srcCol_' + f.key).value; });
    if (fields.some((f) => !Engine.colToIndex(cols[f.key]))) {
      showStatus('err', 'Indiquez une colonne (lettre) pour chaque champ coché.');
      return;
    }
    const config = {
      sheetName: sourceSheet.value,
      startRow: parseInt(srcStartRow.value, 10) || 1,
      endRow: srcEndRow.value.trim() ? parseInt(srcEndRow.value, 10) : null,
      fields,
      cols,
    };
    const { items, error } = Engine.extractExcel(state.sourceWorkbook, config);
    if (error) { showStatus('err', error); return; }
    state.items = items;
    renderItems();
    showStatus(items.length ? 'ok' : 'warn',
      items.length ? `${items.length} ligne(s) extraite(s).`
                   : 'Aucune ligne trouvée dans la plage indiquée. Vérifiez la feuille et les colonnes.');
  });

  function buildPdfConfigFromForm() {
    return {
      recordMode: recordMode.value,
      excludeTotals: excludeTotals.checked,
      boundStart: boundStart.value.trim(),
      boundEnd: boundEnd.value.trim(),
      generic: { ht: generic_ht.checked, ttc: generic_ttc.checked },
      stripTrailingQty: stripTrailingQty.checked,
      captureBullets: captureBullets.checked,
      bulletMarker: bulletMarker.value.trim() || '-',
      keywordRules: state.keywordRules.filter((r) => r.keyword && r.role !== 'ignore'),
      allFieldKeys: FIELDS.map((f) => f.key),
    };
  }

  function runPdfExtraction(cfg) {
    const usedKeys = Engine.usedFieldKeys(cfg);
    FIELDS.forEach((f) => {
      const box = el('field_' + f.key);
      if (box) box.checked = usedKeys.has(f.key);
    });
    renderExcelColFields();
    renderDestColFields();

    if (cfg.recordMode === 'multi') {
      const { fiches } = Engine.applyMultiFicheRules(state.pdfLines, cfg);
      state.documentFields = {};
      const items = [];
      fiches.forEach((ficheItems, fi) => {
        ficheItems.forEach((it) => { it._fiche = fi; items.push(it); });
      });
      return items;
    }

    const { items, documentFields } = Engine.applyPdfRules(state.pdfLines, cfg);
    state.documentFields = documentFields;
    return items;
  }

  function documentFieldsSummary() {
    const entries = Object.entries(state.documentFields || {});
    if (!entries.length) return '';
    const parts = entries.map(([k, v]) => {
      const f = FIELDS.find((x) => x.key === k);
      return `${f ? f.label : k} = ${v}`;
    });
    return ` Valeur(s) globale(s) détectée(s) : ${parts.join(', ')}.`;
  }

  btnTestRules.addEventListener('click', () => {
    if (!state.pdfLines.length) { showStatus('err', 'Importez un devis exemple ci-dessus.'); return; }
    const cfg = buildPdfConfigFromForm();
    const items = runPdfExtraction(cfg);
    state.items = items;
    renderItems();
    if (cfg.recordMode === 'multi') {
      const nbFiches = new Set(items.map((it) => it._fiche)).size;
      showStatus(items.length ? 'ok' : 'warn',
        items.length ? `${nbFiches} chariot(s) détecté(s), ${items.length} ligne(s) au total.`
                     : "Aucun chariot détecté. Vérifiez que la règle « fin de chariot » est bien cochée sur la bonne ligne.");
      return;
    }
    showStatus(items.length ? 'ok' : 'warn',
      (items.length ? `${items.length} ligne(s) détectée(s) avec ces règles.`
                    : "Aucune ligne détectée. Ajoutez des règles mot-clé ou ajustez les bornes du tableau.")
      + documentFieldsSummary());
  });

  // ── Modèle Excel de destination ────────────────────────────────────────
  templateFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.templateFile = file;
    const buf = await file.arrayBuffer();
    state.templateArrayBuffer = buf;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    templateSheet.innerHTML = '';
    wb.worksheets.forEach((ws) => {
      const opt = document.createElement('option');
      opt.value = ws.name;
      opt.textContent = ws.name;
      templateSheet.appendChild(opt);
    });
  });

  enableDuplicate.addEventListener('change', () => {
    dupFields.hidden = !enableDuplicate.checked;
  });

  // ── Test de génération ──────────────────────────────────────────────────
  function gatherDestCols(fields) {
    return fields.map((f) => ({
      ...f,
      col: (el('mapCol_' + f.key)?.value || '').trim().toUpperCase(),
    })).filter((f) => f.col);
  }
  function gatherFixedCells(fields) {
    const cells = {};
    fields.filter((f) => isGlobalField(f.key)).forEach((f) => {
      const val = (el('mapCell_' + f.key)?.value || '').trim().toUpperCase();
      if (val) cells[f.key] = val;
    });
    return cells;
  }

  btnGenerate.addEventListener('click', async () => {
    if (!state.templateArrayBuffer) { showStatus('err', "Importez d'abord le modèle Excel (étape 2)."); return; }
    const fields = activeFields();
    const included = state.items.filter((i) => {
      if (i.excluded) return false;
      return fields.some((f) => String(i[f.key] ?? '').trim());
    });
    if (!included.length) { showStatus('err', "Aucune ligne à insérer. Testez l'étape 1 d'abord."); return; }

    const startRow = parseInt(mapStartRow.value, 10);
    if (!startRow) { showStatus('err', "Vérifiez la ligne de départ à l'étape 2."); return; }
    const destCols = gatherDestCols(fields);
    const fixedCells = gatherFixedCells(fields);
    if (!destCols.length && !Object.values(fixedCells).some(Boolean)) {
      showStatus('err', "Indiquez au moins une colonne ou cellule de destination à l'étape 2."); return;
    }

    btnGenerate.disabled = true;
    try {
      if (state.sourceKind === 'pdf' && recordMode.value === 'multi') {
        const groups = {};
        included.forEach((it) => { const k = it._fiche ?? 0; (groups[k] = groups[k] || []).push(it); });
        const fiches = Object.keys(groups).sort((a, b) => a - b).map((k) => groups[k]);
        const { buffer, warning } = await Engine.generateExcelMulti(state.templateArrayBuffer, {
          sheetName: templateSheet.value,
          startRow,
          destCols,
          fiches,
          sheetNameField: 'desc',
          enableDuplicate: enableDuplicate.checked,
          dupModelRow: dupModelRow.value,
          dupLastRow: dupLastRow.value,
        });
        Engine.downloadBuffer(buffer, outFileName.value.trim() || 'Feuille de calcul.xlsx');
        showStatus('ok', `Test : ${fiches.length} chariot(s), ${included.length} ligne(s) au total.${warning}`);
        return;
      }
      const { buffer, warning } = await Engine.generateExcel(state.templateArrayBuffer, {
        sheetName: templateSheet.value,
        startRow,
        destCols,
        items: included,
        documentFields: state.documentFields,
        fixedCells,
        enableDuplicate: enableDuplicate.checked,
        dupModelRow: dupModelRow.value,
        dupLastRow: dupLastRow.value,
      });
      Engine.downloadBuffer(buffer, outFileName.value.trim() || 'Feuille de calcul.xlsx');
      showStatus('ok', `Test : ${included.length} ligne(s) insérée(s).${warning}`);
    } catch (err) {
      console.error(err);
      showStatus('err', 'Erreur lors du test : ' + err.message);
    } finally {
      btnGenerate.disabled = false;
    }
  });

  // ── Enregistrement dans Supabase ────────────────────────────────────────
  function slugify(name) {
    return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
  }

  btnSaveTool.addEventListener('click', async () => {
    const name = toolName.value.trim();
    if (!name) { showStatus('err', "Donnez un nom à l'outil."); return; }
    if (!state.sourceKind) { showStatus('err', "Importez un devis d'exemple (étape 1)."); return; }

    const fields = activeFields();
    const config = { sourceType: state.sourceKind };

    if (state.sourceKind === 'pdf') {
      const cfg = buildPdfConfigFromForm();
      config.pdfConfig = {
        recordMode: cfg.recordMode,
        excludeTotals: cfg.excludeTotals,
        boundStart: cfg.boundStart,
        boundEnd: cfg.boundEnd,
        generic: cfg.generic,
        stripTrailingQty: cfg.stripTrailingQty,
        captureBullets: cfg.captureBullets,
        bulletMarker: cfg.bulletMarker,
        keywordRules: state.keywordRules.filter((r) => r.keyword),
      };
    } else if (state.sourceKind === 'cesab') {
      // Rien à configurer : la structure du rapport CESAB est fixe (voir Engine.parseCesabExcel).
    } else {
      const cols = {};
      fields.forEach((f) => { cols[f.key] = el('srcCol_' + f.key).value; });
      config.excelConfig = {
        fieldKeys: fields.map((f) => f.key),
        startRow: srcStartRow.value,
        endRow: srcEndRow.value,
        cols,
      };
    }

    config.mapping = {
      templateSheetName: templateSheet.value || '',
      mapStartRow: mapStartRow.value,
      mapCols: (() => {
        const m = {};
        gatherDestCols(fields).forEach((f) => { m[f.key] = f.col; });
        return m;
      })(),
      fixedCells: gatherFixedCells(fields),
      enableDuplicate: enableDuplicate.checked,
      dupModelRow: dupModelRow.value,
      dupLastRow: dupLastRow.value,
      outFileName: outFileName.value,
    };

    btnSaveTool.disabled = true;
    try {
      let toolId = state.toolId;
      if (toolId) {
        const { error } = await supabaseClient.from('tools').update({
          name, description: toolDescription.value.trim(), config, updated_at: new Date().toISOString(),
        }).eq('id', toolId);
        if (error) throw error;
      } else {
        const { data, error } = await supabaseClient.from('tools').insert({
          name, description: toolDescription.value.trim(), config, slug: slugify(name),
        }).select().single();
        if (error) throw error;
        toolId = data.id;
        state.toolId = toolId;
      }

      if (state.templateFile) {
        const { error: upErr } = await supabaseClient.storage.from('templates')
          .upload(`${toolId}/template.xlsx`, state.templateFile, { upsert: true });
        if (upErr) throw upErr;
        await supabaseClient.from('tools').update({ template_path: `${toolId}/template.xlsx` }).eq('id', toolId);
      }

      showStatus('ok', `Outil « ${name} » enregistré. Retournez à l'admin pour donner l'accès à une entreprise.`);
      history.replaceState(null, '', `import-devis.html?tool=${toolId}`);
      pageTitle.textContent = `Modifier : ${name}`;
    } catch (err) {
      console.error(err);
      showStatus('err', "Erreur lors de l'enregistrement : " + err.message);
    } finally {
      btnSaveTool.disabled = false;
    }
  });

  // ── Chargement d'un outil existant ──────────────────────────────────────
  async function loadExistingTool() {
    const { data: tool, error } = await supabaseClient.from('tools').select('*').eq('id', state.toolId).single();
    if (error || !tool) { showStatus('err', 'Outil introuvable.'); return; }

    toolName.value = tool.name || '';
    toolDescription.value = tool.description || '';
    pageTitle.textContent = `Modifier : ${tool.name}`;

    const cfg = tool.config || {};
    state.sourceKind = cfg.sourceType || null;

    if (cfg.sourceType === 'pdf' && cfg.pdfConfig) {
      pdfTrainPanel.hidden = false;
      recordMode.value = cfg.pdfConfig.recordMode || 'table';
      tableModeOptions.hidden = recordMode.value !== 'table';
      singleModeOptions.hidden = recordMode.value === 'table';
      multiModeHint.hidden = recordMode.value !== 'multi';
      excludeTotals.checked = cfg.pdfConfig.excludeTotals !== false;
      boundStart.value = cfg.pdfConfig.boundStart || '';
      boundEnd.value = cfg.pdfConfig.boundEnd || '';
      generic_ht.checked = !!(cfg.pdfConfig.generic && cfg.pdfConfig.generic.ht);
      generic_ttc.checked = !!(cfg.pdfConfig.generic && cfg.pdfConfig.generic.ttc);
      stripTrailingQty.checked = !!cfg.pdfConfig.stripTrailingQty;
      captureBullets.checked = !!cfg.pdfConfig.captureBullets;
      bulletMarker.value = cfg.pdfConfig.bulletMarker || '-';
      state.keywordRules = (cfg.pdfConfig.keywordRules || []).map((r) => ({ ...r }));
      renderKeywordRules();

      const usedKeys = Engine.usedFieldKeys({ ...cfg.pdfConfig, keywordRules: state.keywordRules });
      FIELDS.forEach((f) => {
        const box = el('field_' + f.key);
        if (box) box.checked = usedKeys.has(f.key);
      });
      renderExcelColFields();

      showStatus('warn', 'Importez à nouveau un devis exemple ci-dessus pour tester vos modifications.');
    } else if (cfg.sourceType === 'cesab') {
      isCesabSource.checked = true;
      cesabPanel.hidden = false;
      FIELDS.forEach((f) => {
        const box = el('field_' + f.key);
        if (box) box.checked = (f.key === 'desc' || f.key === 'ht');
      });
      renderDestColFields();
      showStatus('warn', 'Importez à nouveau un devis exemple CESAB ci-dessus pour tester.');
    } else if (cfg.sourceType === 'excel' && cfg.excelConfig) {
      excelOptions.hidden = false;
      srcStartRow.value = cfg.excelConfig.startRow || 2;
      srcEndRow.value = cfg.excelConfig.endRow || '';
      FIELDS.forEach((f) => {
        const box = el('field_' + f.key);
        if (box) box.checked = (cfg.excelConfig.fieldKeys || []).includes(f.key);
      });
      renderExcelColFields();
      Object.entries(cfg.excelConfig.cols || {}).forEach(([k, v]) => {
        const input = el('srcCol_' + k);
        if (input) input.value = v;
      });
    }

    if (cfg.mapping) {
      const m = cfg.mapping;
      mapStartRow.value = m.mapStartRow || 2;
      renderDestColFields();
      Object.entries(m.mapCols || {}).forEach(([key, val]) => {
        const input = el('mapCol_' + key);
        if (input) input.value = val;
      });
      Object.entries(m.fixedCells || {}).forEach(([key, val]) => {
        const input = el('mapCell_' + key);
        if (input) input.value = val;
      });
      enableDuplicate.checked = !!m.enableDuplicate;
      dupFields.hidden = !enableDuplicate.checked;
      dupModelRow.value = m.dupModelRow || '';
      dupLastRow.value = m.dupLastRow || '';
      outFileName.value = m.outFileName || 'Feuille de calcul.xlsx';
    }

    if (tool.template_path) {
      showStatus('warn', 'Un modèle Excel est déjà enregistré pour cet outil. Réimportez-le seulement si vous voulez le remplacer.');
    }
  }

  // ── Init ────────────────────────────────────────────────────────────
  (async function init() {
    const session = await requireSession('../pages/login.html');
    if (!session) return;
    const profile = await loadCurrentProfile();
    if (!profile || !profile.is_admin) { window.location.href = '../pages/login.html'; return; }

    renderNavAccount('navAccount', '../pages/');
    renderExcelColFields();
    renderDestColFields();
    renderItemsHeader();
    renderKeywordRules();

    if (state.toolId) await loadExistingTool();
  })();
})();

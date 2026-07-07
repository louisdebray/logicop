/* Logicop — page client : importer un devis et générer le fichier avec un outil déjà entraîné
   par l'administrateur. Aucune règle n'est visible ni modifiable ici. */

(function () {
  'use strict';

  const Engine = window.DevisEngine;
  const el = (id) => document.getElementById(id);

  const toolTitle = el('toolTitle');
  const toolBrandLogo = el('toolBrandLogo');
  const toolDesc = el('toolDesc');
  const notFoundStep = el('notFoundStep');
  const mainSteps = el('mainSteps');
  const sourceFile = el('sourceFile');
  const passwordField = el('passwordField');
  const filePassword = el('filePassword');
  const extractStatus = el('extractStatus');
  const itemsTable = el('itemsTable');
  const itemsHeadRow = el('itemsHeadRow');
  const itemsBody = el('itemsBody');
  const itemsActions = el('itemsActions');
  const itemsCount = el('itemsCount');
  const btnAddRow = el('btnAddRow');
  const outFileName = el('outFileName');
  const btnGenerate = el('btnGenerate');
  const genStatus = el('genStatus');

  const state = {
    tool: null,
    templateArrayBuffer: null,
    fields: [],
    items: [],
    documentFields: {},
  };

  function showExtractStatus(type, msg) {
    extractStatus.className = 'status show ' + type;
    extractStatus.textContent = msg;
  }
  function showGenStatus(type, msg) {
    genStatus.className = 'status show ' + type;
    genStatus.textContent = msg;
  }

  // ── Tableau des résultats ───────────────────────────────────────────
  function renderItemsHeader() {
    itemsHeadRow.innerHTML = '';
    const thKeep = document.createElement('th');
    thKeep.style.width = '36px';
    itemsHeadRow.appendChild(thKeep);
    state.fields.forEach((f) => {
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
    const bydDoubtPanel = el('bydDoubtPanel');
    const bydDoubtList = el('bydDoubtList');
    if (bydDoubtPanel) { bydDoubtPanel.hidden = true; bydDoubtList.innerHTML = ''; }
    let lastFiche;
    const doubtItems = [];
    state.items.forEach((item, idx) => {
      if (item._fiche !== undefined && item._fiche !== lastFiche) {
        lastFiche = item._fiche;
        const sep = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = state.fields.length + 2;
        td.style.cssText = 'font-weight:600; background:var(--paper-dim,#eee); padding:4px 8px;';
        td.textContent = `— Chariot ${item._fiche + 1} (feuille Excel séparée) —`;
        sep.appendChild(td);
        itemsBody.appendChild(sep);
      }
      const tr = document.createElement('tr');
      if (item.excluded) tr.classList.add('excluded');
      if (item._doubt) tr.style.background = '#fff3e0';

      const tdKeep = document.createElement('td');
      const keepBox = document.createElement('input');
      keepBox.type = 'checkbox';
      keepBox.checked = !item.excluded;
      keepBox.addEventListener('change', () => {
        item.excluded = !keepBox.checked;
        tr.classList.toggle('excluded', item.excluded);
        updateItemsCount();
      });
      tdKeep.appendChild(keepBox);
      tr.appendChild(tdKeep);

      state.fields.forEach((f) => {
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
      if (item._doubt) doubtItems.push({ item, idx, keepBox, tr });
    });

    // Panneau options BYD — regroupées par catégorie
    if (bydDoubtPanel && doubtItems.length > 0) {
      bydDoubtPanel.hidden = false;
      let lastCat = '';
      doubtItems.forEach(({ item, keepBox, tr }) => {
        if (item._catLabel && item._catLabel !== lastCat) {
          lastCat = item._catLabel;
          const catHead = document.createElement('div');
          catHead.style.cssText = 'font-weight:600; font-size:0.85rem; margin-top:8px; color:#e65100;';
          catHead.textContent = item._catLabel;
          bydDoubtList.appendChild(catHead);
        }
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; padding-left:12px;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !item.excluded;
        cb.addEventListener('change', () => {
          item.excluded = !cb.checked;
          keepBox.checked = cb.checked;
          tr.classList.toggle('excluded', item.excluded);
          updateItemsCount();
        });
        const label = document.createElement('span');
        label.style.fontSize = '0.9rem';
        label.textContent = item.desc || '';
        row.appendChild(cb);
        row.appendChild(label);
        bydDoubtList.appendChild(row);
      });
    }

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
    state.fields.forEach((f) => { row[f.key] = ''; });
    const last = state.items[state.items.length - 1];
    if (last && last._fiche !== undefined) row._fiche = last._fiche;
    state.items.push(row);
    renderItems();
  });

  // ── Extraction ──────────────────────────────────────────────────────
  sourceFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showExtractStatus('', '');
    extractStatus.className = 'status';
    const ext = file.name.split('.').pop().toLowerCase();
    const cfg = state.tool.config;

    try {
      if (ext === 'pdf' && cfg.sourceType === 'ep') {
        const buf = await file.arrayBuffer();
        const lines = await Engine.getPdfLines(buf);
        state.fields = Engine.FIELDS.filter((f) => f.key === 'desc' || f.key === 'ht');
        const result = Engine.parseEpPdf(lines);
        if (!result || !result.items.length) { showExtractStatus('err', "Aucune ligne détectée — vérifiez qu'il s'agit bien d'un devis EP."); return; }
        state.items = result.items;
      } else if (ext === 'pdf') {
        if (cfg.sourceType !== 'pdf') { showExtractStatus('err', 'Cet outil attend un fichier Excel/CSV, pas un PDF.'); return; }
        const buf = await file.arrayBuffer();
        const lines = await Engine.getPdfLines(buf);
        const ruleCfg = {
          recordMode: cfg.pdfConfig.recordMode,
          excludeTotals: cfg.pdfConfig.excludeTotals,
          boundStart: cfg.pdfConfig.boundStart,
          boundEnd: cfg.pdfConfig.boundEnd,
          generic: cfg.pdfConfig.generic || {},
          captureBullets: cfg.pdfConfig.captureBullets,
          bulletMarker: cfg.pdfConfig.bulletMarker,
          keywordRules: cfg.pdfConfig.keywordRules || [],
          allFieldKeys: Engine.FIELDS.map((f) => f.key),
        };
        const usedKeys = Engine.usedFieldKeys(ruleCfg);
        state.fields = Engine.FIELDS.filter((f) => usedKeys.has(f.key));
        if (ruleCfg.recordMode === 'multi') {
          const { fiches } = Engine.applyMultiFicheRules(lines, ruleCfg);
          state.items = [];
          fiches.forEach((ficheItems, fi) => {
            ficheItems.forEach((it) => { it._fiche = fi; state.items.push(it); });
          });
          state.documentFields = {};
        } else {
          const result = Engine.applyPdfRules(lines, ruleCfg);
          state.items = result.items;
          state.documentFields = result.documentFields;
        }
      } else if (cfg.sourceType === 'cesab') {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        state.fields = Engine.FIELDS.filter((f) => f.key === 'desc' || f.key === 'ht');
        const result = Engine.parseCesabExcel(wb);
        if (!result) { showExtractStatus('err', "Impossible d'analyser ce fichier — vérifiez qu'il s'agit bien d'un rapport CESAB (T-Order)."); return; }
        state.items = result.items;
      } else if (cfg.sourceType === 'byd') {
        const pwd = filePassword.value.trim();
        if (!pwd) { showExtractStatus('err', 'Saisissez le mot de passe du fichier.'); return; }
        const buf = await file.arrayBuffer();
        let wb;
        try {
          const decrypted = await window.decryptOfficeFile(buf, pwd);
          wb = XLSX.read(new Uint8Array(decrypted), { type: 'array' });
        } catch (e) {
          console.error('BYD decrypt error:', e);
          showExtractStatus('err', 'Impossible de déchiffrer le fichier : ' + (e.message || e));
          return;
        }
        state.fields = Engine.FIELDS.filter((f) => f.key === 'desc' || f.key === 'ht');
        const result = Engine.parseBydExcel(wb);
        if (!result || !result.items.length) { showExtractStatus('err', "Impossible d'analyser ce fichier — vérifiez qu'il s'agit bien d'un formulaire BYD."); return; }
        state.items = result.items;
      } else {
        if (cfg.sourceType !== 'excel') { showExtractStatus('err', 'Cet outil attend un fichier PDF, pas un Excel/CSV.'); return; }
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const fields = Engine.FIELDS.filter((f) => (cfg.excelConfig.fieldKeys || []).includes(f.key));
        state.fields = fields;
        const config = {
          sheetName: wb.SheetNames[0],
          startRow: parseInt(cfg.excelConfig.startRow, 10) || 1,
          endRow: cfg.excelConfig.endRow ? parseInt(cfg.excelConfig.endRow, 10) : null,
          fields,
          cols: cfg.excelConfig.cols || {},
        };
        const { items, error } = Engine.extractExcel(wb, config);
        if (error) { showExtractStatus('err', error); return; }
        state.items = items;
      }

      renderItems();
      if (cfg.sourceType === 'byd' && state.items.some((i) => i._doubt)) {
        showExtractStatus('warn',
          `Cochez les options correspondant au devis dans le panneau ci-dessous. Le modèle et le prix sont déjà remplis.`);
      } else if (cfg.sourceType === 'pdf' && cfg.pdfConfig.recordMode === 'multi') {
        const nbFiches = new Set(state.items.map((it) => it._fiche)).size;
        showExtractStatus(state.items.length ? 'ok' : 'warn',
          state.items.length ? `${nbFiches} chariot(s) détecté(s) — chacun sera généré sur sa propre feuille Excel.`
                              : 'Aucun chariot détecté dans ce devis.');
      } else {
        showExtractStatus(state.items.length ? 'ok' : 'warn',
          state.items.length ? `${state.items.length} ligne(s) détectée(s). Vérifiez avant de générer.`
                              : 'Aucune ligne détectée dans ce devis. Vérifiez le fichier ou ajoutez des lignes manuellement.');
      }
    } catch (err) {
      console.error(err);
      showExtractStatus('err', "Erreur lors de la lecture du fichier : " + err.message);
    }
  });

  // ── Génération ──────────────────────────────────────────────────────
  btnGenerate.addEventListener('click', async () => {
    if (!state.templateArrayBuffer) { showGenStatus('err', 'Modèle Excel introuvable pour cet outil. Contactez Logicop.'); return; }
    const included = state.items.filter((i) => {
      if (i.excluded) return false;
      return state.fields.some((f) => String(i[f.key] ?? '').trim());
    });
    if (!included.length) { showGenStatus('err', "Aucune ligne à insérer. Importez un devis à l'étape 1."); return; }

    const mapping = state.tool.config.mapping || {};
    const startRow = parseInt(mapping.mapStartRow, 10) || 2;
    const fixedCells = mapping.fixedCells || {};
    const destCols = state.fields
      .map((f) => ({ ...f, col: (mapping.mapCols && mapping.mapCols[f.key] || '').trim().toUpperCase() }))
      .filter((f) => f.col);

    if (!destCols.length && !Object.values(fixedCells).some(Boolean)) {
      showGenStatus('err', 'Ce modèle Excel ne semble pas configuré correctement. Contactez Logicop.'); return;
    }

    btnGenerate.disabled = true;
    try {
      const cfg = state.tool.config;
      if (cfg.sourceType === 'pdf' && cfg.pdfConfig.recordMode === 'multi') {
        const groups = {};
        included.forEach((it) => { const k = it._fiche ?? 0; (groups[k] = groups[k] || []).push(it); });
        const fiches = Object.keys(groups).sort((a, b) => a - b).map((k) => groups[k]);
        const { buffer, warning } = await Engine.generateExcelMulti(state.templateArrayBuffer, {
          sheetName: mapping.templateSheetName,
          startRow,
          destCols,
          fiches,
          sheetNameField: 'desc',
          enableDuplicate: mapping.enableDuplicate,
          dupModelRow: mapping.dupModelRow,
          dupLastRow: mapping.dupLastRow,
        });
        Engine.downloadBuffer(buffer, outFileName.value.trim() || 'Feuille de calcul.xlsx');
        showGenStatus('ok', `${fiches.length} chariot(s) générés sur des feuilles séparées.${warning}`);
        return;
      }
      const { buffer, warning } = await Engine.generateExcel(state.templateArrayBuffer, {
        sheetName: mapping.templateSheetName,
        startRow,
        destCols,
        items: included,
        documentFields: state.documentFields,
        fixedCells,
        enableDuplicate: mapping.enableDuplicate,
        dupModelRow: mapping.dupModelRow,
        dupLastRow: mapping.dupLastRow,
      });
      Engine.downloadBuffer(buffer, outFileName.value.trim() || 'Feuille de calcul.xlsx');
      showGenStatus('ok', `${included.length} ligne(s) insérée(s) avec succès.${warning}`);
    } catch (err) {
      console.error(err);
      showGenStatus('err', 'Erreur lors de la génération : ' + err.message);
    } finally {
      btnGenerate.disabled = false;
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

    state.tool = tool;
    toolTitle.textContent = tool.name;
    toolDesc.textContent = tool.description || '';
    const BRAND_LOGOS = [
      { match: /hangcha/i, src: '../assets/img/logo.hangcha.png' },
      { match: /mitsubishi/i, src: '../assets/img/logo.mitsubishi.png' },
      { match: /cesab/i, src: '../assets/img/logo.cesab.png' },
      { match: /\bep\b/i, src: '../assets/img/logo.ep.png' },
      { match: /byd/i, src: '../assets/img/logo.byd.png' },
    ];
    const brand = BRAND_LOGOS.find((b) => b.match.test(tool.name) || b.match.test(tool.description || ''));
    if (brand) {
      toolBrandLogo.src = brand.src;
      toolBrandLogo.hidden = false;
    }
    if ((tool.config || {}).sourceType === 'byd') passwordField.style.display = '';
    const brandMatch = (tool.name + ' ' + (tool.description || '')).match(/hangcha|mitsubishi|cesab|\bep\b|byd/i);
    const brandName = brandMatch ? brandMatch[0].toUpperCase() : '';
    const defaultFileName = brandName ? `Feuille de calcul - ${brandName}.xlsx` : '';
    outFileName.value = (tool.config.mapping && tool.config.mapping.outFileName) || defaultFileName;

    if (tool.template_path) {
      const { data: blob, error: dlErr } = await supabaseClient.storage.from('templates').download(tool.template_path);
      if (dlErr) {
        showGenStatus('err', "Impossible de charger le modèle Excel de cet outil. Contactez Logicop.");
      } else {
        state.templateArrayBuffer = await blob.arrayBuffer();
      }
    }

    mainSteps.hidden = false;
  })();
})();

/* Logicop — page d'administration : entreprises (membres + accès), outils. */

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const newCompanyName = el('newCompanyName');
  const btnAddCompany = el('btnAddCompany');
  const companiesBody = el('companiesBody');

  const companyDetailStep = el('companyDetailStep');
  const companyDetailName = el('companyDetailName');
  const membersBody = el('membersBody');
  const membersEmpty = el('membersEmpty');
  const pendingBody = el('pendingBody');
  const pendingEmpty = el('pendingEmpty');
  const companyToolGrants = el('companyToolGrants');
  const noToolsHint = el('noToolsHint');

  const toolsList = el('toolsList');
  const toolsEmpty = el('toolsEmpty');
  const btnNewCapaciteResiduelle = el('btnNewCapaciteResiduelle');
  const btnNewTransport = el('btnNewTransport');
  const btnNewEp = el('btnNewEp');
  const btnNewByd = el('btnNewByd');


  const btnNewDocuments = el('btnNewDocuments');
  const btnNewQrcode = el('btnNewQrcode');
  const btnNewCoefficient = el('btnNewCoefficient');

  let companies = [];
  let tools = [];
  let grants = []; // [{company_id, tool_id}]
  let selectedCompanyId = null;

  // ── Entreprises ──────────────────────────────────────────────────────
  async function loadCompanies() {
    const { data, error } = await supabaseClient.from('companies').select('*').order('name');
    if (error) { console.error(error); return; }
    companies = data || [];
    renderCompanies();
  }

  function renderCompanies() {
    companiesBody.innerHTML = '';
    companies.forEach((c) => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      if (c.id === selectedCompanyId) tr.style.background = 'var(--bg-soft)';

      const tdName = document.createElement('td');
      tdName.textContent = c.name;
      tr.addEventListener('click', () => selectCompany(c.id));

      const tdDel = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Supprimer l'entreprise « ${c.name} » ? Ses membres repasseront "en attente".`)) return;
        const { error } = await supabaseClient.from('companies').delete().eq('id', c.id);
        if (error) { alert(error.message); return; }
        if (selectedCompanyId === c.id) { selectedCompanyId = null; companyDetailStep.hidden = true; }
        await loadCompanies();
      });
      tdDel.appendChild(delBtn);

      tr.append(tdName, tdDel);
      companiesBody.appendChild(tr);
    });
  }

  btnAddCompany.addEventListener('click', async () => {
    const name = newCompanyName.value.trim();
    if (!name) return;
    const { data, error } = await supabaseClient.from('companies').insert({ name }).select().single();
    if (error) { alert(error.message); return; }
    newCompanyName.value = '';
    await loadCompanies();
    selectCompany(data.id);
  });

  // ── Détail d'une entreprise ──────────────────────────────────────────
  async function selectCompany(id) {
    selectedCompanyId = id;
    renderCompanies();
    const company = companies.find((c) => c.id === id);
    if (!company) return;

    companyDetailStep.hidden = false;
    companyDetailName.textContent = company.name;

    await Promise.all([loadMembers(), loadPending(), loadGrantsForDetail()]);
  }

  async function loadMembers() {
    const { data, error } = await supabaseClient
      .from('profiles').select('id, email, is_gestionnaire')
      .eq('company_id', selectedCompanyId);
    if (error) { console.error(error); return; }
    membersBody.innerHTML = '';
    membersEmpty.hidden = (data || []).length > 0;
    (data || []).forEach((p) => {
      const tr = document.createElement('tr');
      const tdEmail = document.createElement('td');
      tdEmail.textContent = p.email || p.id;

      const tdGestion = document.createElement('td');
      tdGestion.style.textAlign = 'center';
      if (!p.is_admin) {
        const gBox = document.createElement('input');
        gBox.type = 'checkbox';
        gBox.checked = !!p.is_gestionnaire;
        gBox.title = 'Rôle Gestion';
        gBox.addEventListener('change', async () => {
          const { error: e } = await supabaseClient.from('profiles')
            .update({ is_gestionnaire: gBox.checked }).eq('id', p.id);
          if (e) { alert(e.message); gBox.checked = !gBox.checked; }
        });
        tdGestion.appendChild(gBox);
      }

      const tdBtn = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'danger';
      btn.textContent = 'Retirer';
      btn.addEventListener('click', async () => {
        const { error: updErr } = await supabaseClient.from('profiles').update({ company_id: null }).eq('id', p.id);
        if (updErr) { alert(updErr.message); return; }
        await loadMembers();
        await loadPending();
      });
      tdBtn.appendChild(btn);
      tr.append(tdEmail, tdGestion, tdBtn);
      membersBody.appendChild(tr);
    });
  }

  async function loadPending() {
    const { data, error } = await supabaseClient
      .from('profiles').select('id, email')
      .is('company_id', null)
      .eq('is_admin', false);
    if (error) { console.error(error); return; }
    pendingBody.innerHTML = '';
    pendingEmpty.hidden = (data || []).length > 0;
    (data || []).forEach((p) => {
      const tr = document.createElement('tr');
      const tdEmail = document.createElement('td');
      tdEmail.textContent = p.email || p.id;
      const tdBtn = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = 'Assigner ici';
      btn.addEventListener('click', async () => {
        const { error: updErr } = await supabaseClient.from('profiles').update({ company_id: selectedCompanyId }).eq('id', p.id);
        if (updErr) { alert(updErr.message); return; }
        await loadMembers();
        await loadPending();
      });
      tdBtn.appendChild(btn);
      tr.append(tdEmail, tdBtn);
      pendingBody.appendChild(tr);
    });
  }

  function hasGrant(companyId, toolId) {
    return grants.some((g) => g.company_id === companyId && g.tool_id === toolId);
  }

  async function loadGrantsForDetail() {
    const { data, error } = await supabaseClient.from('access_grants').select('company_id, tool_id');
    if (error) { console.error(error); return; }
    grants = data || [];
    renderCompanyToolGrants();
  }

  function renderCompanyToolGrants() {
    companyToolGrants.innerHTML = '';
    noToolsHint.hidden = tools.length > 0;
    tools.forEach((tool) => {
      const label = document.createElement('label');
      label.className = 'checkbox-line';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = hasGrant(selectedCompanyId, tool.id);
      box.addEventListener('change', async () => {
        if (box.checked) {
          const { error } = await supabaseClient.from('access_grants').insert({ company_id: selectedCompanyId, tool_id: tool.id });
          if (error) { alert(error.message); box.checked = false; return; }
          grants.push({ company_id: selectedCompanyId, tool_id: tool.id });
        } else {
          const { error } = await supabaseClient.from('access_grants')
            .delete().eq('company_id', selectedCompanyId).eq('tool_id', tool.id);
          if (error) { alert(error.message); box.checked = true; return; }
          grants = grants.filter((g) => !(g.company_id === selectedCompanyId && g.tool_id === tool.id));
        }
      });
      label.append(box, document.createTextNode(' ' + tool.name));
      companyToolGrants.appendChild(label);
    });
  }

  // ── Outils ───────────────────────────────────────────────────────────
  async function loadTools() {
    const { data, error } = await supabaseClient.from('tools').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); return; }
    tools = data || [];
    renderTools();
    if (selectedCompanyId) renderCompanyToolGrants();
  }

  function renderTools() {
    toolsList.innerHTML = '';
    toolsEmpty.hidden = tools.length > 0;

    tools.forEach((tool) => {
      const card = document.createElement('div');
      card.className = 'step';
      card.style.marginBottom = '16px';

      const header = document.createElement('div');
      header.className = 'row';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'flex-start';

      const titleBox = document.createElement('div');
      const h3 = document.createElement('h3');
      h3.style.margin = '0 0 4px';
      h3.textContent = tool.name;
      const desc = document.createElement('p');
      desc.style.margin = '0';
      desc.style.color = 'var(--text-dim)';
      desc.style.fontSize = '0.85rem';
      desc.textContent = tool.description || '';
      titleBox.append(h3, desc);

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '8px';
      const appType = (tool.config || {}).appType;
    const isCapaciteResiduelle = appType === 'capacite_residuelle';
    const isTransport = appType === 'transport';
    const isQrcode = appType === 'qrcode_blg';
    const isDocuments = appType === 'documents';
    const isCoefficient = appType === 'coefficient';
    const isEtiquettes = appType === 'etiquettes_blg';
    const isRapport = appType === 'rapport_controle';
    const isEp = (tool.config || {}).sourceType === 'ep';
    const isByd = (tool.config || {}).sourceType === 'byd';
      let editLink;
      if (isDocuments) {
        editLink = document.createElement('a');
        editLink.className = 'btn secondary';
        editLink.style.textDecoration = 'none';
        editLink.href = `../outils/documents.html?tool=${tool.id}`;
        editLink.textContent = 'Configurer';
      } else if (isQrcode || isCapaciteResiduelle || isCoefficient || isEtiquettes || isRapport) {
        editLink = document.createElement('button');
        editLink.className = 'secondary';
        editLink.textContent = 'Renommer';
        editLink.addEventListener('click', async () => {
          const name = prompt('Nom de l\'outil :', tool.name);
          if (name === null) return;
          const description = prompt('Description (visible par le client) :', tool.description || '');
          if (description === null) return;
          const { error } = await supabaseClient.from('tools')
            .update({ name: name.trim(), description: description.trim(), updated_at: new Date().toISOString() })
            .eq('id', tool.id);
          if (error) { alert(error.message); return; }
          await loadTools();
        });
      } else if (isTransport) {
        editLink = document.createElement('a');
        editLink.className = 'btn secondary';
        editLink.style.textDecoration = 'none';
        editLink.href = `../outils/transport.html?tool=${tool.id}`;
        editLink.textContent = 'Configurer';
      } else {
        editLink = document.createElement('a');
        editLink.className = 'btn secondary';
        editLink.style.textDecoration = 'none';
        editLink.href = `../outils/import-devis.html?tool=${tool.id}`;
        editLink.textContent = 'Modifier';
      }
      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = 'Supprimer';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Supprimer l'outil « ${tool.name} » ?`)) return;
        await supabaseClient.storage.from('templates').remove([`${tool.id}/template.xlsx`]);
        const { error } = await supabaseClient.from('tools').delete().eq('id', tool.id);
        if (error) { alert(error.message); return; }
        await loadTools();
      });
      actions.append(editLink, delBtn);

      header.append(titleBox, actions);
      card.appendChild(header);
      toolsList.appendChild(card);
    });
  }

  function slugify(name) {
    return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
  }

  btnNewCapaciteResiduelle.addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Capacité résiduelle');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Estime la capacité résiduelle d\'un chariot à partir de sa fiche matériel.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { appType: 'capacite_residuelle' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  btnNewEp.addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Convertisseur EP');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Convertit les devis EP en feuille de calcul Excel.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { sourceType: 'ep' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  btnNewByd.addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Convertisseur BYD');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Convertit les formulaires de commande BYD en feuille de calcul Excel.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { sourceType: 'byd' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  btnNewTransport.addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Prix de transport');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Consultez le tarif de livraison par ville ou code postal.');
    if (description === null) return;
    const mapUrl = prompt('URL de la carte Google Maps (iframe embed) :',
      'https://www.google.com/maps/d/embed?mid=1Qe8nmZcNkW6UBvgFW_EimiDvM_FqGIY&ehbc=2E312F');

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { appType: 'transport', mapUrl: mapUrl || '', zones: [], postals: [] },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  btnNewQrcode.addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'QR Code BLG');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Extrait l\'étiquette QR code d\'un PDF en image PNG haute résolution.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { appType: 'qrcode_blg' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  btnNewCoefficient.addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Simulation coefficient');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Simulez les coefficients et loyers de location pour vos machines.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { appType: 'coefficient' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  el('btnNewEtiquettes').addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Étiquettes BLG');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Générez des étiquettes à partir de vos PDF.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { appType: 'etiquettes_blg' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  el('btnNewRapport').addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Rapport de contrôle');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Générez un rapport de contrôle Word à partir d\'un PDF.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { appType: 'rapport_controle' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  btnNewDocuments.addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Documents partagés');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Consultez et téléchargez les documents partagés.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { appType: 'documents' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  el('btnNewCatalogue').addEventListener('click', async () => {
    const name = prompt('Nom de l\'outil :', 'Catalogue produits');
    if (name === null || !name.trim()) return;
    const description = prompt('Description (visible par le client) :',
      'Parcourez, filtrez et trouvez le chariot, gerbeur, transpalette ou préparateur de commandes adapté à un besoin client.');
    if (description === null) return;

    const { error } = await supabaseClient.from('tools').insert({
      name: name.trim(),
      description: description.trim(),
      slug: slugify(name.trim()),
      config: { appType: 'catalogue_produits' },
    });
    if (error) { alert(error.message); return; }
    await loadTools();
  });

  // ── Liens produits (Catalogue produits) ─────────────────────────────
  const productLinkSearch = el('productLinkSearch');
  const productLinksBody = el('productLinksBody');
  const productLinksHint = el('productLinksHint');
  let catalogModels = null; // chargé à la demande depuis outils/catalogue-data.json
  let productLinksMap = {}; // "marque|modele" -> url

  async function ensureCatalogLoaded() {
    if (catalogModels) return;
    const res = await fetch('../outils/catalogue-data.json');
    catalogModels = await res.json();
    const { data } = await supabaseClient.from('product_links').select('marque,modele,url');
    (data || []).forEach((row) => { productLinksMap[`${row.marque}|${row.modele}`] = row.url; });
  }

  function renderProductLinksRows(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      productLinksBody.innerHTML = '';
      productLinksHint.hidden = false;
      productLinksHint.textContent = 'Tapez au moins 2 caractères pour rechercher un modèle.';
      return;
    }
    const matches = catalogModels.filter((m) =>
      m.modele.toLowerCase().includes(q) || m.marque.toLowerCase().includes(q)
    ).slice(0, 30);

    if (!matches.length) {
      productLinksBody.innerHTML = '';
      productLinksHint.hidden = false;
      productLinksHint.textContent = 'Aucun modèle ne correspond à cette recherche.';
      return;
    }
    productLinksHint.hidden = true;

    productLinksBody.innerHTML = matches.map((m) => {
      const key = `${m.marque}|${m.modele}`;
      const url = productLinksMap[key] || '';
      const rowId = key.replace(/[^a-zA-Z0-9]/g, '_');
      return `<tr>
        <td>${escHtml(m.marque)}</td>
        <td>${escHtml(m.modele)}</td>
        <td><input type="url" data-key="${escHtml(key)}" id="link_${rowId}" placeholder="https://..." value="${escHtml(url)}" style="width:100%;"></td>
        <td><button class="secondary" data-save="${escHtml(key)}">Enregistrer</button></td>
      </tr>`;
    }).join('');

    productLinksBody.querySelectorAll('button[data-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-save');
        const [marque, modele] = key.split('|');
        const input = productLinksBody.querySelector(`input[data-key="${CSS.escape(key)}"]`);
        const url = input.value.trim();
        btn.disabled = true;
        try {
          if (url) {
            const { error } = await supabaseClient.from('product_links')
              .upsert({ marque, modele, url, updated_at: new Date().toISOString() }, { onConflict: 'marque,modele' });
            if (error) throw error;
            productLinksMap[key] = url;
          } else {
            const { error } = await supabaseClient.from('product_links').delete().eq('marque', marque).eq('modele', modele);
            if (error) throw error;
            delete productLinksMap[key];
          }
        } catch (e) {
          alert(e.message || 'Erreur lors de l\'enregistrement du lien.');
        }
        btn.disabled = false;
      });
    });
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  productLinkSearch.addEventListener('input', async () => {
    await ensureCatalogLoaded();
    renderProductLinksRows(productLinkSearch.value);
  });

  (async function init() {
    const session = await requireSession('login.html');
    if (!session) return;
    const profile = await loadCurrentProfile();
    if (!profile || !profile.is_admin) { window.location.href = 'dashboard.html'; return; }

    renderNavAccount('navAccount', '');
    await loadCompanies();
    await loadTools();
  })();
})();

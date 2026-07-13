/* Logicop — page gestionnaire : affecter les outils aux employés de son entreprise
   et mettre à jour les tarifs transport. */

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const accessGrid = el('accessGrid');
  const noMembers = el('noMembers');
  const btnSaveAccess = el('btnSaveAccess');
  const accessStatus = el('accessStatus');
  const transportStep = el('transportStep');
  const transportToolSelect = el('transportToolSelect');
  const transportZonesBody = el('transportZonesBody');
  const btnSaveTransport = el('btnSaveTransport');
  const transportStatus = el('transportStatus');

  let members = [];
  let companyTools = [];
  let userGrants = [];
  let transportTools = [];
  let currentTransportTool = null;

  const CITY_ZONES = [
    { zone: 'Lucé - Luisant' },
    { zone: 'Chartres Agglo' },
  ];

  function showAccessStatus(type, msg) {
    accessStatus.className = 'status show ' + type;
    accessStatus.textContent = msg;
  }
  function showTransportStatus(type, msg) {
    transportStatus.className = 'status show ' + type;
    transportStatus.textContent = msg;
  }

  function hasGrant(profileId, toolId) {
    return userGrants.some((g) => g.profile_id === profileId && g.tool_id === toolId);
  }

  function renderAccessGrid() {
    accessGrid.innerHTML = '';
    if (!members.length || !companyTools.length) {
      noMembers.hidden = !(!members.length);
      return;
    }

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const thEmpty = document.createElement('th');
    thEmpty.textContent = 'Employé';
    headRow.appendChild(thEmpty);
    companyTools.forEach((t) => {
      const th = document.createElement('th');
      th.textContent = t.name;
      th.style.textAlign = 'center';
      th.style.fontSize = '0.85rem';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    members.forEach((m) => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = m.email || m.id;
      tr.appendChild(tdName);
      companyTools.forEach((t) => {
        const td = document.createElement('td');
        td.style.textAlign = 'center';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = hasGrant(m.id, t.id);
        box.dataset.profileId = m.id;
        box.dataset.toolId = t.id;
        td.appendChild(box);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    accessGrid.appendChild(table);
  }

  btnSaveAccess.addEventListener('click', async () => {
    btnSaveAccess.disabled = true;
    showAccessStatus('', '');
    try {
      const boxes = accessGrid.querySelectorAll('input[type=checkbox]');
      const toAdd = [];
      const toRemove = [];
      boxes.forEach((box) => {
        const pid = box.dataset.profileId;
        const tid = box.dataset.toolId;
        const had = hasGrant(pid, tid);
        if (box.checked && !had) toAdd.push({ profile_id: pid, tool_id: tid });
        if (!box.checked && had) toRemove.push({ profile_id: pid, tool_id: tid });
      });

      for (const r of toRemove) {
        const { error } = await supabaseClient.rpc('manage_user_tool_grant', {
          p_profile_id: r.profile_id, p_tool_id: r.tool_id, p_action: 'remove',
        });
        if (error) throw error;
      }
      for (const a of toAdd) {
        const { error } = await supabaseClient.rpc('manage_user_tool_grant', {
          p_profile_id: a.profile_id, p_tool_id: a.tool_id, p_action: 'add',
        });
        if (error) throw error;
      }

      const { data } = await supabaseClient.rpc('get_company_user_grants', {
        caller_company_id: (await loadCurrentProfile()).company_id,
      });
      userGrants = data || [];
      showAccessStatus('ok', 'Accès enregistrés.');
    } catch (err) {
      showAccessStatus('err', 'Erreur : ' + err.message);
    } finally {
      btnSaveAccess.disabled = false;
    }
  });

  // ── Tarifs transport ───────────────────────────────────────────────
  function renderTransportPrices(tool) {
    currentTransportTool = tool;
    transportZonesBody.innerHTML = '';
    const prices = tool.config.prices || {};
    const pricesTech = tool.config.pricesTech || {};
    const polyZones = Object.keys(window.TRANSPORT_ZONES || {}).sort((a, b) =>
      (parseInt(a.match(/\d+/)) || 0) - (parseInt(b.match(/\d+/)) || 0));
    const zoneNames = [...CITY_ZONES.map((c) => c.zone), ...polyZones];

    zoneNames.forEach((name) => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = name;
      tdName.style.fontWeight = '600';

      const tdPL = document.createElement('td');
      const inputPL = document.createElement('input');
      inputPL.type = 'text';
      inputPL.value = prices[name] || '';
      inputPL.placeholder = '0';
      inputPL.dataset.zone = name;
      inputPL.dataset.type = 'pl';
      tdPL.appendChild(inputPL);

      const tdTech = document.createElement('td');
      const inputTech = document.createElement('input');
      inputTech.type = 'text';
      inputTech.value = pricesTech[name] || '';
      inputTech.placeholder = '0';
      inputTech.dataset.zone = name;
      inputTech.dataset.type = 'tech';
      tdTech.appendChild(inputTech);

      tr.append(tdName, tdPL, tdTech);
      transportZonesBody.appendChild(tr);
    });
  }

  transportToolSelect.addEventListener('change', () => {
    const tool = transportTools.find((t) => t.id === transportToolSelect.value);
    if (tool) renderTransportPrices(tool);
  });

  btnSaveTransport.addEventListener('click', async () => {
    if (!currentTransportTool) return;
    btnSaveTransport.disabled = true;
    showTransportStatus('', '');
    try {
      const prices = {};
      const pricesTech = {};
      transportZonesBody.querySelectorAll('input').forEach((input) => {
        const zone = input.dataset.zone;
        const val = input.value.trim();
        if (input.dataset.type === 'pl') prices[zone] = val;
        else pricesTech[zone] = val;
      });
      const config = { ...currentTransportTool.config, prices, pricesTech };
      const { error } = await supabaseClient.from('tools')
        .update({ config, updated_at: new Date().toISOString() })
        .eq('id', currentTransportTool.id);
      if (error) throw error;
      currentTransportTool.config = config;
      showTransportStatus('ok', 'Tarifs enregistrés.');
    } catch (err) {
      showTransportStatus('err', 'Erreur : ' + err.message);
    } finally {
      btnSaveTransport.disabled = false;
    }
  });

  // ── Init ────────────────────────────────────────────────────────────
  (async function init() {
    const session = await requireSession('login.html');
    if (!session) return;
    const profile = await loadCurrentProfile();
    if (!profile || (!profile.is_gestionnaire && !profile.is_admin)) {
      window.location.href = 'dashboard.html';
      return;
    }

    renderNavAccount('navAccount', '');

    const { data: mData } = await supabaseClient.rpc('get_company_profiles', {
      caller_company_id: profile.company_id,
    });
    members = (mData || []).filter((m) => m.id !== profile.id && !m.is_admin);

    const { data: gData } = await supabaseClient.from('access_grants').select('tool_id')
      .eq('company_id', profile.company_id);
    const toolIds = (gData || []).map((g) => g.tool_id);

    if (toolIds.length) {
      const { data: tData } = await supabaseClient.from('tools').select('*')
        .in('id', toolIds).order('name');
      companyTools = tData || [];
    }

    const { data: ugData } = await supabaseClient.rpc('get_company_user_grants', {
      caller_company_id: profile.company_id,
    });
    userGrants = ugData || [];

    renderAccessGrid();

    transportTools = companyTools.filter((t) => (t.config || {}).appType === 'transport');
    if (transportTools.length) {
      transportStep.hidden = false;
      transportToolSelect.innerHTML = '';
      transportTools.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        transportToolSelect.appendChild(opt);
      });
      if (transportTools.length === 1) transportToolSelect.style.display = 'none';
      renderTransportPrices(transportTools[0]);
    }
  })();
})();

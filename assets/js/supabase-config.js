/* Logicop — configuration Supabase partagée par toutes les pages.
   La clé "anon" est prévue pour être publique : la vraie protection vient des règles
   RLS définies côté base de données (voir supabase_schema.sql), pas du secret de cette clé. */

const SUPABASE_URL = 'https://uwnfjusguswpeueqaqdt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3bmZqdXNndXN3cGV1ZXFhcWR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5OTU2MDcsImV4cCI6MjA5ODU3MTYwN30.gwWBwtBGt5ghzEQaHLRStb35RZ1AJTGr5G5Q3QxcLNw';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

/** Redirige vers login.html si personne n'est connecté. Renvoie la session sinon. */
async function requireSession(redirectTo) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = redirectTo || '../pages/login.html';
    return null;
  }
  return session;
}

/** Charge le profil (is_admin, company_id) de l'utilisateur connecté. */
async function loadCurrentProfile() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  if (error) { console.error('loadCurrentProfile error:', error); return null; }
  return { ...data, is_gestionnaire: data.is_gestionnaire || false, email: user.email };
}

async function signOut(loginPath) {
  await supabaseClient.auth.signOut();
  window.location.href = loginPath || 'login.html';
}

/** Injecte dans `containerId` soit un lien "Connexion", soit un menu déroulant "Mon compte"
 *  (Mes outils / Administration + Me déconnecter) selon l'état de connexion. `basePath` vaut
 *  '' pour une page à la racine, '../' pour une page dans outils/. */
async function renderNavAccount(containerId, basePath) {
  basePath = basePath || '';
  var pagesPath = basePath;
  var loginPath = pagesPath + 'login.html';
  const container = document.getElementById(containerId);
  if (!container) return;

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    container.innerHTML = `<a class="nav-login" href="${loginPath}">Se connecter <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></a>`;
    return;
  }

  const profile = await loadCurrentProfile();
  if (!profile) {
    container.innerHTML = `<a class="nav-login" href="${loginPath}">Se connecter <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></a>`;
    return;
  }
  const isAdmin = !!(profile && profile.is_admin);
  const isGestionnaire = !!(profile && profile.is_gestionnaire);
  const toolsHref = pagesPath + (isAdmin ? 'admin.html' : 'dashboard.html');
  const toolsLabel = isAdmin ? 'Administration' : 'Mes outils';
  const gestionLink = isGestionnaire && !isAdmin ? `<a href="${pagesPath}gestion.html">Gestion</a>` : '';
  const email = profile.email || '';
  const fullName = (profile.full_name || '').trim();
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Initiales : depuis le « Prénom Nom » s'il est renseigné, sinon depuis l'e-mail.
  const parts = (fullName ? fullName.split(/\s+/) : email.split('@')[0].split(/[._-]+/)).filter(Boolean);
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();

  container.innerHTML = `
    <div class="account-menu" id="accountMenuRoot">
      <button type="button" class="account-menu-btn" aria-haspopup="true" aria-expanded="false">
        <span class="acct-avatar" aria-hidden="true">${escHtml(initials)}</span>
        <span class="acct-label">Mon compte</span>
        <svg class="acct-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
      </button>
      <div class="account-menu-list">
        <div class="acct-identity"><small>Connecté</small><strong>${escHtml(fullName || email)}</strong>${fullName ? `<span class="acct-email">${escHtml(email)}</span>` : ''}</div>
        <a href="${toolsHref}">${toolsLabel}</a>
        ${gestionLink}
        <button type="button" id="accountMenuSignOut">Me déconnecter</button>
      </div>
    </div>`;

  const root = document.getElementById('accountMenuRoot');
  const menuBtn = root.querySelector('.account-menu-btn');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menuBtn.setAttribute('aria-expanded', String(root.classList.toggle('open')));
  });
  document.addEventListener('click', () => { root.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); });
  document.getElementById('accountMenuSignOut').addEventListener('click', () => signOut(loginPath));
}

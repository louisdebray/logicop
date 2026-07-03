/* Logicop — configuration Supabase partagée par toutes les pages.
   La clé "anon" est prévue pour être publique : la vraie protection vient des règles
   RLS définies côté base de données (voir supabase_schema.sql), pas du secret de cette clé. */

const SUPABASE_URL = 'https://uwnfjusguswpeueqaqdt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3bmZqdXNndXN3cGV1ZXFhcWR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5OTU2MDcsImV4cCI6MjA5ODU3MTYwN30.gwWBwtBGt5ghzEQaHLRStb35RZ1AJTGr5G5Q3QxcLNw';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Redirige vers login.html si personne n'est connecté. Renvoie la session sinon. */
async function requireSession(redirectTo) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = redirectTo || '../login.html';
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
    .select('id, company_id, is_admin')
    .eq('id', user.id)
    .single();
  if (error) { console.error(error); return null; }
  return { ...data, email: user.email };
}

async function signOut(basePath) {
  await supabaseClient.auth.signOut();
  window.location.href = (basePath || '') + 'login.html';
}

/** Injecte dans `containerId` soit un lien "Connexion", soit un menu déroulant "Mon compte"
 *  (Mes outils / Administration + Me déconnecter) selon l'état de connexion. `basePath` vaut
 *  '' pour une page à la racine, '../' pour une page dans outils/. */
async function renderNavAccount(containerId, basePath) {
  basePath = basePath || '';
  const container = document.getElementById(containerId);
  if (!container) return;

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    container.innerHTML = `<a href="${basePath}login.html">Connexion</a>`;
    return;
  }

  const profile = await loadCurrentProfile();
  const isAdmin = !!(profile && profile.is_admin);
  const toolsHref = basePath + (isAdmin ? 'admin.html' : 'dashboard.html');
  const toolsLabel = isAdmin ? 'Administration' : 'Mes outils';

  container.innerHTML = `
    <div class="account-menu" id="accountMenuRoot">
      <button type="button" class="account-menu-btn">Mon compte ▾</button>
      <div class="account-menu-list">
        <a href="${toolsHref}">${toolsLabel}</a>
        <button type="button" id="accountMenuSignOut">Me déconnecter</button>
      </div>
    </div>`;

  const root = document.getElementById('accountMenuRoot');
  root.querySelector('.account-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    root.classList.toggle('open');
  });
  document.addEventListener('click', () => root.classList.remove('open'));
  document.getElementById('accountMenuSignOut').addEventListener('click', () => signOut(basePath));
}

-- Logicop — schéma de base (à exécuter une fois dans Supabase SQL Editor)

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  company_id uuid references companies(id) on delete set null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table tools (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  config jsonb not null default '{}'::jsonb,
  template_path text, -- chemin du modèle Excel de destination dans le bucket "templates"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table access_grants (
  company_id uuid not null references companies(id) on delete cascade,
  tool_id uuid not null references tools(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (company_id, tool_id)
);

-- ── Sécurité (Row Level Security) ──────────────────────────────────────────
alter table companies enable row level security;
alter table profiles enable row level security;
alter table tools enable row level security;
alter table access_grants enable row level security;

create or replace function is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and is_admin = true
  );
$$;

-- profiles : chacun voit son propre profil, l'admin voit tout
create policy "own profile" on profiles
  for select using (id = auth.uid() or is_admin());
create policy "admin manages profiles" on profiles
  for all using (is_admin());

-- companies : l'admin gère tout, un utilisateur voit sa propre entreprise
create policy "admin manages companies" on companies
  for all using (is_admin());
create policy "own company" on companies
  for select using (
    id = (select company_id from profiles where id = auth.uid())
  );

-- has_tool_access : fonction "security definer" (comme is_admin()) qui contourne les règles
-- RLS de access_grants/profiles pour faire cette vérification. Indispensable : sans elle, la
-- policy "granted tools" ci-dessous exécuterait sa sous-requête sur access_grants avec les
-- droits du client (pas de l'admin), qui n'a par définition pas le droit de lire access_grants
-- — la sous-requête verrait alors toujours 0 ligne et aucun outil n'apparaîtrait jamais, même
-- avec un accès correctement accordé.
create or replace function has_tool_access(check_tool_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from access_grants ag
    join profiles p on p.company_id = ag.company_id
    where ag.tool_id = check_tool_id and p.id = auth.uid()
  );
$$;

-- tools : l'admin gère tout, un client voit uniquement les outils qui lui sont accordés
create policy "admin manages tools" on tools
  for all using (is_admin());
create policy "granted tools" on tools
  for select using (is_admin() or has_tool_access(tools.id));

-- access_grants : admin uniquement
create policy "admin manages grants" on access_grants
  for all using (is_admin());

-- Crée automatiquement une ligne "profiles" à chaque nouvel utilisateur créé (client ou admin,
-- que ce soit via Authentication → Users dans le dashboard, ou plus tard via l'admin panel).
-- Par défaut is_admin = false et company_id = null ; vous les assignez ensuite manuellement.
create function handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email, is_admin) values (new.id, new.email, false);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── Stockage des modèles Excel de destination ───────────────────────────────
-- Dans Supabase : Storage → New bucket → nom "templates", "Public bucket" DÉCOCHÉ (privé).
-- Puis exécutez ceci pour autoriser l'admin à tout faire, et les utilisateurs connectés
-- à seulement télécharger (le vrai filtre "quel outil" reste fait par la table `tools`,
-- qui elle est protégée par ses propres règles ci-dessus).
create policy "admin manages template files"
  on storage.objects for all
  using (bucket_id = 'templates' and is_admin());

create policy "authenticated users download template files"
  on storage.objects for select
  using (bucket_id = 'templates' and auth.role() = 'authenticated');

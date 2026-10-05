-- Migration : affectation d'outils par utilisateur + rôle "gestionnaire"
-- À exécuter dans Supabase SQL Editor APRÈS le schéma initial.

-- 1. Ajout du rôle gestionnaire sur profiles
alter table profiles add column if not exists is_gestionnaire boolean not null default false;

-- 2. Table d'accès utilisateur-outil (en plus de l'accès entreprise)
create table if not exists user_tool_grants (
  profile_id uuid not null references profiles(id) on delete cascade,
  tool_id uuid not null references tools(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (profile_id, tool_id)
);

alter table user_tool_grants enable row level security;

-- Admin peut tout faire
create policy "admin manages user grants" on user_tool_grants
  for all using (is_admin());

-- Gestionnaire peut gérer les grants de sa propre entreprise
create or replace function is_gestionnaire()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and is_gestionnaire = true
  );
$$;

create policy "gestionnaire manages own company user grants" on user_tool_grants
  for all using (
    is_gestionnaire() and (
      select p.company_id from profiles p where p.id = user_tool_grants.profile_id
    ) = (
      select p2.company_id from profiles p2 where p2.id = auth.uid()
    )
  );

-- Les utilisateurs peuvent voir leurs propres grants
create policy "own user grants" on user_tool_grants
  for select using (profile_id = auth.uid());

-- 3. Mettre à jour has_tool_access pour vérifier aussi les grants utilisateur
-- L'entreprise doit avoir l'accès, ET soit l'utilisateur est gestionnaire (accès à tout),
-- soit il est explicitement listé dans user_tool_grants.
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
  )
  and (
    (select is_gestionnaire from profiles where id = auth.uid()) = true
    or exists (
      select 1 from user_tool_grants utg
      where utg.tool_id = check_tool_id and utg.profile_id = auth.uid()
    )
  );
$$;

-- 4. Permettre aux gestionnaires de voir les profils de leur entreprise
create policy "gestionnaire sees own company profiles" on profiles
  for select using (
    is_gestionnaire() and company_id = (select p.company_id from profiles p where p.id = auth.uid())
  );

-- 5. Permettre aux gestionnaires de voir les outils accordés à leur entreprise
create policy "gestionnaire sees company grants" on access_grants
  for select using (
    is_gestionnaire() and company_id = (select p.company_id from profiles p where p.id = auth.uid())
  );

-- 6. Permettre aux gestionnaires de modifier la config des outils transport de leur entreprise
create policy "gestionnaire updates transport tools" on tools
  for update using (
    is_gestionnaire() and (config->>'appType') = 'transport'
    and has_tool_access(tools.id)
  );

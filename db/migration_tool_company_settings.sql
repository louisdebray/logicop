-- Paramètres par outil et par entreprise (ex: taux d'intérêt, typologies)
-- Le gestionnaire de l'entreprise peut modifier ces paramètres.

create table tool_company_settings (
  id uuid primary key default gen_random_uuid(),
  tool_id uuid not null references tools(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  settings jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique(tool_id, company_id)
);

alter table tool_company_settings enable row level security;

-- Lecture : utilisateur authentifié dont le company_id correspond
create policy "Authenticated users read their company settings"
  on tool_company_settings for select to authenticated
  using (
    company_id = (select company_id from profiles where id = auth.uid())
    or is_admin()
  );

-- Écriture : gestionnaire de l'entreprise ou admin
create policy "Gestionnaire or admin can upsert settings"
  on tool_company_settings for insert to authenticated
  with check (
    (company_id = (select company_id from profiles where id = auth.uid())
     and (select is_gestionnaire from profiles where id = auth.uid()) = true)
    or is_admin()
  );

create policy "Gestionnaire or admin can update settings"
  on tool_company_settings for update to authenticated
  using (
    (company_id = (select company_id from profiles where id = auth.uid())
     and (select is_gestionnaire from profiles where id = auth.uid()) = true)
    or is_admin()
  );

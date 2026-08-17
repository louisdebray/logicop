-- Logicop — tables folders + documents (liens Google Drive liés à un outil)

create table folders (
  id uuid primary key default gen_random_uuid(),
  tool_id uuid not null references tools(id) on delete cascade,
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

alter table folders enable row level security;

create policy "admin manages folders" on folders
  for all using (is_admin());

create policy "authenticated users read folders" on folders
  for select using (auth.role() = 'authenticated');

create table documents (
  id uuid primary key default gen_random_uuid(),
  tool_id uuid not null references tools(id) on delete cascade,
  folder_id uuid references folders(id) on delete set null,
  name text not null,
  url text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

alter table documents enable row level security;

create policy "admin manages documents" on documents
  for all using (is_admin());

create policy "authenticated users read documents" on documents
  for select using (auth.role() = 'authenticated');

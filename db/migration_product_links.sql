-- Liens produit (fiche PDF, page constructeur...) associés à un modèle du catalogue.
-- Gérés uniquement par l'admin depuis l'outil "Catalogue produits" ; lus par tous les
-- utilisateurs connectés.
create table product_links (
  id uuid primary key default gen_random_uuid(),
  marque text not null,
  modele text not null,
  url text not null,
  updated_at timestamptz not null default now(),
  unique (marque, modele)
);

alter table product_links enable row level security;

create policy "admin manages product_links" on product_links
  for all using (is_admin());

create policy "authenticated users read product_links" on product_links
  for select using (auth.uid() is not null);

-- Prénom Nom des utilisateurs, saisi par l'admin et affiché à la place de l'e-mail dans l'interface.
-- Colonne facultative : sans valeur, l'interface continue d'afficher l'e-mail.
-- Les règles d'accès existantes suffisent (l'admin gère les profils, chacun lit le sien).
alter table profiles add column if not exists full_name text;

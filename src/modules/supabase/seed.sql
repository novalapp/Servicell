-- Insert Servicell client if it doesn't exist
INSERT INTO clients (name, slug, created_at, updated_at)
VALUES ('Servicell', 'servicell', NOW(), NOW())
ON CONFLICT (slug) DO NOTHING;

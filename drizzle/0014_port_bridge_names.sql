-- ports.bridges used to hold {name, fast} objects; it now holds the bridge names the crossing workbench offers
UPDATE "ports"
SET "bridges" = COALESCE((SELECT jsonb_agg(COALESCE(e->>'name', e#>>'{}')) FROM jsonb_array_elements("bridges") e WHERE COALESCE(e->>'name', e#>>'{}') IS NOT NULL), '[]'::jsonb)
WHERE jsonb_typeof("bridges") = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements("bridges") e WHERE jsonb_typeof(e) = 'object');

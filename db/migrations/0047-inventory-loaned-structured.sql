-- Follow-on fix to #542: inventory_items.loaned_to was a flattened
-- comma-joined string of borrower NAMES, which threw away each borrower's
-- loaned amount and made the string unparseable back into member ids (the
-- frontend was matching member ids against a list of names and always
-- missing, showing "Unknown" and "1 item" for everyone). Store the v2 API's
-- per-borrower {member_id, member_name, amount} directly instead.
--
-- No backfill is possible: the old string has no id or amount, only names
-- joined with no separatorable structure. The column resets to NULL and the
-- next inventory sync (cron or manual) repopulates it correctly.
--
-- ⚠️ inventory_items_with_prices (and the 9 per-category views built on top
-- of it) all SELECT loaned_to, so Postgres refuses the ALTER outright:
-- "cannot alter type of a column used by a view or rule". This crashed on
-- every production deploy attempt (server left on 3.54.0, migrations
-- stopping dead at 0047) until caught — CASCADE-dropping and recreating the
-- view chain around the ALTER, verbatim from db/template.sql, so the two
-- never drift apart.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items'
      AND column_name = 'loaned_to' AND data_type = 'text'
  ) THEN
    DROP VIEW IF EXISTS public.inventory_items_with_prices CASCADE;

    ALTER TABLE public.inventory_items ALTER COLUMN loaned_to TYPE jsonb USING NULL::jsonb;

    CREATE VIEW public.inventory_items_with_prices AS
     SELECT ii.id AS item_id,
        ii.name AS item_name,
        ii.quantity,
        ii.available,
        ii.loaned,
        ii.loaned_to,
        ii.api_type,
        ii.category,
        ii.last_synced,
        COALESCE(sum(pb.price * pb.quantity) / NULLIF(sum(pb.quantity), 0)::numeric, 0::numeric) AS weighted_avg_price,
        COALESCE(sum(pb.quantity), 0::bigint) AS total_batched_quantity,
        COALESCE(sum(pb.price * pb.quantity) / NULLIF(sum(pb.quantity), 0)::numeric * ii.quantity::numeric, 0::numeric) AS total_value,
        max(pb.added_at) AS last_price_update
       FROM inventory_items ii
         LEFT JOIN pricing_batches pb ON ii.id = pb.item_id
      GROUP BY ii.id, ii.name, ii.quantity, ii.available, ii.loaned, ii.loaned_to, ii.api_type, ii.category, ii.last_synced;

    CREATE VIEW public.inventory_armor AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices WHERE category = 'armor'::text;

    CREATE VIEW public.inventory_caches AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices WHERE category = 'caches'::text;

    CREATE VIEW public.inventory_cesium AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices WHERE category = 'cesium'::text;

    CREATE VIEW public.inventory_crime_items AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices
      WHERE item_id = ANY (ARRAY['66'::text, '67'::text, '68'::text, '69'::text, '70'::text, '71'::text, '72'::text, '74'::text, '159'::text, '213'::text, '568'::text, '579'::text, '981'::text, '1080'::text, '1203'::text, '1258'::text, '1284'::text, '1331'::text, '1350'::text, '1362'::text, '1380'::text, '1383'::text, '73'::text, '103'::text, '158'::text, '172'::text, '188'::text, '190'::text, '201'::text, '222'::text, '226'::text, '256'::text, '567'::text, '576'::text, '643'::text, '856'::text, '1012'::text, '1094'::text, '1223'::text, '1230'::text, '884'::text, '1361'::text, '1379'::text, '1381'::text, '1429'::text, '1430'::text, '1461'::text, '1431'::text]);

    CREATE VIEW public.inventory_drugs AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices WHERE category = 'drugs'::text;

    CREATE VIEW public.inventory_medical AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices WHERE category = 'medical'::text;

    CREATE VIEW public.inventory_temporary AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices WHERE category = 'temporary'::text;

    CREATE VIEW public.inventory_utilities AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices WHERE category = 'utilities'::text;

    CREATE VIEW public.inventory_weapons AS
     SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
            weighted_avg_price, total_batched_quantity, total_value, last_price_update
       FROM inventory_items_with_prices WHERE category = 'weapons'::text;
  END IF;
END $$;

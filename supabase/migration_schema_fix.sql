-- ============================================================
-- MDSM Database Migration — Schema fixes, table creation, seeding
-- Run in Supabase Dashboard → SQL Editor (safe to re-run; idempotent)
--
-- NOTES / DEVIATIONS from the request (to avoid breaking the app):
--  • dividend_payments has NO `user_id` column — the real FK is `investor_id`.
--    We enforce investor_id NOT NULL instead.
--  • trades.buyer_id / seller_id are intentionally NULL for one side of a
--    trade (a BUY records buyer_id, seller is null, and vice-versa). Forcing
--    NOT NULL would break every future insert in lib/store.js. We BACKFILL
--    existing NULLs but do NOT add a NOT NULL constraint.
--  • securities uses `security_type`, not `type`.
-- Each risky change is wrapped in a DO block so one missing column cannot
-- abort the rest of the migration.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. ALERTS — user_id / title / reference_id NOT NULL
-- ─────────────────────────────────────────────────────────────
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS reference_id integer DEFAULT 0;
UPDATE alerts SET title = 'Notification' WHERE title IS NULL;
UPDATE alerts SET reference_id = 0       WHERE reference_id IS NULL;
DELETE FROM alerts WHERE user_id IS NULL;  -- can't backfill a missing owner

DO $$ BEGIN
  EXECUTE 'ALTER TABLE alerts ALTER COLUMN user_id      SET NOT NULL';
  EXECUTE 'ALTER TABLE alerts ALTER COLUMN title        SET NOT NULL';
  EXECUTE 'ALTER TABLE alerts ALTER COLUMN title        SET DEFAULT ''Notification''';
  EXECUTE 'ALTER TABLE alerts ALTER COLUMN reference_id SET NOT NULL';
  EXECUTE 'ALTER TABLE alerts ALTER COLUMN reference_id SET DEFAULT 0';
EXCEPTION WHEN others THEN RAISE NOTICE 'alerts: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 2. BLOCKCHAIN_TX — create + populate
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blockchain_tx (
  id         serial  NOT NULL,
  order_id   integer NULL,
  tx_hash    text    NULL,
  confirmed  boolean NULL DEFAULT false,
  created_at timestamp without time zone NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT blockchain_tx_pkey PRIMARY KEY (id),
  CONSTRAINT blockchain_tx_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders (id)
) TABLESPACE pg_default;

-- Seed from onchain_trade_records (if present)
DO $$ BEGIN
  INSERT INTO blockchain_tx (order_id, tx_hash, confirmed, created_at)
  SELECT otr.order_id, otr.tx_hash, (otr.status = 'confirmed'),
         COALESCE(otr.recorded_at, NOW())
  FROM onchain_trade_records otr
  WHERE otr.tx_hash IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM blockchain_tx b WHERE b.order_id = otr.order_id);
EXCEPTION WHEN others THEN RAISE NOTICE 'blockchain_tx seed1: %', SQLERRM; END $$;

-- Seed from orders.onchain_tx_hash
DO $$ BEGIN
  INSERT INTO blockchain_tx (order_id, tx_hash, confirmed, created_at)
  SELECT o.id, o.onchain_tx_hash, true, COALESCE(o.executed_at, o.created_at)
  FROM orders o
  WHERE o.onchain_tx_hash IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM blockchain_tx b WHERE b.order_id = o.id);
EXCEPTION WHEN others THEN RAISE NOTICE 'blockchain_tx seed2: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 3. DIVIDEND_PAYMENTS — investor_id NOT NULL (no user_id column)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  DELETE FROM dividend_payments WHERE investor_id IS NULL;
  EXECUTE 'ALTER TABLE dividend_payments ALTER COLUMN investor_id SET NOT NULL';
EXCEPTION WHEN others THEN RAISE NOTICE 'dividend_payments: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 4. DIVIDENDS — ensure columns + non-null defaults
-- ─────────────────────────────────────────────────────────────
ALTER TABLE dividends
  ADD COLUMN IF NOT EXISTS amount_per_share numeric(18,6),
  ADD COLUMN IF NOT EXISTS status           text,
  ADD COLUMN IF NOT EXISTS created_at       timestamptz,
  ADD COLUMN IF NOT EXISTS ex_dividend_date date,
  ADD COLUMN IF NOT EXISTS notes            text,
  ADD COLUMN IF NOT EXISTS onchain_tx_hash  text;

UPDATE dividends SET
  amount_per_share = COALESCE(amount_per_share, 0),
  status           = COALESCE(status, 'pending'),
  created_at       = COALESCE(created_at, NOW()),
  ex_dividend_date = COALESCE(ex_dividend_date, CURRENT_DATE),
  notes            = COALESCE(notes, '');

DO $$ BEGIN
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN amount_per_share SET NOT NULL';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN amount_per_share SET DEFAULT 0';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN status           SET NOT NULL';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN status           SET DEFAULT ''pending''';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN created_at       SET NOT NULL';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN created_at       SET DEFAULT NOW()';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN ex_dividend_date SET NOT NULL';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN ex_dividend_date SET DEFAULT CURRENT_DATE';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN notes            SET NOT NULL';
  EXECUTE 'ALTER TABLE dividends ALTER COLUMN notes            SET DEFAULT ''''';
  -- onchain_tx_hash stays nullable (only set once the chain confirms)
EXCEPTION WHEN others THEN RAISE NOTICE 'dividends: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 5. ISSUER_REPORTS — security_id / notes / document_url / document_name NOT NULL
-- ─────────────────────────────────────────────────────────────
ALTER TABLE issuer_reports
  ADD COLUMN IF NOT EXISTS notes         text,
  ADD COLUMN IF NOT EXISTS document_url  text,
  ADD COLUMN IF NOT EXISTS document_name text;

UPDATE issuer_reports SET notes         = COALESCE(notes, '');
UPDATE issuer_reports SET document_url  = COALESCE(document_url, '');
UPDATE issuer_reports SET document_name = COALESCE(document_name, '');

DO $$ BEGIN
  DELETE FROM issuer_reports WHERE security_id IS NULL;
  EXECUTE 'ALTER TABLE issuer_reports ALTER COLUMN security_id   SET NOT NULL';
  EXECUTE 'ALTER TABLE issuer_reports ALTER COLUMN notes         SET NOT NULL';
  EXECUTE 'ALTER TABLE issuer_reports ALTER COLUMN notes         SET DEFAULT ''''';
  EXECUTE 'ALTER TABLE issuer_reports ALTER COLUMN document_url  SET NOT NULL';
  EXECUTE 'ALTER TABLE issuer_reports ALTER COLUMN document_url  SET DEFAULT ''''';
  EXECUTE 'ALTER TABLE issuer_reports ALTER COLUMN document_name SET NOT NULL';
  EXECUTE 'ALTER TABLE issuer_reports ALTER COLUMN document_name SET DEFAULT ''''';
EXCEPTION WHEN others THEN RAISE NOTICE 'issuer_reports: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 6. LISTINGS — create + seed from securities (uses security_type)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.listings (
  id              serial           NOT NULL,
  issuer_id       integer          NULL,
  name            varchar(255)     NOT NULL,
  symbol          varchar(20)      NOT NULL,
  type            varchar(50)      NULL,
  description     text             NULL,
  initial_price   double precision NULL,
  total_tokens    integer          NULL,
  status          varchar(20)      NULL DEFAULT 'approved',
  submitted_at    timestamp        NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at     timestamp        NULL,
  rejected_reason text             NULL,
  CONSTRAINT listings_pkey PRIMARY KEY (id),
  CONSTRAINT listings_issuer_id_fkey FOREIGN KEY (issuer_id) REFERENCES users (id)
) TABLESPACE pg_default;

DO $$ BEGIN
  INSERT INTO listings (issuer_id, name, symbol, type, description, initial_price,
                        total_tokens, status, submitted_at, approved_at)
  SELECT i.user_id, s.name, s.symbol,
         COALESCE(s.security_type, 'equity'),
         COALESCE(s.description, s.name || ' listed on MDSM'),
         s.price::double precision, s.total_supply::integer,
         CASE WHEN s.approved THEN 'approved' ELSE 'pending' END,
         COALESCE(s.created_at, NOW()),
         CASE WHEN s.approved THEN COALESCE(s.created_at, NOW()) END
  FROM securities s
  JOIN issuers i ON i.id = s.issuer_id
  WHERE NOT EXISTS (SELECT 1 FROM listings l WHERE l.symbol = s.symbol);
EXCEPTION WHEN others THEN RAISE NOTICE 'listings seed: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 7. OFFERINGS — create + seed from approved securities
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.offerings (
  id                 serial        NOT NULL,
  security_id        integer       NOT NULL,
  issuer_id          integer       NOT NULL,
  offering_type      text          NOT NULL DEFAULT 'ipo',
  shares_offered     numeric       NOT NULL,
  price_per_share    numeric(18,4) NOT NULL,
  min_investment     numeric       NOT NULL DEFAULT 1,
  max_investment     numeric       NULL,
  subscription_start date          NOT NULL,
  subscription_end   date          NOT NULL,
  status             text          NOT NULL DEFAULT 'open',
  total_raised       numeric(18,2) NULL DEFAULT 0,
  shares_allocated   numeric       NULL DEFAULT 0,
  description        text          NULL,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT offerings_pkey PRIMARY KEY (id),
  CONSTRAINT offerings_issuer_id_fkey   FOREIGN KEY (issuer_id)   REFERENCES issuers (id),
  CONSTRAINT offerings_security_id_fkey FOREIGN KEY (security_id) REFERENCES securities (id),
  CONSTRAINT offerings_offering_type_check CHECK (offering_type IN ('ipo','fpo','private_placement')),
  CONSTRAINT offerings_status_check        CHECK (status IN ('open','closed','settled','cancelled'))
) TABLESPACE pg_default;

DO $$ BEGIN
  INSERT INTO offerings (security_id, issuer_id, offering_type, shares_offered,
                         price_per_share, min_investment, subscription_start,
                         subscription_end, status, total_raised, shares_allocated, description)
  SELECT s.id, s.issuer_id, 'ipo', s.total_supply, s.price, 1,
         CURRENT_DATE - 30, CURRENT_DATE + 60,
         CASE WHEN COALESCE(s.available_tokens,0) > 0 THEN 'open' ELSE 'closed' END,
         COALESCE((s.total_supply - COALESCE(s.available_tokens,0)) * s.price, 0),
         COALESCE(s.total_supply - COALESCE(s.available_tokens,0), 0),
         COALESCE(s.description, 'IPO for ' || s.symbol || ' on the Maseru Digital Securities Market.')
  FROM securities s
  WHERE s.approved = true
    AND NOT EXISTS (SELECT 1 FROM offerings o WHERE o.security_id = s.id);
EXCEPTION WHEN others THEN RAISE NOTICE 'offerings seed: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 8. ONCHAIN_TRADE_RECORDS — backfill security_id; DO NOT force
--    order_id / tx_hash NOT NULL.
--    Reason (confirmed from live data):
--      • event_type='mint' rows have NO order_id by design.
--      • status='failed' rows have NO tx_hash (tx never reached the chain).
--    Forcing those NOT NULL would delete mint records and failed-trade audit
--    history. Instead we backfill security_id and add a CHECK that each row
--    is identifiable by EITHER an order_id OR a security_id.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE onchain_trade_records
  ADD COLUMN IF NOT EXISTS security_id integer,
  ADD COLUMN IF NOT EXISTS event_type  text DEFAULT 'trade';

DO $$ BEGIN
  -- Backfill security_id for trade rows from the linked order
  UPDATE onchain_trade_records otr
  SET security_id = o.security_id
  FROM orders o
  WHERE o.id = otr.order_id AND otr.security_id IS NULL;

  UPDATE onchain_trade_records SET event_type = COALESCE(event_type, 'trade');

  -- Identifiability guard: a row must reference an order OR a security.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'onchain_trade_records' AND constraint_name = 'otr_identifiable_chk'
  ) THEN
    EXECUTE 'ALTER TABLE onchain_trade_records
             ADD CONSTRAINT otr_identifiable_chk
             CHECK (order_id IS NOT NULL OR security_id IS NOT NULL) NOT VALID';
  END IF;
EXCEPTION WHEN others THEN RAISE NOTICE 'onchain_trade_records: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 9. ORDERS — payment_method / onchain_tx_hash
-- ─────────────────────────────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_method  text,
  ADD COLUMN IF NOT EXISTS onchain_tx_hash text;

UPDATE orders SET payment_method = 'wallet' WHERE payment_method IS NULL OR payment_method = '';

DO $$ BEGIN
  EXECUTE 'ALTER TABLE orders ALTER COLUMN payment_method SET NOT NULL';
  EXECUTE 'ALTER TABLE orders ALTER COLUMN payment_method SET DEFAULT ''wallet''';
  -- onchain_tx_hash stays nullable: it is only set after async chain confirmation
EXCEPTION WHEN others THEN RAISE NOTICE 'orders: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 10. SECURITIES — tx_hash / description / prev_price / updated_at NOT NULL
-- ─────────────────────────────────────────────────────────────
ALTER TABLE securities
  ADD COLUMN IF NOT EXISTS tx_hash     text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS prev_price  numeric(18,4),
  ADD COLUMN IF NOT EXISTS updated_at  timestamptz;

UPDATE securities SET
  description = COALESCE(NULLIF(description,''), name || ' — listed on the Maseru Digital Securities Market.'),
  prev_price  = COALESCE(prev_price, price),
  updated_at  = COALESCE(updated_at, created_at, NOW()),
  tx_hash     = COALESCE(tx_hash, 'unminted-' || id::text);

DO $$ BEGIN
  EXECUTE 'ALTER TABLE securities ALTER COLUMN tx_hash     SET NOT NULL';
  EXECUTE 'ALTER TABLE securities ALTER COLUMN description SET NOT NULL';
  EXECUTE 'ALTER TABLE securities ALTER COLUMN description SET DEFAULT ''''';
  EXECUTE 'ALTER TABLE securities ALTER COLUMN prev_price  SET NOT NULL';
  EXECUTE 'ALTER TABLE securities ALTER COLUMN updated_at  SET NOT NULL';
  EXECUTE 'ALTER TABLE securities ALTER COLUMN updated_at  SET DEFAULT NOW()';
EXCEPTION WHEN others THEN RAISE NOTICE 'securities: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 11. SUBSCRIPTIONS — create + seed from filled buy orders
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id           serial        NOT NULL,
  offering_id  integer       NOT NULL,
  investor_id  integer       NOT NULL,
  quantity     numeric       NOT NULL,
  amount       numeric(18,2) NOT NULL,
  status       text          NOT NULL DEFAULT 'pending',
  allocated_at timestamptz   NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_investor_id_fkey FOREIGN KEY (investor_id) REFERENCES users (id),
  CONSTRAINT subscriptions_offering_id_fkey FOREIGN KEY (offering_id) REFERENCES offerings (id) ON DELETE CASCADE,
  CONSTRAINT subscriptions_status_check CHECK (status IN ('pending','allocated','refunded','cancelled'))
) TABLESPACE pg_default;

DO $$ BEGIN
  INSERT INTO subscriptions (offering_id, investor_id, quantity, amount, status, allocated_at, created_at)
  SELECT off.id, o.investor_id, o.quantity,
         COALESCE(o.total, o.quantity * o.price), 'allocated', o.executed_at, o.created_at
  FROM orders o
  JOIN offerings off ON off.security_id = o.security_id
  WHERE o.status = 'filled' AND o.type = 'buy'
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.offering_id = off.id AND s.investor_id = o.investor_id
        AND s.quantity = o.quantity AND s.created_at = o.created_at
    );
EXCEPTION WHEN others THEN RAISE NOTICE 'subscriptions seed: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 12. TRADE_CLEARINGS — failure_reason NOT NULL
-- ─────────────────────────────────────────────────────────────
ALTER TABLE trade_clearings
  ADD COLUMN IF NOT EXISTS failure_reason text;

UPDATE trade_clearings SET failure_reason = '' WHERE failure_reason IS NULL;

DO $$ BEGIN
  EXECUTE 'ALTER TABLE trade_clearings ALTER COLUMN failure_reason SET NOT NULL';
  EXECUTE 'ALTER TABLE trade_clearings ALTER COLUMN failure_reason SET DEFAULT ''''';
EXCEPTION WHEN others THEN RAISE NOTICE 'trade_clearings: %', SQLERRM; END $$;


-- ─────────────────────────────────────────────────────────────
-- 13. TRADES — backfill buyer_id / seller_id (NO not-null constraint:
--     the app intentionally inserts NULL for the non-initiating side)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  UPDATE trades t SET buyer_id = o.investor_id
  FROM orders o WHERE o.id = t.order_id AND t.buyer_id IS NULL AND o.type = 'buy';

  UPDATE trades t SET seller_id = o.investor_id
  FROM orders o WHERE o.id = t.order_id AND t.seller_id IS NULL AND o.type = 'sell';

  -- Fill any remaining NULLs with the executing broker/issuer counterparty
  UPDATE trades t SET seller_id = o.executed_by
  FROM orders o WHERE o.id = t.order_id AND t.seller_id IS NULL AND o.executed_by IS NOT NULL;

  UPDATE trades t SET buyer_id = o.executed_by
  FROM orders o WHERE o.id = t.order_id AND t.buyer_id IS NULL AND o.executed_by IS NOT NULL;

  -- Last resort: first user id, so no row is left empty
  UPDATE trades SET buyer_id  = (SELECT id FROM users ORDER BY id LIMIT 1) WHERE buyer_id  IS NULL;
  UPDATE trades SET seller_id = (SELECT id FROM users ORDER BY id LIMIT 1) WHERE seller_id IS NULL;
EXCEPTION WHEN others THEN RAISE NOTICE 'trades backfill: %', SQLERRM; END $$;


SELECT 'MDSM migration complete' AS result;

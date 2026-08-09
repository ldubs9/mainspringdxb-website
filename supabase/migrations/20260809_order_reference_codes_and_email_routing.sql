-- Add durable watch identifiers to order workflows and reduce owner noise for
-- pending Ziina attempts. Apply after 20260807_payment_finalizes_inventory.sql
-- and before deploying the matching mainspring-payments service.

BEGIN;

ALTER TABLE public.mainspring_orders
    ADD COLUMN IF NOT EXISTS reference_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE public.mainspring_order_status_history
    ADD COLUMN IF NOT EXISTS reference_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE public.mainspring_order_email_events
    ADD COLUMN IF NOT EXISTS reference_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE OR REPLACE FUNCTION public.set_mainspring_order_item_identifiers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.items IS NULL OR JSONB_TYPEOF(NEW.items) <> 'array' THEN
        NEW.reference_codes := ARRAY[]::TEXT[];
        RETURN NEW;
    END IF;

    SELECT COALESCE(
        JSONB_AGG(
            source.item || JSONB_BUILD_OBJECT(
                'reference_code', CASE WHEN TG_OP = 'INSERT' THEN
                    COALESCE(
                        p.reference_code,
                        NULLIF(BTRIM(source.item->>'reference_code'), ''),
                        ''
                    )
                ELSE
                    COALESCE(
                        NULLIF(BTRIM(source.item->>'reference_code'), ''),
                        p.reference_code,
                        ''
                    )
                END,
                'thumbnail_url', CASE WHEN TG_OP = 'INSERT' THEN
                    COALESCE(
                        NULLIF(BTRIM(TO_JSONB(p.image_urls)->>0), ''),
                        NULLIF(BTRIM(source.item->>'thumbnail_url'), ''),
                        NULLIF(BTRIM(source.item->>'image_url'), ''),
                        ''
                    )
                ELSE
                    COALESCE(
                        NULLIF(BTRIM(source.item->>'thumbnail_url'), ''),
                        NULLIF(BTRIM(source.item->>'image_url'), ''),
                        NULLIF(BTRIM(TO_JSONB(p.image_urls)->>0), ''),
                        ''
                    )
                END
            )
            ORDER BY source.ordinality
        ),
        '[]'::JSONB
    )
    INTO NEW.items
    FROM JSONB_ARRAY_ELEMENTS(NEW.items) WITH ORDINALITY AS source(item, ordinality)
    LEFT JOIN public.mainspring_products AS p
      ON p.id = CASE
          WHEN source.item->>'id' ~ '^[0-9]+$' THEN (source.item->>'id')::BIGINT
          ELSE NULL
      END;

    SELECT COALESCE(
        ARRAY_AGG(DISTINCT reference_code ORDER BY reference_code),
        ARRAY[]::TEXT[]
    )
    INTO NEW.reference_codes
    FROM (
        SELECT NULLIF(BTRIM(item->>'reference_code'), '') AS reference_code
        FROM JSONB_ARRAY_ELEMENTS(NEW.items) AS item
    ) AS item_references
    WHERE reference_code IS NOT NULL;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_mainspring_order_item_identifiers_trigger
    ON public.mainspring_orders;
CREATE TRIGGER set_mainspring_order_item_identifiers_trigger
    BEFORE INSERT OR UPDATE OF items ON public.mainspring_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.set_mainspring_order_item_identifiers();

CREATE OR REPLACE FUNCTION public.set_mainspring_history_reference_codes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    SELECT o.reference_codes
    INTO NEW.reference_codes
    FROM public.mainspring_orders AS o
    WHERE o.id = NEW.order_id;

    NEW.reference_codes := COALESCE(NEW.reference_codes, ARRAY[]::TEXT[]);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_mainspring_history_reference_codes_trigger
    ON public.mainspring_order_status_history;
CREATE TRIGGER set_mainspring_history_reference_codes_trigger
    BEFORE INSERT OR UPDATE OF order_id ON public.mainspring_order_status_history
    FOR EACH ROW
    EXECUTE FUNCTION public.set_mainspring_history_reference_codes();

CREATE OR REPLACE FUNCTION public.set_mainspring_email_event_reference_codes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    SELECT o.reference_codes
    INTO NEW.reference_codes
    FROM public.mainspring_orders AS o
    WHERE o.id = NEW.order_id;

    NEW.reference_codes := COALESCE(NEW.reference_codes, ARRAY[]::TEXT[]);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_mainspring_email_event_reference_codes_trigger
    ON public.mainspring_order_email_events;
CREATE TRIGGER set_mainspring_email_event_reference_codes_trigger
    BEFORE INSERT OR UPDATE OF order_id ON public.mainspring_order_email_events
    FOR EACH ROW
    EXECUTE FUNCTION public.set_mainspring_email_event_reference_codes();

-- Cash orders intentionally use the same authoritative pricing, locking, and
-- discount-redemption path as bank transfer. The temporary bank-transfer value
-- exists only inside this transaction; it is changed before the RPC returns.
CREATE OR REPLACE FUNCTION public.create_mainspring_cash_order(
    p_order_ref TEXT,
    p_customer_name TEXT,
    p_customer_email TEXT,
    p_customer_phone TEXT,
    p_customer_address TEXT,
    p_items JSONB,
    p_payment_method TEXT,
    p_device_type TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_discount_code TEXT DEFAULT NULL
)
RETURNS TABLE (
    order_ref TEXT,
    subtotal_aed NUMERIC,
    discount_code TEXT,
    discount_aed NUMERIC,
    discounted_subtotal_aed NUMERIC,
    total_aed NUMERIC,
    payment_method TEXT,
    surcharge_pct NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order RECORD;
    v_order_id UUID;
BEGIN
    IF p_payment_method <> 'cash_in_store' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Invalid payment method';
    END IF;

    IF NULLIF(BTRIM(COALESCE(p_discount_code, '')), '') IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Discount codes are not available for cash orders';
    END IF;

    SELECT *
    INTO v_order
    FROM public.create_mainspring_order(
        p_order_ref,
        p_customer_name,
        p_customer_email,
        p_customer_phone,
        p_customer_address,
        p_items,
        'bank_transfer',
        p_device_type,
        p_user_agent,
        NULL
    );

    UPDATE public.mainspring_orders AS o
    SET payment_method = 'cash_in_store'
    WHERE o.order_ref = v_order.order_ref
    RETURNING o.id INTO v_order_id;

    IF v_order_id IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Cash order could not be finalized';
    END IF;

    UPDATE public.mainspring_order_status_history AS h
    SET note = REPLACE(h.note, 'bank_transfer', 'cash_in_store')
    WHERE h.order_id = v_order_id
      AND h.note LIKE 'Order created via bank_transfer%';

    RETURN QUERY SELECT
        v_order.order_ref::TEXT,
        v_order.subtotal_aed::NUMERIC,
        v_order.discount_code::TEXT,
        v_order.discount_aed::NUMERIC,
        v_order.discounted_subtotal_aed::NUMERIC,
        v_order.total_aed::NUMERIC,
        'cash_in_store'::TEXT,
        v_order.surcharge_pct::NUMERIC;
END;
$$;

-- Ziina attempts are noisy before payment. Bank-transfer and cash orders still
-- notify the owner immediately; Ziina notifies the owner only through the paid
-- transition handled by enqueue_mainspring_payment_confirmed_emails().
CREATE OR REPLACE FUNCTION public.enqueue_mainspring_order_created_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.payment_method <> 'ziina' THEN
        INSERT INTO public.mainspring_order_email_events (order_id, event_type)
        VALUES (NEW.id, 'order_created_business')
        ON CONFLICT (order_id, event_type) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

-- Remove unsent Ziina creation notices already queued before this routing rule.
DELETE FROM public.mainspring_order_email_events AS e
USING public.mainspring_orders AS o
WHERE e.order_id = o.id
  AND e.event_type = 'order_created_business'
  AND o.payment_method = 'ziina'
  AND e.status IN ('pending', 'processing', 'failed');

-- Include the durable identifiers in every claimed email snapshot. Item-level
-- reference_code and thumbnail_url values come from the immutable order items.
CREATE OR REPLACE FUNCTION public.claim_mainspring_order_email_events(
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    event_id UUID,
    event_type TEXT,
    attempts INTEGER,
    order_data JSONB
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH candidates AS (
        SELECT e.id
        FROM public.mainspring_order_email_events AS e
        JOIN public.mainspring_orders AS o ON o.id = e.order_id
        WHERE e.attempts < 8
          AND NOT (
              e.event_type = 'order_created_business'
              AND o.payment_method = 'ziina'
          )
          AND (
              (e.status IN ('pending', 'failed') AND e.next_attempt_at <= NOW())
              OR (
                  e.status = 'processing'
                  AND e.locked_at <= NOW() - INTERVAL '15 minutes'
              )
          )
        ORDER BY e.created_at, e.id
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(p_limit, 1), 50)
    ), claimed AS (
        UPDATE public.mainspring_order_email_events AS e
        SET status = 'processing',
            attempts = e.attempts + 1,
            locked_at = NOW(),
            updated_at = NOW()
        FROM candidates AS c
        WHERE e.id = c.id
        RETURNING e.id, e.order_id, e.event_type, e.attempts
    )
    SELECT
        c.id,
        c.event_type,
        c.attempts,
        JSONB_BUILD_OBJECT(
            'order_ref', o.order_ref,
            'reference_codes', o.reference_codes,
            'customer_name', o.customer_name,
            'customer_email', o.customer_email,
            'customer_phone', o.customer_phone,
            'customer_address', o.customer_address,
            'items', o.items,
            'subtotal_aed', o.subtotal_aed,
            'discount_code', o.discount_code,
            'discount_type', o.discount_type,
            'discount_value', o.discount_value,
            'discount_aed', o.discount_aed,
            'discounted_subtotal_aed', o.discounted_subtotal_aed,
            'surcharge_pct', o.surcharge_pct,
            'total_aed', o.total_aed,
            'payment_method', o.payment_method,
            'payment_status', o.payment_status,
            'order_status', o.order_status,
            'created_at', o.created_at
        )
    FROM claimed AS c
    JOIN public.mainspring_orders AS o ON o.id = c.order_id;
$$;

REVOKE ALL ON FUNCTION public.set_mainspring_order_item_identifiers()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_mainspring_history_reference_codes()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_mainspring_email_event_reference_codes()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_mainspring_cash_order(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_mainspring_order_created_email()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_mainspring_order_email_events(INTEGER)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_mainspring_cash_order(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_mainspring_order_email_events(INTEGER)
    TO service_role;

COMMIT;

-- Backfill outside the schema transaction so production writes are not held for
-- the duration of all historical row updates. Existing snapshots always win;
-- product data fills only fields that were never stored on the order.
UPDATE public.mainspring_orders
SET items = items
WHERE EXISTS (
    SELECT 1
    FROM JSONB_ARRAY_ELEMENTS(items) AS item
    WHERE NULLIF(BTRIM(item->>'reference_code'), '') IS NULL
       OR (
           NULLIF(BTRIM(item->>'thumbnail_url'), '') IS NULL
           AND NULLIF(BTRIM(item->>'image_url'), '') IS NULL
       )
);

UPDATE public.mainspring_order_status_history AS h
SET reference_codes = o.reference_codes
FROM public.mainspring_orders AS o
WHERE o.id = h.order_id
  AND h.reference_codes IS DISTINCT FROM o.reference_codes;

UPDATE public.mainspring_order_email_events AS e
SET reference_codes = o.reference_codes
FROM public.mainspring_orders AS o
WHERE o.id = e.order_id
  AND e.reference_codes IS DISTINCT FROM o.reference_codes;

NOTIFY pgrst, 'reload schema';

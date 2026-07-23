-- Atomic inventory reservations for Mainspring checkout.
-- Apply this migration before deploying the matching mainspring-payments service.

BEGIN;

ALTER TABLE public.mainspring_products
    ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reserved_by_order_id UUID,
    ADD COLUMN IF NOT EXISTS reservation_previous_status TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'mainspring_products_reserved_by_order_id_fkey'
          AND conrelid = 'public.mainspring_products'::regclass
    ) THEN
        ALTER TABLE public.mainspring_products
            ADD CONSTRAINT mainspring_products_reserved_by_order_id_fkey
            FOREIGN KEY (reserved_by_order_id)
            REFERENCES public.mainspring_orders(id)
            ON DELETE SET NULL;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_mainspring_products_reservation_expiry
    ON public.mainspring_products (reservation_expires_at)
    WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_mainspring_products_reserved_order
    ON public.mainspring_products (reserved_by_order_id)
    WHERE reserved_by_order_id IS NOT NULL;

-- Preserve historical payment values while allowing the new in-store method.
-- New orders can only be created through the RPC below, whose whitelist contains
-- bank_transfer, ziina, and cash_in_store.
ALTER TABLE public.mainspring_orders
    DROP CONSTRAINT IF EXISTS mainspring_orders_payment_method_check;
ALTER TABLE public.mainspring_orders
    ADD CONSTRAINT mainspring_orders_payment_method_check
    CHECK (payment_method IN (
        'bank_transfer', 'ziina', 'cash_in_store',
        'cash', 'tap_card', 'tabby', 'tamara'
    ));

CREATE OR REPLACE FUNCTION public.release_expired_mainspring_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_released INTEGER := 0;
BEGIN
    WITH expired AS (
        SELECT p.id, p.reserved_by_order_id
        FROM public.mainspring_products AS p
        JOIN public.mainspring_orders AS o
          ON o.id = p.reserved_by_order_id
        WHERE p.status = 'reserved'
          AND p.reservation_expires_at IS NOT NULL
          AND p.reservation_expires_at <= NOW()
          AND o.payment_status = 'pending'
        ORDER BY p.id
        FOR UPDATE OF p
    ), released AS (
        UPDATE public.mainspring_products AS p
        SET status = COALESCE(p.reservation_previous_status, 'available'),
            reservation_expires_at = NULL,
            reserved_by_order_id = NULL,
            reservation_previous_status = NULL,
            updated_at = NOW()
        FROM expired
        WHERE p.id = expired.id
        RETURNING expired.reserved_by_order_id
    )
    SELECT COUNT(*) INTO v_released FROM released;

    UPDATE public.mainspring_orders AS o
    SET payment_status = 'cancelled',
        order_status = 'cancelled',
        notes = CONCAT_WS(E'\n', NULLIF(o.notes, ''), 'Reservation expired after one hour.'),
        updated_at = NOW()
    WHERE o.payment_status = 'pending'
      AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(o.items) AS item
          JOIN public.mainspring_products AS p
            ON p.id = (item->>'id')::BIGINT
          WHERE p.reserved_by_order_id IS NULL
            AND p.reservation_expires_at IS NULL
      )
      AND o.created_at <= NOW() - INTERVAL '1 hour';

    RETURN v_released;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_mainspring_order_with_reservation(
    p_order_ref TEXT,
    p_customer_name TEXT,
    p_customer_email TEXT,
    p_customer_phone TEXT,
    p_customer_address TEXT,
    p_items JSONB,
    p_payment_method TEXT,
    p_device_type TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE (
    order_ref TEXT,
    total_aed NUMERIC,
    payment_method TEXT,
    surcharge_pct NUMERIC,
    reservation_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order_id UUID;
    v_product_ids BIGINT[];
    v_requested_count INTEGER;
    v_locked_count INTEGER;
    v_subtotal NUMERIC(12, 2);
    v_surcharge NUMERIC(5, 2);
    v_total NUMERIC(12, 2);
    v_items JSONB;
    v_reservation_expires_at TIMESTAMPTZ := NOW() + INTERVAL '1 hour';
BEGIN
    IF p_payment_method NOT IN ('bank_transfer', 'ziina', 'cash_in_store') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid payment method';
    END IF;

    IF NULLIF(BTRIM(p_order_ref), '') IS NULL
       OR NULLIF(BTRIM(p_customer_name), '') IS NULL
       OR NULLIF(BTRIM(p_customer_phone), '') IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Missing required customer or order fields';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Order must contain at least one product';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS item
        WHERE (item->>'id') IS NULL
           OR (item->>'id') !~ '^[0-9]+$'
           OR COALESCE((item->>'qty')::INTEGER, 1) <> 1
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Each inventory record can only be purchased once';
    END IF;

    SELECT ARRAY_AGG(DISTINCT (item->>'id')::BIGINT ORDER BY (item->>'id')::BIGINT),
           COUNT(*)
    INTO v_product_ids, v_requested_count
    FROM jsonb_array_elements(p_items) AS item;

    IF CARDINALITY(v_product_ids) <> v_requested_count THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate products are not allowed';
    END IF;

    PERFORM public.release_expired_mainspring_reservations();

    -- Lock every requested record in a deterministic order. Concurrent buyers
    -- for the same watch serialize here; only the first transaction can reserve it.
    SELECT COUNT(*)
    INTO v_locked_count
    FROM (
        SELECT p.id
        FROM public.mainspring_products AS p
        WHERE p.id = ANY(v_product_ids)
        ORDER BY p.id
        FOR UPDATE
    ) AS locked_products;

    IF v_locked_count <> v_requested_count THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'One or more products no longer exist';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.mainspring_products AS p
        WHERE p.id = ANY(v_product_ids)
          AND p.status NOT IN ('available', 'active')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'One or more products are already sold or reserved';
    END IF;

    SELECT COALESCE(SUM(p.price), 0),
           jsonb_agg(
               jsonb_build_object(
                   'id', p.id,
                   'brand', COALESCE(p.brand, ''),
                   'name', COALESCE(NULLIF(p.model, ''), p.name, ''),
                   'price', p.price,
                   'qty', 1
               )
               ORDER BY p.id
           )
    INTO v_subtotal, v_items
    FROM public.mainspring_products AS p
    WHERE p.id = ANY(v_product_ids);

    IF v_subtotal <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Order total must be greater than zero';
    END IF;

    v_surcharge := CASE WHEN p_payment_method = 'ziina' THEN 3.00 ELSE 0.00 END;
    v_total := ROUND(v_subtotal * (1 + v_surcharge / 100), 0);

    INSERT INTO public.mainspring_orders (
        order_ref,
        customer_name,
        customer_email,
        customer_phone,
        customer_address,
        items,
        subtotal_aed,
        surcharge_pct,
        total_aed,
        payment_method,
        payment_status,
        order_status,
        device_type,
        user_agent
    ) VALUES (
        LEFT(BTRIM(p_order_ref), 100),
        LEFT(BTRIM(p_customer_name), 200),
        NULLIF(LEFT(BTRIM(COALESCE(p_customer_email, '')), 200), ''),
        LEFT(BTRIM(p_customer_phone), 20),
        NULLIF(LEFT(BTRIM(COALESCE(p_customer_address, '')), 500), ''),
        v_items,
        v_subtotal,
        v_surcharge,
        v_total,
        p_payment_method,
        'pending',
        'pending',
        LEFT(COALESCE(p_device_type, ''), 20),
        LEFT(COALESCE(p_user_agent, ''), 500)
    )
    RETURNING id INTO v_order_id;

    UPDATE public.mainspring_products AS p
    SET reservation_previous_status = p.status,
        status = 'reserved',
        reservation_expires_at = v_reservation_expires_at,
        reserved_by_order_id = v_order_id,
        updated_at = NOW()
    WHERE p.id = ANY(v_product_ids);

    INSERT INTO public.mainspring_order_status_history (
        order_id, old_status, new_status, changed_by, note
    ) VALUES (
        v_order_id, NULL, 'pending', 'system',
        CONCAT('Order created via ', p_payment_method, '; inventory reserved for one hour')
    );

    RETURN QUERY
    SELECT p_order_ref, v_total, p_payment_method, v_surcharge, v_reservation_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_mainspring_inventory_from_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_expected INTEGER;
    v_reserved INTEGER;
BEGIN
    IF NEW.payment_status IS NOT DISTINCT FROM OLD.payment_status THEN
        RETURN NEW;
    END IF;

    IF NEW.payment_status = 'processing' THEN
        -- Once a hosted card session exists, keep its inventory lock until the
        -- verified webhook reports paid, failed, or cancelled.
        UPDATE public.mainspring_products
        SET reservation_expires_at = NULL,
            updated_at = NOW()
        WHERE reserved_by_order_id = NEW.id
          AND status = 'reserved';
        RETURN NEW;
    END IF;

    IF NEW.payment_status = 'paid' THEN
        SELECT jsonb_array_length(NEW.items), COUNT(*)
        INTO v_expected, v_reserved
        FROM public.mainspring_products AS p
        WHERE p.id IN (
            SELECT (item->>'id')::BIGINT
            FROM jsonb_array_elements(NEW.items) AS item
        )
          AND p.reserved_by_order_id = NEW.id
          AND p.status = 'reserved'
        FOR UPDATE;

        IF v_reserved <> v_expected THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Inventory is no longer reserved for this order; manual payment review required';
        END IF;

        UPDATE public.mainspring_products
        SET status = 'sold',
            sold_at = COALESCE(sold_at, NOW()),
            sold_price = COALESCE(sold_price, price),
            reservation_expires_at = NULL,
            reserved_by_order_id = NULL,
            reservation_previous_status = NULL,
            updated_at = NOW()
        WHERE reserved_by_order_id = NEW.id;

        NEW.order_status := 'confirmed';
        RETURN NEW;
    END IF;

    IF NEW.payment_status IN ('failed', 'cancelled') AND OLD.payment_status <> 'paid' THEN
        UPDATE public.mainspring_products
        SET status = COALESCE(reservation_previous_status, 'available'),
            reservation_expires_at = NULL,
            reserved_by_order_id = NULL,
            reservation_previous_status = NULL,
            updated_at = NOW()
        WHERE reserved_by_order_id = NEW.id
          AND status = 'reserved';

        IF NEW.payment_status = 'cancelled' THEN
            NEW.order_status := 'cancelled';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_mainspring_inventory_from_order_trigger
    ON public.mainspring_orders;
CREATE TRIGGER sync_mainspring_inventory_from_order_trigger
    BEFORE UPDATE OF payment_status ON public.mainspring_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_mainspring_inventory_from_order();

-- Orders must be created through the server-side RPC so price lookup, row locks,
-- the order insert, and inventory reservation remain one transaction.
DROP POLICY IF EXISTS "Allow anonymous order creation" ON public.mainspring_orders;
REVOKE INSERT ON public.mainspring_orders FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.release_expired_mainspring_reservations()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_mainspring_reservations()
    TO service_role;

COMMIT;

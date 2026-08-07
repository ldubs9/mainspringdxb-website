-- Remove inventory reservations from checkout.
-- Orders remain available while payment is pending or processing. Inventory is
-- marked sold only by the verified paid-payment transition below.
-- Apply after 20260801_discount_codes.sql and deploy the matching payments service.

BEGIN;

-- Stop the deployed reservation trigger and functions before removing the
-- columns they reference.
DROP TRIGGER IF EXISTS sync_mainspring_inventory_from_order_trigger
    ON public.mainspring_orders;
DROP FUNCTION IF EXISTS public.sync_mainspring_inventory_from_order();
DROP FUNCTION IF EXISTS public.release_expired_mainspring_reservations();

-- A paid order must not be silently released during this migration. Surface
-- that inconsistent state for manual payment review instead.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.mainspring_products AS p
        WHERE p.status = 'reserved'
          AND EXISTS (
              SELECT 1
              FROM public.mainspring_orders AS o
              WHERE o.payment_status = 'paid'
                AND EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(o.items) AS item
                    WHERE (item->>'id') ~ '^[0-9]+$'
                      AND (item->>'id')::BIGINT = p.id
                )
          )
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'A paid order still references reserved inventory; manual payment review required';
    END IF;
END;
$$;

-- Release legacy holds because this migration removes the concept entirely.
-- Preserve the prior live state when it is known; otherwise make the product
-- available rather than leaving an unusable legacy status behind.
UPDATE public.mainspring_products
SET status = CASE
        WHEN reservation_previous_status IN ('available', 'active') THEN reservation_previous_status
        ELSE 'available'
    END,
    reservation_expires_at = NULL,
    reserved_by_order_id = NULL,
    reservation_previous_status = NULL,
    updated_at = NOW()
WHERE status = 'reserved';

DROP INDEX IF EXISTS idx_mainspring_products_reservation_expiry;
DROP INDEX IF EXISTS idx_mainspring_products_reserved_order;
ALTER TABLE public.mainspring_products
    DROP CONSTRAINT IF EXISTS mainspring_products_reserved_by_order_id_fkey,
    DROP COLUMN IF EXISTS reservation_expires_at,
    DROP COLUMN IF EXISTS reserved_by_order_id,
    DROP COLUMN IF EXISTS reservation_previous_status;

-- Remove both historical implementations. Compatibility wrappers are recreated
-- below so a staggered service rollout cannot invoke reservation behavior or
-- fail while the new payment service is being deployed.
DROP FUNCTION IF EXISTS public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
);
DROP FUNCTION IF EXISTS public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION public.create_mainspring_order(
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
    v_order_id UUID;
    v_product_ids BIGINT[];
    v_requested_count INTEGER;
    v_locked_count INTEGER;
    v_subtotal NUMERIC(12, 2);
    v_surcharge NUMERIC(5, 2);
    v_total NUMERIC(12, 2);
    v_items JSONB;
    v_code TEXT := public.normalize_mainspring_discount_code(p_discount_code);
    v_discount public.mainspring_discount_codes%ROWTYPE;
    v_validation RECORD;
    v_discount_aed NUMERIC(12, 2) := 0;
    v_discounted_subtotal NUMERIC(12, 2);
    v_customer_phone TEXT;
BEGIN
    IF p_payment_method NOT IN ('bank_transfer', 'ziina') THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Invalid payment method';
    END IF;

    IF NULLIF(BTRIM(p_order_ref), '') IS NULL
       OR NULLIF(BTRIM(p_customer_name), '') IS NULL
       OR NULLIF(BTRIM(p_customer_phone), '') IS NULL
       OR NULLIF(BTRIM(p_customer_email), '') IS NULL
       OR NULLIF(BTRIM(p_customer_address), '') IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Missing required customer or order fields';
    END IF;

    IF p_items IS NULL
       OR jsonb_typeof(p_items) <> 'array'
       OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Order must contain at least one product';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS item
        WHERE item->>'id' IS NULL
           OR item->>'id' !~ '^[0-9]+$'
           OR COALESCE(item->>'qty', '1') <> '1'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Each inventory record can only be purchased once';
    END IF;

    SELECT
        ARRAY_AGG(DISTINCT (item->>'id')::BIGINT ORDER BY (item->>'id')::BIGINT),
        COUNT(*)
    INTO v_product_ids, v_requested_count
    FROM jsonb_array_elements(p_items) AS item;

    IF CARDINALITY(v_product_ids) <> v_requested_count THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Duplicate products are not allowed';
    END IF;

    -- Lock only for the duration of this order write so prices and product
    -- descriptions are read consistently. No product status is changed here.
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
        RAISE EXCEPTION USING
            ERRCODE = 'P0002',
            MESSAGE = 'One or more products no longer exist';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.mainspring_products AS p
        WHERE p.id = ANY(v_product_ids)
          AND p.status NOT IN ('available', 'active')
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'One or more products are no longer available';
    END IF;

    SELECT
        COALESCE(SUM(p.price), 0),
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
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
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Order total must be greater than zero';
    END IF;

    v_customer_phone := NULLIF(
        REGEXP_REPLACE(COALESCE(p_customer_phone, ''), '[^0-9]', '', 'g'),
        ''
    );

    IF v_code IS NOT NULL THEN
        SELECT d.*
        INTO v_discount
        FROM public.mainspring_discount_codes AS d
        WHERE d.code = v_code
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                ERRCODE = '22023',
                MESSAGE = 'This discount code is not valid';
        END IF;

        SELECT *
        INTO v_validation
        FROM public.validate_mainspring_discount(
            v_code,
            p_items,
            v_customer_phone
        );

        IF v_validation.valid IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION USING
                ERRCODE = '22023',
                MESSAGE = COALESCE(v_validation.message, 'This discount code is not valid');
        END IF;

        v_discount_aed := v_validation.discount_aed;
    ELSIF NULLIF(BTRIM(COALESCE(p_discount_code, '')), '') IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'This discount code is not valid';
    END IF;

    v_discounted_subtotal := v_subtotal - v_discount_aed;
    v_surcharge := CASE WHEN p_payment_method = 'ziina' THEN 3.00 ELSE 0.00 END;
    v_total := ROUND(v_discounted_subtotal * (1 + v_surcharge / 100), 0);

    IF v_discounted_subtotal <= 0
       OR (p_payment_method = 'ziina' AND v_total < 2) THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Discount leaves the order below the permitted payment minimum';
    END IF;

    INSERT INTO public.mainspring_orders (
        order_ref,
        customer_name,
        customer_email,
        customer_phone,
        customer_address,
        items,
        subtotal_aed,
        discount_code_id,
        discount_code,
        discount_type,
        discount_value,
        discount_aed,
        discounted_subtotal_aed,
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
        LEFT(BTRIM(p_customer_email), 200),
        LEFT(BTRIM(p_customer_phone), 20),
        LEFT(BTRIM(p_customer_address), 500),
        v_items,
        v_subtotal,
        CASE WHEN v_code IS NULL THEN NULL ELSE v_discount.id END,
        v_code,
        CASE WHEN v_code IS NULL THEN NULL ELSE v_discount.discount_type END,
        CASE WHEN v_code IS NULL THEN NULL ELSE v_discount.discount_value END,
        v_discount_aed,
        v_discounted_subtotal,
        v_surcharge,
        v_total,
        p_payment_method,
        'pending',
        'pending',
        LEFT(COALESCE(p_device_type, ''), 20),
        LEFT(COALESCE(p_user_agent, ''), 500)
    )
    RETURNING id INTO v_order_id;

    IF v_code IS NOT NULL THEN
        INSERT INTO public.mainspring_discount_redemptions (
            discount_code_id,
            order_id,
            customer_phone_normalized,
            discount_aed,
            status
        ) VALUES (
            v_discount.id,
            v_order_id,
            v_customer_phone,
            v_discount_aed,
            'reserved'
        );
    END IF;

    INSERT INTO public.mainspring_order_status_history (
        order_id,
        old_status,
        new_status,
        changed_by,
        note
    ) VALUES (
        v_order_id,
        NULL,
        'pending',
        'system',
        CONCAT(
            'Order created via ',
            p_payment_method,
            '; inventory remains available until payment is confirmed',
            CASE WHEN v_code IS NULL THEN '' ELSE CONCAT('; discount ', v_code, ' applied') END
        )
    );

    RETURN QUERY SELECT
        LEFT(BTRIM(p_order_ref), 100),
        v_subtotal,
        v_code,
        v_discount_aed,
        v_discounted_subtotal,
        v_total,
        p_payment_method,
        v_surcharge;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_mainspring_inventory_sold_on_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_expected INTEGER;
    v_distinct INTEGER;
    v_found INTEGER;
    v_available INTEGER;
    v_sold INTEGER;
BEGIN
    IF NEW.payment_status IS NOT DISTINCT FROM OLD.payment_status THEN
        RETURN NEW;
    END IF;

    IF NEW.payment_status <> 'paid' THEN
        RETURN NEW;
    END IF;

    IF NEW.items IS NULL
       OR jsonb_typeof(NEW.items) <> 'array'
       OR jsonb_array_length(NEW.items) = 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Paid order has invalid inventory items; manual payment review required';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.items) AS item
        WHERE item->>'id' IS NULL
           OR item->>'id' !~ '^[0-9]+$'
           OR COALESCE(item->>'qty', '1') <> '1'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Paid order has invalid inventory items; manual payment review required';
    END IF;

    SELECT COUNT(*), COUNT(DISTINCT (item->>'id')::BIGINT)
    INTO v_expected, v_distinct
    FROM jsonb_array_elements(NEW.items) AS item;

    IF v_expected <> v_distinct THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Paid order contains duplicate inventory records; manual payment review required';
    END IF;

    -- Lock all referenced rows in a deterministic order. If another paid
    -- transition wins the race, this transaction waits and then sees the sold
    -- status instead of creating a second sale.
    PERFORM p.id
    FROM public.mainspring_products AS p
    WHERE p.id IN (
        SELECT (item->>'id')::BIGINT
        FROM jsonb_array_elements(NEW.items) AS item
    )
    ORDER BY p.id
    FOR UPDATE;

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE p.status IN ('available', 'active'))
    INTO v_found, v_available
    FROM public.mainspring_products AS p
    WHERE p.id IN (
        SELECT (item->>'id')::BIGINT
        FROM jsonb_array_elements(NEW.items) AS item
    );

    IF v_found <> v_expected OR v_available <> v_expected THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Inventory is no longer available for this paid order; manual payment review required';
    END IF;

    UPDATE public.mainspring_products AS p
    SET status = 'sold',
        sold_at = COALESCE(p.sold_at, NOW()),
        sold_price = COALESCE(p.sold_price, p.price),
        updated_at = NOW()
    WHERE p.id IN (
        SELECT (item->>'id')::BIGINT
        FROM jsonb_array_elements(NEW.items) AS item
    )
      AND p.status IN ('available', 'active');

    GET DIAGNOSTICS v_sold = ROW_COUNT;
    IF v_sold <> v_expected THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Inventory sale could not be completed; manual payment review required';
    END IF;

    NEW.order_status := 'confirmed';
    RETURN NEW;
END;
$$;

-- Backward-compatible RPC shapes for an already-running service. These wrappers
-- delegate to the new order function and always return a null legacy field;
-- they never change inventory state.
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        result.order_ref,
        result.total_aed,
        result.payment_method,
        result.surcharge_pct,
        NULL::TIMESTAMPTZ
    FROM public.create_mainspring_order(
        p_order_ref,
        p_customer_name,
        p_customer_email,
        p_customer_phone,
        p_customer_address,
        p_items,
        p_payment_method,
        p_device_type,
        p_user_agent,
        NULL
    ) AS result;
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
    surcharge_pct NUMERIC,
    reservation_expires_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        result.order_ref,
        result.subtotal_aed,
        result.discount_code,
        result.discount_aed,
        result.discounted_subtotal_aed,
        result.total_aed,
        result.payment_method,
        result.surcharge_pct,
        NULL::TIMESTAMPTZ
    FROM public.create_mainspring_order(
        p_order_ref,
        p_customer_name,
        p_customer_email,
        p_customer_phone,
        p_customer_address,
        p_items,
        p_payment_method,
        p_device_type,
        p_user_agent,
        p_discount_code
    ) AS result;
$$;

DROP TRIGGER IF EXISTS mark_mainspring_inventory_sold_on_payment_trigger
    ON public.mainspring_orders;
CREATE TRIGGER mark_mainspring_inventory_sold_on_payment_trigger
    BEFORE UPDATE OF payment_status ON public.mainspring_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.mark_mainspring_inventory_sold_on_payment();

-- Orders remain server-only, but the RPC no longer changes inventory during
-- order creation. Only the trusted payment update can finalize a sale.
DROP POLICY IF EXISTS "Allow anonymous order creation" ON public.mainspring_orders;
REVOKE INSERT ON public.mainspring_orders FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_mainspring_order(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_mainspring_order(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.mark_mainspring_inventory_sold_on_payment()
    FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

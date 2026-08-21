-- Replace the 3% card surcharge with a 5% VAT charged on every order.
-- Historical orders keep their stored surcharge_pct so past totals stay
-- explainable; new orders record vat_pct instead and leave surcharge_pct at 0.
-- Apply after 20260809_cash_constraint_and_ziina_notice.sql.

BEGIN;

ALTER TABLE public.mainspring_orders
    ADD COLUMN IF NOT EXISTS vat_pct NUMERIC(5, 2) NOT NULL DEFAULT 0;

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
    v_vat NUMERIC(5, 2);
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

    -- VAT applies to every payment method; the former card-only surcharge is gone.
    v_discounted_subtotal := v_subtotal - v_discount_aed;
    v_vat := 5.00;
    v_total := ROUND(v_discounted_subtotal * (1 + v_vat / 100), 0);

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
        vat_pct,
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
        0.00,
        v_vat,
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
        0.00::NUMERIC;
END;
$$;

-- Email snapshots need the VAT rate so transactional emails can itemize it.
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
            'vat_pct', o.vat_pct,
            'total_aed', o.total_aed,
            'payment_method', o.payment_method,
            'payment_status', o.payment_status,
            'order_status', o.order_status,
            'created_at', o.created_at
        )
    FROM claimed AS c
    JOIN public.mainspring_orders AS o ON o.id = c.order_id;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';

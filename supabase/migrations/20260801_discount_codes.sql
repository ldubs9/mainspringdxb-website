-- Owner-issued discount codes integrated with atomic inventory reservation,
-- payment reconciliation, and the transactional email outbox.
-- Apply after the 20260731 checkout/email/status migrations.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mainspring_discount_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed_aed')),
    discount_value NUMERIC(12, 2) NOT NULL CHECK (discount_value > 0),
    minimum_subtotal_aed NUMERIC(12, 2) NOT NULL DEFAULT 0
        CHECK (minimum_subtotal_aed >= 0),
    maximum_discount_aed NUMERIC(12, 2)
        CHECK (maximum_discount_aed IS NULL OR maximum_discount_aed > 0),
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
    per_customer_limit INTEGER CHECK (per_customer_limit IS NULL OR per_customer_limit > 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'archived')),
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mainspring_discount_code_format_check
        CHECK (code = UPPER(code) AND code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
    CONSTRAINT mainspring_discount_percentage_value_check
        CHECK (discount_type <> 'percentage' OR discount_value <= 100),
    CONSTRAINT mainspring_discount_dates_check
        CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE IF NOT EXISTS public.mainspring_discount_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discount_code_id UUID NOT NULL
        REFERENCES public.mainspring_discount_codes(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL
        CHECK (target_type IN ('product', 'category', 'subcategory')),
    product_id BIGINT REFERENCES public.mainspring_products(id) ON DELETE CASCADE,
    target_value TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mainspring_discount_target_shape_check CHECK (
        (target_type = 'product' AND product_id IS NOT NULL AND target_value IS NULL)
        OR
        (
            target_type IN ('category', 'subcategory')
            AND product_id IS NULL
            AND NULLIF(BTRIM(target_value), '') IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mainspring_discount_target_product
    ON public.mainspring_discount_targets (discount_code_id, product_id)
    WHERE target_type = 'product';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mainspring_discount_target_value
    ON public.mainspring_discount_targets (
        discount_code_id,
        target_type,
        LOWER(target_value)
    )
    WHERE target_type IN ('category', 'subcategory');
CREATE INDEX IF NOT EXISTS idx_mainspring_discount_codes_active_lookup
    ON public.mainspring_discount_codes (code)
    WHERE status = 'active';

ALTER TABLE public.mainspring_orders
    ADD COLUMN IF NOT EXISTS discount_code_id UUID
        REFERENCES public.mainspring_discount_codes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS discount_code TEXT,
    ADD COLUMN IF NOT EXISTS discount_type TEXT,
    ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS discount_aed NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discounted_subtotal_aed NUMERIC(12, 2);

UPDATE public.mainspring_orders
SET discounted_subtotal_aed = subtotal_aed - discount_aed
WHERE discounted_subtotal_aed IS NULL;

-- Preserve compatibility with legacy service-role order writers that predate
-- discounts. The production storefront uses the atomic RPC, but old deployed
-- Edge Functions should continue to create non-discounted orders safely.
CREATE OR REPLACE FUNCTION public.set_mainspring_order_discount_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.discount_aed := COALESCE(NEW.discount_aed, 0);
    IF NEW.discounted_subtotal_aed IS NULL THEN
        NEW.discounted_subtotal_aed := NEW.subtotal_aed - NEW.discount_aed;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_mainspring_order_discount_defaults_trigger
    ON public.mainspring_orders;
CREATE TRIGGER set_mainspring_order_discount_defaults_trigger
    BEFORE INSERT ON public.mainspring_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.set_mainspring_order_discount_defaults();

ALTER TABLE public.mainspring_orders
    ALTER COLUMN discounted_subtotal_aed SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'mainspring_orders_discount_type_check'
          AND conrelid = 'public.mainspring_orders'::regclass
    ) THEN
        ALTER TABLE public.mainspring_orders
            ADD CONSTRAINT mainspring_orders_discount_type_check
            CHECK (discount_type IS NULL OR discount_type IN ('percentage', 'fixed_aed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'mainspring_orders_discount_amount_check'
          AND conrelid = 'public.mainspring_orders'::regclass
    ) THEN
        ALTER TABLE public.mainspring_orders
            ADD CONSTRAINT mainspring_orders_discount_amount_check
            CHECK (
                discount_aed >= 0
                AND discount_aed <= subtotal_aed
                AND discounted_subtotal_aed = subtotal_aed - discount_aed
                AND (
                    (discount_code IS NULL AND discount_type IS NULL AND discount_value IS NULL AND discount_aed = 0)
                    OR
                    (discount_code IS NOT NULL AND discount_type IS NOT NULL AND discount_value IS NOT NULL)
                )
            );
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.mainspring_discount_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discount_code_id UUID NOT NULL
        REFERENCES public.mainspring_discount_codes(id) ON DELETE RESTRICT,
    order_id UUID NOT NULL UNIQUE
        REFERENCES public.mainspring_orders(id) ON DELETE CASCADE,
    customer_phone_normalized TEXT,
    discount_aed NUMERIC(12, 2) NOT NULL CHECK (discount_aed > 0),
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'redeemed', 'released')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    redeemed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mainspring_discount_redemptions_usage
    ON public.mainspring_discount_redemptions (discount_code_id, status);
CREATE INDEX IF NOT EXISTS idx_mainspring_discount_redemptions_customer
    ON public.mainspring_discount_redemptions (
        discount_code_id,
        customer_phone_normalized,
        status
    )
    WHERE customer_phone_normalized IS NOT NULL;

ALTER TABLE public.mainspring_discount_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mainspring_discount_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mainspring_discount_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mainspring_discount_codes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mainspring_discount_targets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mainspring_discount_redemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mainspring_discount_codes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mainspring_discount_targets TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mainspring_discount_redemptions TO service_role;

CREATE OR REPLACE FUNCTION public.normalize_mainspring_discount_code(p_code TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
    SELECT NULLIF(UPPER(REGEXP_REPLACE(BTRIM(p_code), '\s+', '', 'g')), '');
$$;

CREATE OR REPLACE FUNCTION public.set_mainspring_discount_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_mainspring_discount_updated_at_trigger
    ON public.mainspring_discount_codes;
CREATE TRIGGER set_mainspring_discount_updated_at_trigger
    BEFORE UPDATE ON public.mainspring_discount_codes
    FOR EACH ROW
    EXECUTE FUNCTION public.set_mainspring_discount_updated_at();

CREATE OR REPLACE FUNCTION public.validate_mainspring_discount(
    p_code TEXT,
    p_items JSONB,
    p_customer_phone TEXT DEFAULT NULL
)
RETURNS TABLE (
    valid BOOLEAN,
    message TEXT,
    discount_code TEXT,
    discount_type TEXT,
    discount_value NUMERIC,
    subtotal_aed NUMERIC,
    eligible_subtotal_aed NUMERIC,
    discount_aed NUMERIC,
    discounted_subtotal_aed NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_code TEXT := public.normalize_mainspring_discount_code(p_code);
    v_discount public.mainspring_discount_codes%ROWTYPE;
    v_product_ids BIGINT[];
    v_requested_count INTEGER;
    v_found_count INTEGER;
    v_subtotal NUMERIC(12, 2);
    v_eligible_subtotal NUMERIC(12, 2);
    v_discount_aed NUMERIC(12, 2);
    v_customer_phone TEXT := NULLIF(
        REGEXP_REPLACE(COALESCE(p_customer_phone, ''), '[^0-9]', '', 'g'),
        ''
    );
    v_usage_count INTEGER;
BEGIN
    IF v_code IS NULL OR v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$' THEN
        RETURN QUERY SELECT
            FALSE,
            'Enter a valid discount code.',
            v_code,
            NULL::TEXT,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    IF p_items IS NULL
       OR jsonb_typeof(p_items) <> 'array'
       OR jsonb_array_length(p_items) = 0 THEN
        RETURN QUERY SELECT
            FALSE,
            'Your cart is empty.',
            v_code,
            NULL::TEXT,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS item
        WHERE item->>'id' IS NULL
           OR item->>'id' !~ '^[0-9]+$'
           OR COALESCE(item->>'qty', '1') <> '1'
    ) THEN
        RETURN QUERY SELECT
            FALSE,
            'One or more cart items are invalid.',
            v_code,
            NULL::TEXT,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    SELECT
        ARRAY_AGG(DISTINCT (item->>'id')::BIGINT ORDER BY (item->>'id')::BIGINT),
        COUNT(*)
    INTO v_product_ids, v_requested_count
    FROM jsonb_array_elements(p_items) AS item;

    IF CARDINALITY(v_product_ids) <> v_requested_count THEN
        RETURN QUERY SELECT
            FALSE,
            'Duplicate products are not allowed.',
            v_code,
            NULL::TEXT,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    SELECT COUNT(*), COALESCE(SUM(p.price), 0)
    INTO v_found_count, v_subtotal
    FROM public.mainspring_products AS p
    WHERE p.id = ANY(v_product_ids)
      AND p.status IN ('available', 'active');

    IF v_found_count <> v_requested_count THEN
        RETURN QUERY SELECT
            FALSE,
            'One or more items are no longer available.',
            v_code,
            NULL::TEXT,
            NULL::NUMERIC,
            v_subtotal,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    SELECT d.*
    INTO v_discount
    FROM public.mainspring_discount_codes AS d
    WHERE d.code = v_code;

    IF NOT FOUND OR v_discount.status <> 'active' THEN
        RETURN QUERY SELECT
            FALSE,
            'This discount code is not valid.',
            v_code,
            NULL::TEXT,
            NULL::NUMERIC,
            v_subtotal,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    IF v_discount.starts_at IS NOT NULL AND v_discount.starts_at > NOW() THEN
        RETURN QUERY SELECT
            FALSE,
            'This discount code is not active yet.',
            v_code,
            v_discount.discount_type,
            v_discount.discount_value,
            v_subtotal,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    IF v_discount.expires_at IS NOT NULL AND v_discount.expires_at <= NOW() THEN
        RETURN QUERY SELECT
            FALSE,
            'This discount code has expired.',
            v_code,
            v_discount.discount_type,
            v_discount.discount_value,
            v_subtotal,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    SELECT COUNT(*)
    INTO v_usage_count
    FROM public.mainspring_discount_redemptions AS r
    WHERE r.discount_code_id = v_discount.id
      AND r.status IN ('reserved', 'redeemed');

    IF v_discount.usage_limit IS NOT NULL
       AND v_usage_count >= v_discount.usage_limit THEN
        RETURN QUERY SELECT
            FALSE,
            'This discount code has reached its usage limit.',
            v_code,
            v_discount.discount_type,
            v_discount.discount_value,
            v_subtotal,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    IF v_discount.per_customer_limit IS NOT NULL AND v_customer_phone IS NULL THEN
        RETURN QUERY SELECT
            FALSE,
            'Enter your phone number before applying this discount.',
            v_code,
            v_discount.discount_type,
            v_discount.discount_value,
            v_subtotal,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    IF v_discount.per_customer_limit IS NOT NULL THEN
        SELECT COUNT(*)
        INTO v_usage_count
        FROM public.mainspring_discount_redemptions AS r
        WHERE r.discount_code_id = v_discount.id
          AND r.customer_phone_normalized = v_customer_phone
          AND r.status IN ('reserved', 'redeemed');

        IF v_usage_count >= v_discount.per_customer_limit THEN
            RETURN QUERY SELECT
                FALSE,
                'This discount code has already been used for this customer.',
                v_code,
                v_discount.discount_type,
                v_discount.discount_value,
                v_subtotal,
                NULL::NUMERIC,
                NULL::NUMERIC,
                NULL::NUMERIC;
            RETURN;
        END IF;
    END IF;

    IF v_subtotal < v_discount.minimum_subtotal_aed THEN
        RETURN QUERY SELECT
            FALSE,
            CONCAT(
                'This code requires a minimum subtotal of AED ',
                TRIM(TO_CHAR(v_discount.minimum_subtotal_aed, 'FM999999999990.00')),
                '.'
            ),
            v_code,
            v_discount.discount_type,
            v_discount.discount_value,
            v_subtotal,
            NULL::NUMERIC,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.mainspring_discount_targets AS t
        WHERE t.discount_code_id = v_discount.id
    ) THEN
        SELECT COALESCE(SUM(p.price), 0)
        INTO v_eligible_subtotal
        FROM public.mainspring_products AS p
        WHERE p.id = ANY(v_product_ids)
          AND EXISTS (
              SELECT 1
              FROM public.mainspring_discount_targets AS t
              WHERE t.discount_code_id = v_discount.id
                AND (
                    (t.target_type = 'product' AND t.product_id = p.id)
                    OR
                    (
                        t.target_type = 'category'
                        AND LOWER(t.target_value) = LOWER(COALESCE(p.category, ''))
                    )
                    OR
                    (
                        t.target_type = 'subcategory'
                        AND LOWER(t.target_value) = LOWER(COALESCE(p.subcategory, ''))
                    )
                )
          );
    ELSE
        v_eligible_subtotal := v_subtotal;
    END IF;

    IF v_eligible_subtotal <= 0 THEN
        RETURN QUERY SELECT
            FALSE,
            'This code does not apply to the items in your cart.',
            v_code,
            v_discount.discount_type,
            v_discount.discount_value,
            v_subtotal,
            v_eligible_subtotal,
            NULL::NUMERIC,
            NULL::NUMERIC;
        RETURN;
    END IF;

    IF v_discount.discount_type = 'percentage' THEN
        v_discount_aed := ROUND(
            v_eligible_subtotal * v_discount.discount_value / 100,
            2
        );
        IF v_discount.maximum_discount_aed IS NOT NULL THEN
            v_discount_aed := LEAST(
                v_discount_aed,
                v_discount.maximum_discount_aed
            );
        END IF;
    ELSE
        v_discount_aed := LEAST(
            v_discount.discount_value,
            v_eligible_subtotal
        );
    END IF;

    IF v_subtotal - v_discount_aed <= 0 THEN
        RETURN QUERY SELECT
            FALSE,
            'This code would reduce the order total below the permitted minimum.',
            v_code,
            v_discount.discount_type,
            v_discount.discount_value,
            v_subtotal,
            v_eligible_subtotal,
            v_discount_aed,
            v_subtotal - v_discount_aed;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        TRUE,
        'Discount applied.',
        v_code,
        v_discount.discount_type,
        v_discount.discount_value,
        v_subtotal,
        v_eligible_subtotal,
        v_discount_aed,
        v_subtotal - v_discount_aed;
END;
$$;

-- Replace the deployed nine-argument function with a backward-compatible
-- ten-argument version. The final argument has a default, so the currently
-- deployed payments service continues to work during rollout.
DROP FUNCTION IF EXISTS public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
);

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
    v_code TEXT := public.normalize_mainspring_discount_code(p_discount_code);
    v_discount public.mainspring_discount_codes%ROWTYPE;
    v_validation RECORD;
    v_discount_aed NUMERIC(12, 2) := 0;
    v_discounted_subtotal NUMERIC(12, 2);
    v_customer_phone TEXT;
BEGIN
    IF p_payment_method NOT IN ('bank_transfer', 'ziina') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid payment method';
    END IF;

    IF NULLIF(BTRIM(p_order_ref), '') IS NULL
       OR NULLIF(BTRIM(p_customer_name), '') IS NULL
       OR NULLIF(BTRIM(p_customer_email), '') IS NULL
       OR NULLIF(BTRIM(p_customer_phone), '') IS NULL
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

    PERFORM public.release_expired_mainspring_reservations();

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
            MESSAGE = 'One or more products are already sold or reserved';
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

    UPDATE public.mainspring_products AS p
    SET reservation_previous_status = p.status,
        status = 'reserved',
        reservation_expires_at = v_reservation_expires_at,
        reserved_by_order_id = v_order_id,
        updated_at = NOW()
    WHERE p.id = ANY(v_product_ids);

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
            '; inventory reserved for one hour',
            CASE WHEN v_code IS NULL THEN '' ELSE CONCAT('; discount ', v_code, ' applied') END
        )
    );

    RETURN QUERY SELECT
        p_order_ref,
        v_subtotal,
        v_code,
        v_discount_aed,
        v_discounted_subtotal,
        v_total,
        p_payment_method,
        v_surcharge,
        v_reservation_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_mainspring_discount_redemption_from_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.payment_status IS NOT DISTINCT FROM OLD.payment_status THEN
        RETURN NEW;
    END IF;

    IF NEW.payment_status = 'paid' THEN
        UPDATE public.mainspring_discount_redemptions
        SET status = 'redeemed',
            redeemed_at = COALESCE(redeemed_at, NOW()),
            released_at = NULL
        WHERE order_id = NEW.id
          AND status = 'reserved';
    ELSIF NEW.payment_status IN ('failed', 'cancelled')
          AND OLD.payment_status <> 'paid' THEN
        UPDATE public.mainspring_discount_redemptions
        SET status = 'released',
            released_at = COALESCE(released_at, NOW())
        WHERE order_id = NEW.id
          AND status = 'reserved';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_mainspring_discount_redemption_trigger
    ON public.mainspring_orders;
CREATE TRIGGER sync_mainspring_discount_redemption_trigger
    BEFORE UPDATE OF payment_status ON public.mainspring_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_mainspring_discount_redemption_from_order();

-- Preserve discount snapshots in the durable email events. This replaces only
-- the claim function introduced by 20260731_order_email_outbox.sql.
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

REVOKE ALL ON FUNCTION public.normalize_mainspring_discount_code(TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_mainspring_discount_updated_at()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_mainspring_order_discount_defaults()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_mainspring_discount(TEXT, JSONB, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_mainspring_discount_redemption_from_order()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_mainspring_order_email_events(INTEGER)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.normalize_mainspring_discount_code(TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_mainspring_discount(TEXT, JSONB, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.create_mainspring_order_with_reservation(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_mainspring_order_email_events(INTEGER)
    TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

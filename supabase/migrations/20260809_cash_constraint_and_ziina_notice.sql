-- Repair the legacy production payment-method constraint and restore a clearly
-- labelled owner notification when a Ziina order is created but not yet paid.
-- Apply after 20260809_order_reference_codes_and_email_routing.sql.

BEGIN;

-- Production retained this older constraint name, so cash_in_store updates were
-- rejected even though the newer canonical constraint allowed them.
ALTER TABLE public.mainspring_orders
    DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE public.mainspring_orders
    DROP CONSTRAINT IF EXISTS mainspring_orders_payment_method_check;
ALTER TABLE public.mainspring_orders
    ADD CONSTRAINT mainspring_orders_payment_method_check
    CHECK (payment_method IN (
        'bank_transfer', 'ziina', 'cash_in_store',
        'cash', 'tap_card', 'tabby', 'tamara'
    )) NOT VALID;
ALTER TABLE public.mainspring_orders
    VALIDATE CONSTRAINT mainspring_orders_payment_method_check;

-- Every newly created order now queues an owner notice. The payment service
-- explicitly labels Ziina creation notices as unpaid, so they cannot be mistaken
-- for the separate payment-confirmed event.
CREATE OR REPLACE FUNCTION public.enqueue_mainspring_order_created_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.mainspring_order_email_events (order_id, event_type)
    VALUES (NEW.id, 'order_created_business')
    ON CONFLICT (order_id, event_type) DO NOTHING;
    RETURN NEW;
END;
$$;

-- Remove the previous Ziina exclusion while retaining the same locking,
-- retry, snapshot, and batching behavior.
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
            'total_aed', o.total_aed,
            'payment_method', o.payment_method,
            'payment_status', o.payment_status,
            'order_status', o.order_status,
            'created_at', o.created_at
        )
    FROM claimed AS c
    JOIN public.mainspring_orders AS o ON o.id = c.order_id;
$$;

REVOKE ALL ON FUNCTION public.enqueue_mainspring_order_created_email()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_mainspring_order_email_events(INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mainspring_order_email_events(INTEGER)
    TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

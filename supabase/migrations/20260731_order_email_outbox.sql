-- Durable transactional email outbox for order and payment notifications.
-- This migration is independent of the future discount-code feature.
-- Apply before deploying the matching mainspring-payments service.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mainspring_order_email_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.mainspring_orders(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'order_created_business',
        'payment_confirmed_business',
        'payment_confirmed_customer'
    )),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    provider_message_id TEXT,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_mainspring_order_email_events_pending
    ON public.mainspring_order_email_events (next_attempt_at, created_at)
    WHERE status IN ('pending', 'failed', 'processing') AND attempts < 8;

ALTER TABLE public.mainspring_order_email_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mainspring_order_email_events FROM PUBLIC;
REVOKE ALL ON TABLE public.mainspring_order_email_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mainspring_order_email_events TO service_role;

CREATE TABLE IF NOT EXISTS public.mainspring_order_submission_rate_limits (
    limiter_key TEXT NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (limiter_key, window_started_at)
);

ALTER TABLE public.mainspring_order_submission_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mainspring_order_submission_rate_limits FROM PUBLIC;
REVOKE ALL ON TABLE public.mainspring_order_submission_rate_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_mainspring_order_submission_limit(
    p_limiter_key TEXT,
    p_limit INTEGER DEFAULT 10,
    p_window_seconds INTEGER DEFAULT 3600
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_window_started_at TIMESTAMPTZ;
    v_attempts INTEGER;
BEGIN
    IF NULLIF(BTRIM(p_limiter_key), '') IS NULL
       OR p_limit < 1 OR p_limit > 100
       OR p_window_seconds < 60 OR p_window_seconds > 86400 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid rate-limit parameters';
    END IF;

    v_window_started_at := TO_TIMESTAMP(
        FLOOR(EXTRACT(EPOCH FROM CLOCK_TIMESTAMP()) / p_window_seconds) * p_window_seconds
    );

    INSERT INTO public.mainspring_order_submission_rate_limits (
        limiter_key,
        window_started_at,
        attempts,
        updated_at
    )
    VALUES (LEFT(p_limiter_key, 200), v_window_started_at, 1, NOW())
    ON CONFLICT (limiter_key, window_started_at)
    DO UPDATE SET
        attempts = LEAST(
            public.mainspring_order_submission_rate_limits.attempts + 1,
            p_limit + 1
        ),
        updated_at = NOW()
    RETURNING attempts INTO v_attempts;

    DELETE FROM public.mainspring_order_submission_rate_limits
    WHERE window_started_at < v_window_started_at - INTERVAL '1 day';

    RETURN v_attempts <= p_limit;
END;
$$;

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

DROP TRIGGER IF EXISTS enqueue_mainspring_order_created_email_trigger
    ON public.mainspring_orders;
CREATE TRIGGER enqueue_mainspring_order_created_email_trigger
    AFTER INSERT ON public.mainspring_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.enqueue_mainspring_order_created_email();

CREATE OR REPLACE FUNCTION public.enqueue_mainspring_payment_confirmed_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.payment_status IS DISTINCT FROM 'paid'
       AND NEW.payment_status = 'paid' THEN
        INSERT INTO public.mainspring_order_email_events (order_id, event_type)
        VALUES (NEW.id, 'payment_confirmed_business')
        ON CONFLICT (order_id, event_type) DO NOTHING;

        IF NULLIF(BTRIM(COALESCE(NEW.customer_email, '')), '') IS NOT NULL THEN
            INSERT INTO public.mainspring_order_email_events (order_id, event_type)
            VALUES (NEW.id, 'payment_confirmed_customer')
            ON CONFLICT (order_id, event_type) DO NOTHING;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_mainspring_payment_confirmed_emails_trigger
    ON public.mainspring_orders;
CREATE TRIGGER enqueue_mainspring_payment_confirmed_emails_trigger
    AFTER UPDATE OF payment_status ON public.mainspring_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.enqueue_mainspring_payment_confirmed_emails();

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
        jsonb_build_object(
            'order_ref', o.order_ref,
            'customer_name', o.customer_name,
            'customer_email', o.customer_email,
            'customer_phone', o.customer_phone,
            'customer_address', o.customer_address,
            'items', o.items,
            'subtotal_aed', o.subtotal_aed,
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

REVOKE ALL ON FUNCTION public.consume_mainspring_order_submission_limit(TEXT, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_mainspring_order_created_email()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_mainspring_payment_confirmed_emails()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_mainspring_order_email_events(INTEGER)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.consume_mainspring_order_submission_limit(TEXT, INTEGER, INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_mainspring_order_email_events(INTEGER)
    TO service_role;

COMMIT;

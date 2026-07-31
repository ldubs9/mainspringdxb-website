-- Replace the legacy status-history trigger accidentally attached to
-- mainspring_orders. The legacy trigger writes to public.order_status_history;
-- Mainspring orders use public.mainspring_order_status_history.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mainspring_order_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.mainspring_orders(id) ON DELETE CASCADE,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by TEXT NOT NULL DEFAULT 'system',
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mainspring_order_status_history_order_id
    ON public.mainspring_order_status_history (order_id, created_at);

ALTER TABLE public.mainspring_order_status_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mainspring_order_status_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.mainspring_order_status_history TO service_role;

DROP TRIGGER IF EXISTS orders_status_change_trigger
    ON public.mainspring_orders;

CREATE OR REPLACE FUNCTION public.log_mainspring_order_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.order_status IS DISTINCT FROM NEW.order_status THEN
        INSERT INTO public.mainspring_order_status_history (
            order_id, old_status, new_status, changed_by, note
        ) VALUES (
            NEW.id, OLD.order_status, NEW.order_status, 'system',
            'Order status change'
        );
    END IF;

    IF OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
        INSERT INTO public.mainspring_order_status_history (
            order_id, old_status, new_status, changed_by, note
        ) VALUES (
            NEW.id, OLD.payment_status, NEW.payment_status, 'system',
            'Payment status change'
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mainspring_orders_status_change_trigger
    ON public.mainspring_orders;
CREATE TRIGGER mainspring_orders_status_change_trigger
    AFTER UPDATE OF order_status, payment_status ON public.mainspring_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.log_mainspring_order_status_change();

REVOKE ALL ON FUNCTION public.log_mainspring_order_status_change()
    FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

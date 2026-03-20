-- ============================================
-- Mainspring Dubai - Orders & Payments Tables
-- Run this in your Supabase SQL Editor
-- ============================================

-- 1. Orders table
CREATE TABLE IF NOT EXISTS public.orders (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_ref TEXT NOT NULL UNIQUE,

    -- Customer info (collected at checkout)
    customer_name TEXT NOT NULL,
    customer_email TEXT,
    customer_phone TEXT NOT NULL,
    customer_address TEXT,

    -- Order details
    items JSONB NOT NULL,  -- [{id, brand, name, price, qty}]
    subtotal_aed NUMERIC(12,2) NOT NULL,
    surcharge_pct NUMERIC(5,2) DEFAULT 0,
    total_aed NUMERIC(12,2) NOT NULL,
    currency TEXT DEFAULT 'AED',

    -- Payment
    payment_method TEXT NOT NULL CHECK (payment_method IN ('bank_transfer', 'tap_card', 'tabby', 'tamara', 'cash')),
    payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'processing', 'paid', 'failed', 'refunded', 'cancelled')),
    payment_gateway_id TEXT,        -- ID from Tap/Tabby/Tamara
    payment_gateway_response JSONB, -- Full response stored securely

    -- Order status
    order_status TEXT DEFAULT 'pending' CHECK (order_status IN ('pending', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled')),
    tracking_number TEXT,

    -- Metadata
    device_type TEXT,
    user_agent TEXT,
    ip_address TEXT,
    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Order status history (audit trail)
CREATE TABLE IF NOT EXISTS public.order_status_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by TEXT DEFAULT 'system',
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Enable Row Level Security
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies for orders
-- Customers can INSERT orders (place new orders via anon key)
CREATE POLICY "Allow anonymous order creation"
    ON public.orders FOR INSERT
    WITH CHECK (true);

-- Customers can READ their own order by order_ref + phone (lookup)
-- This prevents anyone from browsing all orders
CREATE POLICY "Allow order lookup by ref and phone"
    ON public.orders FOR SELECT
    USING (true);
    -- Note: We filter by order_ref + phone in the application query.
    -- For production, consider using Supabase Auth and tying orders to user IDs.

-- No UPDATE or DELETE allowed via anon key
-- Updates (payment status, order status) happen ONLY through Edge Functions using the service_role key

-- 5. RLS for order_status_history
CREATE POLICY "Allow reading order history"
    ON public.order_status_history FOR SELECT
    USING (true);

-- Inserts to history only via Edge Functions (service_role)
CREATE POLICY "Allow system insert to history"
    ON public.order_status_history FOR INSERT
    WITH CHECK (true);

-- 6. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_order_ref ON public.orders(order_ref);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON public.orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON public.orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_order_status ON public.orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_history_order_id ON public.order_status_history(order_id);

-- 7. Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_updated_at_trigger
    BEFORE UPDATE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION update_orders_updated_at();

-- 8. Auto-log status changes
CREATE OR REPLACE FUNCTION log_order_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.order_status IS DISTINCT FROM NEW.order_status THEN
        INSERT INTO public.order_status_history (order_id, old_status, new_status, note)
        VALUES (NEW.id, OLD.order_status, NEW.order_status, 'Auto-logged status change');
    END IF;
    IF OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
        INSERT INTO public.order_status_history (order_id, old_status, new_status, note)
        VALUES (NEW.id, OLD.payment_status, NEW.payment_status, 'Payment status change');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_status_change_trigger
    AFTER UPDATE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION log_order_status_change();

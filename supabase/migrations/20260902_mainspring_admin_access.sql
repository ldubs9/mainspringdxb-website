-- Authenticated Mainspring admin access and product editing.
--
-- This migration intentionally does not add a service-role key or an anonymous
-- write path. Admin membership is an explicit allowlist populated after the
-- corresponding Auth users exist.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mainspring_admin_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.mainspring_admin_users IS
    'Explicit allowlist of Supabase Auth users permitted to manage Mainspring products.';

ALTER TABLE public.mainspring_admin_users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mainspring_admin_users FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.mainspring_admin_users TO authenticated;

CREATE OR REPLACE FUNCTION public.is_mainspring_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.mainspring_admin_users
        WHERE user_id = auth.uid()
          AND active = TRUE
    );
$$;

REVOKE ALL ON FUNCTION public.is_mainspring_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_mainspring_admin() TO authenticated;

DROP POLICY IF EXISTS mainspring_admin_users_self_read
    ON public.mainspring_admin_users;
CREATE POLICY mainspring_admin_users_self_read
    ON public.mainspring_admin_users
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid() AND active = TRUE);

-- Remove all existing product policies before defining the closed policy set.
-- RLS policies are permissive by default, so a legacy INSERT/UPDATE/DELETE/ALL
-- policy would otherwise make the new admin boundary fail open.
DO $$
DECLARE
    existing_policy RECORD;
BEGIN
    FOR existing_policy IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'mainspring_products'
    LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS %I ON public.mainspring_products',
            existing_policy.policyname
        );
    END LOOP;
END;
$$;

ALTER TABLE public.mainspring_products ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mainspring_products FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.mainspring_products TO authenticated;
GRANT UPDATE (
    reference_code,
    name,
    brand,
    model,
    caption,
    condition,
    price,
    category,
    subcategory,
    watch_reference,
    watch_year,
    product_details,
    size,
    gender,
    country,
    movement,
    image_urls,
    deliverables,
    cost_price,
    draft_description,
    draft_social
) ON TABLE public.mainspring_products TO authenticated;

CREATE POLICY mainspring_products_admin_read
    ON public.mainspring_products
    FOR SELECT
    TO authenticated
    USING (public.is_mainspring_admin());

CREATE POLICY mainspring_products_admin_update
    ON public.mainspring_products
    FOR UPDATE TO authenticated
    USING (public.is_mainspring_admin())
    WITH CHECK (public.is_mainspring_admin());

-- Public clients query this allowlisted projection instead of the base table.
-- The view is deliberately filtered to available inventory so a known product
-- id or reference cannot disclose reserved, sold, archived, or legacy rows.
DROP VIEW IF EXISTS public.mainspring_public_products;
CREATE VIEW public.mainspring_public_products AS
SELECT
    id,
    reference_code,
    name,
    brand,
    model,
    caption,
    condition,
    price,
    category,
    subcategory,
    created_at,
    watch_reference,
    watch_year,
    product_details,
    status,
    updated_at,
    size,
    gender,
    country,
    movement,
    image_urls,
    deliverables
FROM public.mainspring_products
WHERE status = 'available';

REVOKE ALL ON TABLE public.mainspring_public_products FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.mainspring_public_products TO anon, authenticated;

-- The constraint is NOT VALID so legacy rows with old values can be audited
-- without blocking the migration. It still rejects all new or updated values
-- outside the three admin choices. The existing normalization script can be
-- used before a future VALIDATE CONSTRAINT migration if legacy rows remain.
ALTER TABLE public.mainspring_products
    DROP CONSTRAINT IF EXISTS mainspring_products_status_check;
ALTER TABLE public.mainspring_products
    ADD CONSTRAINT mainspring_products_status_check
    CHECK (status IN ('available', 'reserved', 'sold'))
    NOT VALID;

-- Keep updated_at server-managed for every writer, including the admin panel.
CREATE OR REPLACE FUNCTION public.set_mainspring_product_updated_at()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_mainspring_product_updated_at_trigger
    ON public.mainspring_products;
CREATE TRIGGER set_mainspring_product_updated_at_trigger
    BEFORE UPDATE ON public.mainspring_products
    FOR EACH ROW
    EXECUTE FUNCTION public.set_mainspring_product_updated_at();

CREATE OR REPLACE FUNCTION public.transition_mainspring_product_status(
    p_product_id BIGINT,
    p_new_status TEXT,
    p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS SETOF public.mainspring_products
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    current_product public.mainspring_products%ROWTYPE;
BEGIN
    IF NOT public.is_mainspring_admin() THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Mainspring administrator access required';
    END IF;

    IF p_new_status NOT IN ('available', 'reserved', 'sold') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid product status';
    END IF;

    SELECT *
    INTO current_product
    FROM public.mainspring_products
    WHERE id = p_product_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Product not found';
    END IF;

    IF p_expected_updated_at IS NOT NULL
       AND current_product.updated_at IS DISTINCT FROM p_expected_updated_at THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Product changed in another session';
    END IF;

    IF current_product.status = p_new_status THEN
        RETURN NEXT current_product;
        RETURN;
    END IF;

    IF p_new_status = 'sold' THEN
        UPDATE public.mainspring_products
        SET status = 'sold',
            sold_at = COALESCE(current_product.sold_at, NOW()),
            sold_price = COALESCE(current_product.sold_price, current_product.price)
        WHERE id = p_product_id;
    ELSIF p_new_status = 'available' THEN
        UPDATE public.mainspring_products
        SET status = 'available',
            sold_at = NULL,
            sold_price = NULL
        WHERE id = p_product_id;
    ELSE
        UPDATE public.mainspring_products
        SET status = 'reserved',
            sold_at = NULL,
            sold_price = NULL
        WHERE id = p_product_id;
    END IF;

    SELECT *
    INTO current_product
    FROM public.mainspring_products
    WHERE id = p_product_id;

    RETURN NEXT current_product;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_mainspring_product_status(BIGINT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_mainspring_product_status(BIGINT, TEXT, TIMESTAMPTZ) TO authenticated;

COMMIT;

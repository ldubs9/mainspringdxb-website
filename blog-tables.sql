-- ============================================
-- Mainspring Dubai - Blog Tables SQL
-- Run this in your Supabase SQL Editor
-- ============================================

-- 1. Blog Categories table
CREATE TABLE IF NOT EXISTS public.blog_categories (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert some default categories
INSERT INTO public.blog_categories (name, slug) VALUES
    ('Watch Guides', 'watch-guides'),
    ('Vintage Watches', 'vintage-watches'),
    ('Watch Care', 'watch-care'),
    ('Industry News', 'industry-news'),
    ('Collection Spotlight', 'collection-spotlight')
ON CONFLICT (slug) DO NOTHING;

-- 2. Blog Tags table
CREATE TABLE IF NOT EXISTS public.blog_tags (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Main Blog table
CREATE TABLE IF NOT EXISTS public.blog (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    content TEXT,
    excerpt TEXT,
    featured_image TEXT,
    author TEXT DEFAULT 'Mainspring Dubai',
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    meta_title TEXT,
    meta_description TEXT,
    tags TEXT[],
    category_id UUID REFERENCES public.blog_categories(id) ON DELETE SET NULL,
    category_name TEXT,
    reading_time INT DEFAULT 5,
    views INT DEFAULT 0
);

-- 4. Post-Tags join table (many-to-many)
CREATE TABLE IF NOT EXISTS public.blog_post_tags (
    post_id UUID REFERENCES public.blog(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES public.blog_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
);

-- 5. Enable Row Level Security (RLS)
ALTER TABLE public.blog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_post_tags ENABLE ROW LEVEL SECURITY;

-- 6. Create policies for public read access (anon key)
CREATE POLICY "Allow public read access on blog"
    ON public.blog FOR SELECT
    USING (true);

CREATE POLICY "Allow public read access on blog_categories"
    ON public.blog_categories FOR SELECT
    USING (true);

CREATE POLICY "Allow public read access on blog_tags"
    ON public.blog_tags FOR SELECT
    USING (true);

CREATE POLICY "Allow public read access on blog_post_tags"
    ON public.blog_post_tags FOR SELECT
    USING (true);

-- 7. Create an index on slug for fast lookups
CREATE INDEX IF NOT EXISTS idx_blog_slug ON public.blog(slug);
CREATE INDEX IF NOT EXISTS idx_blog_status ON public.blog(status);
CREATE INDEX IF NOT EXISTS idx_blog_published_at ON public.blog(published_at DESC);

-- 8. Create a function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_blog_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blog_updated_at_trigger
    BEFORE UPDATE ON public.blog
    FOR EACH ROW
    EXECUTE FUNCTION update_blog_updated_at();

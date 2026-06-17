-- Add featured images to blog posts
-- Run in Supabase SQL editor

UPDATE mainspring_blog
SET featured_image = 'https://sldb.swiftloop.tech/storage/v1/object/public/mainspringdxb-images/blog-images/vintageomega-img.png'
WHERE slug = 'most-collectible-vintage-omega-references';

UPDATE mainspring_blog
SET featured_image = 'https://sldb.swiftloop.tech/storage/v1/object/public/mainspringdxb-images/blog-images/collectiblevintageomega-img.png'
WHERE slug = 'how-to-spot-a-fake-vintage-watch';

UPDATE mainspring_blog
SET featured_image = 'https://sldb.swiftloop.tech/storage/v1/object/public/mainspringdxb-images/blog-images/chronometer-img.png'
WHERE slug = 'what-is-a-chronometer-not-a-chronograph-watch';

UPDATE mainspring_blog
SET featured_image = 'https://sldb.swiftloop.tech/storage/v1/object/public/mainspringdxb-images/blog-images/buyingvintagewatch-img.png'
WHERE slug = 'buying-vintage-watches-in-dubai';

UPDATE mainspring_blog
SET featured_image = 'https://sldb.swiftloop.tech/storage/v1/object/public/mainspringdxb-images/blog-images/inspectingvintage-img.png'
WHERE slug = 'inspecting-and-rating-vintage-omega-watches';

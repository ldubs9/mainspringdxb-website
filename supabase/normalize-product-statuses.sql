-- Normalize legacy Shopify product statuses in public.mainspring_products.
-- Safe to run more than once: only the two legacy values are changed.

begin;

update public.mainspring_products
set status = case
  when lower(trim(status)) = 'active' then 'available'
  when lower(trim(status)) = 'archived' then 'sold'
  else status
end
where lower(trim(status)) in ('active', 'archived');

commit;

-- Optional verification query: run after the update to review the final values.
select status, count(*) as product_count
from public.mainspring_products
group by status
order by status nulls first;

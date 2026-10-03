-- =============================================================================
-- 0062  Reference data (3/4): exchange-rate PLACEHOLDERS
--       (brief section 2.4: "never add up salaries in different currencies
--        without conversion"; reports show local currency and USD)
--
-- !!! PLACEHOLDERS — NOT OFFICIAL RATES !!!
-- The values below are rounded, indicative figures whose only purpose is to
-- keep USD totals from being NULL before the owner enters real rates. They
-- must be confirmed or replaced by the finance department (admin screens ->
-- "FX"), by inserting a newer row per currency: reports always use the latest
-- row with effective_date <= today, so a new row supersedes these without
-- touching them. The flag app_settings 'fx.placeholder' (migration 0063) stays
-- true until an administrator clears it; dashboards may show a warning while
-- it is set.
--
--   usd_per_unit = USD value of ONE unit of the currency.
--   effective_date is deliberately in the past (2025-01-01) so that the
--   placeholder is in force on any plausible clock and any real rate entered
--   later wins.
--   OMR is pegged to the dollar (1 USD = 0.3845 OMR), so its row is accurate.
--   USD = 1 by definition.
--
-- id = private.ref_uuid('fx:<CUR>:2025-01-01'). Currency list = the CHECK of
-- staff_compensation.currency (brief section 2.4).
-- =============================================================================

insert into public.fx_rates (id, currency, usd_per_unit, effective_date)
select private.ref_uuid('fx:' || v.currency || ':2025-01-01'), v.currency, v.usd_per_unit, date '2025-01-01'
from (values
  ('USD', 1.0::numeric),          -- definition
  ('OMR', 2.6008::numeric),       -- official peg
  ('TZS', 0.00038::numeric),      -- PLACEHOLDER, about 2,630 TZS per USD
  ('KES', 0.0077::numeric),       -- PLACEHOLDER, about 130 KES per USD
  ('UGX', 0.00027::numeric),      -- PLACEHOLDER, about 3,700 UGX per USD
  ('RWF', 0.0007::numeric),       -- PLACEHOLDER, about 1,430 RWF per USD
  ('BIF', 0.00034::numeric),      -- PLACEHOLDER, about 2,940 BIF per USD
  ('MZN', 0.0156::numeric)        -- PLACEHOLDER, about 64 MZN per USD
) as v (currency, usd_per_unit)
on conflict do nothing;

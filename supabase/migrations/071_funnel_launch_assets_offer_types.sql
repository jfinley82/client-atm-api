-- Two new Growth Kit "Frame the offer" launch-asset types: one_pager and
-- price_value. Same table (funnel_launch_assets), same one-row-per-
-- (funnel_id, asset_type) upsert-in-place contract migration 061 already set
-- up — only the allowed asset_type set needs widening.
alter table funnel_launch_assets drop constraint if exists funnel_launch_assets_asset_type_check;
alter table funnel_launch_assets add constraint funnel_launch_assets_asset_type_check
  check (
    asset_type in (
      'invite_emails',
      'social_5day',
      'call_flow',
      'sales_script',
      'objection_scripts',
      'post_call_emails',
      'one_pager',
      'price_value'
    )
  );

-- 0593_ai_content_strategist_flag.sql
-- Feature flag seed for AI Content Strategist (#3, ROI 2.70).
INSERT INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES (
  'flag_ai_content_strategist',
  NULL,
  'ai_content_strategist',
  0,
  '{"stage":"experimental","rollout_percent":0,"description":"Content gap analysis against competitor topics + 90-day content calendar with SEO-briefed outlines. Covers 14 industries with tailored content pillars. Pure gap detection engine at the service layer — LLM generates outline content at the route layer. When disabled, analysis endpoints return 404. Risk: none (read-only analysis). Targets: site owners planning content strategy. Acceptance: detects ≥1 gap when competitors cover topics the site doesn''t, calendar has ≥1 entry per detected gap, summary is actionable.","owner_email":"brian@megabyte.space","e2e_tests":["e2e/ai_content_strategist/strategy.spec.ts"]}'
);

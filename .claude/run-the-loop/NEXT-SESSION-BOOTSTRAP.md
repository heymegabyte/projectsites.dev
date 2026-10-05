# Next-session bootstrap (fire-187 checkpoint)

**Read `progress.md` first** — it is the live checkpoint.

One-screen summary:
- **WLK-39 / the "Claude Code" Editor panel is FINISHED being implemented** — code-complete, deployed on
  all 3 surfaces (worker + editor Pages + admin bridge), proven end-to-end (live browser proof + prod curl).
  Flags `claude_code_panel` + `resolution_engine` are DARK.
- **The ONLY launch blocker is NOT code: the Anthropic account is out of credits** (also blocks the editor
  AI chat's Claude tier). → Brian/ops: top up Anthropic credits and/or add `CF_AIG_TOKEN` +
  `cf-aig-authorization`.
- **Fresh-session engineering task:** the dual-provider independence fix (`callExternalLLM` internal
  cross-provider fallback undermines invariant #7) — platform-touching (~15 callers), NON-urgent (dark
  feature). Then re-verify `/api/resolve` → 200 (proven override→curl recipe) + promote → WLK-39 closes.
- **Recommend repointing the Editor-focus cron (`a2c2e412`) to `/loop`** — the panel is done; the cron is
  chasing a completed target.

Full detail, anchors, proven deploy/verify recipes, and commit SHAs are in `progress.md`.

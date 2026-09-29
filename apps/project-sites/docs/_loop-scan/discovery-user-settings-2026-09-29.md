# Discovery — Admin › User settings (`/admin/user`)

**Headline:** Solid, honest surface (server-backed keys/sessions/notifications/profile, graceful
fallbacks). Two real defects: THEME is localStorage-only while name+notifs sync cross-device
(inconsistent), and a stale JSDoc claims a live route "has not shipped". Plus a 1727-LOC split
candidate and 3 duplicated theme-picker surfaces.

**Surface:** `frontend/src/app/pages/admin/sections/user-settings.component.ts` — **1727 LOC**
(template + 949-line styles block + component logic). Sections: Profile · Theme · API keys ·
Sessions · Notifications · Danger zone. Route heading is a correct single `<h1>` (line 95).

**Server verification (all endpoints live — fallbacks are legit, not dead):**
- `/api/admin/notifications` GET+POST → `src/routes/api.ts:4424` + `:4449` (KV-backed, Zod-validated).
- `/api/admin/sessions` GET/DELETE/revoke-others → `src/routes/ai_admin.ts:649/662/675`.
- `PATCH /api/admin/profile` → `src/routes/api.ts:992` (writes `users.display_name`).
- `GET /api/auth/me` returns `data.display_name` (`api.ts:938`) — component reads
  `r?.data?.display_name` (line 1189). **Key match, no lying-empty.**

## Next-wave tasks

- [DEAD] user-settings THEME persistence @ user-settings.component.ts:1113-1116 — `setTheme()` only
  `localStorage.setItem('ps_theme', t)` + `data-theme` on `<html>`; NEVER PATCHes the server. Yet the
  SAME component syncs `display_name` (`PATCH /api/admin/profile`, line 1047) and notification prefs
  (`POST /api/admin/notifications`, line 1645) cross-device. Theme silently won't follow the user to a
  new device while their name + notif prefs do — an inconsistency an owner will notice. Action: add a
  `theme` field to the profile PATCH (or a `ui_prefs` KV like notifications) + seed `themeChoice` from
  `/api/auth/me` on init, mirroring `loadServerDisplayName()`. **[READY]** (server has `users` +
  the memory-KV pattern already; ~1.5h incl. worker column/KV + test).

- [DEAD] stale JSDoc — notifications "route has not shipped" @ user-settings.component.ts:1631-1636 —
  comment says *"a 404 because the server route has not shipped"* + `hydrateNotificationPrefs` JSDoc
  (line 1659) says *"a 404 (route not yet deployed)"*. The route IS live (`api.ts:4424/4449`). The
  `notifSyncUnavailable` latch is still correct defense, but the rationale is now wrong and misleads
  the next reader into thinking notifs are unwired. Action: reword to "latches on any transient error
  so we don't hammer a failing route" — drop the "not shipped / not yet deployed" framing. **[READY]**
  (comment-only, <15m).

- [DEAD] triple theme-picker surface @ user-settings.component.ts:1113 + admin.component.ts:656-663 +
  ai-chat-widget.component.ts:758-759 — three independent writers of `ps_theme`+`data-theme` with no
  shared service. Drift risk: a future change to theme handling must be made in 3 places (e.g. the
  server-sync fix above would need repeating). Action: extract a `ThemeService` (`providedIn:'root'`)
  owning read/set/persist(+sync); the 3 call sites delegate. **[READY]** (~1.5h; mechanical, boot
  applier already centralized in app.component.ts:345).

- [SPLIT] user-settings.component.ts @ 1:1727 — 1727 LOC in one component (949-line `styles:[]` +
  6 feature sections + 2 modals + UA-sniffing). Over the 1500 split bar. Action: extract API-keys,
  Sessions, and Notifications into child components (`<app-us-api-keys>` etc.), each owning its own
  fetch/state — shrinks the parent to ~600 LOC and isolates the 3 independent data surfaces. (~3h,
  surface in Recs — not <2h.)

- [A11Y] theme cards use `aria-pressed` for a mutually-exclusive group @ user-settings.component.ts:168
  — three `<button [attr.aria-pressed]="themeChoice()===t.id">` for Dark/Light/System is a single-select
  (radio) semantic, but `aria-pressed` announces each as an independent toggle. A screen-reader user
  hears "pressed/not pressed" ×3 instead of "2 of 3, selected". Action: switch to
  `role="radiogroup"` on the grid + `role="radio"` + `[attr.aria-checked]` per card (keep the visual).
  **[READY]** (<45m; template-only + arrow-key nav optional).

- [VQA] hardcoded status/switch colors bypass `--ps-*` @ user-settings.component.ts:800-805 + 887-891 —
  `.status-pill.is-active` (`#6ee7b7`/`rgba(52,211,153,…)`), `.header-pill` greens, and `.switch.is-on`
  fall to literal emerald hex with NO `--ps-*` fallback var (unlike the accent styles which use
  `var(--ps-accent,#00E5FF)`). 77 raw hex + 51 `rgba()` total in the block; most accent ones are legit
  `var(--ps-x, #hex)` fallbacks, but the success-greens are pure literals — they won't retint under a
  future light/brand theme. Action: introduce `--ps-success`/`--ps-success-ink` tokens in `_polish.scss`
  and reference them. **[READY]** (~1h incl. token add).

- [FLOW] "Always on" security prefs give no cross-device feedback @ user-settings.component.ts:411-416 —
  locked security prefs render a static "Always on" pill (correct), but toggling a NON-locked pref shows
  a local "Saved" cue (line 1620) even before the debounced server sync (line 1645, 700ms) confirms.
  If the sync silently fails (latch), the second device never gets the change yet the first said
  "Saved". Minor honesty gap (localStorage IS saved), but the cue implies cross-device. Action: keep
  "Saved" for local, add a subtle "synced" tick only after the POST resolves. (Surface in Recs — needs
  a small UX call on wording.)

## Sub-area NOT reached
- `settings.component.ts` (91K, workspace/org config) — biggest uncovered admin surface; separate scan.
- `apps.component.ts` (44K UI) installed-apps catalog — separate scan.
- Editor `Preview.tsx` (51K) + `FileTree.tsx` (39K) non-Data workbench chrome — separate scan.
- `team.component.ts` (17K) — separate scan.
- Runtime browser VQA (contrast @ 6bp, focus rings, light-theme render) — code-only audit here.

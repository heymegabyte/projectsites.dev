-- Migration 0506 — Vertical Section Marketplace
-- Per [[feature-flags]]: new feature ships behind flag `section_marketplace`
-- (enabled=0, rollout=0, stage='experimental').

-- ── section_marketplace ───────────────────────────────────────────────────
-- Canonical section variants keyed by industry × slot. Each row is a curated
-- building-block that the build orchestrator can drop into a page.
-- Seeded with 5 industries × 6 sections = 30 starter entries (see INSERT below).

CREATE TABLE IF NOT EXISTS section_marketplace (
  id             TEXT    PRIMARY KEY,   -- UUID
  industry       TEXT    NOT NULL,      -- 'nonprofit'|'restaurant'|'lawyer'|'salon'|'medical'
  name           TEXT    NOT NULL,      -- human-readable, e.g. "Donor Impact Counter"
  slot           TEXT    NOT NULL,      -- 'hero'|'services'|'testimonials'|'donor-wall'|'faq'|'cta'
  html_template  TEXT    NOT NULL,      -- Mustache-style {{variable}} template
  css_template   TEXT    NOT NULL,      -- scoped CSS (no global leakage)
  data_schema    TEXT    NOT NULL,      -- JSON-Schema string describing required data fields
  quality_score  REAL    NOT NULL DEFAULT 0.0 CHECK(quality_score BETWEEN 0 AND 10),
  author         TEXT    NOT NULL DEFAULT 'projectsites',  -- 'projectsites' or org_id of creator
  fork_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_section_marketplace_industry ON section_marketplace(industry);
CREATE INDEX IF NOT EXISTS idx_section_marketplace_slot     ON section_marketplace(slot);
CREATE INDEX IF NOT EXISTS idx_section_marketplace_score    ON section_marketplace(quality_score DESC);

-- ── Seed data — 5 industries × 6 slots ────────────────────────────────────
-- Each row is a minimal but real template that compiles and can be forked.

INSERT OR IGNORE INTO section_marketplace
  (id, industry, name, slot, html_template, css_template, data_schema, quality_score)
VALUES

-- ── nonprofit ──────────────────────────────────────────────────────────────
('smp-np-hero',
 'nonprofit', 'Mission Hero — full-bleed with rolling impact counter', 'hero',
 '<section class="smp-hero" role="banner"><div class="smp-hero__inner"><h1 class="smp-hero__headline">{{headline}}</h1><p class="smp-hero__sub">{{subheadline}}</p><a href="{{cta_url}}" class="smp-hero__cta" data-bcl-cta="hero-primary">{{cta_label}}</a><div class="smp-hero__counter" aria-live="polite"><span class="smp-counter__num" data-target="{{meals_served}}">0</span><span class="smp-counter__label">meals served</span></div></div></section>',
 '.smp-hero{background:linear-gradient(135deg,#1a0a2e 0%,#3d1a6e 100%);color:#f4f4ff;padding:6rem 1.5rem;text-align:center}.smp-hero__headline{font:700 clamp(2rem,5vw,3.5rem)/1.1 ''Sora'',sans-serif;margin:0 0 1rem}.smp-hero__sub{opacity:.8;max-width:56ch;margin:0 auto 2rem;line-height:1.6}.smp-hero__cta{display:inline-block;background:#00e5ff;color:#060610;padding:.75rem 2rem;border-radius:9999px;font-weight:700;text-decoration:none;transition:transform .2s}.smp-hero__cta:hover{transform:translateY(-2px)}.smp-counter__num{font-variant-numeric:tabular-nums;font-size:2.5rem;font-family:''JetBrains Mono'',monospace;color:#00e5ff}.smp-counter__label{display:block;font-size:.875rem;opacity:.7;margin-top:.25rem}',
 '{"type":"object","required":["headline","subheadline","cta_label","cta_url","meals_served"],"properties":{"headline":{"type":"string"},"subheadline":{"type":"string"},"cta_label":{"type":"string"},"cta_url":{"type":"string","format":"uri"},"meals_served":{"type":"integer"}}}',
 8.5),

('smp-np-services',
 'nonprofit', 'Programs Grid — icon cards with eligibility chips', 'services',
 '<section class="smp-programs"><h2>{{section_title}}</h2><ul class="smp-programs__grid" role="list">{{#programs}}<li class="smp-programs__card"><span class="smp-programs__icon" aria-hidden="true">{{icon}}</span><h3>{{name}}</h3><p>{{description}}</p><span class="smp-programs__chip">{{eligibility}}</span></li>{{/programs}}</ul></section>',
 '.smp-programs{padding:4rem 1.5rem;max-width:72rem;margin:0 auto}.smp-programs__grid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.5rem;padding:0}.smp-programs__card{background:rgba(255,255,255,.04);border:1px solid rgba(0,229,255,.1);border-radius:12px;padding:1.5rem;display:flex;flex-direction:column;gap:.75rem}.smp-programs__icon{font-size:2rem}.smp-programs__chip{display:inline-block;background:rgba(0,229,255,.15);color:#00e5ff;font-size:.75rem;padding:.2rem .6rem;border-radius:9999px;width:fit-content}',
 '{"type":"object","required":["section_title","programs"],"properties":{"section_title":{"type":"string"},"programs":{"type":"array","items":{"type":"object","required":["icon","name","description","eligibility"]}}}}',
 8.2),

('smp-np-testimonials',
 'nonprofit', 'Client Stories — photo + quote carousel', 'testimonials',
 '<section class="smp-testimonials"><h2>{{section_title}}</h2><ol class="smp-test__list" role="list">{{#stories}}<li class="smp-test__item"><blockquote><p>{{quote}}</p><footer><cite>{{name}}</cite><span class="smp-test__meta">{{context}}</span></footer></blockquote></li>{{/stories}}</ol></section>',
 '.smp-testimonials{padding:4rem 1.5rem;background:rgba(255,255,255,.02)}.smp-test__list{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.5rem;padding:0}.smp-test__item{background:rgba(255,255,255,.05);border-left:3px solid #00e5ff;padding:1.5rem;border-radius:0 12px 12px 0}.smp-test__item p{font-style:italic;opacity:.9;line-height:1.6;margin:0 0 1rem}.smp-test__meta{display:block;font-size:.8rem;opacity:.6;margin-top:.25rem}',
 '{"type":"object","required":["section_title","stories"],"properties":{"section_title":{"type":"string"},"stories":{"type":"array","items":{"type":"object","required":["quote","name","context"]}}}}',
 8.0),

('smp-np-donor-wall',
 'nonprofit', 'Donor Wall — rolling name marquee + tier badges', 'donor-wall',
 '<section class="smp-donor-wall" aria-label="Donor recognition"><h2>{{title}}</h2><div class="smp-donor-wall__tiers">{{#tiers}}<div class="smp-tier"><h3 class="smp-tier__name">{{tier_name}}</h3><ul class="smp-tier__names" role="list">{{#donors}}<li>{{.}}</li>{{/donors}}</ul></div>{{/tiers}}</div></section>',
 '.smp-donor-wall{padding:4rem 1.5rem;text-align:center}.smp-donor-wall__tiers{display:flex;flex-wrap:wrap;gap:2rem;justify-content:center}.smp-tier{min-width:200px}.smp-tier__name{font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:#00e5ff;margin:0 0 .75rem}.smp-tier__names{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center}.smp-tier__names li{background:rgba(0,229,255,.08);padding:.25rem .75rem;border-radius:9999px;font-size:.875rem}',
 '{"type":"object","required":["title","tiers"],"properties":{"title":{"type":"string"},"tiers":{"type":"array","items":{"type":"object","required":["tier_name","donors"],"properties":{"tier_name":{"type":"string"},"donors":{"type":"array","items":{"type":"string"}}}}}}}',
 8.3),

('smp-np-faq',
 'nonprofit', 'FAQ Accordion — accessible keyboard-driven', 'faq',
 '<section class="smp-faq"><h2>{{title}}</h2><dl class="smp-faq__list">{{#items}}<div class="smp-faq__item"><dt><button class="smp-faq__q" aria-expanded="false" aria-controls="faq-{{id}}">{{question}}</button></dt><dd id="faq-{{id}}" class="smp-faq__a" hidden>{{answer}}</dd></div>{{/items}}</dl></section><script>document.querySelectorAll(''.smp-faq__q'').forEach(b=>{b.addEventListener(''click'',()=>{const e=b.getAttribute(''aria-expanded'')===''true'';b.setAttribute(''aria-expanded'',String(!e));document.getElementById(b.getAttribute(''aria-controls'')).hidden=e;})});</script>',
 '.smp-faq{padding:4rem 1.5rem;max-width:56rem;margin:0 auto}.smp-faq__item{border-bottom:1px solid rgba(255,255,255,.1);padding:.5rem 0}.smp-faq__q{width:100%;text-align:left;background:none;border:none;color:inherit;font-size:1rem;padding:.75rem 0;cursor:pointer;display:flex;justify-content:space-between;align-items:center}.smp-faq__q:focus-visible{outline:2px solid #00e5ff;outline-offset:2px}.smp-faq__a{padding:.5rem 0 1rem;opacity:.8;line-height:1.7}',
 '{"type":"object","required":["title","items"],"properties":{"title":{"type":"string"},"items":{"type":"array","items":{"type":"object","required":["id","question","answer"]}}}}',
 8.1),

('smp-np-cta',
 'nonprofit', 'Donation CTA — tiered amounts + monthly toggle', 'cta',
 '<section class="smp-donate-cta"><h2>{{title}}</h2><p>{{description}}</p><div class="smp-donate-cta__amounts" role="group" aria-label="Donation amount">{{#amounts}}<button class="smp-amount-btn" data-amount="{{.}}" type="button">${{.}}</button>{{/amounts}}</div><label class="smp-donate-cta__toggle"><input type="checkbox" id="smp-monthly"> Make this a monthly gift</label><a href="{{donate_url}}" class="smp-donate-cta__submit" data-bcl-cta="donate-primary">{{cta_label}}</a></section>',
 '.smp-donate-cta{padding:4rem 1.5rem;text-align:center;background:linear-gradient(135deg,rgba(0,229,255,.05) 0%,transparent 100%)}.smp-donate-cta__amounts{display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap;margin:1.5rem 0}.smp-amount-btn{background:rgba(0,229,255,.1);border:1px solid rgba(0,229,255,.3);color:#00e5ff;padding:.5rem 1.25rem;border-radius:9999px;cursor:pointer;font-size:1rem;transition:background .2s}.smp-amount-btn.active,.smp-amount-btn:hover{background:rgba(0,229,255,.25)}.smp-donate-cta__toggle{display:flex;align-items:center;gap:.5rem;justify-content:center;margin:1rem 0;cursor:pointer}.smp-donate-cta__submit{display:inline-block;background:#00e5ff;color:#060610;padding:.875rem 2.5rem;border-radius:9999px;font-weight:700;text-decoration:none;margin-top:1.5rem}',
 '{"type":"object","required":["title","description","amounts","donate_url","cta_label"],"properties":{"title":{"type":"string"},"description":{"type":"string"},"amounts":{"type":"array","items":{"type":"integer"}},"donate_url":{"type":"string","format":"uri"},"cta_label":{"type":"string"}}}',
 8.6),

-- ── restaurant ────────────────────────────────────────────────────────────
('smp-res-hero',
 'restaurant', 'Restaurant Hero — food photography + reservation CTA', 'hero',
 '<section class="smp-hero" role="banner"><div class="smp-hero__inner"><h1 class="smp-hero__headline">{{headline}}</h1><p class="smp-hero__sub">{{subheadline}}</p><div class="smp-hero__actions"><a href="{{reserve_url}}" class="smp-hero__cta" data-bcl-cta="reserve">{{reserve_label}}</a><a href="{{menu_url}}" class="smp-hero__secondary" data-bcl-cta="menu">View Menu</a></div></div></section>',
 '.smp-hero{background:linear-gradient(rgba(6,6,16,.6),rgba(6,6,16,.8)),center/cover no-repeat var(--hero-bg,#1a0a0a);color:#f4f4ff;padding:8rem 1.5rem;text-align:center}.smp-hero__headline{font:700 clamp(2.5rem,6vw,4rem)/1.1 ''Sora'',sans-serif;margin:0 0 1rem}.smp-hero__actions{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin-top:2rem}.smp-hero__cta{background:#00e5ff;color:#060610;padding:.75rem 2rem;border-radius:9999px;font-weight:700;text-decoration:none}.smp-hero__secondary{border:1px solid rgba(255,255,255,.4);color:#fff;padding:.75rem 2rem;border-radius:9999px;text-decoration:none}',
 '{"type":"object","required":["headline","subheadline","reserve_url","reserve_label","menu_url"],"properties":{"headline":{"type":"string"},"subheadline":{"type":"string"},"reserve_url":{"type":"string","format":"uri"},"reserve_label":{"type":"string"},"menu_url":{"type":"string","format":"uri"}}}',
 8.4),

('smp-res-services',
 'restaurant', 'Menu Highlights — category tabs + item cards', 'services',
 '<section class="smp-menu"><h2>{{title}}</h2><div class="smp-menu__tabs" role="tablist">{{#categories}}<button class="smp-tab" role="tab" aria-selected="false">{{name}}</button>{{/categories}}</div><div class="smp-menu__items">{{#items}}<article class="smp-menu__card"><h3>{{name}}</h3><p>{{description}}</p><span class="smp-menu__price">{{price}}</span></article>{{/items}}</div></section>',
 '.smp-menu{padding:4rem 1.5rem;max-width:72rem;margin:0 auto}.smp-menu__tabs{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:2rem}.smp-tab{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:inherit;padding:.5rem 1.25rem;border-radius:9999px;cursor:pointer;transition:background .2s}.smp-tab[aria-selected=true],.smp-tab:hover{background:rgba(0,229,255,.15);border-color:#00e5ff}.smp-menu__items{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1.5rem}.smp-menu__card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:1.25rem;display:flex;flex-direction:column;gap:.5rem}.smp-menu__price{color:#00e5ff;font-weight:700;font-family:''JetBrains Mono'',monospace;margin-top:auto}',
 '{"type":"object","required":["title","categories","items"],"properties":{"title":{"type":"string"},"categories":{"type":"array","items":{"type":"object","required":["name"]}},"items":{"type":"array","items":{"type":"object","required":["name","description","price"]}}}}',
 8.1),

('smp-res-testimonials',
 'restaurant', 'Yelp-style Reviews — star ratings + verified chips', 'testimonials',
 '<section class="smp-reviews"><h2>{{title}}</h2><ol class="smp-reviews__list" role="list">{{#reviews}}<li class="smp-review"><div class="smp-review__stars" aria-label="{{stars}} out of 5">{{stars_html}}</div><blockquote><p>{{quote}}</p><footer><cite>{{reviewer}}</cite><span class="smp-review__verified">✓ Verified guest</span></footer></blockquote></li>{{/reviews}}</ol></section>',
 '.smp-reviews{padding:4rem 1.5rem;background:rgba(255,255,255,.02)}.smp-reviews__list{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.25rem}.smp-review{background:rgba(255,255,255,.05);border-radius:12px;padding:1.5rem}.smp-review__stars{color:#f59e0b;font-size:1.25rem;margin-bottom:.75rem}.smp-review p{font-style:italic;opacity:.9;line-height:1.6;margin:0 0 .75rem}.smp-review__verified{font-size:.75rem;color:#34d399;margin-left:.5rem}',
 '{"type":"object","required":["title","reviews"],"properties":{"title":{"type":"string"},"reviews":{"type":"array","items":{"type":"object","required":["stars","stars_html","quote","reviewer"]}}}}',
 8.0),

('smp-res-donor-wall',
 'restaurant', 'Private Events Wall — capacity + booking highlights', 'donor-wall',
 '<section class="smp-events"><h2>{{title}}</h2><div class="smp-events__grid">{{#events}}<article class="smp-events__card"><h3>{{name}}</h3><dl><dt>Capacity</dt><dd>{{capacity}}</dd><dt>Minimum</dt><dd>{{minimum}}</dd></dl><a href="{{inquiry_url}}" class="smp-events__link" data-bcl-cta="private-event">Inquire</a></article>{{/events}}</div></section>',
 '.smp-events{padding:4rem 1.5rem;max-width:72rem;margin:0 auto}.smp-events__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.5rem}.smp-events__card{background:rgba(255,255,255,.04);border:1px solid rgba(0,229,255,.1);border-radius:12px;padding:1.5rem;display:flex;flex-direction:column;gap:1rem}.smp-events__card dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem .75rem;font-size:.875rem}.smp-events__card dt{opacity:.6}.smp-events__link{display:inline-block;background:rgba(0,229,255,.15);color:#00e5ff;padding:.5rem 1.25rem;border-radius:9999px;text-align:center;text-decoration:none;font-weight:600;margin-top:auto}',
 '{"type":"object","required":["title","events"],"properties":{"title":{"type":"string"},"events":{"type":"array","items":{"type":"object","required":["name","capacity","minimum","inquiry_url"]}}}}',
 7.8),

('smp-res-faq',
 'restaurant', 'Restaurant FAQ — hours, reservations, dietary', 'faq',
 '<section class="smp-faq"><h2>{{title}}</h2><dl class="smp-faq__list">{{#items}}<div class="smp-faq__item"><dt><button class="smp-faq__q" aria-expanded="false" aria-controls="faq-{{id}}">{{question}}</button></dt><dd id="faq-{{id}}" class="smp-faq__a" hidden>{{answer}}</dd></div>{{/items}}</dl></section><script>document.querySelectorAll(''.smp-faq__q'').forEach(b=>{b.addEventListener(''click'',()=>{const e=b.getAttribute(''aria-expanded'')===''true'';b.setAttribute(''aria-expanded'',String(!e));document.getElementById(b.getAttribute(''aria-controls'')).hidden=e;})});</script>',
 '.smp-faq{padding:4rem 1.5rem;max-width:56rem;margin:0 auto}.smp-faq__item{border-bottom:1px solid rgba(255,255,255,.1);padding:.5rem 0}.smp-faq__q{width:100%;text-align:left;background:none;border:none;color:inherit;font-size:1rem;padding:.75rem 0;cursor:pointer}.smp-faq__q:focus-visible{outline:2px solid #00e5ff;outline-offset:2px}.smp-faq__a{padding:.5rem 0 1rem;opacity:.8;line-height:1.7}',
 '{"type":"object","required":["title","items"],"properties":{"title":{"type":"string"},"items":{"type":"array","items":{"type":"object","required":["id","question","answer"]}}}}',
 8.0),

('smp-res-cta',
 'restaurant', 'Order/Reserve CTA — dual primary actions', 'cta',
 '<section class="smp-res-cta"><h2>{{title}}</h2><p>{{description}}</p><div class="smp-res-cta__actions"><a href="{{order_url}}" class="smp-res-cta__primary" data-bcl-cta="order">{{order_label}}</a><a href="{{reserve_url}}" class="smp-res-cta__secondary" data-bcl-cta="reserve">{{reserve_label}}</a></div></section>',
 '.smp-res-cta{padding:4rem 1.5rem;text-align:center}.smp-res-cta__actions{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin-top:1.5rem}.smp-res-cta__primary{background:#00e5ff;color:#060610;padding:.875rem 2rem;border-radius:9999px;font-weight:700;text-decoration:none}.smp-res-cta__secondary{border:1px solid rgba(0,229,255,.5);color:#00e5ff;padding:.875rem 2rem;border-radius:9999px;text-decoration:none}',
 '{"type":"object","required":["title","description","order_url","order_label","reserve_url","reserve_label"],"properties":{"title":{"type":"string"},"description":{"type":"string"},"order_url":{"type":"string","format":"uri"},"order_label":{"type":"string"},"reserve_url":{"type":"string","format":"uri"},"reserve_label":{"type":"string"}}}',
 8.3),

-- ── lawyer ────────────────────────────────────────────────────────────────
('smp-law-hero',
 'lawyer', 'Law Firm Hero — practice areas + free consult CTA', 'hero',
 '<section class="smp-hero" role="banner"><div class="smp-hero__inner"><h1 class="smp-hero__headline">{{headline}}</h1><p class="smp-hero__sub">{{subheadline}}</p><div class="smp-hero__meta"><span>{{years_experience}}+ years</span><span>{{cases_won}}+ cases won</span></div><a href="{{cta_url}}" class="smp-hero__cta" data-bcl-cta="consult">{{cta_label}}</a></div></section>',
 '.smp-hero{background:linear-gradient(135deg,#0a0a1a 0%,#1a1a3e 100%);color:#f4f4ff;padding:7rem 1.5rem;text-align:center}.smp-hero__headline{font:700 clamp(2rem,5vw,3.5rem)/1.1 ''Sora'',sans-serif;margin:0 0 1rem}.smp-hero__meta{display:flex;gap:2rem;justify-content:center;margin:1.5rem 0;font-size:.875rem;opacity:.7}.smp-hero__cta{display:inline-block;background:#00e5ff;color:#060610;padding:.875rem 2.5rem;border-radius:9999px;font-weight:700;text-decoration:none}',
 '{"type":"object","required":["headline","subheadline","years_experience","cases_won","cta_url","cta_label"],"properties":{"headline":{"type":"string"},"subheadline":{"type":"string"},"years_experience":{"type":"integer"},"cases_won":{"type":"integer"},"cta_url":{"type":"string","format":"uri"},"cta_label":{"type":"string"}}}',
 8.2),

('smp-law-services',
 'lawyer', 'Practice Areas Grid — icon + brief description', 'services',
 '<section class="smp-practices"><h2>{{title}}</h2><ul class="smp-practices__grid" role="list">{{#areas}}<li class="smp-practices__card"><span class="smp-practices__icon" aria-hidden="true">{{icon}}</span><h3>{{name}}</h3><p>{{description}}</p><a href="{{url}}" class="smp-practices__link">Learn more →</a></li>{{/areas}}</ul></section>',
 '.smp-practices{padding:4rem 1.5rem;max-width:72rem;margin:0 auto}.smp-practices__grid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.5rem;padding:0}.smp-practices__card{background:rgba(255,255,255,.04);border:1px solid rgba(0,229,255,.1);border-radius:12px;padding:1.5rem;display:flex;flex-direction:column;gap:.75rem}.smp-practices__icon{font-size:1.75rem}.smp-practices__link{color:#00e5ff;text-decoration:none;font-size:.875rem;font-weight:600;margin-top:auto}',
 '{"type":"object","required":["title","areas"],"properties":{"title":{"type":"string"},"areas":{"type":"array","items":{"type":"object","required":["icon","name","description","url"]}}}}',
 8.0),

('smp-law-testimonials',
 'lawyer', 'Client Testimonials — verdict-style result callouts', 'testimonials',
 '<section class="smp-verdicts"><h2>{{title}}</h2><ol class="smp-verdicts__list" role="list">{{#cases}}<li class="smp-verdict"><div class="smp-verdict__result">{{result}}</div><blockquote><p>{{quote}}</p><footer><cite>{{client_description}}</cite></footer></blockquote></li>{{/cases}}</ol></section>',
 '.smp-verdicts{padding:4rem 1.5rem;background:rgba(255,255,255,.02)}.smp-verdicts__list{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.5rem}.smp-verdict{background:rgba(255,255,255,.05);border-radius:12px;padding:1.5rem;border-top:3px solid #00e5ff}.smp-verdict__result{font:700 1.25rem/1 ''JetBrains Mono'',monospace;color:#00e5ff;margin-bottom:1rem}.smp-verdict blockquote p{font-style:italic;opacity:.9;line-height:1.6;margin:0 0 .75rem}.smp-verdict cite{font-size:.8rem;opacity:.6}',
 '{"type":"object","required":["title","cases"],"properties":{"title":{"type":"string"},"cases":{"type":"array","items":{"type":"object","required":["result","quote","client_description"]}}}}',
 8.1),

('smp-law-donor-wall',
 'lawyer', 'Attorney Profiles — headshots + credentials', 'donor-wall',
 '<section class="smp-attorneys"><h2>{{title}}</h2><ul class="smp-attorneys__grid" role="list">{{#attorneys}}<li class="smp-attorneys__card"><div class="smp-attorneys__photo"><img src="{{photo_url}}" alt="{{name}}" loading="lazy" width="160" height="160"></div><h3>{{name}}</h3><span class="smp-attorneys__title">{{title_role}}</span><ul class="smp-attorneys__creds" aria-label="Credentials">{{#credentials}}<li>{{.}}</li>{{/credentials}}</ul></li>{{/attorneys}}</ul></section>',
 '.smp-attorneys{padding:4rem 1.5rem;max-width:72rem;margin:0 auto}.smp-attorneys__grid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:2rem;padding:0}.smp-attorneys__card{text-align:center}.smp-attorneys__photo img{width:160px;height:160px;border-radius:50%;object-fit:cover;border:2px solid rgba(0,229,255,.3)}.smp-attorneys__title{display:block;font-size:.875rem;color:#00e5ff;margin:.5rem 0}.smp-attorneys__creds{list-style:none;padding:0;font-size:.8rem;opacity:.7;display:flex;flex-wrap:wrap;gap:.25rem;justify-content:center}',
 '{"type":"object","required":["title","attorneys"],"properties":{"title":{"type":"string"},"attorneys":{"type":"array","items":{"type":"object","required":["photo_url","name","title_role","credentials"]}}}}',
 7.9),

('smp-law-faq',
 'lawyer', 'Legal FAQ — fee structure + process transparency', 'faq',
 '<section class="smp-faq"><h2>{{title}}</h2><dl class="smp-faq__list">{{#items}}<div class="smp-faq__item"><dt><button class="smp-faq__q" aria-expanded="false" aria-controls="faq-{{id}}">{{question}}</button></dt><dd id="faq-{{id}}" class="smp-faq__a" hidden>{{answer}}</dd></div>{{/items}}</dl></section><script>document.querySelectorAll(''.smp-faq__q'').forEach(b=>{b.addEventListener(''click'',()=>{const e=b.getAttribute(''aria-expanded'')===''true'';b.setAttribute(''aria-expanded'',String(!e));document.getElementById(b.getAttribute(''aria-controls'')).hidden=e;})});</script>',
 '.smp-faq{padding:4rem 1.5rem;max-width:56rem;margin:0 auto}.smp-faq__item{border-bottom:1px solid rgba(255,255,255,.1);padding:.5rem 0}.smp-faq__q{width:100%;text-align:left;background:none;border:none;color:inherit;font-size:1rem;padding:.75rem 0;cursor:pointer}.smp-faq__q:focus-visible{outline:2px solid #00e5ff;outline-offset:2px}.smp-faq__a{padding:.5rem 0 1rem;opacity:.8;line-height:1.7}',
 '{"type":"object","required":["title","items"],"properties":{"title":{"type":"string"},"items":{"type":"array","items":{"type":"object","required":["id","question","answer"]}}}}',
 8.0),

('smp-law-cta',
 'lawyer', 'Free Consultation CTA — urgency + form inline', 'cta',
 '<section class="smp-consult-cta"><h2>{{title}}</h2><p>{{description}}</p><p class="smp-consult-cta__urgency">{{urgency_note}}</p><a href="{{cta_url}}" class="smp-consult-cta__btn" data-bcl-cta="free-consult">{{cta_label}}</a></section>',
 '.smp-consult-cta{padding:4rem 1.5rem;text-align:center;border-top:1px solid rgba(0,229,255,.2)}.smp-consult-cta__urgency{font-size:.875rem;color:#f59e0b;margin-bottom:1.5rem}.smp-consult-cta__btn{display:inline-block;background:#00e5ff;color:#060610;padding:.875rem 2.5rem;border-radius:9999px;font-weight:700;text-decoration:none}',
 '{"type":"object","required":["title","description","urgency_note","cta_url","cta_label"],"properties":{"title":{"type":"string"},"description":{"type":"string"},"urgency_note":{"type":"string"},"cta_url":{"type":"string","format":"uri"},"cta_label":{"type":"string"}}}',
 8.2),

-- ── salon ─────────────────────────────────────────────────────────────────
('smp-sal-hero',
 'salon', 'Salon Hero — transformation photography + booking CTA', 'hero',
 '<section class="smp-hero" role="banner"><div class="smp-hero__inner"><h1 class="smp-hero__headline">{{headline}}</h1><p class="smp-hero__sub">{{subheadline}}</p><a href="{{book_url}}" class="smp-hero__cta" data-bcl-cta="book">{{cta_label}}</a></div></section>',
 '.smp-hero{background:linear-gradient(rgba(6,6,16,.5),rgba(6,6,16,.75)),center/cover no-repeat var(--hero-bg,#1a0a1a);color:#f4f4ff;padding:8rem 1.5rem;text-align:center}.smp-hero__headline{font:700 clamp(2.5rem,6vw,4rem)/1.1 ''Sora'',sans-serif;margin:0 0 1rem}.smp-hero__cta{display:inline-block;background:#00e5ff;color:#060610;padding:.875rem 2.5rem;border-radius:9999px;font-weight:700;text-decoration:none;margin-top:2rem}',
 '{"type":"object","required":["headline","subheadline","book_url","cta_label"],"properties":{"headline":{"type":"string"},"subheadline":{"type":"string"},"book_url":{"type":"string","format":"uri"},"cta_label":{"type":"string"}}}',
 8.3),

('smp-sal-services',
 'salon', 'Service Menu — duration + price + book inline', 'services',
 '<section class="smp-service-menu"><h2>{{title}}</h2><ul class="smp-service-menu__list" role="list">{{#services}}<li class="smp-service-menu__item"><div class="smp-service-menu__info"><h3>{{name}}</h3><p>{{description}}</p><div class="smp-service-menu__meta"><span>{{duration}}</span></div></div><div class="smp-service-menu__action"><span class="smp-service-menu__price">{{price}}</span><a href="{{book_url}}" class="smp-service-menu__book" data-bcl-cta="book-service">Book</a></div></li>{{/services}}</ul></section>',
 '.smp-service-menu{padding:4rem 1.5rem;max-width:56rem;margin:0 auto}.smp-service-menu__list{list-style:none;padding:0;display:flex;flex-direction:column;gap:1px}.smp-service-menu__item{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.25rem;background:rgba(255,255,255,.04);border-radius:8px;margin-bottom:4px}.smp-service-menu__info{flex:1}.smp-service-menu__meta{font-size:.8rem;opacity:.6;margin-top:.25rem}.smp-service-menu__action{display:flex;flex-direction:column;align-items:flex-end;gap:.5rem}.smp-service-menu__price{font-family:''JetBrains Mono'',monospace;font-weight:700;color:#00e5ff}.smp-service-menu__book{background:rgba(0,229,255,.15);color:#00e5ff;padding:.375rem .875rem;border-radius:9999px;text-decoration:none;font-size:.875rem;white-space:nowrap}',
 '{"type":"object","required":["title","services"],"properties":{"title":{"type":"string"},"services":{"type":"array","items":{"type":"object","required":["name","description","duration","price","book_url"]}}}}',
 8.4),

('smp-sal-testimonials',
 'salon', 'Before/After Gallery with client reviews', 'testimonials',
 '<section class="smp-before-after"><h2>{{title}}</h2><ol class="smp-ba__list" role="list">{{#transformations}}<li class="smp-ba__item"><div class="smp-ba__images"><img src="{{before_url}}" alt="Before: {{alt}}" loading="lazy" width="240" height="300"><img src="{{after_url}}" alt="After: {{alt}}" loading="lazy" width="240" height="300"></div><blockquote><p>{{quote}}</p><footer><cite>{{client}}</cite></footer></blockquote></li>{{/transformations}}</ol></section>',
 '.smp-before-after{padding:4rem 1.5rem}.smp-ba__list{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:2rem}.smp-ba__item{background:rgba(255,255,255,.04);border-radius:12px;overflow:hidden}.smp-ba__images{display:grid;grid-template-columns:1fr 1fr}.smp-ba__images img{width:100%;height:200px;object-fit:cover}.smp-ba__item blockquote{padding:1.25rem}.smp-ba__item p{font-style:italic;opacity:.9;margin:0 0 .5rem}',
 '{"type":"object","required":["title","transformations"],"properties":{"title":{"type":"string"},"transformations":{"type":"array","items":{"type":"object","required":["before_url","after_url","alt","quote","client"]}}}}',
 8.2),

('smp-sal-donor-wall',
 'salon', 'Stylist Team Wall — photos + specialties', 'donor-wall',
 '<section class="smp-team"><h2>{{title}}</h2><ul class="smp-team__grid" role="list">{{#stylists}}<li class="smp-team__card"><img src="{{photo_url}}" alt="{{name}}" loading="lazy" width="160" height="160"><h3>{{name}}</h3><span class="smp-team__title">{{title_role}}</span><ul class="smp-team__specialties" aria-label="Specialties">{{#specialties}}<li>{{.}}</li>{{/specialties}}</ul></li>{{/stylists}}</ul></section>',
 '.smp-team{padding:4rem 1.5rem;max-width:72rem;margin:0 auto}.smp-team__grid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:2rem;padding:0}.smp-team__card{text-align:center;display:flex;flex-direction:column;align-items:center;gap:.5rem}.smp-team__card img{width:140px;height:140px;border-radius:50%;object-fit:cover;border:2px solid rgba(0,229,255,.25)}.smp-team__title{color:#00e5ff;font-size:.875rem}.smp-team__specialties{list-style:none;padding:0;font-size:.75rem;opacity:.7;display:flex;flex-wrap:wrap;gap:.25rem;justify-content:center}',
 '{"type":"object","required":["title","stylists"],"properties":{"title":{"type":"string"},"stylists":{"type":"array","items":{"type":"object","required":["photo_url","name","title_role","specialties"]}}}}',
 7.9),

('smp-sal-faq',
 'salon', 'Salon FAQ — prep, aftercare, pricing transparency', 'faq',
 '<section class="smp-faq"><h2>{{title}}</h2><dl class="smp-faq__list">{{#items}}<div class="smp-faq__item"><dt><button class="smp-faq__q" aria-expanded="false" aria-controls="faq-{{id}}">{{question}}</button></dt><dd id="faq-{{id}}" class="smp-faq__a" hidden>{{answer}}</dd></div>{{/items}}</dl></section><script>document.querySelectorAll(''.smp-faq__q'').forEach(b=>{b.addEventListener(''click'',()=>{const e=b.getAttribute(''aria-expanded'')===''true'';b.setAttribute(''aria-expanded'',String(!e));document.getElementById(b.getAttribute(''aria-controls'')).hidden=e;})});</script>',
 '.smp-faq{padding:4rem 1.5rem;max-width:56rem;margin:0 auto}.smp-faq__item{border-bottom:1px solid rgba(255,255,255,.1)}.smp-faq__q{width:100%;text-align:left;background:none;border:none;color:inherit;font-size:1rem;padding:.75rem 0;cursor:pointer}.smp-faq__q:focus-visible{outline:2px solid #00e5ff;outline-offset:2px}.smp-faq__a{padding:.5rem 0 1rem;opacity:.8;line-height:1.7}',
 '{"type":"object","required":["title","items"],"properties":{"title":{"type":"string"},"items":{"type":"array","items":{"type":"object","required":["id","question","answer"]}}}}',
 8.0),

('smp-sal-cta',
 'salon', 'Booking CTA — urgency + slots remaining counter', 'cta',
 '<section class="smp-book-cta"><h2>{{title}}</h2><p>{{description}}</p><p class="smp-book-cta__urgency">{{slots_remaining}} slots open this week</p><a href="{{book_url}}" class="smp-book-cta__btn" data-bcl-cta="book">{{cta_label}}</a></section>',
 '.smp-book-cta{padding:4rem 1.5rem;text-align:center;border-top:1px solid rgba(0,229,255,.2)}.smp-book-cta__urgency{color:#f59e0b;font-size:.875rem;margin-bottom:1.5rem}.smp-book-cta__btn{display:inline-block;background:#00e5ff;color:#060610;padding:.875rem 2.5rem;border-radius:9999px;font-weight:700;text-decoration:none}',
 '{"type":"object","required":["title","description","slots_remaining","book_url","cta_label"],"properties":{"title":{"type":"string"},"description":{"type":"string"},"slots_remaining":{"type":"integer"},"book_url":{"type":"string","format":"uri"},"cta_label":{"type":"string"}}}',
 8.1),

-- ── medical ───────────────────────────────────────────────────────────────
('smp-med-hero',
 'medical', 'Medical Practice Hero — trust signals + appointment CTA', 'hero',
 '<section class="smp-hero" role="banner"><div class="smp-hero__inner"><h1 class="smp-hero__headline">{{headline}}</h1><p class="smp-hero__sub">{{subheadline}}</p><div class="smp-hero__trust"><span>{{board_certifications}}</span><span>{{years_practice}}+ years experience</span><span>{{insurance_accepted}}</span></div><a href="{{appt_url}}" class="smp-hero__cta" data-bcl-cta="appointment">{{cta_label}}</a></div></section>',
 '.smp-hero{background:linear-gradient(135deg,#0a1a2e 0%,#0a2e2e 100%);color:#f4f4ff;padding:7rem 1.5rem;text-align:center}.smp-hero__headline{font:700 clamp(2rem,5vw,3.5rem)/1.1 ''Sora'',sans-serif;margin:0 0 1rem}.smp-hero__trust{display:flex;gap:1.5rem;justify-content:center;flex-wrap:wrap;font-size:.875rem;opacity:.75;margin:1.5rem 0;padding:1rem;border:1px solid rgba(0,229,255,.2);border-radius:8px}.smp-hero__cta{display:inline-block;background:#00e5ff;color:#060610;padding:.875rem 2.5rem;border-radius:9999px;font-weight:700;text-decoration:none}',
 '{"type":"object","required":["headline","subheadline","board_certifications","years_practice","insurance_accepted","appt_url","cta_label"],"properties":{"headline":{"type":"string"},"subheadline":{"type":"string"},"board_certifications":{"type":"string"},"years_practice":{"type":"integer"},"insurance_accepted":{"type":"string"},"appt_url":{"type":"string","format":"uri"},"cta_label":{"type":"string"}}}',
 8.5),

('smp-med-services',
 'medical', 'Medical Services Grid — specialty cards with scheduling', 'services',
 '<section class="smp-specialties"><h2>{{title}}</h2><ul class="smp-specialties__grid" role="list">{{#specialties}}<li class="smp-specialties__card"><span class="smp-specialties__icon" aria-hidden="true">{{icon}}</span><h3>{{name}}</h3><p>{{description}}</p><a href="{{schedule_url}}" class="smp-specialties__link" data-bcl-cta="schedule-specialty">Schedule →</a></li>{{/specialties}}</ul></section>',
 '.smp-specialties{padding:4rem 1.5rem;max-width:72rem;margin:0 auto}.smp-specialties__grid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.5rem;padding:0}.smp-specialties__card{background:rgba(255,255,255,.04);border:1px solid rgba(0,229,255,.1);border-radius:12px;padding:1.5rem;display:flex;flex-direction:column;gap:.75rem}.smp-specialties__icon{font-size:1.75rem}.smp-specialties__link{color:#00e5ff;text-decoration:none;font-size:.875rem;font-weight:600;margin-top:auto}',
 '{"type":"object","required":["title","specialties"],"properties":{"title":{"type":"string"},"specialties":{"type":"array","items":{"type":"object","required":["icon","name","description","schedule_url"]}}}}',
 8.1),

('smp-med-testimonials',
 'medical', 'Patient Testimonials — HIPAA-safe attributions', 'testimonials',
 '<section class="smp-patient-stories"><h2>{{title}}</h2><ol class="smp-stories__list" role="list">{{#stories}}<li class="smp-story"><blockquote><p>{{quote}}</p><footer><cite>{{attribution}}</cite></footer></blockquote></li>{{/stories}}</ol></section>',
 '.smp-patient-stories{padding:4rem 1.5rem;background:rgba(255,255,255,.02)}.smp-stories__list{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.5rem}.smp-story{background:rgba(255,255,255,.05);border-radius:12px;padding:1.5rem;border-top:3px solid #00e5ff}.smp-story p{font-style:italic;opacity:.9;line-height:1.6;margin:0 0 .75rem}.smp-story cite{font-size:.8rem;opacity:.6}',
 '{"type":"object","required":["title","stories"],"properties":{"title":{"type":"string"},"stories":{"type":"array","items":{"type":"object","required":["quote","attribution"]}}}}',
 7.8),

('smp-med-donor-wall',
 'medical', 'Provider Directory — credentials + telehealth badge', 'donor-wall',
 '<section class="smp-providers"><h2>{{title}}</h2><ul class="smp-providers__grid" role="list">{{#providers}}<li class="smp-providers__card"><img src="{{photo_url}}" alt="{{name}}" loading="lazy" width="120" height="120"><h3>{{name}}</h3><span class="smp-providers__role">{{role}}</span>{{#telehealth}}<span class="smp-providers__badge">Telehealth available</span>{{/telehealth}}<ul class="smp-providers__creds">{{#credentials}}<li>{{.}}</li>{{/credentials}}</ul></li>{{/providers}}</ul></section>',
 '.smp-providers{padding:4rem 1.5rem;max-width:72rem;margin:0 auto}.smp-providers__grid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:2rem;padding:0}.smp-providers__card{text-align:center;display:flex;flex-direction:column;align-items:center;gap:.5rem}.smp-providers__card img{width:120px;height:120px;border-radius:50%;object-fit:cover;border:2px solid rgba(0,229,255,.25)}.smp-providers__role{color:#00e5ff;font-size:.875rem}.smp-providers__badge{background:rgba(52,211,153,.15);color:#34d399;font-size:.75rem;padding:.2rem .6rem;border-radius:9999px}.smp-providers__creds{list-style:none;padding:0;font-size:.75rem;opacity:.6;display:flex;flex-wrap:wrap;gap:.25rem;justify-content:center}',
 '{"type":"object","required":["title","providers"],"properties":{"title":{"type":"string"},"providers":{"type":"array","items":{"type":"object","required":["photo_url","name","role","telehealth","credentials"]}}}}',
 8.0),

('smp-med-faq',
 'medical', 'Medical FAQ — insurance, hours, first-visit prep', 'faq',
 '<section class="smp-faq"><h2>{{title}}</h2><dl class="smp-faq__list">{{#items}}<div class="smp-faq__item"><dt><button class="smp-faq__q" aria-expanded="false" aria-controls="faq-{{id}}">{{question}}</button></dt><dd id="faq-{{id}}" class="smp-faq__a" hidden>{{answer}}</dd></div>{{/items}}</dl></section><script>document.querySelectorAll(''.smp-faq__q'').forEach(b=>{b.addEventListener(''click'',()=>{const e=b.getAttribute(''aria-expanded'')===''true'';b.setAttribute(''aria-expanded'',String(!e));document.getElementById(b.getAttribute(''aria-controls'')).hidden=e;})});</script>',
 '.smp-faq{padding:4rem 1.5rem;max-width:56rem;margin:0 auto}.smp-faq__item{border-bottom:1px solid rgba(255,255,255,.1)}.smp-faq__q{width:100%;text-align:left;background:none;border:none;color:inherit;font-size:1rem;padding:.75rem 0;cursor:pointer}.smp-faq__q:focus-visible{outline:2px solid #00e5ff;outline-offset:2px}.smp-faq__a{padding:.5rem 0 1rem;opacity:.8;line-height:1.7}',
 '{"type":"object","required":["title","items"],"properties":{"title":{"type":"string"},"items":{"type":"array","items":{"type":"object","required":["id","question","answer"]}}}}',
 8.0),

('smp-med-cta',
 'medical', 'Appointment Request CTA — online + phone options', 'cta',
 '<section class="smp-appt-cta"><h2>{{title}}</h2><p>{{description}}</p><div class="smp-appt-cta__actions"><a href="{{online_url}}" class="smp-appt-cta__primary" data-bcl-cta="book-online">{{online_label}}</a><a href="tel:{{phone_e164}}" class="smp-appt-cta__secondary" data-bcl-cta="call">{{phone_display}}</a></div></section>',
 '.smp-appt-cta{padding:4rem 1.5rem;text-align:center;border-top:1px solid rgba(0,229,255,.2)}.smp-appt-cta__actions{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin-top:1.5rem}.smp-appt-cta__primary{background:#00e5ff;color:#060610;padding:.875rem 2rem;border-radius:9999px;font-weight:700;text-decoration:none}.smp-appt-cta__secondary{border:1px solid rgba(0,229,255,.5);color:#00e5ff;padding:.875rem 2rem;border-radius:9999px;text-decoration:none}',
 '{"type":"object","required":["title","description","online_url","online_label","phone_e164","phone_display"],"properties":{"title":{"type":"string"},"description":{"type":"string"},"online_url":{"type":"string","format":"uri"},"online_label":{"type":"string"},"phone_e164":{"type":"string","pattern":"^\\+[1-9]\\d{1,14}$"},"phone_display":{"type":"string"}}}',
 8.4);

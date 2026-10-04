import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RollingCounterComponent } from '../../components/rolling-counter/rolling-counter.component';
import { RevealDirective } from '../../directives/reveal.directive';
import { MetaService } from '../../services/meta.service';

/**
 * Public pricing page rendered at `/pricing`.
 *
 * @remarks
 * The ProjectSites.dev cost model, in the open: you pay the exact metered
 * Cloudflare cost of everything in your site's Workers-for-Platforms namespace —
 * its Worker, its own database, its storage, its compute — plus one flat
 * $50/month platform fee, and we absorb Cloudflare's account-level base fees so
 * they never land on your bill. SSOT: `apps/project-sites/docs/PRICING-MODEL.md`.
 *
 * Sections: hero ("You pay what it costs. Plus $50.") → the 10 charge components
 * → Cloudflare unit prices → a worked itemized monthly bill → transparent-vs-
 * opaque competitor comparison (Vercel/Netlify/WP Engine/Squarespace/Webflow/Wix)
 * → idle-vs-typical installable-app prices → FAQ → CTA into the create funnel.
 *
 * Cinematic per the brand: `<app-rolling-counter>` count-up on the "$50" fee,
 * `appReveal` scroll-reveal on every section, animated comparison bars — all
 * reduced-motion-safe (the shared primitives snap to final state; the bars gate
 * on the same media query). Injects `FAQPage` + `BreadcrumbList` +
 * `Product`/`Offer` JSON-LD into `<head>` (mirrors the changelog page's direct
 * DOM approach, tagged for clean teardown).
 */

/** One row in a unit-price table. */
interface PriceRow {
  readonly resource: string;
  readonly metric: string;
  readonly price: string;
}

/** One of the 10 charge components. */
interface ChargeComponent {
  readonly n: number;
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

/** One line in the worked-example itemized bill. */
interface BillLine {
  readonly label: string;
  readonly detail: string;
  readonly amount: number;
}

/** One competitor row for the comparison table. */
interface Competitor {
  readonly name: string;
  readonly model: string;
  readonly entry: string;
  readonly transparent: boolean;
  /** 0-100 width of the dead-headroom bar; ours is a thin sliver. */
  readonly headroom: number;
  readonly note: string;
}

/** One app in the idle-vs-typical table. */
interface AppPrice {
  readonly app: string;
  readonly kind: string;
  readonly idle: string;
  readonly typical: string;
}

/** One FAQ entry — also emitted as JSON-LD FAQPage mainEntity. */
interface Faq {
  readonly q: string;
  readonly a: string;
}

/**
 * Public pricing page.
 *
 * @example
 * ```ts
 * // app.routes.ts
 * { path: 'pricing', loadComponent: () =>
 *   import('./pages/pricing/pricing.component').then((m) => m.PricingComponent) }
 * ```
 */
@Component({
  selector: 'app-pricing',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, RollingCounterComponent, RevealDirective],
  template: `
    <main class="pricing">
      <!-- HERO -->
      <section class="hero" appReveal aria-labelledby="pricing-h1">
        <p class="eyebrow">Pricing</p>
        <h1 id="pricing-h1">
          You pay what it costs. Plus $<app-rolling-counter [value]="50" [duration]="1200" />.
        </h1>
        <p class="subtitle">
          We bill the exact metered Cloudflare cost of everything in your site &mdash; its
          Worker, its own database, its storage, its compute &mdash; then add one flat
          platform fee. No markup on infrastructure. No Cloudflare membership fee passed to
          you. No mystery tiers.
        </p>
        <ul class="badges" aria-label="Pricing principles">
          <li class="badge">Exact metered cost</li>
          <li class="badge">Flat $50 / month per site</li>
          <li class="badge">We absorb Cloudflare's base fees</li>
          <li class="badge">Every line is attributable</li>
        </ul>
        <div class="cta-row">
          <a class="cta-btn primary" routerLink="/search" data-testid="pricing-cta-hero">
            Build my site
          </a>
          <a class="cta-btn" href="#components">See the 10 components</a>
        </div>
      </section>

      <!-- THE DEAL -->
      <section class="deal-grid" appReveal aria-label="How pricing works">
        <div class="deal-card">
          <h2 class="deal-title">What you pay for</h2>
          <p class="deal-lede">
            Every site gets its own named Worker, its own database, and its own storage bucket
            in a single Workers-for-Platforms namespace. We meter each one through Cloudflare's
            analytics API and bill its published unit cost &mdash; the same number Cloudflare
            charges us, with nothing added.
          </p>
        </div>
        <div class="deal-card accent">
          <h2 class="deal-title">The one flat fee</h2>
          <p class="deal-fee">
            $<app-rolling-counter [value]="50" [duration]="1200" /><span class="per">/mo</span>
          </p>
          <p class="deal-lede">
            per site. It covers our Cloudflare Workers Paid and Workers-for-Platforms base
            fees, engineering, and support &mdash; so those account-level costs never surface
            on your bill.
          </p>
        </div>
      </section>

      <!-- THE 10 COMPONENTS -->
      <section id="components" class="block" appReveal aria-labelledby="components-h">
        <h2 id="components-h" class="block-title">Your monthly bill is a sum of 10 things</h2>
        <p class="block-lede">
          Nine of them are pass-through cost. One is the flat fee. Nothing else exists.
        </p>
        <ol class="components">
          @for (c of components(); track c.n) {
            <li class="component-card">
              <div class="component-head">
                <span class="component-n" aria-hidden="true">{{
                  c.n < 10 ? '0' + c.n : c.n
                }}</span>
                <span class="component-tag">{{ c.tag }}</span>
              </div>
              <h3 class="component-title">{{ c.title }}</h3>
              <p class="component-body">{{ c.body }}</p>
            </li>
          }
        </ol>
      </section>

      <!-- UNIT PRICES -->
      <section class="block" appReveal aria-labelledby="units-h">
        <h2 id="units-h" class="block-title">Unit prices</h2>
        <p class="block-lede">
          Cloudflare's published marginal rates &mdash; no base fee baked in. These are the
          defaults; your bill uses whatever the meter reads that month.
        </p>
        <div class="table-wrap" role="region" aria-labelledby="units-h" tabindex="0">
          <table class="price-table">
            <caption class="sr-only">Cloudflare unit prices used to meter your site</caption>
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Metric</th>
                <th scope="col" class="num">Unit price</th>
              </tr>
            </thead>
            <tbody>
              @for (r of unitPrices(); track r.resource + r.metric) {
                <tr>
                  <th scope="row">{{ r.resource }}</th>
                  <td>{{ r.metric }}</td>
                  <td class="num mono">{{ r.price }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="fine">
          Fixed platform base we absorb, never billed: Workers Paid $5/mo + Workers-for-Platforms
          $25/mo. That's what your flat $50 covers.
        </p>
      </section>

      <!-- WORKED EXAMPLE -->
      <section class="block" appReveal aria-labelledby="example-h">
        <h2 id="example-h" class="block-title">A real monthly bill, itemized</h2>
        <p class="block-lede">
          A small business site &mdash; a few thousand visits, one AI concierge, nightly
          production snapshots. Here's exactly what it costs.
        </p>
        <div class="table-wrap" role="region" aria-labelledby="example-h" tabindex="0">
          <table class="price-table bill">
            <caption class="sr-only">Example itemized monthly bill for a typical site</caption>
            <thead>
              <tr>
                <th scope="col">Line item</th>
                <th scope="col">What it is</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              @for (line of billLines(); track line.label) {
                <tr>
                  <th scope="row">{{ line.label }}</th>
                  <td>{{ line.detail }}</td>
                  <td class="num mono">
                    {{ line.amount === 0 ? '$0.00' : '$' + line.amount.toFixed(2) }}
                  </td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr class="total-row">
                <th scope="row" colspan="2">Total this month</th>
                <td class="num mono total">\${{ billTotal().toFixed(2) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p class="fine">
          The $50 is the only fixed number. Everything above it is metered &mdash; a quieter
          month costs less, a busier month costs a little more, and you can read every cent.
        </p>
      </section>

      <!-- COMPETITOR COMPARISON -->
      <section class="block" appReveal aria-labelledby="compare-h">
        <h2 id="compare-h" class="block-title">Transparent cost vs. flat mystery tiers</h2>
        <p class="block-lede">
          Everyone else sells you a tier and hopes you don't use it all. You pay for a bucket
          of "up to" &mdash; and eat the gap between what you bought and what you used. We bill
          the meter.
        </p>
        <div class="compare-list">
          @for (co of competitors(); track co.name) {
            <div class="compare-row" [class.is-us]="co.transparent">
              <div class="compare-name">
                <span class="compare-vendor">{{ co.name }}</span>
                <span class="compare-badge" [class.good]="co.transparent">
                  {{ co.transparent ? 'Transparent' : 'Opaque tier' }}
                </span>
              </div>
              <div class="compare-model">
                <span class="compare-entry">{{ co.entry }}</span>
                <span class="compare-desc">{{ co.model }}</span>
              </div>
              <div
                class="compare-bar-track"
                role="img"
                [attr.aria-label]="
                  co.transparent
                    ? co.name + ': you pay only for what you use, at cost, plus a flat fee'
                    : co.name + ': ' + co.note
                "
              >
                <span
                  class="compare-bar"
                  [class.us]="co.transparent"
                  [style.width.%]="barsArmed() ? co.headroom : 0"
                ></span>
                <span class="compare-note">{{ co.note }}</span>
              </div>
            </div>
          }
        </div>
        <p class="fine">
          Bars show how much of a flat plan is dead headroom you pay for regardless of use.
          Ours is a sliver &mdash; the $50 fee &mdash; because everything else is your real
          usage at cost.
        </p>
      </section>

      <!-- IDLE VS TYPICAL -->
      <section class="block" appReveal aria-labelledby="apps-h">
        <h2 id="apps-h" class="block-title">Add an app? See it idle and typical</h2>
        <p class="block-lede">
          Install a backend app &mdash; a CMS, analytics, a database studio &mdash; and it gets
          its own metered resources too. Worker-based apps scale to zero, so idle is often free.
        </p>
        <div class="table-wrap" role="region" aria-labelledby="apps-h" tabindex="0">
          <table class="price-table">
            <caption class="sr-only">
              Example installable apps with idle and typical monthly cost
            </caption>
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Type</th>
                <th scope="col" class="num">Idle (scale-to-zero)</th>
                <th scope="col" class="num">Typical (AI-estimated)</th>
              </tr>
            </thead>
            <tbody>
              @for (a of appPrices(); track a.app) {
                <tr>
                  <th scope="row">{{ a.app }}</th>
                  <td>{{ a.kind }}</td>
                  <td class="num mono idle">{{ a.idle }}</td>
                  <td class="num mono">{{ a.typical }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="fine">
          "Typical" is an AI estimate of a normal-usage month for that app's resource profile.
          Your real bill is always the meter, never the estimate.
        </p>
      </section>

      <!-- FAQ -->
      <section class="block" appReveal aria-labelledby="faq-h">
        <h2 id="faq-h" class="block-title">Questions, answered plainly</h2>
        <div class="faq">
          @for (f of faqs(); track f.q; let i = $index) {
            <details class="faq-item" [open]="i === 0">
              <summary>
                <span class="faq-q">{{ f.q }}</span>
                <span class="faq-icon" aria-hidden="true"></span>
              </summary>
              <p class="faq-a">{{ f.a }}</p>
            </details>
          }
        </div>
      </section>

      <!-- CTA -->
      <section class="cta-band" appReveal aria-labelledby="cta-h">
        <h2 id="cta-h" class="cta-title">See your first bill before it surprises you</h2>
        <p class="cta-lede">
          Start a site, watch it get built, and every cost is a line item you can read.
        </p>
        <a class="cta-btn primary big" routerLink="/search" data-testid="pricing-cta-footer">
          Build my site &rarr;
        </a>
      </section>
    </main>

    <footer class="site-footer">
      <div class="footer-inner">
        <div class="footer-bottom">
          <span>
            &copy; 2026
            <a href="https://megabyte.space" target="_blank" rel="noopener noreferrer">
              Megabyte LLC
            </a>
          </span>
          <span>
            <a routerLink="/pricing">Pricing</a> |
            <a routerLink="/privacy">Privacy</a> |
            <a routerLink="/terms">Terms</a> |
            <a routerLink="/trust">Trust</a> |
            <a routerLink="/changelog">Changelog</a>
          </span>
        </div>
      </div>
    </footer>
  `,
  styles: [
    `
      :host {
        display: block;
        background: var(--ps-bg, #060610);
        color: var(--ps-ink, #f4f4ff);
        font-family: 'Space Grotesk', 'Sora', system-ui, sans-serif;
      }

      .pricing {
        max-width: 1040px;
        margin: 0 auto;
        padding: clamp(3rem, 8vw, 5rem) 1.25rem 6rem;
      }

      /* HERO */
      .hero {
        text-align: center;
        margin-bottom: clamp(3rem, 7vw, 4.5rem);
      }

      .eyebrow {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        margin: 0 0 0.9rem;
      }

      h1 {
        font-family: 'Sora', 'Space Grotesk', system-ui, sans-serif;
        font-size: clamp(2.2rem, 6vw, 4rem);
        font-weight: 800;
        letter-spacing: -0.035em;
        line-height: 1.05;
        margin: 0 0 1.1rem;
        text-wrap: balance;
      }

      h1 app-rolling-counter {
        color: var(--ps-accent, #00e5ff);
      }

      .subtitle {
        font-size: clamp(1rem, 2.2vw, 1.2rem);
        line-height: 1.6;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 72%, transparent);
        max-width: 44ch;
        margin: 0 auto 1.6rem;
        text-wrap: pretty;
      }

      .badges {
        list-style: none;
        padding: 0;
        margin: 0 0 1.8rem;
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        justify-content: center;
      }

      .badge {
        font-size: 0.82rem;
        font-weight: 600;
        padding: 0.45rem 0.95rem;
        border-radius: 999px;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 26%, transparent);
      }

      .cta-row {
        display: flex;
        gap: 0.85rem;
        justify-content: center;
        flex-wrap: wrap;
      }

      .cta-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        padding: 0.85rem 1.6rem;
        border-radius: 999px;
        font-size: 0.95rem;
        font-weight: 700;
        text-decoration: none;
        cursor: pointer;
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 22%, transparent);
        background: transparent;
        color: var(--ps-ink, #f4f4ff);
        transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
      }

      .cta-btn:hover {
        border-color: var(--ps-accent, #00e5ff);
        color: var(--ps-accent, #00e5ff);
      }

      .cta-btn.primary {
        background: var(--ps-accent, #00e5ff);
        color: #03070a;
        border-color: var(--ps-accent, #00e5ff);
      }

      .cta-btn.primary:hover {
        color: #03070a;
        transform: translateY(-2px);
        box-shadow: 0 12px 32px color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
      }

      .cta-btn.big {
        min-height: 56px;
        padding: 1.05rem 2.1rem;
        font-size: 1.05rem;
      }

      .cta-btn:focus-visible {
        outline: 3px solid var(--ps-accent, #00e5ff);
        outline-offset: 3px;
      }

      /* DEAL GRID */
      .deal-grid {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: 1.25rem;
        margin-bottom: clamp(3.5rem, 8vw, 5rem);
      }

      .deal-card {
        padding: 1.8rem 1.9rem;
        border-radius: var(--ps-radius-xl, 22px);
        background: color-mix(in oklch, var(--ps-bg, #060610) 76%, var(--ps-ink, #f4f4ff));
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent);
      }

      .deal-card.accent {
        background: linear-gradient(
          160deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, var(--ps-bg, #060610)),
          color-mix(in oklch, var(--ps-bg, #060610) 88%, var(--ps-ink, #f4f4ff))
        );
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 34%, transparent);
        text-align: center;
      }

      .deal-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.15rem;
        font-weight: 700;
        margin: 0 0 0.75rem;
      }

      .deal-lede {
        font-size: 0.96rem;
        line-height: 1.6;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        margin: 0;
        text-wrap: pretty;
      }

      .deal-fee {
        display: flex;
        align-items: baseline;
        justify-content: center;
        gap: 0.15rem;
        font-family: 'Sora', system-ui, sans-serif;
        font-size: clamp(3rem, 8vw, 4.6rem);
        font-weight: 800;
        line-height: 1;
        margin: 0.4rem 0 0.9rem;
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
      }

      .deal-fee .per {
        font-size: 1.3rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
        font-weight: 600;
      }

      /* BLOCKS */
      .block {
        margin-bottom: clamp(3.5rem, 8vw, 5rem);
      }

      .block-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: clamp(1.5rem, 3.6vw, 2.2rem);
        font-weight: 800;
        letter-spacing: -0.02em;
        margin: 0 0 0.7rem;
        text-wrap: balance;
      }

      .block-lede {
        font-size: 1.02rem;
        line-height: 1.6;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 66%, transparent);
        max-width: 62ch;
        margin: 0 0 1.75rem;
        text-wrap: pretty;
      }

      .fine {
        font-size: 0.85rem;
        line-height: 1.55;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent);
        margin: 1.1rem 0 0;
        max-width: 62ch;
      }

      /* COMPONENTS GRID */
      .components {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 1rem;
      }

      .component-card {
        padding: 1.35rem 1.35rem 1.5rem;
        border-radius: 16px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 78%, var(--ps-ink, #f4f4ff));
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 7%, transparent);
        transition: border-color 0.3s ease, transform 0.3s ease;
      }

      .component-card:hover {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
        transform: translateY(-3px);
      }

      .component-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.75rem;
      }

      .component-n {
        font-family: 'JetBrains Mono', monospace;
        font-size: 1.4rem;
        font-weight: 700;
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
      }

      .component-tag {
        font-size: 0.64rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.09em;
        padding: 0.25rem 0.55rem;
        border-radius: 20px;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent);
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 7%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 12%, transparent);
      }

      .component-title {
        font-size: 1.02rem;
        font-weight: 700;
        margin: 0 0 0.5rem;
        line-height: 1.3;
      }

      .component-body {
        font-size: 0.9rem;
        line-height: 1.6;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 66%, transparent);
        margin: 0;
        text-wrap: pretty;
      }

      /* TABLES */
      .table-wrap {
        overflow-x: auto;
        border-radius: 16px;
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent);
        background: color-mix(in oklch, var(--ps-bg, #060610) 80%, var(--ps-ink, #f4f4ff));
      }

      .table-wrap:focus-visible {
        outline: 3px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      .price-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.92rem;
        min-width: 480px;
      }

      .price-table caption {
        text-align: left;
      }

      .price-table th,
      .price-table td {
        padding: 0.8rem 1.1rem;
        text-align: left;
        border-bottom: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 7%, transparent);
      }

      .price-table thead th {
        font-size: 0.72rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
        background: color-mix(in oklch, var(--ps-bg, #060610) 60%, var(--ps-ink, #f4f4ff));
      }

      .price-table tbody th[scope='row'] {
        font-weight: 600;
        color: var(--ps-ink, #f4f4ff);
      }

      .price-table td {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 76%, transparent);
      }

      .price-table tbody tr:hover td,
      .price-table tbody tr:hover th {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 5%, transparent);
      }

      .price-table tbody tr:last-child td,
      .price-table tbody tr:last-child th {
        border-bottom: none;
      }

      .num {
        text-align: right;
      }

      .mono {
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }

      .idle {
        color: var(--ps-accent, #00e5ff);
      }

      .bill tfoot .total-row th,
      .bill tfoot .total-row td {
        border-top: 2px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
        border-bottom: none;
        padding-top: 1rem;
        font-weight: 700;
        font-size: 1rem;
      }

      .total {
        color: var(--ps-accent, #00e5ff);
        font-size: 1.15rem;
      }

      /* COMPARISON */
      .compare-list {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }

      .compare-row {
        display: grid;
        grid-template-columns: 1.1fr 1.4fr 2fr;
        gap: 1.1rem;
        align-items: center;
        padding: 1rem 1.25rem;
        border-radius: 14px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 80%, var(--ps-ink, #f4f4ff));
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
      }

      .compare-row.is-us {
        background: linear-gradient(
          100deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, var(--ps-bg, #060610)),
          color-mix(in oklch, var(--ps-bg, #060610) 86%, var(--ps-ink, #f4f4ff))
        );
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 34%, transparent);
      }

      .compare-name {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }

      .compare-vendor {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1rem;
        font-weight: 700;
      }

      .compare-badge {
        align-self: flex-start;
        font-size: 0.62rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 0.2rem 0.5rem;
        border-radius: 20px;
        color: #fbbf24;
        background: rgba(245, 158, 11, 0.12);
        border: 1px solid rgba(245, 158, 11, 0.28);
      }

      .compare-badge.good {
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
      }

      .compare-model {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }

      .compare-entry {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.95rem;
        font-weight: 700;
        color: var(--ps-ink, #f4f4ff);
      }

      .compare-desc {
        font-size: 0.8rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 58%, transparent);
        line-height: 1.45;
      }

      .compare-bar-track {
        position: relative;
        height: 34px;
        border-radius: 8px;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 6%, transparent);
        overflow: hidden;
        display: flex;
        align-items: center;
      }

      .compare-bar {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 0;
        border-radius: 8px;
        background: linear-gradient(90deg, rgba(245, 158, 11, 0.5), rgba(245, 158, 11, 0.22));
        transition: width 1.1s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .compare-bar.us {
        background: linear-gradient(
          90deg,
          var(--ps-accent, #00e5ff),
          color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent)
        );
      }

      .compare-note {
        position: relative;
        z-index: 1;
        padding-left: 0.85rem;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--ps-ink, #f4f4ff);
      }

      /* FAQ */
      .faq {
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
      }

      .faq-item {
        border-radius: 14px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 80%, var(--ps-ink, #f4f4ff));
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
        overflow: hidden;
      }

      .faq-item[open] {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 24%, transparent);
      }

      .faq-item summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 1.1rem 1.35rem;
        cursor: pointer;
        list-style: none;
        min-height: 24px;
      }

      .faq-item summary::-webkit-details-marker {
        display: none;
      }

      .faq-item summary:focus-visible {
        outline: 3px solid var(--ps-accent, #00e5ff);
        outline-offset: -3px;
        border-radius: 14px;
      }

      .faq-q {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1rem;
        font-weight: 700;
        line-height: 1.4;
      }

      .faq-icon {
        position: relative;
        flex: 0 0 auto;
        width: 20px;
        height: 20px;
      }

      .faq-icon::before,
      .faq-icon::after {
        content: '';
        position: absolute;
        background: var(--ps-accent, #00e5ff);
        border-radius: 2px;
        transition: transform 0.25s ease;
      }

      .faq-icon::before {
        top: 9px;
        left: 2px;
        right: 2px;
        height: 2px;
      }

      .faq-icon::after {
        left: 9px;
        top: 2px;
        bottom: 2px;
        width: 2px;
      }

      .faq-item[open] .faq-icon::after {
        transform: scaleY(0);
      }

      .faq-a {
        padding: 0 1.35rem 1.2rem;
        font-size: 0.94rem;
        line-height: 1.65;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 72%, transparent);
        margin: 0;
        text-wrap: pretty;
      }

      /* CTA BAND */
      .cta-band {
        text-align: center;
        padding: clamp(2.5rem, 6vw, 3.5rem) 1.9rem;
        border-radius: var(--ps-radius-xl, 22px);
        background: linear-gradient(
          160deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, var(--ps-bg, #060610)),
          color-mix(in oklch, var(--ps-bg, #060610) 90%, var(--ps-ink, #f4f4ff))
        );
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent);
      }

      .cta-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: clamp(1.5rem, 4vw, 2.4rem);
        font-weight: 800;
        letter-spacing: -0.02em;
        margin: 0 0 0.7rem;
        text-wrap: balance;
      }

      .cta-lede {
        font-size: 1.05rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        margin: 0 auto 1.6rem;
        max-width: 44ch;
      }

      /* FOOTER */
      .site-footer {
        padding: 2.25rem 1.5rem 1.75rem;
        border-top: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 6%, transparent);
      }

      .footer-inner {
        max-width: 1040px;
        margin: 0 auto;
      }

      .footer-bottom {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.75rem;
        font-size: 0.8rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610));
      }

      .footer-bottom a {
        color: inherit;
        text-decoration: none;
        transition: color 0.2s ease;
      }

      .footer-bottom a:hover {
        color: var(--ps-accent, #00e5ff);
      }

      .footer-bottom a:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* RESPONSIVE */
      @media (max-width: 860px) {
        .deal-grid {
          grid-template-columns: 1fr;
        }

        .compare-row {
          grid-template-columns: 1fr;
          gap: 0.75rem;
        }

        .compare-bar-track {
          height: 30px;
        }
      }

      @media (max-width: 560px) {
        .pricing {
          padding: 2.5rem 1rem 4.5rem;
        }

        .badges {
          gap: 0.45rem;
        }

        .badge {
          font-size: 0.75rem;
          padding: 0.4rem 0.75rem;
        }

        .footer-bottom {
          flex-direction: column;
          text-align: center;
        }
      }

      /* REDUCED MOTION — the shared primitives already snap; kill local transitions too */
      @media (prefers-reduced-motion: reduce) {
        .compare-bar,
        .component-card,
        .cta-btn,
        .faq-icon::before,
        .faq-icon::after {
          transition: none;
        }
      }
    `,
  ],
})
export class PricingComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly meta = inject(MetaService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Flip to true when the comparison section scrolls in → bars animate. */
  protected readonly barsArmed = signal<boolean>(false);

  private io?: IntersectionObserver;

  /** The 10 charge components. Copy sourced from PRICING-MODEL.md. */
  protected readonly components = signal<readonly ChargeComponent[]>([
    {
      n: 1,
      tag: 'Metered',
      title: 'Namespace resource cost',
      body: 'The exact Cloudflare cost of every asset in your site’s namespace: Worker requests and CPU, database rows read and written plus storage, and object-storage operations. Each rate is a published unit price.',
    },
    {
      n: 2,
      tag: 'Flat',
      title: 'Platform fee — $50 / month',
      body: 'One flat fee per site. It covers our Cloudflare base subscriptions, engineering, and support — so account-level costs never surface on your bill.',
    },
    {
      n: 3,
      tag: 'Pass-through',
      title: 'AI usage',
      body: 'Model spend passed through at cost, metered per token or per logged AI call. If a site leans on AI heavily, that shows as its own honest line — never buried in a tier.',
    },
    {
      n: 4,
      tag: 'Metered',
      title: 'Production snapshot storage',
      body: 'Every published version of your site is snapshotted to object storage so you can roll back. You pay only the storage those snapshots actually occupy.',
    },
    {
      n: 5,
      tag: 'Metered',
      title: 'Workers + Containers compute',
      body: 'Worker CPU time and any container compute your site uses. Containers hibernate when idle, so at rest this is near zero and you only pay when work runs.',
    },
    {
      n: 6,
      tag: 'Per-minute',
      title: 'Voice',
      body: 'A single per-minute rate for phone time that bundles text-to-speech, plus browser-time and any WebRTC voice as separate honest lines. Pay for minutes used, nothing standing.',
    },
    {
      n: 7,
      tag: 'Per-post',
      title: 'Social posts',
      body: 'A small per-post cost for each network you publish to — X, LinkedIn, Instagram, Facebook, Bluesky, TikTok. Post nothing, pay nothing here.',
    },
    {
      n: 8,
      tag: 'Pass-through',
      title: 'Search (Exa)',
      body: 'When your site runs AI-grounded web search, each search and content fetch is passed through at its real cost — one line, no bundling.',
    },
    {
      n: 9,
      tag: 'Per-feature',
      title: 'Features',
      body: 'Any capability you switch on in your site’s Features panel carries its own unit cost, shown up front before you enable it. Off means $0.',
    },
    {
      n: 10,
      tag: 'Pass-through',
      title: 'Everything else, at cost',
      body: 'Any remaining third-party spend attributable to your site — transactional email, image generation, a domain at cost. A catch-all pass-through so nothing hides.',
    },
  ]);

  /** Cloudflare published unit prices (no base fee). */
  protected readonly unitPrices = signal<readonly PriceRow[]>([
    { resource: 'Worker', metric: 'Requests', price: '$0.30 / M' },
    { resource: 'Worker', metric: 'CPU time', price: '$0.02 / M CPU-ms' },
    { resource: 'Database', metric: 'Rows read', price: '$0.001 / M' },
    { resource: 'Database', metric: 'Rows written', price: '$1.00 / M' },
    { resource: 'Database', metric: 'Storage', price: '$0.75 / GB-mo' },
    { resource: 'Object storage', metric: 'Storage', price: '$0.015 / GB-mo' },
    { resource: 'Object storage', metric: 'Writes / lists', price: '$4.50 / M' },
    { resource: 'Object storage', metric: 'Reads', price: '$0.36 / M' },
    { resource: 'Object storage', metric: 'Egress', price: '$0.00' },
    { resource: 'Container', metric: 'Compute', price: '~$0.0000025 / GiB-s' },
  ]);

  /** Worked-example itemized bill. billTotal() sums the amounts. */
  protected readonly billLines = signal<readonly BillLine[]>([
    { label: 'Platform fee', detail: 'Flat, per site', amount: 50 },
    { label: 'Worker requests', detail: '~120K requests this month', amount: 0.04 },
    {
      label: 'Worker + container compute',
      detail: 'CPU-ms + idle-hibernated container',
      amount: 0.18,
    },
    { label: 'Database', detail: 'Rows read/written + storage', amount: 0.21 },
    { label: 'Object storage', detail: 'Live assets + read/write ops', amount: 0.09 },
    { label: 'Production snapshots', detail: 'Nightly versioned rollbacks (~0.6 GB)', amount: 0.01 },
    { label: 'AI usage', detail: 'Concierge chat, at cost', amount: 1.4 },
    { label: 'Search (Exa)', detail: 'AI-grounded lookups, at cost', amount: 0.35 },
    { label: 'Email (SES)', detail: 'Contact-form + notification sends', amount: 0.02 },
  ]);

  /** Sum of every bill line. */
  protected billTotal(): number {
    return this.billLines().reduce((sum, l) => sum + l.amount, 0);
  }

  /**
   * Competitor comparison. `headroom` = how much of a flat plan is dead capacity
   * you pay for regardless of use; ours is a thin sliver (the fee only).
   */
  protected readonly competitors = signal<readonly Competitor[]>([
    {
      name: 'ProjectSites.dev',
      model: 'Exact metered cost + one flat $50 fee',
      entry: 'Cost + $50',
      transparent: true,
      headroom: 12,
      note: 'You pay usage at cost',
    },
    {
      name: 'Vercel',
      model: 'Flat seat + usage overages that surprise',
      entry: '$20 / seat',
      transparent: false,
      headroom: 72,
      note: 'Overage cliffs beyond the tier',
    },
    {
      name: 'Netlify',
      model: 'Flat tier with bundled build minutes + bandwidth',
      entry: '$19 / mo',
      transparent: false,
      headroom: 68,
      note: 'Pay for bundled capacity you may not use',
    },
    {
      name: 'WP Engine',
      model: 'Flat managed-hosting tier by visits',
      entry: '$25+ / mo',
      transparent: false,
      headroom: 78,
      note: 'Visit caps, then a bigger flat tier',
    },
    {
      name: 'Squarespace',
      model: 'All-in-one flat plan, take it or leave it',
      entry: '$16+ / mo',
      transparent: false,
      headroom: 64,
      note: 'One bundle, no itemization',
    },
    {
      name: 'Webflow',
      model: 'Flat site plan + separate workspace seats',
      entry: '$14+ / mo',
      transparent: false,
      headroom: 70,
      note: 'Stacked flat fees, add-on gated',
    },
    {
      name: 'Wix',
      model: 'Flat premium plan by feature bundle',
      entry: '$17+ / mo',
      transparent: false,
      headroom: 66,
      note: 'Feature gates drive plan upgrades',
    },
  ]);

  /** Idle-vs-typical example apps. */
  protected readonly appPrices = signal<readonly AppPrice[]>([
    { app: 'Payload CMS', kind: 'Worker + database', idle: '$0', typical: '~$5 / mo' },
    { app: 'Umami analytics', kind: 'Worker + database', idle: '$0', typical: '~$3 / mo' },
    { app: 'Listmonk', kind: 'Container (hibernates)', idle: '~$0', typical: '~$6 / mo' },
    { app: 'NocoDB studio', kind: 'Container (hibernates)', idle: '~$0', typical: '~$7 / mo' },
    { app: 'Ghost blog', kind: 'Container (hibernates)', idle: '~$0', typical: '~$8 / mo' },
  ]);

  /** FAQ — also emitted as FAQPage JSON-LD. */
  protected readonly faqs = signal<readonly Faq[]>([
    {
      q: 'What exactly is the $50 for?',
      a: 'It is a flat platform fee per site that covers our Cloudflare Workers Paid and Workers-for-Platforms account subscriptions, plus engineering and support. Those are real costs of running the platform — we pay them once and cover them with this fee instead of marking up your infrastructure.',
    },
    {
      q: 'Do you add a markup on the Cloudflare usage?',
      a: 'No. The metered lines are Cloudflare’s published unit prices — the same rates we are charged. The only place we make money is the flat $50 fee. AI, voice, and social carry a small transparent adjustment shown on the page, and even those are itemized, never hidden.',
    },
    {
      q: 'Why is my bill different each month?',
      a: 'Because you are billed for real usage. A quiet month with few visits and little AI costs less; a busy launch month costs a bit more. The $50 fee is the only fixed number — every other line moves with what your site actually did.',
    },
    {
      q: 'What happens to cost when my site is idle?',
      a: 'Very little. Worker-based apps scale to zero and containers hibernate after a short idle window, so at rest you pay only for the small amount of storage your site and its snapshots occupy — often just cents beyond the flat fee.',
    },
    {
      q: 'How is this different from Vercel or Squarespace pricing?',
      a: 'They sell you a flat tier and you pay for the whole bucket whether or not you use it — then hit overage cliffs or forced upgrades. We bill the meter: your true usage at cost, plus one honest fee. No dead headroom, no surprise tier jump.',
    },
    {
      q: 'Can I see the cost of a feature before I turn it on?',
      a: 'Yes. Every capability in your site’s Features panel shows its unit cost up front, and installable apps print both an idle and a typical monthly estimate before you add them. Nothing gets billed that you did not deliberately enable.',
    },
  ]);

  ngOnInit(): void {
    this.meta.init();
    this.injectJsonLd();
    // Non-browser or reduced-motion: bars land at final state immediately.
    if (!isPlatformBrowser(this.platformId)) {
      this.barsArmed.set(true);
      return;
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) this.barsArmed.set(true);
  }

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    if (this.barsArmed()) return; // reduced-motion already armed
    this.observeCompareBars();
  }

  ngOnDestroy(): void {
    this.io?.disconnect();
    this.removeJsonLd();
  }

  /**
   * Arm the comparison bars when the comparison section scrolls into view.
   * (The count-up + section reveals are handled by the shared
   * `<app-rolling-counter>` + `appReveal` primitives, both reduced-motion-safe.)
   */
  private observeCompareBars(): void {
    if (typeof IntersectionObserver === 'undefined') {
      this.barsArmed.set(true);
      return;
    }
    const track = this.host.nativeElement.querySelector('.compare-bar-track');
    if (!track) {
      this.barsArmed.set(true);
      return;
    }
    this.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.barsArmed.set(true);
            this.io?.disconnect();
          }
        }
      },
      { threshold: 0.2, rootMargin: '0px 0px -8% 0px' },
    );
    this.io.observe(track);
  }

  /**
   * Inject FAQPage + BreadcrumbList + Product/Offer JSON-LD into `<head>`.
   * Mirrors the changelog page's direct-DOM approach; tagged with a data attr
   * so `removeJsonLd` cleans up on destroy (SPA nav away).
   */
  private injectJsonLd(): void {
    if (typeof document === 'undefined') return;
    this.removeJsonLd();

    const blocks: Record<string, unknown>[] = [
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: this.faqs().map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://projectsites.dev/' },
          {
            '@type': 'ListItem',
            position: 2,
            name: 'Pricing',
            item: 'https://projectsites.dev/pricing',
          },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'ProjectSites.dev hosted website',
        description:
          'An AI-generated, hosted, SSL-secured website billed at exact metered Cloudflare cost plus a flat $50/month platform fee.',
        brand: { '@type': 'Brand', name: 'ProjectSites.dev' },
        offers: {
          '@type': 'Offer',
          price: '50.00',
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
          url: 'https://projectsites.dev/pricing',
          description:
            'Flat $50/month platform fee per site, plus pass-through metered usage at Cloudflare published unit prices.',
        },
      },
    ];

    for (const block of blocks) {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute('data-pricing-jsonld', 'true');
      script.textContent = JSON.stringify(block);
      document.head.appendChild(script);
    }
  }

  /** Remove any JSON-LD this component added (idempotent). */
  private removeJsonLd(): void {
    if (typeof document === 'undefined') return;
    document
      .querySelectorAll('script[data-pricing-jsonld="true"]')
      .forEach((el) => el.remove());
  }
}

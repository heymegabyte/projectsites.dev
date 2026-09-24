import { Component, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

/**
 * Grafana Cloud embed — /admin/grafana
 *
 * Embeds Grafana Cloud dashboards via iframe. Requires GRAFANA_CLOUD_API_KEY
 * stored as a CF Worker secret. The Worker proxies requests to Grafana Cloud
 * to avoid exposing the API key to the browser.
 *
 * Graceful when key is missing: shows setup instructions instead of a broken iframe.
 */
@Component({
  selector: 'app-grafana-dashboard',
  standalone: true,
  template: `
    <div class="grafana-container">
      @if (apiKeyReady()) {
        <iframe
          [src]="dashboardUrl()"
          class="grafana-iframe"
          frameborder="0"
          title="Grafana Cloud Dashboards"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          loading="lazy"
        ></iframe>
      } @else {
        <div class="grafana-setup">
          <h2>Grafana Cloud Setup</h2>
          <p>Connect your Grafana Cloud account to view dashboards.</p>
          <ol>
            <li>Create a Grafana Cloud account at <a href="https://grafana.com/auth/sign-up/create-user" target="_blank">grafana.com</a></li>
            <li>Create an API key at <a href="https://grafana.com/orgs/your-org/api-keys" target="_blank">grafana.com/orgs/your-org/api-keys</a></li>
            <li>Save it:
              <code>echo 'your-api-key' > ~/.local/share/chezmoi/home/.chezmoitemplates/secrets-macbook-pro/GRAFANA_CLOUD_API_KEY</code>
            </li>
            <li>Set the Worker secret:
              <code>npx wrangler secret put GRAFANA_CLOUD_API_KEY --env production</code>
            </li>
          </ol>
        </div>
      }
    </div>
  `,
  styles: [`
    .grafana-container {
      width: 100%;
      height: calc(100vh - 64px);
      position: relative;
    }
    .grafana-iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #0a0a1a;
    }
    .grafana-setup {
      max-width: 600px;
      margin: 4rem auto;
      padding: 2rem;
      background: rgba(0, 229, 255, 0.05);
      border: 1px solid rgba(0, 229, 255, 0.15);
      border-radius: 12px;
      color: #f4f4ff;
    }
    .grafana-setup h2 { color: #00e5ff; margin-bottom: 1rem; }
    .grafana-setup ol { padding-left: 1.5rem; }
    .grafana-setup li { margin-bottom: 0.75rem; line-height: 1.6; }
    .grafana-setup code {
      display: block;
      margin: 0.5rem 0;
      padding: 0.5rem 0.75rem;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: #00e5ff;
    }
    .grafana-setup a { color: #50aae3; }
  `]
})
export class GrafanaDashboardComponent {
  apiKeyReady = signal(false);

  private readonly http = inject(HttpClient);

  constructor() {
    // Check if the API key is configured by hitting the Worker health endpoint
    this.http.get<{ grafana_configured: boolean }>('/api/admin/grafana/status')
      .subscribe({
        next: (res) => this.apiKeyReady.set(res.grafana_configured),
        error: () => this.apiKeyReady.set(false),
      });
  }

  dashboardUrl() {
    return '/api/admin/grafana/proxy/d/overview';
  }
}

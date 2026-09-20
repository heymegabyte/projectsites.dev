/**
 * @module platform/email
 *
 * @description
 * Email ports + path routing (convergence §42 / ADR-0019). Transactional email
 * goes through {@link EmailProvider} (Amazon SES); newsletters/campaigns go
 * through {@link MarketingEmailProvider} (Listmonk over SES SMTP). `chooseEmailPath`
 * is the single policy that decides which rail a given {@link EmailKind} takes —
 * critical/transactional → SES, everything else → Listmonk.
 *
 * This port is the seam every transactional call site sends through — SES (SigV4,
 * `AmazonSesEmailProvider`) for critical mail, the Listmonk adapter (wrapping
 * `services/listmonk_client.ts`) for the rest — behind `email.ses.enabled`. §16
 * fakes back the tests.
 *
 * @see docs/adr/0019-amazon-ses-plus-listmonk-email.md
 */

/** Every email the platform sends, by intent. */
export type EmailKind =
  | 'magic-link'
  | 'claim-verification'
  | 'receipt'
  | 'billing-alert'
  | 'security'
  | 'domain-verification'
  | 'transactional'
  | 'newsletter'
  | 'campaign'
  | 'lifecycle';

/** A single transactional send. */
export interface SendEmailInput {
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly from?: string;
  /** Reply-To address — e.g. a contact-form submitter so the brand can reply
   * directly to the lead. Optional; only the SES rail honours it today. */
  readonly replyTo?: string;
  /** Extra MIME headers (e.g. `List-Unsubscribe` + `List-Unsubscribe-Post` for
   * one-click unsubscribe on lifecycle/digest mail). Optional; the SES rail maps
   * these to `Content.Simple.Headers`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly kind: EmailKind;
  readonly tenantId?: string;
  /** Dedupe key — providers/log dedupe on this (§23). */
  readonly idempotencyKey?: string;
}

export interface EmailResult {
  readonly id: string;
  readonly accepted: boolean;
}

/** Transactional email port (Amazon SES in prod). */
export interface EmailProvider {
  sendTransactional(input: SendEmailInput): Promise<EmailResult>;
}

export interface UpsertSubscriberInput {
  readonly email: string;
  readonly tenantId?: string;
  readonly attribs?: Record<string, string>;
}
export interface SubscriberResult {
  readonly id: string;
}
export interface CreateCampaignInput {
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly listIds?: readonly number[];
}
export interface CampaignResult {
  readonly id: string;
}
export interface SendCampaignInput {
  readonly campaignId: string;
}
export interface CampaignSendResult {
  readonly id: string;
  readonly started: boolean;
}
export interface UnsubscribeInput {
  readonly email: string;
}

/** Marketing/bulk email port (Listmonk → SES SMTP in prod). */
export interface MarketingEmailProvider {
  upsertSubscriber(input: UpsertSubscriberInput): Promise<SubscriberResult>;
  createCampaign(input: CreateCampaignInput): Promise<CampaignResult>;
  sendCampaign(input: SendCampaignInput): Promise<CampaignSendResult>;
  unsubscribe(input: UnsubscribeInput): Promise<void>;
}

/** Kinds that MUST go transactional (SES): time-critical / per-user / sensitive. */
const SES_KINDS: ReadonlySet<EmailKind> = new Set<EmailKind>([
  'magic-link',
  'claim-verification',
  'receipt',
  'billing-alert',
  'security',
  'domain-verification',
  'transactional',
]);

/**
 * Decide the rail for an email kind (§42). Transactional/critical → SES; bulk →
 * Listmonk.
 *
 * @example chooseEmailPath('magic-link') // 'ses'
 * @example chooseEmailPath('newsletter') // 'listmonk'
 */
export function chooseEmailPath(kind: EmailKind): 'ses' | 'listmonk' {
  return SES_KINDS.has(kind) ? 'ses' : 'listmonk';
}

/** Thrown when a send is missing a required field. */
export class EmailInputError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'EmailInputError';
  }
}

function assertSend(input: SendEmailInput): void {
  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  if (recipients.length === 0 || recipients.some((r) => !r || !/.+@.+\..+/.test(r))) {
    throw new EmailInputError('valid recipient(s) required', 'to');
  }
  if (!input.subject) throw new EmailInputError('subject required', 'subject');
  if (!input.html) throw new EmailInputError('html required', 'html');
}

/** Deterministic in-memory transactional provider for tests + no-vendor mode (§16). */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: SendEmailInput[] = [];
  async sendTransactional(input: SendEmailInput): Promise<EmailResult> {
    assertSend(input);
    this.sent.push(input);
    return { id: input.idempotencyKey ?? `fake_email_${this.sent.length}`, accepted: true };
  }
}

/** Deterministic in-memory marketing provider for tests + no-vendor mode (§16). */
export class FakeMarketingEmailProvider implements MarketingEmailProvider {
  readonly subscribers: UpsertSubscriberInput[] = [];
  readonly campaigns: CreateCampaignInput[] = [];
  readonly sentCampaigns: string[] = [];
  readonly unsubscribed: string[] = [];

  async upsertSubscriber(input: UpsertSubscriberInput): Promise<SubscriberResult> {
    if (!/.+@.+\..+/.test(input.email)) throw new EmailInputError('valid email required', 'email');
    this.subscribers.push(input);
    return { id: `sub_${this.subscribers.length}` };
  }
  async createCampaign(input: CreateCampaignInput): Promise<CampaignResult> {
    this.campaigns.push(input);
    return { id: `camp_${this.campaigns.length}` };
  }
  async sendCampaign(input: SendCampaignInput): Promise<CampaignSendResult> {
    this.sentCampaigns.push(input.campaignId);
    return { id: input.campaignId, started: true };
  }
  async unsubscribe(input: UnsubscribeInput): Promise<void> {
    this.unsubscribed.push(input.email);
  }
}

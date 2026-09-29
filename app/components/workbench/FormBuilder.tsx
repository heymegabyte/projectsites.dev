/**
 * @file Form builder — let an owner define a simple public form whose submissions land in the site's OWN D1 (FIRE 6).
 *
 * @remarks
 * The Database tab's "Forms" sub-view. An owner names a form and adds a few fields (name / email / number / …); on
 * create we (1) build a backing table in the site's OWN per-site D1 (`id` PK + `submitted_at` + one typed column
 * per field) and (2) store the form's JSON definition in a per-site `_ps_forms` metadata table. Both writes go
 * through the SAME per-site exec rail everything else uses (`PS_RES_MUTATE { kind:'d1', action:'exec',
 * input:{ sql, params }, confirm:true }` → the worker's single-statement, PARAMETERIZED, SERVER-RESOLVED executor —
 * INV-1/INV-9). The compile + safety live in the pure, unit-tested {@link module:app/components/workbench/data-ingest-logic}
 * (`buildFormPlan`): field columns are slugified + de-duped + identifier-validated; the definition JSON is bound as a
 * `?` param, never concatenated.
 *
 * SCOPE (honest, per the FIRE 6 brief): this ships the BUILDER UI + the per-site write path (backing table + stored
 * definition + the submit-INSERT contract). The PUBLIC render of the form on the live site + the public submit
 * endpoint that runs the INSERT are a DOCUMENTED FOLLOW-UP — the `_ps_forms` definition row is the contract those
 * will read. An owner can already build the form + its table today; wiring the public page comes next. This is
 * surfaced in the UI (a "what's next" note), never hidden.
 *
 * Style matches the editor conventions (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*` icons, black+cyan per
 * docs/ULTIMATE-UI-DIRECTION.md).
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  onParentMessage,
  postToParent,
  type ParentToChildMessage,
  type ResMutateResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  buildFormPlan,
  type FormFieldDraft,
  type FormFieldKind,
  IngestError,
  isSafeIdent,
  slugifyColumnName,
} from './data-ingest-logic';

// ── Bridge plumbing (mirrors SchemaBuilder / ImportPanel / AiSeedPanel) ────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const DISABLED_404 = 'Per-site data is not enabled';

/** The per-site metadata table that stores every form definition (the public renderer's contract). */
const FORMS_META_TABLE = '_ps_forms';

interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `form_${++correlationCounter}`;
}

interface ExecResult {
  ok: boolean;
  error?: string;
  disabled?: boolean;
}

const FIELD_KINDS: ReadonlyArray<{ value: FormFieldKind; label: string; icon: string }> = [
  { value: 'text', label: 'Short text', icon: 'i-ph:text-aa' },
  { value: 'textarea', label: 'Long text', icon: 'i-ph:text-align-left' },
  { value: 'email', label: 'Email', icon: 'i-ph:envelope' },
  { value: 'tel', label: 'Phone', icon: 'i-ph:phone' },
  { value: 'number', label: 'Number', icon: 'i-ph:hash' },
  { value: 'date', label: 'Date', icon: 'i-ph:calendar' },
  { value: 'checkbox', label: 'Yes / No', icon: 'i-ph:check-square' },
];

interface FieldRow {
  label: string;
  kind: FormFieldKind;
  required: boolean;
}

const DEFAULT_FIELDS: FieldRow[] = [
  { label: 'Name', kind: 'text', required: true },
  { label: 'Email', kind: 'email', required: true },
  { label: 'Message', kind: 'textarea', required: false },
];

export const FormBuilder = memo(() => {
  const [title, setTitle] = useState('Contact form');
  const [tableName, setTableName] = useState('contact_submissions');
  const [tableEdited, setTableEdited] = useState(false);
  const [fields, setFields] = useState<FieldRow[]>(DEFAULT_FIELDS);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createdNote, setCreatedNote] = useState<string | null>(null);

  const pendingRef = useRef<Map<string, Pending>>(new Map());

  const request = useCallback((message: Parameters<typeof postToParent>[0]): Promise<ParentToChildMessage> => {
    return new Promise<ParentToChildMessage>((resolve, reject) => {
      const correlationId = (message as { correlationId: string }).correlationId;
      const timer = setTimeout(() => {
        pendingRef.current.delete(correlationId);
        reject(new Error('The request timed out. Check the admin connection and retry.'));
      }, REQUEST_TIMEOUT_MS);
      pendingRef.current.set(correlationId, { resolve, reject, timer });
      postToParent(message);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_MUTATE_RESPONSE') {
        return;
      }

      const correlationId = msg.correlationId;

      if (!correlationId) {
        return;
      }

      const pending = pendingRef.current.get(correlationId);

      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      pendingRef.current.delete(correlationId);
      pending.resolve(msg);
    });

    return () => {
      unsubscribe();

      for (const [, pending] of pendingRef.current) {
        clearTimeout(pending.timer);
        pending.reject(new Error('cancelled'));
      }
      pendingRef.current.clear();
    };
  }, []);

  const execSql = useCallback(
    async (sql: string, params: (string | number | null)[]): Promise<ExecResult> => {
      let reply: ResMutateResponseMessage;

      try {
        reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'd1',
          action: 'exec',
          input: { sql, params },
          confirm: true,
        })) as ResMutateResponseMessage;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'The database could not be reached.' };
      }

      if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
        return { ok: false, disabled: true, error: DISABLED_404 };
      }

      if (reply.error) {
        return { ok: false, error: reply.error };
      }

      const result = reply.result;

      if (!result) {
        return { ok: false, error: 'No response from the database. Retry in a moment.' };
      }

      if (!result.ok) {
        return { ok: false, error: result.error?.message ?? 'The statement could not run.' };
      }

      return { ok: true };
    },
    [request],
  );

  // Keep the table name in sync with the title until the owner edits it directly.
  const onTitle = useCallback(
    (value: string) => {
      setTitle(value);

      if (!tableEdited) {
        const slug = slugifyColumnName(value) || 'form_submissions';
        setTableName(slug.endsWith('_submissions') ? slug : `${slug}_submissions`.slice(0, 64));
      }
    },
    [tableEdited],
  );

  const addField = useCallback(() => {
    setFields((prev) => [...prev, { label: '', kind: 'text', required: false }]);
  }, []);

  const removeField = useCallback((index: number) => {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateField = useCallback((index: number, patch: Partial<FieldRow>) => {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }, []);

  const validFields = fields.filter((f) => f.label.trim().length > 0);
  const canCreate = title.trim().length > 0 && isSafeIdent(tableName.trim()) && validFields.length > 0 && !creating;

  const create = useCallback(async () => {
    if (!isEmbedded) {
      setCreateError('Open this from the ProjectSites admin to build a form.');
      return;
    }

    setCreating(true);
    setCreateError('');
    setCreatedNote(null);

    try {
      const drafts: FormFieldDraft[] = validFields.map((f) => ({
        label: f.label.trim(),
        column: slugifyColumnName(f.label),
        kind: f.kind,
        required: f.required,
      }));

      const plan = buildFormPlan(title.trim(), tableName.trim(), drafts);

      // 1. Create the backing table (id PK + submitted_at + one typed column per field).
      const created = await execSql(plan.createTableSql, []);

      if (created.disabled) {
        setCreateError('Per-site data is not enabled for this site yet.');
        setCreating(false);

        return;
      }

      if (!created.ok) {
        setCreateError(`Could not create the form table: ${created.error}`);
        setCreating(false);

        return;
      }

      // 2. Ensure the forms-metadata table exists (idempotent), then store the definition (bound param).
      const metaCreate = await execSql(
        `CREATE TABLE IF NOT EXISTS "${FORMS_META_TABLE}" (` +
          `id INTEGER PRIMARY KEY, form_table TEXT UNIQUE NOT NULL, title TEXT NOT NULL, ` +
          `definition TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
        [],
      );

      if (!metaCreate.ok && !metaCreate.disabled) {
        // The backing table exists; surface the metadata failure honestly but don't claim total failure.
        setCreateError(`The form table was created, but saving the form definition failed: ${metaCreate.error}`);
        setCreating(false);

        return;
      }

      const upsert = await execSql(
        `INSERT INTO "${FORMS_META_TABLE}" (form_table, title, definition) VALUES (?, ?, ?) ` +
          `ON CONFLICT(form_table) DO UPDATE SET title = excluded.title, definition = excluded.definition`,
        [plan.table, plan.definition.title, JSON.stringify(plan.definition)],
      );

      if (!upsert.ok) {
        setCreateError(`The form table was created, but saving the form definition failed: ${upsert.error}`);
        setCreating(false);

        return;
      }

      setCreatedNote(`Form "${plan.definition.title}" is ready. Submissions will save to the "${plan.table}" table.`);
    } catch (err) {
      setCreateError(err instanceof IngestError ? err.message : 'The form could not be created.');
    } finally {
      setCreating(false);
    }
  }, [validFields, title, tableName, execSql]);

  if (!isEmbedded) {
    return (
      <Shell>
        <EmptyNote icon="i-ph:plug" title="Open from the ProjectSites admin">
          The form builder writes to your site&rsquo;s own database, which the admin resolves securely.
        </EmptyNote>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center gap-2 mb-4">
        <div className="i-ph:list-checks-duotone text-lg text-bolt-elements-item-contentAccent" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary tracking-tight">Build a form</h3>
          <p className="text-[11px] text-bolt-elements-textTertiary">
            Define the fields — we create a table that collects every submission.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Form title + table */}
        <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 space-y-3">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Form title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => onTitle(e.target.value)}
              placeholder="Contact form"
              data-testid="form-title"
              className="mt-1 w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Saves to table</span>
            <input
              type="text"
              value={tableName}
              onChange={(e) => {
                setTableName(e.target.value);
                setTableEdited(true);
              }}
              placeholder="contact_submissions"
              data-testid="form-table"
              className={classNames(
                'mt-1 w-full rounded-md border bg-bolt-elements-background-depth-1 px-3 py-1.5 text-[12px] font-mono text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                tableName && !isSafeIdent(tableName.trim()) ? 'border-red-500/60' : 'border-bolt-elements-borderColor',
              )}
            />
            {tableName && !isSafeIdent(tableName.trim()) && (
              <span className="text-[11px] text-red-400">
                Use letters, numbers and underscores only (must start with a letter).
              </span>
            )}
          </label>
        </div>

        {/* Fields */}
        <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 overflow-hidden">
          <div className="px-3 py-2 border-b border-bolt-elements-borderColor flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary">
              Fields
            </span>
            <span className="text-[10px] text-bolt-elements-textTertiary font-mono tabular-nums">
              {validFields.length} field{validFields.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="divide-y divide-bolt-elements-borderColor/40">
            {fields.map((f, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2" data-testid={`form-field-${i}`}>
                <div className="i-ph:dots-six-vertical text-bolt-elements-textTertiary shrink-0" aria-hidden />
                <input
                  type="text"
                  value={f.label}
                  onChange={(e) => updateField(i, { label: e.target.value })}
                  placeholder="Field label"
                  aria-label={`Field ${i + 1} label`}
                  data-testid={`form-field-label-${i}`}
                  className="flex-1 min-w-0 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-1 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
                />
                <select
                  value={f.kind}
                  onChange={(e) => updateField(i, { kind: e.target.value as FormFieldKind })}
                  aria-label={`Field ${i + 1} type`}
                  data-testid={`form-field-kind-${i}`}
                  className="rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-1 text-[11px] text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                >
                  {FIELD_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-[10px] text-bolt-elements-textTertiary cursor-pointer select-none shrink-0">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => updateField(i, { required: e.target.checked })}
                    aria-label={`Field ${i + 1} required`}
                    data-testid={`form-field-required-${i}`}
                    className="accent-bolt-elements-item-contentAccent"
                  />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => removeField(i)}
                  aria-label={`Remove field ${i + 1}`}
                  data-testid={`form-field-remove-${i}`}
                  className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-red-400 hover:bg-bolt-elements-background-depth-3 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                >
                  <div className="i-ph:trash" aria-hidden />
                </button>
              </div>
            ))}
          </div>
          <div className="px-3 py-2 border-t border-bolt-elements-borderColor">
            <button
              type="button"
              onClick={addField}
              data-testid="form-add-field"
              className="min-h-[24px] flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md border border-bolt-elements-borderColor text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:plus" aria-hidden /> Add field
            </button>
          </div>
        </div>

        {/* Create */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={create}
            disabled={!canCreate}
            data-testid="form-create"
            className="min-h-[24px] text-[13px] font-semibold px-5 py-2 rounded-lg bg-bolt-elements-item-contentAccent text-[#061018] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            {creating ? (
              <>
                <div className="i-ph:spinner animate-spin" aria-hidden /> Creating…
              </>
            ) : (
              <>
                <div className="i-ph:check" aria-hidden />
                <span className="min-w-[10ch] text-center">Create form</span>
              </>
            )}
          </button>
          {validFields.length === 0 && <span className="text-[11px] text-amber-400">Add at least one field.</span>}
        </div>

        {createdNote && (
          <div
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2"
            role="status"
            data-testid="form-created"
          >
            <p className="text-[12px] text-emerald-400 flex items-center gap-1.5">
              <div className="i-ph:check-circle" aria-hidden /> {createdNote}
            </p>
            <p className="text-[11px] text-bolt-elements-textTertiary flex items-start gap-1.5">
              <div className="i-ph:info mt-0.5 shrink-0" aria-hidden />
              <span>
                What&rsquo;s next: the public form on your live site (so visitors can submit) is coming soon. Your table
                and form definition are saved now — view submissions any time in Table-view.
              </span>
            </p>
          </div>
        )}
        {createError && (
          <div className="text-[11px] text-red-400 flex items-center gap-1.5" role="alert">
            <div className="i-ph:warning-circle" aria-hidden /> {createError}
          </div>
        )}
      </div>
    </Shell>
  );
});

FormBuilder.displayName = 'FormBuilder';

// ── Local presentational helpers ──────────────────────────────────────────────────────────────────────

const Shell = memo(({ children }: { children: React.ReactNode }) => (
  <div className="h-full overflow-auto p-4" data-testid="form-builder-panel">
    <div className="max-w-[720px]">{children}</div>
  </div>
));
Shell.displayName = 'FormBuilder.Shell';

const EmptyNote = memo(({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) => (
  <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
    <div className={classNames(icon, 'text-4xl text-bolt-elements-item-contentAccent')} aria-hidden />
    <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">{title}</h3>
    <p className="text-[12px] text-bolt-elements-textTertiary max-w-[320px]">{children}</p>
  </div>
));
EmptyNote.displayName = 'FormBuilder.EmptyNote';

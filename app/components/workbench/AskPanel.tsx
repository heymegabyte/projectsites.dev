/**
 * @module components/workbench/AskPanel
 *
 * Grounded "Ask your data" panel for the Data tab — a plain-English question about the ACTIVE overview
 * table. The editor has no cross-origin session, so (like the KV/R2 browsers + SQL console) it asks the
 * Angular admin parent to proxy the call via the postMessage bridge:
 *   child → parent  `PS_ASK_REQUEST`  { table, question }
 *   parent → child  `PS_ASK_RESPONSE` { ok, data:{ question, intent, sql, rows, rowsRead }, error }
 *     (parent calls POST /sites/:id/data-overview/:table/ask)
 *
 * The worker asks a model for a TYPED intent (never SQL), re-validates + compiles it server-side, and
 * EXECUTES the parameterized query — so this panel renders a COMPUTED answer plus (falsifiable) the AI's
 * interpretation and the exact SQL. Owner-gated server-side. Honest failure states (unparseable / AI
 * down / rejected intent) are surfaced, never a fabricated answer.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AskRequestMessage, AskResponseMessage } from '~/lib/embed/embedded-mode';
import { classNames } from '~/utils/classNames';
import { describeIntent, formatCellValue } from './data-panel-logic';

export interface AskPanelProps {
  /** Post a bridge request to the admin parent (DataPanel's existing helper). */
  readonly postToParent: (msg: AskRequestMessage) => void;

  /** The active overview table the question is scoped to. */
  readonly table: string;
}

type Pending = (res: AskResponseMessage) => void;

/** The grounded NL→answer panel: question box → computed rows + AI interpretation + exact SQL. */
export const AskPanel = memo(({ postToParent, table }: AskPanelProps) => {
  const pending = useRef<Map<string, Pending>>(new Map());
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NonNullable<AskResponseMessage['data']> | null>(null);
  const [showSql, setShowSql] = useState(false);

  // Resolve pending bridge requests by correlationId.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as Partial<AskResponseMessage> | undefined;

      if (!data || data.type !== 'PS_ASK_RESPONSE' || typeof data.correlationId !== 'string') {
        return;
      }

      const resolve = pending.current.get(data.correlationId);

      if (resolve) {
        pending.current.delete(data.correlationId);
        resolve(data as AskResponseMessage);
      }
    };
    window.addEventListener('message', onMessage);

    return () => window.removeEventListener('message', onMessage);
  }, []);

  const ask = useCallback(async (): Promise<void> => {
    const q = question.trim();

    if (!q || loading) {
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setShowSql(false);

    const correlationId = crypto.randomUUID();
    const res = await new Promise<AskResponseMessage>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.current.delete(correlationId)) {
          resolve({ type: 'PS_ASK_RESPONSE', correlationId, ok: false, error: 'Request timed out' });
        }
      }, 30_000);
      pending.current.set(correlationId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      postToParent({ type: 'PS_ASK_REQUEST', table, question: q, correlationId });
    });

    setLoading(false);

    if (res.ok && res.data) {
      setResult(res.data);
    } else {
      setError(res.error ?? 'Could not answer that question.');
    }
  }, [question, loading, postToParent, table]);

  const columns = useMemo(() => (result?.rows?.length ? Object.keys(result.rows[0]) : []), [result]);

  return (
    <div
      className="mb-2 rounded-md border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1 p-2"
      data-testid="data-ask-panel"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-bolt-elements-textSecondary">
        <div className="i-ph:sparkle text-[#00e5ff]" /> Ask this table
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void ask();
            }
          }}
          placeholder={`e.g. how many rows by status?`}
          data-testid="data-ask-input"
          aria-label={`Ask a question about ${table}`}
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-[#00e5ff]/50"
        />
        <button
          type="button"
          onClick={() => void ask()}
          disabled={loading || !question.trim()}
          data-testid="data-ask-submit"
          className={classNames(
            'flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-medium',
            loading || !question.trim()
              ? 'cursor-not-allowed bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary'
              : 'cursor-pointer bg-[#00e5ff]/15 text-[#00E5FF] hover:bg-[#00e5ff]/25',
          )}
        >
          <div className={loading ? 'i-ph:circle-notch animate-spin' : 'i-ph:arrow-right'} />
          {loading ? 'Asking…' : 'Ask'}
        </button>
      </div>

      <p className="mt-1 text-[9px] italic text-bolt-elements-textTertiary">
        The AI proposes a query; the server validates + runs it. The exact SQL is shown — nothing is hidden.
      </p>

      {error && (
        <div
          className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-400"
          role="alert"
          data-testid="data-ask-error"
        >
          {error}
        </div>
      )}

      {result && (
        <div className="mt-2 flex flex-col gap-1.5" data-testid="data-ask-result">
          <div className="text-[10px] text-bolt-elements-textTertiary">
            Interpreted as: <span className="text-bolt-elements-textSecondary">{describeIntent(result.intent)}</span>
            {typeof result.rowsRead === 'number' ? ` · ${result.rowsRead.toLocaleString()} rows read` : ''}
          </div>

          {result.rows.length === 0 ? (
            <div className="rounded border border-bolt-elements-borderColor/40 px-2 py-3 text-center text-[11px] text-bolt-elements-textTertiary">
              No rows matched.
            </div>
          ) : (
            <div className="max-h-64 overflow-auto rounded-md border border-bolt-elements-borderColor/40 modern-scrollbar">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-bolt-elements-background-depth-2">
                  <tr>
                    {columns.map((c) => (
                      <th
                        key={c}
                        className="border-b border-bolt-elements-borderColor/40 px-2 py-1 text-left font-mono text-[10px] text-bolt-elements-textSecondary"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i} className="border-b border-bolt-elements-borderColor/20">
                      {columns.map((c) => (
                        <td
                          key={c}
                          className="max-w-[240px] truncate px-2 py-1 font-mono text-bolt-elements-textSecondary"
                          title={formatCellValue(r[c])}
                        >
                          {formatCellValue(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowSql((v) => !v)}
            data-testid="data-ask-show-sql"
            aria-expanded={showSql}
            className="self-start text-[10px] text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary"
          >
            {showSql ? '▾ Hide SQL' : '▸ Show the exact SQL'}
          </button>
          {showSql && (
            <pre
              className="overflow-x-auto rounded bg-bolt-elements-background-depth-2 px-2 py-1 text-[10px] font-mono text-bolt-elements-textTertiary"
              data-testid="data-ask-sql"
            >
              {result.sql}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

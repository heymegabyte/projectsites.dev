/**
 * @file usePromote — the SHARED Promote -> Production flow (Slice 5).
 *
 * @remarks
 * This is the SINGLE source of truth for promoting the site's Preview working tree to Production. It owns
 * the whole state machine (idle -> submitting -> success | failed | commit_ok_deploy_failed), the
 * disabled-WITH-reason gate ({@link promoteGate}), and the `PS_PROMOTE_REQUEST` write bridge. BOTH the
 * Source Control panel ({@link ./SourceControlPanel}) and the editor's main-header control
 * ({@link ./PromoteHeaderControl}) consume THIS hook — neither re-implements the machine, so there is
 * exactly one promote path (interconnectedness; no forked state).
 *
 * INVARIANTS (never violated here):
 *   - Promote is the ONLY authorized path from Preview to Production; it sends the frozen `draft_revision`
 *     + `tree_digest` (idempotency + byte-equality proof), never a fresh build.
 *   - The terminal state mirrors the HONEST server outcome: `success` ONLY when Production actually serves
 *     the promoted revision; `commit_ok_deploy_failed` / `failed` expose a Retry.
 *   - DARK behind `durable_preview`: a dark-flag read (`enabled:false`) is an honest "coming soon" gate
 *     reason, never a scary error, and Promote stays disabled.
 *
 * DATA SOURCES (parent-session bridge — the embedded editor has no cross-origin session, so the admin
 * makes the authed calls and replies, exactly like the Database tab):
 *   - RELEASE HISTORY + PREVIEW STATE = `PS_RELEASES_REQUEST` / `PS_PREVIEW_STATE_REQUEST` -> the gate.
 *   - PROMOTE = `PS_PROMOTE_REQUEST` (the admin runs `POST /api/sites/:id/promote`).
 *
 * @module components/workbench/use-promote
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ChildToParentMessage,
  type ParentToChildMessage,
  type PreviewStateResponseMessage,
  type ReleasesResponseMessage,
  type PromoteResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  summarizePreviewSync,
  promoteGate as computePromoteGate,
  type PreviewWorkingTree,
  type ReleaseRecord,
  type SyncSummary,
} from './git-browser-logic';

/** How long to wait for a bridge reply before rejecting (mirrors SourceControlPanel). */
const REQUEST_TIMEOUT_MS = 20_000;

/** Monotonic fallback correlationId counter (crypto.randomUUID preferred). */
let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `promote_${++correlationCounter}`;
}

/** Response-type each request awaits — the bridge answers async, matched by `correlationId`. */
const RESPONSE_FOR: Record<string, ParentToChildMessage['type']> = {
  PS_PREVIEW_STATE_REQUEST: 'PS_PREVIEW_STATE_RESPONSE',
  PS_RELEASES_REQUEST: 'PS_RELEASES_RESPONSE',
  PS_PROMOTE_REQUEST: 'PS_PROMOTE_RESPONSE',
};

/** The three honest promote outcomes (mirrors the worker `ReleaseOutcome`). */
export type PromoteOutcome = 'success' | 'commit_ok_deploy_failed' | 'failed';

/**
 * Promote -> Production state machine (Slice 5). `idle` (ready or nothing-to-promote) -> `submitting` ->
 * a terminal `success` | `failed` | `commit_ok_deploy_failed`. The terminal outcome mirrors the honest
 * server outcome so the Retry affordance only shows for the two recoverable failures.
 */
export type PromoteState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; idempotent: boolean }
  | { status: 'failed'; message: string }
  | { status: 'commit_ok_deploy_failed'; message: string };

/**
 * The RETAINED result of the last settled promote (Slice 6b). Persists AFTER the promote settles so the
 * Source Control panel can render a release-outcome card from the response ALREADY in the hook — the
 * worker's `serving_sha` proof was computed-but-unrendered before this. Every field comes from the
 * promote RESPONSE itself; `releaseId` is the monotonic completion marker (the response's own release
 * id — deterministic, never a `Date.now()` wall clock). `null` until a promote has settled.
 */
export interface PromoteLastResult {
  /** The HONEST server outcome the card badges on. */
  outcome: PromoteOutcome;

  /** The proof-of-serving SHA-256 of the promoted `index.html` — present ONLY on `success`, else null. */
  servingSha: string | null;

  /** The immutable release id — the completion marker (monotonic, from the response, no wall clock). */
  releaseId: string | null;

  /** The rollback token / production version the release was cut as (the worker's `deployment_id`). */
  version: string | null;
}

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The shared promote surface both the panel and the header control render from. */
export interface UsePromote {
  /** The live promote state machine. */
  promote: PromoteState;

  /**
   * The RETAINED result of the last settled promote (Slice 6b) — outcome + serving SHA + release id/version
   * from the promote RESPONSE. Persists after the promote settles so a release-outcome card can render the
   * `serving_sha` proof (previously computed-but-unrendered). `null` until a promote has settled; cleared by
   * {@link dismiss}.
   */
  lastResult: PromoteLastResult | null;

  /** Whether Promote is offered right now (else disabled WITH {@link promoteReason}). */
  canPromote: boolean;

  /** Empty when {@link canPromote}; else the plain-language reason for the disabled control. */
  promoteReason: string;

  /** The Preview<->Production sync summary (header badge / status), or null while unknown. */
  sync: SyncSummary | null;

  /** Whether the release/preview state has finished its first load. */
  ready: boolean;

  /** PROMOTE the current Preview working tree to Production (idempotent; honest terminal outcome). */
  doPromote: () => void;

  /** Reset the terminal state back to idle (dismiss the success confirmation). */
  dismiss: () => void;

  /** Re-load the release history + Preview state + sync summary from the bridge. */
  reload: () => void;
}

/**
 * The SHARED promote flow. Loads Preview/release state over the parent-session bridge, computes the
 * disabled-WITH-reason gate, and runs the honest-outcome `PS_PROMOTE_REQUEST` write. Consumed unchanged by
 * {@link SourceControlPanel} and {@link PromoteHeaderControl} so the state machine is never forked.
 */
export function usePromote(): UsePromote {
  const [promote, setPromote] = useState<PromoteState>({ status: 'idle' });
  const [lastResult, setLastResult] = useState<PromoteLastResult | null>(null);
  const [ready, setReady] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [previewTree, setPreviewTree] = useState<PreviewWorkingTree | null>(null);
  const [sync, setSync] = useState<SyncSummary | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  /*
   * ONE parent-message listener + a live pending map (mirrors SourceControlPanel — avoids the
   * repo's known empty-deps stale-ref bug). Each request awaits the reply whose `type` matches the
   * request's expected response AND whose `correlationId` matches.
   */
  const pendingRef = useRef<Map<string, Pending>>(new Map());

  /** Send a bridge message + await the reply matched by correlationId (rejects on timeout). */
  const request = useCallback(
    (message: ChildToParentMessage & { correlationId: string }): Promise<ParentToChildMessage> => {
      return new Promise<ParentToChildMessage>((resolve, reject) => {
        const { correlationId } = message;
        const timer = setTimeout(() => {
          pendingRef.current.delete(correlationId);
          reject(new Error('The request timed out. Check the admin connection and retry.'));
        }, REQUEST_TIMEOUT_MS);

        pendingRef.current.set(correlationId, { resolve, reject, timer });
        postToParent(message);
      });
    },
    [],
  );

  useEffect(() => {
    const wanted = new Set(Object.values(RESPONSE_FOR));

    const unsubscribe = onParentMessage((msg) => {
      if (!wanted.has(msg.type)) {
        return;
      }

      const correlationId = (msg as { correlationId?: string }).correlationId;

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

  /**
   * Load release history + the Preview working-tree record from the durable-preview API (both via the
   * parent-session bridge) and recompute the sync summary. A dark `durable_preview` flag
   * (`enabled:false`) is an honest "coming soon" gate, never an error.
   */
  const reload = useCallback(async () => {
    if (!isEmbedded) {
      // Outside the admin the bridge doesn't exist — mark ready so the gate shows the open-from-admin reason.
      if (mounted.current) {
        setReady(true);
        setDisabled(false);
        setPreviewTree(null);
        setSync(null);
      }

      return;
    }

    try {
      const [releasesReply, previewReply] = (await Promise.all([
        request({ type: 'PS_RELEASES_REQUEST', correlationId: nextCorrelationId() }),
        request({ type: 'PS_PREVIEW_STATE_REQUEST', correlationId: nextCorrelationId() }),
      ])) as [ReleasesResponseMessage, PreviewStateResponseMessage];

      if (!mounted.current) {
        return;
      }

      // A dark flag (enabled:false) is NOT an error — it's an honest "coming soon".
      const isDark = releasesReply.enabled === false || previewReply.enabled === false;
      const releases: ReleaseRecord[] = (releasesReply.releases ?? []).map((r) => ({ ...r }));
      const tree: PreviewWorkingTree | null = previewReply.working_tree ? { ...previewReply.working_tree } : null;

      setDisabled(isDark);
      setPreviewTree(tree);
      setSync(summarizePreviewSync(tree, releases));
      setReady(true);
    } catch {
      if (!mounted.current) {
        return;
      }

      // A transport failure still lets the gate resolve (ready) — canPromote stays false with a reason.
      setReady(true);
    }
  }, [request]);

  // On mount: eagerly load the state so the gate + sync badge are populated immediately.
  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Whether Promote is offered right now, and — when NOT — the plain-language reason (so the control is
   * disabled WITH a reason, never a dead/doomed button per embarrassingly-easy-to-use). Delegates to the
   * SAME pure {@link computePromoteGate} the panel used.
   */
  const gate = useMemo(
    () => computePromoteGate(isEmbedded, ready, disabled, previewTree, sync),
    [ready, disabled, previewTree, sync],
  );

  /**
   * PROMOTE the current Preview working tree to Production. Sends the frozen draft revision + tree digest
   * over the `PS_PROMOTE_REQUEST` bridge (the admin makes the authed `POST /api/sites/:id/promote` call).
   * The button is only enabled when the gate allows, so we always have a Preview tree here. The terminal
   * state mirrors the HONEST server outcome.
   */
  const doPromote = useCallback(async () => {
    if (!previewTree) {
      return;
    }

    setPromote({ status: 'submitting' });

    try {
      const reply = (await request({
        type: 'PS_PROMOTE_REQUEST',
        correlationId: nextCorrelationId(),
        draftRevision: previewTree.draft_revision,
        treeDigest: previewTree.tree_digest ?? `r${previewTree.draft_revision}`,
        commitSha: previewTree.base_main_sha ?? null,
      })) as PromoteResponseMessage;

      if (!mounted.current) {
        return;
      }

      // A dark flag is an honest "not available", surfaced as a failed state the user can dismiss/retry.
      if (reply.enabled === false) {
        setPromote({ status: 'failed', message: 'Publishing to Production is not enabled yet for your site.' });
        return;
      }

      if (!reply.ok) {
        setPromote({ status: 'failed', message: reply.error || 'Could not publish to Production. Please retry.' });
        return;
      }

      const outcome: PromoteOutcome = reply.outcome ?? reply.release?.outcome ?? 'failed';

      /*
       * RETAIN the settled result so a release-outcome card can render the response ALREADY in the hook
       * (Slice 6b). `serving_sha` rides the release row over the wire even though the bridge TS type omits
       * it — read it via a narrowed local view. `serving_sha` is only present (non-null) on an honest
       * `success`; the completion marker is the release's OWN id (deterministic, never a wall clock).
       */
      const release = reply.release as (PromoteResponseMessage['release'] & { serving_sha?: string | null }) | undefined;
      setLastResult({
        outcome,
        servingSha: outcome === 'success' ? release?.serving_sha ?? null : null,
        releaseId: release?.id ?? null,
        version: release?.deployment_id ?? null,
      });

      if (outcome === 'success') {
        setPromote({ status: 'success', idempotent: reply.idempotent ?? false });
      } else if (outcome === 'commit_ok_deploy_failed') {
        setPromote({
          status: 'commit_ok_deploy_failed',
          message: 'Your changes were committed but the deploy did not go live. Retry to finish publishing.',
        });
      } else {
        setPromote({ status: 'failed', message: 'The promotion did not complete. Please retry.' });
      }

      // Refresh the timeline + sync badge so the new release + Preview<->Production state show immediately.
      void reload();
    } catch (err) {
      if (!mounted.current) {
        return;
      }

      setPromote({
        status: 'failed',
        message: err instanceof Error ? err.message : 'Could not publish to Production. Please retry.',
      });
    }
  }, [previewTree, request, reload]);

  const dismiss = useCallback(() => {
    setPromote({ status: 'idle' });
    setLastResult(null);
  }, []);

  return {
    promote,
    lastResult,
    canPromote: gate.canPromote,
    promoteReason: gate.reason,
    sync,
    ready,
    doPromote: () => void doPromote(),
    dismiss,
    reload: () => void reload(),
  };
}

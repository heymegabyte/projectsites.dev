import { logStore } from '~/lib/stores/logs';

export interface Feature {
  id: string;
  name: string;
  description: string;
  viewed: boolean;
  releaseDate: string;
}

const FEATURE_LOG_CATEGORY = 'feature';

/*
 * The announcement feed lives in memory, not code. Features are logged by the
 * app as it ships them, so there is no hard-coded feature list to keep in sync
 * with reality — a feature is "announced" exactly when the running app logs it.
 */
const announcedFeatures = (): Feature[] =>
  Object.values(logStore.logs.get())
    .filter((log) => log.category === FEATURE_LOG_CATEGORY)
    .map((log) => ({
      id: log.id,
      name: (log.details?.title as string) || log.message.split('\n')[0],
      description: (log.details?.description as string) || log.message,
      viewed: false,
      releaseDate: log.timestamp,
    }));

/*
 * `viewed` is derived from the log store's own read-state rather than a separate
 * key: `markFeatureViewed` writes through `logStore.markAsRead`, the same flag
 * the notifications feed reads. One source of truth, no drift.
 */
const getViewedIds = (): Set<string> =>
  new Set(
    announcedFeatures()
      .filter((feature) => logStore.isRead(feature.id))
      .map((feature) => feature.id),
  );

/** Returns every announced feature, with `viewed` resolved from the log store. */
export const getFeatureFlags = async (): Promise<Feature[]> => {
  const viewedIds = getViewedIds();

  return announcedFeatures().map((feature) => ({ ...feature, viewed: viewedIds.has(feature.id) }));
};

/** Persists that `featureId` has been seen, so future reads report it viewed. */
export const markFeatureViewed = async (featureId: string): Promise<void> => {
  try {
    logStore.markAsRead(featureId);
  } catch (error) {
    console.warn(`Failed to persist viewed feature ${featureId}:`, error);
  }
};

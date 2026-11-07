/**
 * The off-site rule of task A14: a flag is raised when the latest three location points of one shift are all more than
 * 300 metres from the site. One stray reading never raises a flag; a sustained absence does. In one place for review.
 */
export const OFF_SITE_POLICY = { distanceMeters: 300, consecutivePoints: 3 } as const;

/** Distances in metres from the site, oldest first, for the current attendance only. */
export function isOffSite(distancesOldestFirst: readonly number[]): boolean {
  const latest = distancesOldestFirst.slice(-OFF_SITE_POLICY.consecutivePoints);
  return latest.length === OFF_SITE_POLICY.consecutivePoints && latest.every((distance) => distance > OFF_SITE_POLICY.distanceMeters);
}

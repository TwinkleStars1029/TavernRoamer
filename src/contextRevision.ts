let contextRevision = 0;

/**
 * Monotonic revision for host chat/character navigation. A ref alone cannot
 * distinguish staying on A from switching A -> B -> A during an async job.
 */
export function getContextRevision(): number {
  return contextRevision;
}

export function markContextChanged(): number {
  contextRevision += 1;
  return contextRevision;
}

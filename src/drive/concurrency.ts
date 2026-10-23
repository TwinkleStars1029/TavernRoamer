export async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<Result>
): Promise<Result[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Concurrency limit must be a positive integer');
  }
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index] as T;
      results[index] = await operation(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

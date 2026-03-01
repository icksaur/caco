export function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) return 0;
  if (target.length === 0) return -1;

  const lowerTarget = target.toLowerCase();
  const lowerQuery = query.toLowerCase();

  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < lowerTarget.length && queryIdx < lowerQuery.length; i++) {
    if (lowerTarget[i] === lowerQuery[queryIdx]) {
      score += 1;

      if (i === prevMatchIdx + 1) {
        score += 10;
      }

      if (i === 0 || '-_/ .'.includes(lowerTarget[i - 1])) {
        score += 5;
      }

      prevMatchIdx = i;
      queryIdx++;
    }
  }

  return queryIdx === lowerQuery.length ? score : -1;
}

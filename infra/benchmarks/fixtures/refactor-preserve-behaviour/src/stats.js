/**
 * Descriptive statistics over an array of numbers.
 *
 * The three functions repeat the same accumulate-and-fold shape. That is the duplication
 * a refactor is supposed to remove — without changing what any of them return.
 */

/**
 * @param {number[]} values
 * @returns {number}
 */
export function mean(values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

/**
 * @param {number[]} values
 * @returns {number}
 */
export function mode(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

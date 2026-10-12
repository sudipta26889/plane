/**
 * One-sided Clopper-Pearson upper bound on an error rate: with `errors`
 * mistakes in `n` audited decisions, the true rate is below this with the
 * given confidence. Thresholds are certified on this, not on point accuracy
 * — 1 error in 43 looks like 2% but only bounds the rate at ~11%.
 */
export function errorUpperBound(errors: number, n: number, confidence = 0.95): number {
  if (n === 0) return 1;
  if (errors >= n) return 1;
  // Find p where P(X <= errors | n, p) = 1 - confidence; the CDF falls as p rises.
  const alpha = 1 - confidence;
  let lo = errors / n;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(errors, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

function binomialCdf(k: number, n: number, p: number): number {
  // Log space: n is small (hundreds) but p^n underflows quickly.
  let sum = 0;
  let logCoef = 0; // log C(n, 0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) logCoef += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logCoef + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return sum;
}

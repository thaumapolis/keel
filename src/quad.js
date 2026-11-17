/**
 * quad.js -- Gauss-Legendre nodes and weights, shared by every integrator here.
 *
 * Extracted from hull.js and sections.js, which each carried their own identical
 * copy. The duplication only became visible when the single-file bundler refused
 * to concatenate two top-level `gaussLegendre` declarations -- which is precisely
 * the failure it exists to catch, since two same-named top-level consts in one
 * scope is a blank page. Shared now, so the numerical reasoning lives in one
 * place and cannot drift between the two call sites.
 */

function legendre(n, x) {
  // Recurrence gives P_n and P_{n-1}; the derivative identity
  //     (1 - x^2) P_n'(x) = n (P_{n-1}(x) - x P_n(x))
  // needs P_{n-1} from BEFORE the last update. Writing it with the wrong sign, or
  // reading `previous` after the loop has advanced it, yields a derivative off by
  // a factor and the root iteration converges to the wrong place.
  let previous = 1;
  let current = x;
  for (let k = 2; k <= n; k += 1) {
    const next = ((2 * k - 1) * x * current - (k - 1) * previous) / k;
    previous = current;
    current = next;
  }
  return {
    value: current,
    derivative: (n * (previous - x * current)) / (1 - x * x),
  };
}

/**
 * Nodes and weights on [-1, 1] for the requested order, coerced up to even.
 *
 * Generated, not transcribed: a hand-copied weights table in an earlier revision
 * summed to 2.4488 instead of 2, an 11% error on the cheapest check that exists --
 * "integrate the constant 1 over [-1, 1]" -- and because the rule fed the Cb
 * calibration, every hull built from it displaced ~22% wrong while still looking
 * exactly like a hull.
 *
 * Order coerced to even: nodes come in +-pairs, so enumerating ceil(n/2) pairs on
 * an odd order yields n+1 nodes with the one nearest zero double-counted
 * (gaussLegendre(61) summed to 2.0511, a 2.5% error invisible unless checked). Odd
 * orders are corrected, and the weight-sum assertion below catches a regression.
 * Callers must iterate nodes.length, not their requested order: indexing to the
 * requested order read one past the array and produced a -515% volume that looked
 * like divergent numerics and was an index misalignment.
 */
export function gaussLegendre(order) {
  const even = order % 2 === 0 ? order : order + 1;
  const nodes = [];
  const weights = [];
  for (let i = 0; i < even / 2; i += 1) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (even + 0.5));
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const { value, derivative } = legendre(even, x);
      const step = value / derivative;
      x -= step;
      if (Math.abs(step) < 1e-16) break;
    }
    const { derivative } = legendre(even, x);
    const weight = 2 / ((1 - x * x) * derivative * derivative);
    nodes.push(-x, x);
    weights.push(weight, weight);
  }
  const weightSum = weights.reduce((total, w) => total + w, 0);
  if (Math.abs(weightSum - 2) > 1e-12) {
    throw new Error(`gaussLegendre(${order} -> ${even}): weights sum to ${weightSum}, expected 2`);
  }
  return { nodes, weights };
}

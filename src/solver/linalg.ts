/** Tiny dense linear algebra: solve A·x = b by Gaussian elimination with partial pivoting. */

/** Returns x such that A·x = b, or null if A is singular. A is n×n, b is length n. */
export function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  // Work on copies so the caller's matrices are untouched.
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: largest magnitude in this column.
    let pivot = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-14) return null; // singular
    if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];

    // Eliminate below.
    const pv = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }

  // Back-substitute.
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

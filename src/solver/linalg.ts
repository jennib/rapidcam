/** Tiny dense linear algebra: solve A·x = b by Gaussian elimination with partial pivoting. */

/**
 * Return the set of column indices that are uniquely determined by the row space of A.
 * A variable is "determined" if it has zero component in every null vector of A.
 *
 * Algorithm: full RREF with partial row pivoting.
 * - Free columns (no pivot): always in the null space.
 * - Pivot columns: determined iff their row has no non-zero entry in any free column
 *   (i.e., they don't participate in any null vector).
 */
export function determinedVariables(A: number[][], tolerance = 1e-9): Set<number> {
  if (A.length === 0 || A[0].length === 0) return new Set();
  const m = A.length;
  const n = A[0].length;
  const M = A.map((row) => [...row]);

  const pivotForRow: number[] = new Array(m).fill(-1); // pivotForRow[r] = col, -1 = zero row
  const rowForPivot: number[] = new Array(n).fill(-1); // rowForPivot[c] = row, -1 = free col

  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    // Partial row pivot
    let best = tolerance, pivot = -1;
    for (let r = row; r < m; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (pivot === -1) continue; // free column

    if (pivot !== row) [M[row], M[pivot]] = [M[pivot], M[row]];

    // Scale pivot row to 1
    const pv = M[row][col];
    for (let c = col; c < n; c++) M[row][c] /= pv;

    // Full RREF: eliminate this column in ALL other rows
    for (let r = 0; r < m; r++) {
      if (r === row) continue;
      const f = M[r][col];
      if (Math.abs(f) < tolerance) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[row][c];
    }

    pivotForRow[row] = col;
    rowForPivot[col] = row;
    row++;
  }

  // Free columns = non-pivot columns
  const freeCols: number[] = [];
  for (let c = 0; c < n; c++) {
    if (rowForPivot[c] === -1) freeCols.push(c);
  }

  // A pivot column is truly determined iff its RREF row has all zeros among free columns
  const result = new Set<number>();
  for (let c = 0; c < n; c++) {
    const r = rowForPivot[c];
    if (r === -1) continue; // free column, skip
    const inNullSpace = freeCols.some((fc) => Math.abs(M[r][fc]) > tolerance);
    if (!inNullSpace) result.add(c);
  }
  return result;
}

/** Rank of matrix A via Gaussian elimination with partial pivoting. */
export function matrixRank(A: number[][], tolerance = 1e-9): number {
  if (A.length === 0 || A[0].length === 0) return 0;
  const m = A.length, n = A[0].length;
  const M = A.map((row) => [...row]);
  let rank = 0, row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let pivot = row, best = Math.abs(M[row][col]);
    for (let r = row + 1; r < m; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (best < tolerance) continue;
    if (pivot !== row) [M[row], M[pivot]] = [M[pivot], M[row]];
    const pv = M[row][col];
    for (let r = row + 1; r < m; r++) {
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[row][c];
    }
    rank++; row++;
  }
  return rank;
}

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

/**
 * Recursive descent expression evaluator for parametric dimension formulas.
 * Supports: + - * / ^ (right-assoc), unary -, parentheses, numeric literals, variable names.
 * Numbers are dimensionless (internal mm). Variable names must be valid JS identifiers.
 */

export type VarMap = ReadonlyMap<string, number>;

/** Evaluate an expression string against a variable map. Returns null on any error. */
export function evalExpr(expr: string, vars: VarMap): number | null {
  try {
    const p = new Parser(expr.trim(), vars);
    const v = p.parseExpr();
    if (!p.done()) return null;
    return isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Validate an expression. Returns null if valid, an error message if not.
 * Pass an empty map to check syntax only (unknown variables will still error).
 */
export function validateExpr(expr: string, vars: VarMap): string | null {
  try {
    const p = new Parser(expr.trim(), vars);
    p.parseExpr();
    if (!p.done()) return "Unexpected characters after expression";
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid expression";
  }
}

/** Returns true if the expression string references any variable names. */
export function exprUsesVars(expr: string): boolean {
  return /[a-zA-Z_]/.test(expr);
}

// ---------------------------------------------------------------------------
// Parser implementation
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly src: string, private readonly vars: VarMap) {}

  done(): boolean {
    this.skipWs();
    return this.pos >= this.src.length;
  }

  parseExpr(): number {
    let left = this.parseTerm();
    this.skipWs();
    while (this.pos < this.src.length && (this.src[this.pos] === "+" || this.src[this.pos] === "-")) {
      const op = this.src[this.pos++];
      const right = this.parseTerm();
      left = op === "+" ? left + right : left - right;
      this.skipWs();
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parsePower();
    this.skipWs();
    while (this.pos < this.src.length && (this.src[this.pos] === "*" || this.src[this.pos] === "/")) {
      const op = this.src[this.pos++];
      const right = this.parsePower();
      if (op === "/" && right === 0) throw new Error("Division by zero");
      left = op === "*" ? left * right : left / right;
      this.skipWs();
    }
    return left;
  }

  private parsePower(): number {
    const base = this.parseUnary();
    this.skipWs();
    if (this.pos < this.src.length && this.src[this.pos] === "^") {
      this.pos++;
      const exp = this.parseUnary(); // right-associative via recursion in parseUnary
      return Math.pow(base, exp);
    }
    return base;
  }

  private parseUnary(): number {
    this.skipWs();
    if (this.pos < this.src.length && this.src[this.pos] === "-") {
      this.pos++;
      return -this.parsePrimary();
    }
    if (this.pos < this.src.length && this.src[this.pos] === "+") {
      this.pos++;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWs();
    if (this.pos >= this.src.length) throw new Error("Unexpected end of expression");

    // Parenthesised sub-expression
    if (this.src[this.pos] === "(") {
      this.pos++;
      const v = this.parseExpr();
      this.skipWs();
      if (this.pos >= this.src.length || this.src[this.pos] !== ")") throw new Error("Missing closing parenthesis");
      this.pos++;
      return v;
    }

    // Variable name (identifier)
    if (/[a-zA-Z_]/.test(this.src[this.pos])) {
      const start = this.pos;
      while (this.pos < this.src.length && /[a-zA-Z0-9_]/.test(this.src[this.pos])) this.pos++;
      const name = this.src.slice(start, this.pos);
      if (!this.vars.has(name)) throw new Error(`Unknown variable: ${name}`);
      return this.vars.get(name)!;
    }

    // Numeric literal
    const numMatch = this.src.slice(this.pos).match(/^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/);
    if (numMatch) {
      this.pos += numMatch[0].length;
      return parseFloat(numMatch[0]);
    }

    throw new Error(`Unexpected character: '${this.src[this.pos]}'`);
  }

  private skipWs(): void {
    while (this.pos < this.src.length && this.src[this.pos] === " ") this.pos++;
  }
}

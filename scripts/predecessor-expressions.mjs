import { tokens } from "./migration-function-comparator.mjs";

// Small expression grammar for the reviewed constraints/defaults/policies.
// Only documented PostgreSQL deparser rewrites are equated. Unsupported input
// keeps its exact token stream; no parentheses, operators or literals are lost.
export function expressionContract(source) {
  if (source == null) return null;
  const original = tokens(source) ?? [];
  const t = original[0] === "check" ? original.slice(1) : original;
  let i = 0;
  const take = (expected) => {
    if (t[i++] !== expected) throw Error("GRAMMAR");
  };
  const combine = (op, a, b) => [
    op,
    ...(a[0] === op ? a.slice(1) : [a]),
    ...(b[0] === op ? b.slice(1) : [b]),
  ];
  const precedence = {
    or: 1,
    and: 2,
    "=": 3,
    "<>": 3,
    "<": 3,
    ">": 3,
    "<=": 3,
    ">=": 3,
    "~": 3,
    "!~": 3,
    is: 3,
    in: 3,
    between: 3,
    not: 3,
    "||": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6,
  };
  function atom() {
    let value;
    if (t[i] === "(") {
      i++;
      value = parse(0);
      take(")");
    } else if (["not", "-", "+"].includes(t[i])) {
      const op = t[i++];
      value = ["unary", op, parse(op === "not" ? 3 : 7)];
    } else if (t[i] === "array" && t[i + 1] === "[") {
      i += 2;
      const items = [];
      while (t[i] !== "]") {
        items.push(parse(0));
        if (t[i] !== ",") break;
        i++;
      }
      take("]");
      value = ["array", ...items];
    } else if (t[i] === "select") {
      i++;
      value = ["select", parse(0)];
      if (t[i] === "as") {
        i++;
        if (t[i++] !== "actor") throw Error("GRAMMAR");
      }
    } else {
      const name = t[i++];
      if (
        !name ||
        !/^(?:[a-z_][\w$]*|\d+(?:\.\d+)?|'(?:''|[^'])*')$/i.test(name)
      )
        throw Error("GRAMMAR");
      let qualified = name;
      while (t[i] === ".") {
        i++;
        qualified += "." + t[i++];
      }
      if (t[i] === "(") {
        i++;
        const args = [];
        while (t[i] !== ")") {
          args.push(parse(0));
          if (t[i] !== ",") break;
          i++;
        }
        take(")");
        value = ["call", qualified, ...args];
      } else value = ["value", qualified];
    }
    while (t[i] === ":" && t[i + 1] === ":") {
      i += 2;
      let type = t[i++];
      if (type === "timestamp" && t[i] === "with") {
        i += 3;
        type = "timestamptz";
      }
      if (t[i] === "[") {
        i++;
        take("]");
        type += "[]";
      }
      // The source's untyped string literal and PostgreSQL's explicit text
      // literal have identical values for this reviewed text-only grammar.
      if (!(
        type === "text" &&
        value[0] === "value" &&
        value[1].startsWith("'")
      ))
        value = ["cast", type, value];
      // Exact integral upper bound used by the reviewed bigint CHECKs. The
      // decimal is representable as bigint; no identifier or other cast folds.
      if (
        type === "bigint" &&
        JSON.stringify(value) ===
          JSON.stringify(["cast", "bigint", ["value", "'9007199254740991'"]])
      )
        value = ["value", "9007199254740991"];
    }
    return value;
  }
  function parse(min) {
    let left = atom();
    while (i < t.length) {
      let op = t[i],
        p = precedence[op];
      if (p === undefined || p < min) break;
      i++;
      if (op === "not") {
        op = "not " + t[i++];
        if (!["not in", "not between"].includes(op)) throw Error("GRAMMAR");
      }
      if (op === "between" || op === "not between") {
        const lo = parse(4);
        take("and");
        const hi = parse(4);
        const range = combine("and", [">=", left, lo], ["<=", left, hi]);
        left = op === "between" ? range : ["unary", "not", range];
      } else if (op === "in" || op === "not in") {
        take("(");
        const items = [];
        while (t[i] !== ")") {
          items.push(parse(0));
          if (t[i] !== ",") break;
          i++;
        }
        take(")");
        left = [op, left, ...items];
      } else if (op === "is") {
        if (t[i] === "not") {
          op += " not";
          i++;
        }
        if (t[i] === "distinct") {
          op += " distinct from";
          i++;
          take("from");
        }
        left = [op, left, parse(4)];
      } else {
        const right = parse(p + 1);
        if (
          ["=", "<>"].includes(op) &&
          right[0] === "call" &&
          right.length === 3 &&
          right[1] === (op === "=" ? "any" : "all") &&
          right[2][0] === "array"
        )
          left = [op === "=" ? "in" : "not in", left, ...right[2].slice(1)];
        else
          left = ["and", "or"].includes(op)
            ? combine(op, left, right)
            : [op, left, right];
      }
    }
    return left;
  }
  try {
    const result = parse(0);
    if (i !== t.length) throw Error("GRAMMAR");
    return JSON.stringify(original[0] === "check" ? ["check", result] : result);
  } catch {
    return JSON.stringify(["exact", original]);
  }
}

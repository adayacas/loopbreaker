/**
 * Parser de un subconjunto de YAML suficiente para el frontmatter de las fases:
 *   clave: escalar | [a, b] | (bloque anidado de mapas / listas "- item")
 * No es YAML completo (sin anclas, multilínea ni tipos complejos). Cualquier
 * línea que no entienda produce un error explícito en vez de ignorarse.
 */
type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

interface Line {
  indent: number;
  text: string;
  no: number;
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTop(inner).map((p) => scalar(p));
  }
  return s;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let depth = 0;
  for (const c of s) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === "{" || c === "[") {
      depth++;
      cur += c;
    } else if (c === "}" || c === "]") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function parseBlock(lines: Line[], start: number, indent: number): [Yaml, number] {
  const first = lines[start]!;
  if (first.text.startsWith("- ") || first.text === "-") {
    const arr: Yaml[] = [];
    let i = start;
    while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text.startsWith("- ") || lines[i]!.text === "-")) {
      arr.push(scalar(lines[i]!.text.slice(1)));
      i++;
    }
    return [arr, i];
  }
  const obj: { [k: string]: Yaml } = {};
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const { text, no } = lines[i]!;
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(text);
    if (!m) throw new Error(`frontmatter línea ${no}: no se entiende "${text}"`);
    const key = m[1]!;
    const rest = m[2]!.trim();
    i++;
    if (rest !== "") {
      obj[key] = scalar(rest);
    } else if (i < lines.length && lines[i]!.indent > indent) {
      const [val, next] = parseBlock(lines, i, lines[i]!.indent);
      obj[key] = val;
      i = next;
    } else {
      obj[key] = null;
    }
  }
  if (i < lines.length && lines[i]!.indent > indent) {
    throw new Error(`frontmatter línea ${lines[i]!.no}: indentación inesperada`);
  }
  return [obj, i];
}

/** Devuelve el frontmatter ya parseado, o null si el texto no tiene. Lanza si está mal formado. */
export function parseFrontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const lines: Line[] = [];
  m[1]!.split(/\r?\n/).forEach((raw, idx) => {
    const noComment = stripComment(raw);
    if (noComment.trim() === "") return;
    if (/\t/.test(noComment.match(/^\s*/)![0])) throw new Error(`frontmatter línea ${idx + 2}: usa espacios, no tabs`);
    lines.push({ indent: noComment.match(/^ */)![0].length, text: noComment.trim(), no: idx + 2 });
  });
  if (lines.length === 0) return {};
  const [val, next] = parseBlock(lines, 0, lines[0]!.indent);
  if (next < lines.length) {
    // Un dedent por debajo de la primera clave descartaría claves en silencio:
    // en un guardián, un scope que no se aplica debe fallar fuerte, no callarse.
    throw new Error(
      `frontmatter línea ${lines[next]!.no}: las claves de primer nivel deben compartir la indentación de la primera`,
    );
  }
  if (typeof val !== "object" || val === null || Array.isArray(val)) throw new Error("frontmatter: se esperaba un mapa");
  return val as Record<string, unknown>;
}

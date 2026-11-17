/**
 * Glob mínimo sin dependencias. Soporta: `**`, `*`, `?`, `{a,b}`, `[abc]`.
 * Las rutas se comparan siempre con separador "/" y relativas a la raíz.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;

  let g = glob.replace(/\\/g, "/");
  if (g.startsWith("./")) g = g.slice(2);
  // "dir/" equivale a "dir/**"
  if (g.endsWith("/")) g += "**";

  let re = "";
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**/" = cero o más directorios; "**" final = todo
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) {
      re += "|";
    } else if (c === "[") {
      const end = g.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        re += g.slice(i, end + 1);
        i = end;
      }
    } else if (/[.+^$()|\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  const out = new RegExp("^" + re + "$");
  cache.set(glob, out);
  return out;
}

export function matchGlob(relPath: string, glob: string): boolean {
  return globToRegExp(glob).test(relPath);
}

export function matchAny(relPath: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchGlob(relPath, g));
}

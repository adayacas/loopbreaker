import * as fs from "node:fs";
import * as path from "node:path";
import { matchAny } from "./glob.js";
import type { ResolvedConfig, Verdict } from "./types.js";

/** realpath del ancestro existente más profundo (resuelve symlinks aunque el archivo aún no exista). */
function realish(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Normaliza a ruta relativa al proyecto con "/". Devuelve null si queda fuera de la raíz. */
export function toRel(root: string, p: string): string | null {
  const realRoot = realish(root);
  const abs = realish(path.resolve(root, p));
  const rel = path.relative(realRoot, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** Valida UNA ruta que se va a escribir. */
export function checkPath(cfg: ResolvedConfig, p: string): Verdict {
  const rel = toRel(cfg.root, p);
  if (rel === null) return { blocked: true, reason: `"${p}" está fuera del proyecto` };
  if (matchAny(rel, cfg.protectedGlobs)) return { blocked: true, reason: `"${rel}" es un archivo protegido del guardián` };
  if (matchAny(rel, cfg.scope.denyGlobs)) return { blocked: true, reason: `"${rel}" está prohibido en esta fase (denyGlobs)` };
  const allow = cfg.scope.allowOnlyGlobs;
  if (allow.length && !matchAny(rel, allow)) {
    return { blocked: true, reason: `"${rel}" no está en el alcance de esta fase (allowOnlyGlobs: ${allow.join(", ")})` };
  }
  return { blocked: false };
}

export function checkPaths(cfg: ResolvedConfig, paths: string[]): Verdict {
  for (const p of paths) {
    const v = checkPath(cfg, p);
    if (v.blocked) return v;
  }
  return { blocked: false };
}

/** Rutas que toca una llamada de escritura. Para edit/write/patch es exacto. */
export function writtenPaths(tool: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const f = args.filePath ?? args.file_path ?? args.path;
  if (typeof f === "string") out.push(f);

  if (tool === "patch") {
    const text = String(args.patchText ?? args.patch ?? args.diff ?? "");
    // formato "*** Update/Add/Delete File: x" y diff unificado (--- a/x / +++ b/x)
    for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) out.push(m[1]!.trim());
    for (const m of text.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (m[1] !== "/dev/null") out.push(m[1]!);
    for (const m of text.matchAll(/^--- (?:a\/)?(\S+)/gm)) if (m[1] !== "/dev/null") out.push(m[1]!);
  }
  return [...new Set(out)];
}

/**
 * Mejor esfuerzo sobre bash: redirecciones y comandos de escritura obvios.
 * NO es una garantía (variables, scripts, subshells lo evaden): la red de seguridad
 * fiable es `git diff` al terminar el turno (ver gitViolations).
 */
export function bashWrites(command: string): string[] {
  const out: string[] = [];
  const clean = (s: string) => s.replace(/^["']|["']$/g, "");
  for (const m of command.matchAll(/(?:^|[^>&0-9])>>?\s*(?!&)([^\s;|&<>()]+)/g)) out.push(clean(m[1]!));
  for (const m of command.matchAll(/\btee\s+(?:-[a-z]+\s+)*([^\s;|&<>]+)/g)) out.push(clean(m[1]!));
  for (const m of command.matchAll(/\bsed\s+(?:-[A-Za-z]*i[A-Za-z]*(?:\.\w+)?\s+)(?:-e\s+)?(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;|&]+)/g)) out.push(clean(m[1]!));
  for (const m of command.matchAll(/\b(?:rm|touch|mkdir|rmdir|truncate)\s+((?:-\S+\s+)*)([^;|&<>]+)/g)) {
    for (const t of m[2]!.trim().split(/\s+/)) if (!t.startsWith("-")) out.push(clean(t));
  }
  for (const m of command.matchAll(/\b(?:mv|cp)\s+((?:-\S+\s+)*)([^;|&<>]+)/g)) {
    const toks = m[2]!.trim().split(/\s+/).filter((t) => !t.startsWith("-"));
    if (toks.length) out.push(clean(toks[toks.length - 1]!)); // destino
    if (/^\s*mv/.test(m[0])) toks.slice(0, -1).forEach((t) => out.push(clean(t))); // origen desaparece
  }
  return [...new Set(out.filter((p) => p && !p.startsWith("/dev/") && !/^\$/.test(p)))];
}

/** Archivos modificados según git, fuera del alcance de la fase. */
export function gitViolations(cfg: ResolvedConfig, changed: string[]): string[] {
  return changed.filter((p) => {
    const rel = toRel(cfg.root, p);
    if (rel === null) return true;
    if (matchAny(rel, cfg.protectedGlobs)) return false; // archivos del guardián: los edita el humano
    if (matchAny(rel, cfg.scope.denyGlobs)) return true;
    const allow = cfg.scope.allowOnlyGlobs;
    return allow.length > 0 && !matchAny(rel, allow);
  });
}

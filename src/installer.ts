import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoopbreakerConfig } from "./types.js";

export const PLUGIN_NAME = "@adayacas/loopbreaker";

/** Versión del paquete que está ejecutando el instalador, para pinear el plugin. */
function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "../../package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "latest";
  } catch {
    return "latest";
  }
}

export const PLUGIN_VERSION = packageVersion();
export const PINNED_PLUGIN = `${PLUGIN_NAME}@${PLUGIN_VERSION}`;
export const GITIGNORE_ENTRY = ".opencode/";
export const DEFAULT_INIT: LoopbreakerConfig = { mode: "block", maxConsecutiveRepeats: 3, stagnationRepeats: 3 };

export interface InstallResult {
  ok: boolean;
  changed: boolean;
  file: string;
  message: string;
}

/** Config global de OpenCode: $XDG_CONFIG_HOME/opencode o ~/.config/opencode. */
export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".config");
  return path.join(base, "opencode");
}

/** Busca opencode.json (o .jsonc); si no existe ninguno, devuelve opencode.json como destino a crear. */
export function configFile(dir: string): string {
  for (const n of ["opencode.json", "opencode.jsonc"]) {
    const f = path.join(dir, n);
    if (fs.existsSync(f)) return f;
  }
  return path.join(dir, "opencode.json");
}

/** Quita comentarios // y /* *\/ y comas finales sin tocar el contenido de las cadenas. */
function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function read(file: string): { data: Record<string, unknown>; hadComments: boolean } | { error: string } {
  if (!fs.existsSync(file)) return { data: {}, hadComments: false };
  const raw = fs.readFileSync(file, "utf8");
  try {
    return { data: raw.trim() ? JSON.parse(raw) : {}, hadComments: false };
  } catch {
    try {
      return { data: JSON.parse(stripJsonc(raw)), hadComments: true };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
}

const isLoopbreaker = (p: unknown): boolean => typeof p === "string" && (p === PLUGIN_NAME || p.startsWith(PLUGIN_NAME + "@"));

function manual(file: string, why: string, line: string): InstallResult {
  return { ok: false, changed: false, file, message: `${why}\nNo toqué tu archivo. Añade a mano en ${file}:\n  ${line}` };
}

/**
 * Añade el plugin a opencode.json de forma idempotente, con copia de seguridad.
 * Por defecto fija la versión exacta; una entrada sin versión se reemplaza.
 */
export function install(dir: string, pin = true): InstallResult {
  const spec = pin ? PINNED_PLUGIN : PLUGIN_NAME;
  const file = configFile(dir);
  const r = read(file);
  if ("error" in r) return manual(file, `No pude leer ${file} (${r.error}).`, `"plugin": ["${spec}"]`);
  if (r.hadComments) {
    // Reescribir perdería los comentarios del usuario: mejor no tocar nada.
    return manual(file, `${path.basename(file)} tiene comentarios y reescribirlo los borraría.`, `"plugin": [..., "${spec}"]`);
  }
  const cur = r.data.plugin;
  if (cur !== undefined && !Array.isArray(cur)) return manual(file, `"plugin" en ${file} no es una lista.`, `"plugin": ["${spec}"]`);
  const list: unknown[] = Array.isArray(cur) ? [...cur] : [];
  const idx = list.findIndex(isLoopbreaker);
  if (idx !== -1 && list[idx] === spec) return { ok: true, changed: false, file, message: `Ya estaba instalado en ${file}.` };

  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".loopbreaker.bak");
  if (idx === -1) list.push(spec);
  else list[idx] = spec;
  const next = { ...(fs.existsSync(file) ? r.data : { $schema: "https://opencode.ai/config.json" }), plugin: list };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return {
    ok: true,
    changed: true,
    file,
    message: `Plugin ${idx === -1 ? "añadido" : `actualizado a ${spec}`} en ${file}${fs.existsSync(file + ".loopbreaker.bak") ? ` (copia: ${path.basename(file)}.loopbreaker.bak)` : ""}.`,
  };
}

export function uninstall(dir: string): InstallResult {
  const file = configFile(dir);
  if (!fs.existsSync(file)) return { ok: true, changed: false, file, message: "No hay configuración que modificar." };
  const r = read(file);
  if ("error" in r || r.hadComments) return manual(file, `No puedo editar ${file} automáticamente.`, `quita "${PLUGIN_NAME}" de "plugin"`);
  const cur = r.data.plugin;
  if (!Array.isArray(cur) || !cur.some(isLoopbreaker)) return { ok: true, changed: false, file, message: "El plugin no estaba registrado." };
  fs.copyFileSync(file, file + ".loopbreaker.bak");
  const rest = cur.filter((p) => !isLoopbreaker(p));
  const next = { ...r.data };
  if (rest.length) next.plugin = rest;
  else delete next.plugin;
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return { ok: true, changed: true, file, message: `Plugin quitado de ${file}.` };
}

/** ¿El opencode.json de este directorio registra loopbreaker? */
export function isInstalled(dir: string): boolean {
  const r = read(configFile(dir));
  return !("error" in r) && Array.isArray(r.data.plugin) && r.data.plugin.some(isLoopbreaker);
}

/** Crea un .loopbreaker.json en el proyecto (no sobrescribe). */
export function init(projectDir: string, config: LoopbreakerConfig = DEFAULT_INIT): InstallResult {
  const file = path.join(projectDir, ".loopbreaker.json");
  if (fs.existsSync(file)) return { ok: true, changed: false, file, message: `${file} ya existe.` };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return { ok: true, changed: true, file, message: `Creado ${file}.` };
}

/** Añade `.opencode/` al .gitignore del proyecto de forma idempotente. */
export function ensureGitignore(projectDir: string): InstallResult {
  const file = path.join(projectDir, ".gitignore");
  try {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const has = current
      .split(/\r?\n/)
      .some((l) => l.trim() === GITIGNORE_ENTRY || l.trim() === GITIGNORE_ENTRY.replace(/\/$/, ""));
    if (has) return { ok: true, changed: false, file, message: `Ya estaba ${GITIGNORE_ENTRY} en ${file}.` };
    const prefix = current && !current.endsWith("\n") ? current + "\n" : current;
    fs.writeFileSync(file, prefix + GITIGNORE_ENTRY + "\n");
    return { ok: true, changed: true, file, message: `Añadido ${GITIGNORE_ENTRY} a ${file}.` };
  } catch (e) {
    return { ok: false, changed: false, file, message: `No pude actualizar ${file} (${(e as Error).message}). Añade ${GITIGNORE_ENTRY} a mano.` };
  }
}

import { DEFAULT_INIT } from "./installer.js";
import type { LoopbreakerConfig, Mode } from "./types.js";

export interface InstallChoices {
  target: "global" | "project";
  pin: boolean;
  config?: LoopbreakerConfig;
  gitignore: boolean;
}

export interface WizardIo {
  question(prompt: string): Promise<string>;
}

export function parsePositive(text: string, def: number, min = 2): number {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= min ? n : def;
}

export function parseGlobs(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Respuestas ya normalizadas -> archivo .loopbreaker.json. Separado para poder testearlo. */
export function buildConfig(a: {
  mode: Mode;
  maxConsecutiveRepeats: number;
  stagnationRepeats: number;
  hardStopAfter: number;
  allowOnlyGlobs?: string[];
  denyGlobs?: string[];
}): LoopbreakerConfig {
  const cfg: LoopbreakerConfig = {
    mode: a.mode,
    maxConsecutiveRepeats: a.maxConsecutiveRepeats,
    stagnationRepeats: a.stagnationRepeats,
    hardStopAfter: a.hardStopAfter,
  };
  const allowOnlyGlobs = a.allowOnlyGlobs ?? [];
  const denyGlobs = a.denyGlobs ?? [];
  if (allowOnlyGlobs.length || denyGlobs.length) cfg.scope = { allowOnlyGlobs, denyGlobs };
  return cfg;
}

/** Wizard de instalación. Sin TTY el CLI no lo llama y usa los mismos defaults. */
export async function runWizard(
  projectRoot: string,
  io: WizardIo,
  fixedTarget?: "global" | "project",
): Promise<InstallChoices | undefined> {
  const text = async (q: string): Promise<string> => (await io.question(`${q}: `)).trim();
  const ask = async (q: string, def: string): Promise<string> => (await text(`${q} [${def}]`)) || def;
  const yes = async (q: string, def: boolean): Promise<boolean> => {
    const a = (await text(`${q} (${def ? "S/n" : "s/N"})`)).toLowerCase();
    if (!a) return def;
    return ["s", "si", "sí", "y", "yes"].includes(a);
  };
  const num = async (q: string, def: number, min = 2): Promise<number> => parsePositive(await text(`${q} [${def}]`), def, min);

  const target: "global" | "project" = fixedTarget ?? ((await ask("¿Instalar global o solo en este proyecto? (global/proyecto)", "global")).toLowerCase().startsWith("p") ? "project" : "global");
  const pin = await yes("¿Fijar la versión exacta del plugin?", true);

  let config: LoopbreakerConfig | undefined;
  if (await yes("¿Crear .loopbreaker.json con ajustes del anti-bucles?", false)) {
    const mode: Mode = (await ask("Modo (block/warn)", "block")).toLowerCase() === "warn" ? "warn" : "block";
    const maxConsecutiveRepeats = await num("Repeticiones idénticas antes de bloquear", DEFAULT_INIT.maxConsecutiveRepeats ?? 3, 2);
    const stagnationRepeats = await num("Salidas idénticas para estancamiento", DEFAULT_INIT.stagnationRepeats ?? 3, 2);
    const hardStopAfter = await num("Bloqueos antes de parada dura", DEFAULT_INIT.hardStopAfter ?? 3, 1);
    let allowOnlyGlobs: string[] = [];
    let denyGlobs: string[] = [];
    if (await yes("¿Configurar alcance por globs? (disuasorio, no sandbox)", false)) {
      allowOnlyGlobs = parseGlobs(await text("allowOnlyGlobs separados por coma (vacío = sin límite)"));
      denyGlobs = parseGlobs(await text("denyGlobs separados por coma (vacío = ninguno)"));
    }
    config = buildConfig({ mode, maxConsecutiveRepeats, stagnationRepeats, hardStopAfter, allowOnlyGlobs, denyGlobs });
  }

  const gitignore = await yes("¿Añadir .opencode/ al .gitignore de este proyecto?", true);
  console.log(`\nResumen: ${target === "project" ? `proyecto (${projectRoot})` : "global"} | versión ${pin ? "fija" : "latest"} | .loopbreaker.json ${config ? "sí" : "no"} | .gitignore ${gitignore ? "sí" : "no"}`);
  if (!(await yes("¿Aplicar estos cambios?", true))) return undefined;
  return { target, pin, config, gitignore };
}

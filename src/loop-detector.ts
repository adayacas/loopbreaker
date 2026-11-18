import { createHash } from "node:crypto";
import type { CallEntry, ResolvedConfig, SessionState, Verdict } from "./types.js";

/** Herramientas que cambian el estado del proyecto: una escritura exitosa "da progreso". */
export const WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

export const newSession = (): SessionState => ({ epoch: 0, blocks: 0, entries: [] });

const sha = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  return v;
}

/** Firma estable: mismo tool + mismos argumentos (orden de claves y espacios normalizados). */
export function signature(tool: string, args: unknown, root?: string): string {
  let a = canonical(args);
  if (root) {
    // rutas absolutas dentro del proyecto == relativas
    a = JSON.parse(JSON.stringify(a).split(root.replace(/\/$/, "") + "/").join(""));
  }
  return `${tool}:${sha(JSON.stringify(a))}`;
}

/** Salidas más cortas que esto ("", "ok", "done") son demasiado genéricas para indicar estancamiento. */
export const MIN_STAGNANT_LEN = 40;

/** Familia: la herramienta y, en bash, el programa principal (ignora `cd x &&` y VAR=valor). */
export function family(tool: string, args: Record<string, unknown>): string {
  if (tool === "bash" && typeof args.command === "string") {
    const cmd = args.command.trim().replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, "").replace(/^(?:\w+=\S+\s+)+/, "");
    return `bash:${cmd.split(/\s+/)[0] ?? ""}`;
  }
  return tool;
}

export const resultText = (out: unknown): string => (typeof out === "string" ? out : JSON.stringify(out ?? ""));
export const hashResult = (out: unknown): string => sha(resultText(out));

const thresholdFor = (cfg: ResolvedConfig, tool: string): number => cfg.toolThresholds[tool] ?? cfg.maxConsecutiveRepeats;

/** Entradas de la época actual (sin escrituras exitosas en medio). */
function currentRun(state: SessionState): CallEntry[] {
  const out: CallEntry[] = [];
  for (let i = state.entries.length - 1; i >= 0; i--) {
    if (state.entries[i]!.epoch !== state.epoch) break;
    out.unshift(state.entries[i]!);
  }
  return out;
}

/**
 * Evalúa una llamada ANTES de ejecutarla (no la registra).
 * - Repetición: la misma firma N veces seguidas, con resultados idénticos o desconocidos.
 *   Si el resultado cambia entre repeticiones, hay progreso y el contador se reinicia.
 * - Ciclo: un patrón de periodo 2..K repetido N veces (A-B-A-B-A-B).
 */
export function check(state: SessionState, cfg: ResolvedConfig, tool: string, sig: string, fam: string = tool): Verdict {
  const n = thresholdFor(cfg, tool);
  const run = currentRun(state);

  // 1) repetición idéntica
  let streak = 0;
  for (let i = run.length - 1; i >= 0; i--) {
    const e = run[i]!;
    if (e.sig !== sig) break;
    const next = run[i + 1];
    if (next && e.resultHash && next.resultHash && e.resultHash !== next.resultHash) break;
    streak++;
  }
  if (streak + 1 >= n) {
    return {
      blocked: true,
      reason: `la llamada "${tool}" se repitió ${streak + 1} veces seguidas con los mismos argumentos y sin cambios en el proyecto ni en su salida`,
    };
  }

  // 2) estancamiento: la misma familia devuelve la misma salida (aunque cambien los argumentos)
  const last = run[run.length - 1];
  if (last?.resultHash && last.family === fam && (last.resultLen ?? 0) >= MIN_STAGNANT_LEN) {
    let same = 0;
    for (let i = run.length - 1; i >= 0; i--) {
      const e = run[i]!;
      if (e.family !== fam || e.resultHash !== last.resultHash) break;
      same++;
    }
    if (same >= cfg.stagnationRepeats) {
      return {
        blocked: true,
        reason: `las últimas ${same} llamadas de "${fam}" devolvieron EXACTAMENTE la misma salida («${(last.snippet ?? "").replace(/\s+/g, " ")}») aunque cambiaste los argumentos: el problema no está en el comando, algo se quedó pegado en la herramienta o el entorno`,
      };
    }
  }

  // 3) ciclos de periodo p >= 2
  const seq = [...run.map((e) => e.sig), sig];
  for (let p = 2; p <= cfg.cycleMaxPeriod; p++) {
    const need = p * n;
    if (seq.length < need) continue;
    const tail = seq.slice(-need);
    const pattern = tail.slice(0, p);
    if (new Set(pattern).size < 2) continue; // un patrón uniforme ya lo cubre la regla 1
    if (tail.every((s, i) => s === pattern[i % p])) {
      // Salidas que cambian entre repeticiones del mismo elemento = progreso:
      // el agente avanza aunque alterne, no es un bucle pegado.
      let progress = false;
      const firstHash = new Map<string, string>();
      for (const e of run.slice(-(need - 1))) {
        if (!e.resultHash) continue;
        const first = firstHash.get(e.sig);
        if (first === undefined) firstHash.set(e.sig, e.resultHash);
        else if (first !== e.resultHash) {
          progress = true;
          break;
        }
      }
      if (!progress) {
        return { blocked: true, reason: `se detectó un ciclo de ${p} llamadas repetido ${n} veces sin progreso` };
      }
    }
  }
  return { blocked: false };
}

export function record(state: SessionState, cfg: ResolvedConfig, tool: string, sig: string, fam: string = tool): void {
  state.entries.push({ sig, tool, family: fam, epoch: state.epoch });
  if (state.entries.length > cfg.window) state.entries.splice(0, state.entries.length - cfg.window);
}

/** Después de ejecutar: guarda el hash del resultado y sube la época si hubo escritura. */
export function recordResult(state: SessionState, tool: string, sig: string, text: string, failed = false): void {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i]!;
    if (e.sig === sig && e.resultHash === undefined) {
      e.resultHash = hashResult(text);
      e.resultLen = text.length;
      e.snippet = text.slice(0, 120);
      break;
    }
  }
  if (WRITE_TOOLS.has(tool) && !failed) state.epoch++;
}

/** Mensaje de bloqueo accionable; escala a "parada dura" tras varios bloqueos. */
export function blockMessage(cfg: ResolvedConfig, state: SessionState, reason: string): string {
  const hard = (state.loopBlocks ?? 0) >= cfg.hardStopAfter;
  const head = hard ? "🛑 [LOOPBREAKER PARADA DURA]" : "🛑 [LOOPBREAKER BLOQUEADO]";
  const todo = hard
    ? "Has insistido tras varios bloqueos. DETENTE ahora: explica al usuario qué intentas lograr, qué falla y pídele instrucciones. No sigas llamando herramientas."
    : "No repitas esta acción ni variantes de ella. Lee el error o la salida anterior, cambia de enfoque (otro comando, otro archivo, otra hipótesis) o pide ayuda al usuario.";
  return `${head} ${reason}. ${todo}`;
}

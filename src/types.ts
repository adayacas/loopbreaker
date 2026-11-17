export type Mode = "block" | "warn";

export interface ScopeRules {
  denyGlobs: string[];
  allowOnlyGlobs: string[];
}

/** Contenido de .loopbreaker.json (todo opcional: sin archivo, solo corre el anti-bucles). */
export interface LoopbreakerConfig {
  mode?: Mode;
  /** Repeticiones consecutivas idénticas (sin progreso) que disparan el bloqueo. */
  maxConsecutiveRepeats?: number;
  /** Umbrales por herramienta, p. ej. { "read": 4, "bash": 3 }. */
  toolThresholds?: Record<string, number>;
  /** Periodo máximo de ciclo a detectar (2 = A-B-A-B, 3 = A-B-C-A-B-C). */
  cycleMaxPeriod?: number;
  /** Salidas idénticas seguidas (misma familia de comando) que indican estancamiento. */
  stagnationRepeats?: number;
  /** Tamaño de la ventana deslizante de historial por sesión. */
  window?: number;
  /** Bloqueos acumulados en una sesión tras los cuales el mensaje pasa a "parada dura". */
  hardStopAfter?: number;
  activeSpecFile?: string;
  scope?: Partial<ScopeRules>;
  /** Globs adicionales que el agente nunca puede escribir. */
  protectedGlobs?: string[];
}

/** Frontmatter de .engram/specs/phase-XX.md */
export interface PhaseSpec {
  id?: string;
  goal?: string;
  scope?: Partial<ScopeRules>;
  exitCriteria?: string[];
}

export interface ResolvedConfig {
  root: string;
  mode: Mode;
  maxConsecutiveRepeats: number;
  toolThresholds: Record<string, number>;
  cycleMaxPeriod: number;
  stagnationRepeats: number;
  window: number;
  hardStopAfter: number;
  scope: ScopeRules;
  protectedGlobs: string[];
  specFile?: string;
  phase?: PhaseSpec;
  /** Errores de configuración: el guardián sigue activo y los reporta. */
  warnings: string[];
}

export interface CallEntry {
  sig: string;
  tool: string;
  /** Época de escritura: sube cada vez que una herramienta de escritura termina bien. */
  epoch: number;
  /** Familia del comando: tool, y para bash el primer programa (p. ej. "bash:rtk"). */
  family?: string;
  resultHash?: string;
  resultLen?: number;
  /** Primeros caracteres de la salida, para citarla en el mensaje de bloqueo. */
  snippet?: string;
}

export interface SessionState {
  epoch: number;
  /** Bloqueos totales (informativo). */
  blocks: number;
  /** Bloqueos por bucle: solo estos escalan a parada dura. */
  loopBlocks?: number;
  entries: CallEntry[];
}

export interface Verdict {
  blocked: boolean;
  reason?: string;
}

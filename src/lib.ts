// API programática del paquete, separada de index.ts a propósito:
// OpenCode invoca como plugin CADA export de función/clase del módulo de entrada,
// así que index.ts no puede exponer nada más. Los consumidores de librería
// importan desde acá: `import { Guard, loadConfig } from "@adayacas/loopbreaker/lib"`.
export { Guard } from "./guard.js";
export { loadConfig, phaseCard } from "./config-loader.js";
export { parseFrontmatter } from "./frontmatter.js";
export type {
  CallEntry,
  LoopbreakerConfig,
  Mode,
  PhaseSpec,
  ResolvedConfig,
  ScopeRules,
  SessionState,
  Verdict,
} from "./types.js";

import { Guard } from "./guard.js";
import { phaseCard } from "./config-loader.js";

// Tipos estructurales mínimos: evitan depender de @opencode-ai/plugin en tiempo de compilación.
// Verifica los nombres de hooks contra tu versión de OpenCode (algunos son "experimental.*").
type Args = Record<string, unknown>;
type PluginCtx = { directory?: string; worktree?: string };

export const LoopbreakerPlugin = async (ctx: PluginCtx = {}) => {
  const root = ctx.worktree || ctx.directory || process.cwd();
  const guard = new Guard(root);

  // Las args se guardan entre before y after por callID (el hook after no las recibe).
  const pending = new Map<string, Args>();

  // loopbreaker_status es de solo lectura. No depende de @opencode-ai/plugin:
  // su helper tool() es una identidad (verificado en 1.19.5 y 0.15.31), así que
  // devolver el objeto directamente evita el peer y el fallo silencioso.
  return {
    tool: {
      loopbreaker_status: {
        description: "Muestra el estado del guardián de ejecución (fase activa, alcance, bloqueos).",
        args: {},
        async execute(_a: unknown, c: { sessionID?: string }) {
          return guard.status(c?.sessionID);
        },
      },
    },

    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }, output: { args?: Args }) => {
      const args = output?.args ?? {};
      pending.set(input.callID, args);
      const msg = guard.before(input.sessionID, input.tool, args);
      if (msg) {
        pending.delete(input.callID);
        throw new Error(msg);
      }
    },

    "tool.execute.after": async (input: { tool: string; sessionID: string; callID: string }, output: { output?: unknown; metadata?: { error?: unknown } }) => {
      const args = pending.get(input.callID);
      pending.delete(input.callID);
      if (!args) return;
      guard.after(input.sessionID, input.tool, args, output?.output, Boolean(output?.metadata?.error));
    },

    // Inyecta la tarjeta de fase en cada prompt y durante la compactación (no después).
    "experimental.chat.system.transform": async (_i: unknown, output: { system: string[] }) => {
      guard.reload();
      const card = phaseCard(guard.cfg);
      if (card) output.system.push(card);
    },
    "experimental.session.compacting": async (_i: unknown, output: { context: string[] }) => {
      guard.reload();
      const card = phaseCard(guard.cfg);
      if (card) output.context.push(card);
    },

    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.idle") guard.gitCheck();
    },
  };
};

// Solo se exporta LoopbreakerPlugin: OpenCode invoca como plugin CADA export de función/clase del módulo.

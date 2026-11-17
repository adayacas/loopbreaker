#!/usr/bin/env node
// CLI SOLO PARA HUMANOS. El agente no tiene acceso a estas operaciones como herramientas.
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { PHASE_LOCK } from "./config-loader.js";
import { Guard } from "./guard.js";
import { ensureGitignore, globalConfigDir, init, install, uninstall } from "./installer.js";
import { runWizard } from "./wizard.js";
import type { InstallChoices } from "./wizard.js";

const USAGE = `uso: loopbreaker <comando>
  install [--project] [--yes] [--no-pin] [--no-gitignore]
                          registra el plugin (wizard interactivo; --yes = defaults)
  uninstall [--project]   lo quita
  init                    crea .loopbreaker.json en este proyecto
  status                  muestra la fase, el alcance y los bloqueos
  set-phase <id|ruta>     cambia la fase activa
  reset [sessionID]       limpia el historial de bloqueos`;

function out(r: { ok: boolean; message: string }): never {
  (r.ok ? console.log : console.error)(r.message);
  process.exit(r.ok ? 0 : 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [cmd, arg] = args.filter((a) => !a.startsWith("--"));
  const root = process.cwd();

  switch (cmd) {
    case "install": {
      const project = flags.has("--project");
      let choices: InstallChoices;
      if (!flags.has("--yes") && process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await runWizard(root, { question: (q) => rl.question(q) }, project ? "project" : undefined);
          if (!answer) {
            console.log("Instalación cancelada.");
            return;
          }
          choices = answer;
        } catch {
          console.log("\nInstalación cancelada.");
          return;
        } finally {
          rl.close();
        }
        if (flags.has("--no-pin")) choices.pin = false;
        if (flags.has("--no-gitignore")) choices.gitignore = false;
      } else {
        choices = {
          target: project ? "project" : "global",
          pin: !flags.has("--no-pin"),
          gitignore: project && !flags.has("--no-gitignore"),
        };
      }

      const r = install(choices.target === "project" ? root : globalConfigDir(), choices.pin);
      if (!r.ok) {
        console.error(r.message);
        process.exit(1);
      }
      console.log(r.message);
      if (choices.config) console.log(init(root, choices.config).message);
      if (choices.gitignore) console.log(ensureGitignore(root).message);
      if (r.changed) console.log("Reinicia OpenCode para cargarlo.");
      break;
    }
    case "uninstall":
      out(uninstall(flags.has("--project") ? root : globalConfigDir()));
      break;
    case "init":
      out(init(root));
      break;
    case "status":
      console.log(new Guard(root).status());
      break;
    case "set-phase": {
      if (!arg) {
        console.error("uso: loopbreaker set-phase <id|ruta>   (p. ej. loopbreaker set-phase 2)");
        process.exit(2);
      }
      const guard = new Guard(root);
      const lock = path.join(root, PHASE_LOCK);
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, arg + "\n");
      guard.reset();
      guard.reload();
      console.log(guard.status());
      break;
    }
    case "reset":
      new Guard(root).reset(arg);
      console.log(arg ? `historial de ${arg} limpiado` : "historial limpiado");
      break;
    default:
      console.error(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

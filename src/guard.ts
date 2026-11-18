import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { LOG_FILE, STATE_FILE, loadConfig } from "./config-loader.js";
import { blockMessage, check, family, newSession, record, recordResult, resultText, signature, WRITE_TOOLS } from "./loop-detector.js";
import { bashWrites, checkPaths, gitViolations, writtenPaths } from "./scope-validator.js";
import type { ResolvedConfig, SessionState } from "./types.js";

type StateFile = { sessions: Record<string, SessionState> };

/** Un repo no confiable puede poner symlinks en .opencode: nunca escribimos a través de ellos. */
function isSymlink(f: string): boolean {
  try {
    return fs.lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Núcleo del guardián: independiente de OpenCode para poder probarlo en aislamiento. */
export class Guard {
  cfg: ResolvedConfig;
  private state: StateFile = { sessions: {} };

  constructor(readonly root: string) {
    this.cfg = loadConfig(root);
    this.load();
    this.harden();
  }

  /** Endurece archivos existentes de versiones anteriores (0644 -> 0600). */
  private harden(): void {
    for (const f of [STATE_FILE, LOG_FILE]) {
      const full = path.join(this.root, f);
      if (isSymlink(full)) continue;
      try {
        fs.chmodSync(full, 0o600);
      } catch {
        /* el archivo todavía no existe */
      }
    }
  }

  /** La configuración se relee en cada llamada: cambiar de fase surte efecto sin reiniciar. */
  reload(): void {
    this.cfg = loadConfig(this.root);
  }

  private load(): void {
    try {
      const f = path.join(this.root, STATE_FILE);
      if (isSymlink(f)) return;
      const raw = JSON.parse(fs.readFileSync(f, "utf8"));
      if (raw && typeof raw === "object" && raw.sessions) {
        this.state = raw;
        // Migración: versiones anteriores guardaban los primeros 120 caracteres de cada salida.
        let dirty = false;
        for (const s of Object.values(this.state.sessions)) {
          if (!s || !Array.isArray(s.entries)) continue;
          for (const e of s.entries) {
            if (e && Object.prototype.hasOwnProperty.call(e, "snippet")) {
              delete e.snippet;
              dirty = true;
            }
          }
        }
        if (dirty) this.save();
      }
    } catch {
      /* sin estado previo o corrupto: empezamos limpio */
    }
  }

  private save(): void {
    try {
      const f = path.join(this.root, STATE_FILE);
      if (isSymlink(f)) return;
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      // El snippet se usa solo en memoria para citar la salida en el mensaje de bloqueo.
      // Nunca se persiste: puede contener tokens, variables de entorno o credenciales.
      const data = JSON.stringify(this.state, (k, v) => (k === "snippet" ? undefined : v));
      fs.writeFileSync(f, data, { mode: 0o600 });
      fs.chmodSync(f, 0o600);
    } catch {
      /* el guardián nunca debe romper la sesión por no poder persistir */
    }
  }

  private log(event: Record<string, unknown>): void {
    try {
      const f = path.join(this.root, LOG_FILE);
      if (isSymlink(f)) return;
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      // El motivo de estancamiento cita la salida: se redacta antes de tocar el disco.
      const safe = Object.fromEntries(
        Object.entries(event).map(([k, v]) => [
          k,
          typeof v === "string" ? v.replace(/«[^»]*»/g, "«…»").slice(0, 500) : v,
        ]),
      );
      fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...safe }) + "\n", { mode: 0o600 });
      fs.chmodSync(f, 0o600);
    } catch {
      /* idem */
    }
  }

  session(id: string): SessionState {
    return (this.state.sessions[id] ??= newSession());
  }

  /**
   * Antes de ejecutar una herramienta. Devuelve el mensaje de bloqueo o undefined si puede seguir.
   * En modo "warn" solo registra en el log.
   */
  before(sessionID: string, tool: string, args: Record<string, unknown> = {}): string | undefined {
    this.reload();
    const s = this.session(sessionID);
    const sig = signature(tool, args, this.root);
    const fam = family(tool, args);

    // 1) alcance (solo escrituras)
    let reason: string | undefined;
    let kind = "scope";
    const paths = WRITE_TOOLS.has(tool)
      ? writtenPaths(tool, args)
      : tool === "bash" && typeof args.command === "string"
        ? bashWrites(args.command)
        : [];
    if (paths.length) {
      const v = checkPaths(this.cfg, paths);
      if (v.blocked) reason = v.reason;
    }

    // 2) bucles (todas las herramientas)
    if (!reason) {
      const v = check(s, this.cfg, tool, sig, fam);
      if (v.blocked) {
        reason = v.reason;
        kind = "loop";
      }
    }

    if (reason) {
      s.blocks++;
      this.log({ event: "violation", kind, tool, sessionID, reason, mode: this.cfg.mode, blocks: s.blocks });
      if (this.cfg.mode === "block") {
        // una llamada bloqueada no se ejecuta: no cuenta como progreso ni se añade al historial,
        // salvo los bloqueos por bucle, que sí deben seguir sumando para escalar.
        if (kind === "loop") {
          s.loopBlocks = (s.loopBlocks ?? 0) + 1;
          record(s, this.cfg, tool, sig, fam);
        }
        this.save();
        return kind === "scope"
          ? `🛑 [LOOPBREAKER BLOQUEADO] ${reason}. Trabaja solo dentro del alcance de la fase activa o pide al usuario que cambie de fase.`
          : blockMessage(this.cfg, s, reason);
      }
    }
    record(s, this.cfg, tool, sig, fam);
    this.save();
    return undefined;
  }

  after(sessionID: string, tool: string, args: Record<string, unknown>, output: unknown, failed = false): void {
    const s = this.session(sessionID);
    recordResult(s, tool, signature(tool, args, this.root), resultText(output), failed);
    this.save();
  }

  /** Red de seguridad fiable: archivos cambiados según git que violan el alcance. */
  gitCheck(): string[] {
    this.reload();
    try {
      // Un git colgado (index.lock viejo, FS de red) no debe congelar al agente.
      const out = execFileSync("git", ["status", "--porcelain", "-uall"], {
        cwd: this.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      const changed = out
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""))
        .filter((p) => !p.startsWith(".opencode/"));
      const bad = gitViolations(this.cfg, changed);
      if (bad.length) this.log({ event: "git-violation", files: bad });
      return bad;
    } catch {
      return [];
    }
  }

  reset(sessionID?: string): void {
    if (sessionID) delete this.state.sessions[sessionID];
    else this.state = { sessions: {} };
    this.save();
  }

  status(sessionID?: string): string {
    const c = this.cfg;
    const lines = [
      `modo: ${c.mode} | repeticiones: ${c.maxConsecutiveRepeats} | ciclos hasta periodo ${c.cycleMaxPeriod}`,
      `fase: ${c.specFile ?? "(ninguna)"}`,
      `allowOnly: ${c.scope.allowOnlyGlobs.join(", ") || "-"}`,
      `deny: ${c.scope.denyGlobs.join(", ") || "-"}`,
    ];
    const ids = sessionID ? [sessionID] : Object.keys(this.state.sessions);
    for (const id of ids) {
      const s = this.state.sessions[id];
      if (s) lines.push(`sesión ${id}: ${s.entries.length} llamadas, ${s.blocks} bloqueos`);
    }
    for (const w of c.warnings) lines.push(`⚠ ${w}`);
    return lines.join("\n");
  }
}

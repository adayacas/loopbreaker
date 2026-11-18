import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Guard } from "../src/guard.js";
import { matchGlob } from "../src/glob.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { bashWrites, writtenPaths } from "../src/scope-validator.js";
import { signature } from "../src/loop-detector.js";
import { loadConfig, phaseCard } from "../src/config-loader.js";
import { LoopbreakerPlugin } from "../src/index.js";
import { buildConfig, parseGlobs, parsePositive, runWizard } from "../src/wizard.js";

function project(files: Record<string, string> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopbreaker-")));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  return root;
}
const S = "s1";

// ---------- glob ----------
test("glob: **, *, llaves y directorios", () => {
  assert.ok(matchGlob("src/db/a/b.ts", "src/db/**"));
  assert.ok(matchGlob("src/db/x.ts", "src/db/*.ts"));
  assert.ok(!matchGlob("src/db/a/x.ts", "src/db/*.ts"));
  assert.ok(matchGlob("a/b/c.test.ts", "**/*.test.ts"));
  assert.ok(matchGlob("c.test.ts", "**/*.test.ts"));
  assert.ok(matchGlob("x/y.json", "x/y.{json,yml}"));
  assert.ok(matchGlob("infra/main.tf", "infra/"));
  assert.ok(!matchGlob("infrastructure/a", "infra/**"));
});

// ---------- frontmatter ----------
test("frontmatter: mapas, listas y errores explícitos", () => {
  const fm = parseFrontmatter(`---
id: phase-01
goal: "Migrar DB"   # comentario
scope:
  denyGlobs:
    - src/frontend/**
  allowOnlyGlobs: [src/db/**, tests/db/**]
exitCriteria:
  - tests pasan
---
# cuerpo`) as any;
  assert.equal(fm.id, "phase-01");
  assert.equal(fm.goal, "Migrar DB");
  assert.deepEqual(fm.scope.denyGlobs, ["src/frontend/**"]);
  assert.deepEqual(fm.scope.allowOnlyGlobs, ["src/db/**", "tests/db/**"]);
  assert.deepEqual(fm.exitCriteria, ["tests pasan"]);
  assert.equal(parseFrontmatter("sin frontmatter"), null);
  assert.throws(() => parseFrontmatter("---\nesto no es yaml\n---\n"));
});

test("frontmatter: claves de primer nivel menos indentadas que la primera se rechazan", () => {
  // La primera clave sobre-indentada ancla el mapa: las siguientes, a nivel real,
  // antes se descartaban en silencio y el scope de la fase dejaba de aplicarse.
  assert.throws(
    () => parseFrontmatter("---\n  id: p1\nscope:\n  denyGlobs: [x]\n---\n"),
    /indentación/,
  );
});

// ---------- bucles ----------
test("bucle A-A-A se bloquea en la 3ª repetición idéntica", () => {
  const g = new Guard(project());
  const a = { command: "ls" };
  assert.equal(g.before(S, "bash", a), undefined);
  assert.equal(g.before(S, "bash", a), undefined);
  assert.match(g.before(S, "bash", a)!, /BLOQUEADO/);
});

test("también vigila herramientas de lectura (read/grep)", () => {
  const g = new Guard(project());
  const a = { filePath: "x.ts" };
  g.before(S, "read", a);
  g.before(S, "read", a);
  assert.match(g.before(S, "read", a)!, /BLOQUEADO/);
});

test("orden de claves y espacios no evaden la firma", () => {
  assert.equal(signature("bash", { a: 1, command: "ls  -la" }), signature("bash", { command: "ls -la", a: 1 }));
});

test("rutas absolutas dentro del proyecto == relativas", () => {
  const root = project();
  assert.equal(signature("read", { filePath: path.join(root, "a.ts") }, root), signature("read", { filePath: "a.ts" }, root));
});

test("ciclo A-B-A-B-A-B se bloquea", () => {
  const g = new Guard(project());
  const A = { command: "npm run build" };
  const B = { filePath: "log.txt" };
  let blocked: string | undefined;
  for (let i = 0; i < 3 && !blocked; i++) {
    blocked = g.before(S, "bash", A) ?? g.before(S, "read", B);
  }
  assert.match(blocked ?? "", /ciclo|BLOQUEADO/);
});

test("ciclo A-B con salidas distintas = progreso, no se bloquea", () => {
  const g = new Guard(project());
  const A = { command: "npm run build" };
  const B = { filePath: "log.txt" };
  for (let i = 0; i < 3; i++) {
    assert.equal(g.before(S, "bash", A), undefined, `A${i}`);
    g.after(S, "bash", A, `build ${i}: listo`);
    assert.equal(g.before(S, "read", B), undefined, `B${i}`);
    g.after(S, "read", B, `log ${i}: sin cambios`);
  }
  assert.equal(g.before(S, "read", B), undefined, "6ª llamada del ciclo con salidas cambiantes");
});

test("ciclo A-B con salidas idénticas sí se bloquea", () => {
  const g = new Guard(project());
  const A = { command: "npm run build" };
  const B = { filePath: "log.txt" };
  let blocked: string | undefined;
  for (let i = 0; i < 3 && !blocked; i++) {
    blocked = g.before(S, "bash", A);
    if (!blocked) g.after(S, "bash", A, "igual");
    if (!blocked) blocked = g.before(S, "read", B);
    if (!blocked) g.after(S, "read", B, "igual");
  }
  assert.match(blocked ?? "", /ciclo/);
});

test("falso positivo: npm test tras una edición NO es bucle (reset por escritura)", () => {
  const root = project({ ".loopbreaker.json": JSON.stringify({ maxConsecutiveRepeats: 3 }) });
  const g = new Guard(root);
  const t = { command: "npm test" };
  for (let i = 0; i < 6; i++) {
    assert.equal(g.before(S, "bash", t), undefined, `iteración ${i}`);
    g.after(S, "bash", t, "FAIL");
    const e = { filePath: "a.ts", oldString: String(i), newString: String(i + 1) };
    assert.equal(g.before(S, "edit", e), undefined);
    g.after(S, "edit", e, "ok");
  }
});

test("falso positivo: mismo comando con salida distinta = progreso", () => {
  const g = new Guard(project());
  const t = { command: "tail -n1 build.log" };
  for (let i = 0; i < 8; i++) {
    assert.equal(g.before(S, "bash", t), undefined, `iteración ${i}`);
    g.after(S, "bash", t, `línea ${i}`);
  }
});

test("mismo comando con MISMA salida sin escrituras sí se bloquea", () => {
  const g = new Guard(project());
  const t = { command: "npm test" };
  g.before(S, "bash", t);
  g.after(S, "bash", t, "FAIL");
  g.before(S, "bash", t);
  g.after(S, "bash", t, "FAIL");
  assert.match(g.before(S, "bash", t)!, /BLOQUEADO/);
});

test("escalada: tras hardStopAfter bloqueos el mensaje pasa a parada dura", () => {
  const g = new Guard(project({ ".loopbreaker.json": JSON.stringify({ hardStopAfter: 2 }) }));
  const a = { command: "ls" };
  g.before(S, "bash", a);
  g.before(S, "bash", a);
  const first = g.before(S, "bash", a)!;
  const second = g.before(S, "bash", a)!;
  const third = g.before(S, "bash", a)!;
  assert.doesNotMatch(first, /PARADA DURA/);
  assert.match(second + third, /PARADA DURA/);
});

test("umbral por herramienta", () => {
  const g = new Guard(project({ ".loopbreaker.json": JSON.stringify({ toolThresholds: { read: 5 } }) }));
  const a = { filePath: "x" };
  for (let i = 0; i < 4; i++) assert.equal(g.before(S, "read", a), undefined);
  assert.match(g.before(S, "read", a)!, /BLOQUEADO/);
});

test("sesiones aisladas", () => {
  const g = new Guard(project());
  const a = { command: "ls" };
  g.before("A", "bash", a);
  g.before("A", "bash", a);
  assert.equal(g.before("B", "bash", a), undefined);
});

test("el estado persiste entre instancias", () => {
  const root = project();
  const a = { command: "ls" };
  const g1 = new Guard(root);
  g1.before(S, "bash", a);
  g1.before(S, "bash", a);
  assert.match(new Guard(root).before(S, "bash", a)!, /BLOQUEADO/);
});

test("el estado persistido no guarda snippets de salida", () => {
  const root = project();
  const g = new Guard(root);
  const a = { command: "printenv" };
  g.before(S, "bash", a);
  g.after(S, "bash", a, "SECRET_TOKEN=abc123");
  const file = path.join(root, ".opencode/loopbreaker-state.json");
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /SECRET_TOKEN/);
  assert.match(raw, /resultHash/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("un estado viejo con snippets se sanea al cargar", () => {
  const root = project();
  const file = path.join(root, ".opencode/loopbreaker-state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ sessions: { s1: { epoch: 0, blocks: 0, entries: [{ sig: "bash:x", tool: "bash", epoch: 0, snippet: "SECRET" }] } } }),
  );
  new Guard(root);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /SECRET/);
});

test("un estado viejo 0644 se endurece al cargar", () => {
  const root = project();
  const file = path.join(root, ".opencode/loopbreaker-state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessions: {} }));
  fs.chmodSync(file, 0o644);
  new Guard(root);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("no escribe a través de symlinks en .opencode", () => {
  if (process.platform === "win32") return;
  const root = project();
  const target = path.join(root, "victim.txt");
  fs.writeFileSync(target, "original");
  fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
  fs.symlinkSync(target, path.join(root, ".opencode/loopbreaker-state.json"));
  const g = new Guard(root);
  g.before("symlink-session", "bash", { command: "echo hi" });
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});

test("el log no persiste la salida citada por estancamiento", () => {
  const root = project();
  const g = new Guard(root);
  const out = "SECRET_TOKEN=abc123 " + "x".repeat(60);
  for (let i = 0; i < 3; i++) {
    const a = { command: `rtk lint v${i}` };
    g.before(S, "bash", a);
    g.after(S, "bash", a, out);
  }
  assert.match(g.before(S, "bash", { command: "rtk lint v4" })!, /misma salida/);
  const file = path.join(root, ".opencode/loopbreaker.log.jsonl");
  const log = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(log, /SECRET_TOKEN/);
  assert.match(log, /«…»/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// ---------- alcance ----------
const scoped = () =>
  project({
    ".loopbreaker.json": JSON.stringify({ scope: { allowOnlyGlobs: ["src/db/**"], denyGlobs: ["src/db/secret/**"] } }),
  });

test("scope: dentro permite; fuera y deny bloquean (deny gana a allow)", () => {
  const g = new Guard(scoped());
  assert.equal(g.before(S, "edit", { filePath: "src/db/a.ts" }), undefined);
  assert.match(g.before(S, "write", { filePath: "src/frontend/a.ts" })!, /alcance/);
  assert.match(g.before(S, "write", { filePath: "src/db/secret/k.ts" })!, /prohibido/);
});

test("scope: escapes con ../ y rutas absolutas externas", () => {
  const root = scoped();
  const g = new Guard(root);
  assert.match(g.before(S, "write", { filePath: "src/db/../frontend/x.ts" })!, /alcance/);
  assert.match(g.before(S, "write", { filePath: "../fuera.ts" })!, /fuera del proyecto/);
  assert.match(g.before(S, "write", { filePath: "/etc/passwd" })!, /fuera del proyecto/);
});

test("scope: symlink que apunta fuera del alcance", () => {
  const root = scoped();
  fs.mkdirSync(path.join(root, "src/db"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/frontend"), { recursive: true });
  fs.symlinkSync(path.join(root, "src/frontend"), path.join(root, "src/db/link"));
  const g = new Guard(root);
  assert.match(g.before(S, "write", { filePath: "src/db/link/x.ts" })!, /alcance/);
});

test("archivos del guardián están protegidos por defecto", () => {
  const g = new Guard(project());
  for (const f of [".loopbreaker.json", ".engram/current_phase.lock", ".opencode/loopbreaker-state.json", ".engram/specs/phase-01.md"]) {
    assert.match(g.before(S, "write", { filePath: f })!, /protegido/, f);
  }
});

test("patch: valida todos los archivos del diff", () => {
  const g = new Guard(scoped());
  const patch = "*** Update File: src/db/a.ts\n@@\n*** Update File: src/frontend/b.ts\n@@";
  assert.match(g.before(S, "patch", { patchText: patch })!, /alcance/);
  assert.deepEqual(writtenPaths("patch", { patchText: "--- a/x.ts\n+++ b/x.ts\n" }), ["x.ts"]);
});

test("bash: detecta escrituras obvias (mejor esfuerzo)", () => {
  assert.deepEqual(bashWrites("echo hi > src/frontend/a.ts"), ["src/frontend/a.ts"]);
  assert.ok(bashWrites("cat x | tee out.txt").includes("out.txt"));
  assert.ok(bashWrites("sed -i 's/a/b/' src/x.ts").includes("src/x.ts"));
  assert.ok(bashWrites("rm -rf build").includes("build"));
  assert.ok(bashWrites("mv a.ts src/frontend/b.ts").includes("src/frontend/b.ts"));
  assert.deepEqual(bashWrites("ls -la 2>&1 | grep x"), []);
  const g = new Guard(scoped());
  assert.match(g.before(S, "bash", { command: "echo x > src/frontend/a.ts" })!, /alcance/);
  assert.equal(g.before(S, "bash", { command: "cat src/frontend/a.ts" }), undefined); // lectura libre
});

test("las lecturas no se limitan por alcance", () => {
  const g = new Guard(scoped());
  assert.equal(g.before(S, "read", { filePath: "src/frontend/a.ts" }), undefined);
});

// ---------- fase / configuración ----------
test("fase: lock + frontmatter define el alcance y gana a .loopbreaker.json", () => {
  const root = project({
    ".loopbreaker.json": JSON.stringify({ scope: { allowOnlyGlobs: ["src/**"] } }),
    ".engram/current_phase.lock": "2\n",
    ".engram/specs/phase-02.md": "---\nid: phase-02\ngoal: API\nscope:\n  allowOnlyGlobs:\n    - src/api/**\n---\n",
  });
  const g = new Guard(root);
  assert.equal(g.before(S, "edit", { filePath: "src/api/x.ts" }), undefined);
  assert.match(g.before(S, "edit", { filePath: "src/db/x.ts" })!, /alcance/);
});

test("cambiar de fase en caliente no requiere reinicio", () => {
  const root = project({
    ".engram/current_phase.lock": "1",
    ".engram/specs/phase-01.md": "---\nscope:\n  allowOnlyGlobs: [a/**]\n---\n",
    ".engram/specs/phase-02.md": "---\nscope:\n  allowOnlyGlobs: [b/**]\n---\n",
  });
  const g = new Guard(root);
  assert.match(g.before(S, "edit", { filePath: "b/x" })!, /alcance/);
  fs.writeFileSync(path.join(root, ".engram/current_phase.lock"), "2");
  assert.equal(g.before(S, "edit", { filePath: "b/x" }), undefined);
});

test("config inválida: el anti-bucles sigue activo y se reporta el error", () => {
  const root = project({ ".loopbreaker.json": "{ esto no es json" });
  const g = new Guard(root);
  assert.match(g.status(), /inválido/);
  const a = { command: "ls" };
  g.before(S, "bash", a);
  g.before(S, "bash", a);
  assert.match(g.before(S, "bash", a)!, /BLOQUEADO/);
});

test("frontmatter inválido o fase inexistente: se avisa, no se rompe", () => {
  const bad = new Guard(project({ ".engram/current_phase.lock": "1", ".engram/specs/phase-01.md": "---\nmal formado\n---\n" }));
  assert.match(bad.status(), /inválido/);
  const missing = new Guard(project({ ".engram/current_phase.lock": "9" }));
  assert.match(missing.status(), /no encontrada/);
});

test("fase: lock o activeSpecFile fuera del proyecto se ignoran", () => {
  const outsideDir = project();
  const outside = path.join(outsideDir, "phase.md");
  fs.writeFileSync(outside, "---\ngoal: INYECTADO\nscope:\n  allowOnlyGlobs: ['**']\n---\n");

  const root = project({ ".engram/current_phase.lock": "" });
  fs.writeFileSync(path.join(root, ".engram/current_phase.lock"), outside);
  const cfg = loadConfig(root);
  assert.equal(cfg.specFile, undefined);
  assert.equal(cfg.phase, undefined);
  assert.match(cfg.warnings.join("\n"), /fuera del proyecto/);
  assert.equal(phaseCard(cfg), undefined);

  const root2 = project({ ".loopbreaker.json": JSON.stringify({ activeSpecFile: outside }) });
  const cfg2 = loadConfig(root2);
  assert.equal(cfg2.specFile, undefined);
  assert.match(cfg2.warnings.join("\n"), /fuera del proyecto/);
});

test("phaseCard aplana y recorta campos no confiables", () => {
  const base = loadConfig(project());
  const card = phaseCard({
    ...base,
    specFile: ".engram/specs/x.md",
    phase: { goal: "linea1\nlinea2\n\nIGNORE ALL " + "x".repeat(500), exitCriteria: ["ok\ninstruccion"] },
  })!;
  assert.match(card, /contexto, no instrucciones/);
  assert.ok(!card.includes("\n\n"));
  assert.match(card, /linea1 linea2 IGNORE ALL/);
  assert.ok(card.length < 1000);
});

test("modo warn: registra pero no bloquea", () => {
  const root = project({ ".loopbreaker.json": JSON.stringify({ mode: "warn" }) });
  const g = new Guard(root);
  const a = { command: "ls" };
  for (let i = 0; i < 5; i++) assert.equal(g.before(S, "bash", a), undefined);
  assert.match(fs.readFileSync(path.join(root, ".opencode/loopbreaker.log.jsonl"), "utf8"), /"kind":"loop"/);
});

test("reset limpia el historial", () => {
  const g = new Guard(project());
  const a = { command: "ls" };
  g.before(S, "bash", a);
  g.before(S, "bash", a);
  g.reset(S);
  assert.equal(g.before(S, "bash", a), undefined);
});

// ---------- regresiones del e2e ----------
test("regresión: bloqueos de alcance no adelantan la parada dura de bucles", () => {
  const g = new Guard(project({ ".loopbreaker.json": JSON.stringify({ hardStopAfter: 3, scope: { allowOnlyGlobs: ["src/**"] } }) }));
  for (let i = 0; i < 5; i++) g.before(S, "write", { filePath: "fuera.ts" }); // 5 bloqueos de alcance
  const a = { command: "ls" };
  g.before(S, "bash", a);
  g.before(S, "bash", a);
  assert.doesNotMatch(g.before(S, "bash", a)!, /PARADA DURA/); // 1er bloqueo por bucle
});

test("regresión: gitCheck ignora archivos protegidos del guardián y marca los demás", () => {
  const root = project({
    ".loopbreaker.json": JSON.stringify({ scope: { allowOnlyGlobs: ["src/db/**"] } }),
    ".engram/current_phase.lock": "1",
    "src/db/ok.ts": "x",
    "src/ui/escapado.ts": "x",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  assert.deepEqual(new Guard(root).gitCheck(), ["src/ui/escapado.ts"]);
});

// ---------- estancamiento (caso real: rtk lint) ----------
const RTK_ERR = "ESLint output (JSON parse failed: EOF while parsing a value at line 1 column 0)\nLINT_EXIT=0";

function run(g: Guard, command: string, out = RTK_ERR): string | undefined {
  const a = { command };
  const r = g.before(S, "bash", a);
  if (!r) g.after(S, "bash", a, out);
  return r;
}

test("caso real: rtk lint repetido con variantes se frena aunque la firma cambie", () => {
  const g = new Guard(project());
  const variants = [
    "rtk lint apps/api/src apps/api/test 2>&1 | tail -5; echo \"LINT_EXIT=$?\"",
    "rtk lint apps/api/src apps/api/test 2>&1 | tail -10; echo \"LINT_EXIT=$?\"",
    "cd apps/api && rtk lint src test 2>&1 | tail -3; echo \"LINT_EXIT=$?\"",
    "rtk lint apps/api 2>&1 | tail -20; echo \"LINT_EXIT=$?\"",
  ];
  assert.equal(run(g, variants[0]!), undefined);
  assert.equal(run(g, variants[1]!), undefined);
  assert.equal(run(g, variants[2]!), undefined);
  const blocked = run(g, variants[3]!);
  assert.match(blocked ?? "", /BLOQUEADO/);
  assert.match(blocked!, /misma salida/);
  assert.match(blocked!, /JSON parse failed/); // cita la salida repetida
});

test("estancamiento: la misma salida pegada se frena aunque cambie TODO el comando de la familia", () => {
  const g = new Guard(project());
  const out = "Error: connect ECONNREFUSED 127.0.0.1:5432 (la base de datos no responde)";
  assert.equal(run(g, "psql -c 'select 1'", out), undefined);
  assert.equal(run(g, "psql -c 'select 2'", out), undefined);
  assert.equal(run(g, "psql -h localhost -c 'select 3'", out), undefined);
  assert.match(run(g, "psql -p 5433 -c 'select 4'", out) ?? "", /misma salida/);
});

test("estancamiento: salidas distintas = progreso", () => {
  const g = new Guard(project());
  for (let i = 0; i < 8; i++) {
    assert.equal(run(g, `rtk lint file${i}.ts`, `error numero ${i}: algo distinto en el archivo file${i}.ts`), undefined, `i=${i}`);
  }
});

test("estancamiento: salidas cortas/genéricas no cuentan (mkdir, cd, ok)", () => {
  const g = new Guard(project());
  for (let i = 0; i < 8; i++) assert.equal(run(g, `mkdir d${i}`, ""), undefined);
  for (let i = 0; i < 8; i++) assert.equal(run(g, `git add f${i}`, "ok"), undefined);
});

test("estancamiento: familias distintas no se mezclan", () => {
  const g = new Guard(project());
  const out = "x".repeat(60);
  assert.equal(run(g, "ls a", out), undefined);
  assert.equal(run(g, "cat b", out), undefined);
  assert.equal(run(g, "grep c", out), undefined);
  assert.equal(run(g, "find d", out), undefined);
});

test("estancamiento: una edición exitosa entre intentos lo reinicia", () => {
  const g = new Guard(project());
  for (let i = 0; i < 6; i++) {
    assert.equal(run(g, `rtk lint v${i}`), undefined, `intento ${i}`);
    const e = { filePath: "a.ts", oldString: String(i), newString: String(i + 1) };
    assert.equal(g.before(S, "edit", e), undefined);
    g.after(S, "edit", e, "ok");
  }
});

test("estancamiento: umbral configurable (stagnationRepeats)", () => {
  const g = new Guard(project({ ".loopbreaker.json": JSON.stringify({ stagnationRepeats: 5 }) }));
  for (let i = 0; i < 5; i++) assert.equal(run(g, `rtk lint v${i}`), undefined, `i=${i}`);
  assert.match(run(g, "rtk lint v5") ?? "", /misma salida/);
});

test("estancamiento: aplica también a read/grep con salida idéntica", () => {
  const g = new Guard(project());
  const out = "no matches found for the given pattern in the searched directories";
  for (let i = 0; i < 3; i++) {
    const a = { pattern: `foo${i}` };
    assert.equal(g.before(S, "grep", a), undefined, `i=${i}`);
    g.after(S, "grep", a, out);
  }
  assert.match(g.before(S, "grep", { pattern: "foo3" }) ?? "", /misma salida/);
});

// ---------- instalador ----------
import { ensureGitignore, install, uninstall, init, configFile, PINNED_PLUGIN } from "../src/installer.js";

test("install: crea config si no existe, pinea, es idempotente y uninstall revierte", () => {
  const dir = path.join(project(), "cfg");
  const r1 = install(dir);
  assert.ok(r1.ok && r1.changed);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile(dir), "utf8")).plugin, [PINNED_PLUGIN]);
  const r2 = install(dir);
  assert.ok(r2.ok && !r2.changed);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile(dir), "utf8")).plugin, [PINNED_PLUGIN]);
  const r3 = uninstall(dir);
  assert.ok(r3.ok && r3.changed);
  assert.equal(JSON.parse(fs.readFileSync(configFile(dir), "utf8")).plugin, undefined);
});

test("install: conserva el resto de la config y otros plugins, y hace copia", () => {
  const dir = project({ "opencode.json": JSON.stringify({ model: "x/y", plugin: ["otro-plugin"] }) });
  const r = install(dir);
  assert.ok(r.ok && r.changed);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.model, "x/y");
  assert.deepEqual(cfg.plugin, ["otro-plugin", PINNED_PLUGIN]);
  assert.ok(fs.existsSync(path.join(dir, "opencode.json.loopbreaker.bak")));
});

test("install: reemplaza una entrada sin versión y --no-pin la deja pelada", () => {
  const dir = project({ "opencode.json": JSON.stringify({ plugin: ["otro-plugin", "@adayacas/loopbreaker"] }) });
  assert.ok(install(dir).changed);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8")).plugin, ["otro-plugin", PINNED_PLUGIN]);

  const dir2 = project();
  assert.ok(install(dir2, false).changed);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir2, "opencode.json"), "utf8")).plugin, ["@adayacas/loopbreaker"]);
});

test("install: no reescribe un archivo con comentarios ni uno inválido", () => {
  const withComments = '{\n  // mi modelo\n  "model": "x/y"\n}\n';
  const dir = project({ "opencode.json": withComments });
  const r = install(dir);
  assert.ok(!r.ok && !r.changed);
  assert.equal(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"), withComments);
  const bad = project({ "opencode.json": "{ roto" });
  assert.ok(!install(bad).ok);
  assert.equal(fs.readFileSync(path.join(bad, "opencode.json"), "utf8"), "{ roto");
});

test("init: crea .loopbreaker.json sin sobrescribir y acepta config", () => {
  const dir = project();
  assert.ok(init(dir).changed);
  assert.ok(!init(dir).changed);

  const dir2 = project();
  const cfg = { mode: "warn" as const, maxConsecutiveRepeats: 5, stagnationRepeats: 2, hardStopAfter: 1, scope: { allowOnlyGlobs: ["src/**"], denyGlobs: [] } };
  assert.ok(init(dir2, cfg).changed);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir2, ".loopbreaker.json"), "utf8")), cfg);
});

test("ensureGitignore: crea, agrega y es idempotente", () => {
  const dir = project({ ".gitignore": "dist/\n" });
  assert.ok(ensureGitignore(dir).changed);
  assert.ok(!ensureGitignore(dir).changed);
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "dist/\n.opencode/\n");

  const empty = project();
  assert.ok(ensureGitignore(empty).changed);
  assert.equal(fs.readFileSync(path.join(empty, ".gitignore"), "utf8"), ".opencode/\n");
});

test("wizard: normaliza números y globs, y arma la config", () => {
  assert.equal(parsePositive("5", 3), 5);
  assert.equal(parsePositive("1", 3), 3);
  assert.equal(parsePositive("x", 3), 3);
  assert.deepEqual(parseGlobs(" src/**, tests/** ,, "), ["src/**", "tests/**"]);
  assert.deepEqual(buildConfig({ mode: "warn", maxConsecutiveRepeats: 4, stagnationRepeats: 2, hardStopAfter: 1 }), {
    mode: "warn",
    maxConsecutiveRepeats: 4,
    stagnationRepeats: 2,
    hardStopAfter: 1,
  });
  assert.deepEqual(buildConfig({ mode: "block", maxConsecutiveRepeats: 3, stagnationRepeats: 3, hardStopAfter: 3, allowOnlyGlobs: ["src/**"] }).scope, {
    allowOnlyGlobs: ["src/**"],
    denyGlobs: [],
  });
});

test("wizard: con defaults devuelve una instalación pineada", async () => {
  const choices = await runWizard(project(), { question: async () => "" }, "global");
  assert.deepEqual(choices, { target: "global", pin: true, gitignore: true, config: undefined });
});

test("el plugin expone loopbreaker_status sin @opencode-ai/plugin", async () => {
  const plugin = await LoopbreakerPlugin({ directory: project() });
  const tool = (plugin as any).tool?.loopbreaker_status;
  assert.equal(typeof tool.execute, "function");
  assert.match(String(await tool.execute({}, { sessionID: S })), /modo:/);
});

test("lib: expone la API programática vía el subpath ./lib", async () => {
  const subpath = "@adayacas/loopbreaker/lib";
  const lib: any = await import(subpath);
  assert.equal(typeof lib.Guard, "function");
  assert.equal(typeof lib.loadConfig, "function");
  assert.equal(typeof lib.phaseCard, "function");
  assert.equal(typeof lib.parseFrontmatter, "function");
});

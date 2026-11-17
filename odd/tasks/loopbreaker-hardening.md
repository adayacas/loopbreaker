# Loopbreaker hardening

Objective: close the P0 security/reliability issues and add an install wizard for optional config. Branch: `main` (pushed to `origin`). Delivery: single change set. Test runner: `npm test`.

## Specs

- S1 — Tool output must not be persisted to disk. The state file and log must not contain output snippets; state/log files are created with owner-only permissions; legacy state snippets are sanitized on load. User quote: "Fuga de datos a disco — el único con impacto real. El guardián persiste los primeros 120 caracteres de la salida de cada herramienta en .opencode/.aeg-state.json (loop-detector.js:121, snippet = text.slice(0, 120))."
- S2 — Installation pins the package version by default and replaces an existing unpinned entry. `--no-pin` opts out. User quote: "Pinealo: \"@adayacas/loopbreaker@0.2.0\"."
- S3 — `loopbreaker_status` is available without `@opencode-ai/plugin`; no silent dynamic-import failure. User quote: "aeg_status no está disponible como tool. El peer @opencode-ai/plugin no existe en el node_modules del paquete..."
- S4 — A phase lock or `activeSpecFile` cannot resolve outside the project root. User quote: ".engram/current_phase.lock puede apuntar a una ruta absoluta fuera del repo: resolveSpecPath hace path.resolve(root, ref) sin constrain y readSpec la lee."
- S5 — Phase-card fields are sanitized, length-capped, and clearly delimited as repository data, not instructions. User quote: "El goal/exitCriteria del frontmatter se inyecta verbatim en el system prompt en cada request, sin truncar ni escapar."
- S6 — `loopbreaker install` offers a short wizard for optional configuration (target, pin, anti-loop thresholds, optional scope, project `.gitignore`), with safe defaults and `--yes` for non-interactive use.
- S7 — All runtime names are `loopbreaker`; the installed 0.2.0 `aeg` names must be replaced by publishing and reinstalling 0.3.0. User quote: "Anteriormente el proyecto se llamaba aeg ... ahora todo debe quedar loopbreaker."
- S8 — Docs describe the real security posture: the scope guard is a reminder, not a sandbox; specs are a trust boundary; state/log are sensitive and gitignored.

## Tasks

- T1 — state/log privacy — S1 — inline — done (state serialization omits snippets, log redacts quoted output, 0600, legacy load sanitizes)
- T2 — pinned install + replace unpinned — S2 — inline — done (`PINNED_PLUGIN`, replaces existing entry, `--no-pin`)
- T3 — status tool without peer — S3 — inline — done (structural tool object; peer removed)
- T4 — confine spec path to repo — S4 — inline — done (`toRel` guard; outside warning)
- T5 — sanitize phase card — S5 — inline — done (one-line, caps, data boundary)
- T6 — install wizard — S6 — inline — done (readline wizard, `--yes` defaults, gitignore step)
- T7 — docs + tests — S7, S8 — inline — done (README, 51 tests)
- T8 — verify suite and manual install — all — inline — done (53/53; temp project install/init/status; mode 600; no snippets; symlink write refused)

## Log

- L1 (user request, verbatim): "- Anteriormente el proyecto se llamaba aeg, por eso encuentras variables y bloques de codigo que lo mencionan, ahora todo debe quedar loopbreaker
- Revisa estas mejoras:
1. Fuga de datos a disco — el único con impacto real. El guardián persiste los primeros 120 caracteres de la salida de cada herramienta en .opencode/.aeg-state.json (loop-detector.js:121, snippet = text.slice(0, 120)). Ese archivo está en modo 644 y no está en .gitignore: git status lo muestra como ??, así que un git add -A commitea snippets de outputs que pueden incluir tokens, env vars o credenciales impresas por comandos. Verificado: el archivo actual ya contiene fragmentos de mis comandos de esta sesión. Fix de una línea: .opencode/ o .opencode/.aeg-state.json en .gitignore.
2. El guardián de alcance no es un control de seguridad, es un recordatorio. Lo dice el propio README y el código lo confirma: bashWrites() es heurística de regex (scope-validator.js:76-105) — se evade con variables, node -e, git checkout, npm install, subshells. La \"red de seguridad\" por git solo loguea, no bloquea (guard.js:113-125), y excluye .opencode/. Solo valida 4 tools de escritura (WRITE_TOOLS, loop-detector.js:3). No lo uses como límite de autorización ni con repos no confiables.
3. Cadena de suministro. El plugin está declarado sin versión (\"@adayacas/loopbreaker\" en opencode.json:769) y corre in-process con todos los privilegios del agente sobre cada tool call. La 0.2.0 actual tiene hash de integridad en el lock del cache, pero cualquier publish futuro se ejecuta en el próximo arranque sin que lo revises. Pinealo: \"@adayacas/loopbreaker@0.2.0\".
4. Menor — path traversal + prompt injection. .engram/current_phase.lock puede apuntar a una ruta absoluta fuera del repo: resolveSpecPath hace path.resolve(root, ref) sin constrain y readSpec la lee (config-loader.js:48-60). El goal/exitCriteria del frontmatter se inyecta verbatim en el system prompt en cada request, sin truncar ni escapar (config-loader.js:110-123). Con un repo malicioso eso es inyección indirecta de instrucciones. Solo aplica si el lock/spec viene de contenido que no controlás.
Lo que está bien, para no alarmar de más: cero llamadas de red en todo dist/ (no hay fetch, http, net), sin eval, y git se invoca con execFileSync(\"git\", [...]) sin shell ni interpolación. No exfiltra nada.
¿Te agrego la línea al .gitignore?"
- L2 (user request, verbatim): "Dime que entiendes y dame un plan de mejora que incluya un wizard sencillo a la hora de instalar el plugin para las configuraciones opcionales, para que el usuario tenga posibilidad de modificar detalles"
- L3 (user confirmation): "Yo confirmo"
- L4 (user approval to start): "Si"
- Decision: source 0.3.0 is already renamed; installed cache 0.2.0 is the source of `aeg` names. Fix is publish 0.3.0 + reinstall pinned.
- Decision: `@opencode-ai/plugin` `tool()` is identity in 1.19.5 and 0.15.31, so the status tool can be returned structurally and the peer dependency removed.
- Decision: `install --project` only writes `./opencode.json`; it does not install `.opencode/node_modules`.
- Decision: `.gitignore` prevents commits, not disk exposure; real fix is not persisting output + 0600.
- Baseline: `npm test` 41/41 passing.
- Workspace started without `.git`; it was initialized before pushing to `origin/main`.
- Implementation: `npm test` 53/53 passing. Manual check in a temp project: `install --project --yes` replaced an unpinned entry with `@adayacas/loopbreaker@0.3.0`, created `.gitignore` with `.opencode/`, `init` wrote the default config, and `status` read it. New tests cover state/log redaction, legacy sanitization, 0644 hardening, symlink refusal, spec traversal, phase-card caps, pinned install, gitignore, wizard defaults, and the status tool without the peer. `npm pack --dry-run` includes `dist/src/wizard.js` and no tests.
- Git: initialized the local repo and pushed the source to `origin/main` on GitHub. The remote had only an initial `LICENSE` commit; that LICENSE was preserved.
- Pending: publish 0.3.0 and reinstall so the running 0.2.0 `aeg` cache is replaced (user-owned release step; npm requires 2FA).

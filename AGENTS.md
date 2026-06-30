# Repository Instructions

## Project Shape
- This repository root is the project workspace. Do not assume it is only a wrapper around `.ai/`.
- The `.ai/` directory is the required AI delivery operating system for this repo. Follow the workflows, standards, roles, commands, templates, and schemas in `.ai/` when completing work here.
- Application/product code may be added outside `.ai/`. Treat that code as the primary implementation area unless the task explicitly asks to change the AI delivery system itself.
- Nothing has been implemented in this repo yet; preserve the delivery lifecycle so future work starts from a clean, documented baseline.

## Required Operating Context
- Before non-trivial implementation, consult `.ai/README.md` and the relevant files under `.ai/workflows/`, `.ai/standards/`, `.ai/roles/`, and `.ai/commands/`.
- Use `.ai/commands/command-protocol.md` for slash-command semantics and lifecycle transitions.
- Use `.ai/standards/` as the quality bar for engineering, testing, security, accessibility, performance, observability, backend, frontend, API design, and UI/UX work.
- Use `.ai/templates/` for durable planning, requirements, test, review, and approval artifacts when a feature workflow calls for them.
- Keep `.ai/schemas/` compatibility when editing any lifecycle state, registry, config, or approval JSON.

## Lifecycle Constraints
- Default approval policy is `human_required` for requirements, plan, and implementation gates unless repo config says otherwise.
- Agents may record approvals after a human gives them, but must never self-approve a `human_required` gate.
- Do not begin implementation for non-trivial work before the required requirements and plan gates are satisfied.
- Treat feature state and approval files as durable project state, not scratch notes.

## Commands
- If working on the AI delivery CLI or standards package inside `.ai/`, run checks from `.ai/`: `npm run check`.
- Equivalent direct CLI checks from `.ai/`: `node --check bin/ai-delivery.js` and `node bin/ai-delivery.js help >/dev/null`.
- From the repo root, local AI delivery CLI runs use `node .ai/bin/ai-delivery.js <command>`.
- CLI commands are `init`, `sync`, `feature`, `loop`, `doctor`, `help`, and `version`; no bare `/start-feature` CLI subcommand exists.
- Use `--dry-run` before `init`, `sync`, `feature`, or loop setup when previewing generated files.

## Editing Guidance
- Do not modify `.ai/` unless the task is about AI delivery workflows, standards, templates, schemas, roles, commands, or the CLI itself.
- When generated or lifecycle artifacts are required, update them consistently with `.ai/README.md` and `.ai/commands/command-protocol.md`.
- Prefer the smallest correct change and preserve existing project state.

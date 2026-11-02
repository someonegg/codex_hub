# Repository collaboration rules

- UI changes must include regenerated README screenshots and animations affected by the change.

## Documentation discipline

- Keep `docs/usage.md` and `docs/development.md` concise, task-oriented guides for users and contributors respectively; link to technical details rather than embedding them.
- Keep valuable implementation details, contracts, and runtime guarantees in `docs/technical-reference.md`; avoid duplicating them across guides.
- Change the root `README.md` sparingly, only when needed for the project overview, quick start, or essential user-facing information. Prefer links to focused documentation.
- Update existing documentation when behavior changes; do not add documentation for every code change.

## Session adapter boundaries

- Shared services treat native session IDs as opaque strings: check presence, but delegate format validation to the owning adapter. Never impose Codex UUID formats, CLI arguments, or storage conventions on shared runtime or management code. Adapter preflight and execution must reuse the same native identity rules.
- Session operations are limited to a unified create/resume launch, archive, delete, and exit. Worktree and YOLO are launch options, not separate operations. Identity validation, directory resolution, and exit steps are supporting adapter contracts. Before adding a business capability, explicitly establish its abstraction boundary.
- Keep launch working directory separate from project association: creation defaults to the selected project directory and may explicitly use another working directory while retaining the selected project association; resume uses an available original working/project directory while retaining the original project association, including worktree sessions.

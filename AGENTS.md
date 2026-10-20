# Repository collaboration rules

- UI changes must include regenerated README screenshots and animations affected by the change.
- PR titles, PR descriptions, and commit messages must be written in English. After pushing new commits, review and update the PR description to reflect the final changes and validation results.
- Once a PR is open, automatically commit and push subsequent changes for that PR after validation, unless the user says otherwise.
- After confirming a PR has merged, update the local main branch and remove the temporary branches and worktrees associated with that PR. Preserve uncommitted work; do not force cleanup or remove unrelated branches or worktrees.

## Session adapter boundaries

- Shared services treat native session IDs as opaque strings: check presence and source-local uniqueness, but delegate format validation to the owning adapter. Never impose Codex UUID formats, CLI arguments, or storage conventions on shared runtime or management code. Adapter preflight and execution must reuse the same native identity rules.
- Session operations are limited to a unified create/resume launch, archive, delete, and exit. Worktree and YOLO are launch options, not separate operations. Identity validation, directory resolution, and exit steps are supporting adapter contracts. Before adding a business capability, explicitly establish its abstraction boundary.
- Keep launch working directory separate from project association: creation starts in the selected project; resume uses an available original working/project directory while retaining the original project association, including worktree sessions.

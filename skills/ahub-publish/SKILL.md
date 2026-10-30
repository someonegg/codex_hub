---
name: ahub-publish
description: Publish static pages or review diffs to an existing Codex Hub. Use only when the user explicitly requests `ahub-publish` by name.
---

# Publish to Codex Hub

Publish static pages and review diffs using an existing Hub. Do not manage or probe services, or configure network access.

## Check the environment

- Check `command -v ahub-cli` and read/write access to `~/.codex-hub/hosting`. If storage does not exist yet, check write and search access to its nearest existing parent; publication creates storage. If a custom Hub data root is already configured, pass `--home-dir /absolute/path/to/hub-root` to every resource command; storage is its `hosting/` subdirectory.
- If the command or storage is unavailable, report the blocker and follow environment approval rules. Do not install tools, create alternative storage, or start services on your own.
- Commands write directly to local storage; success does not verify browser access. Do not check HTTP, ports, or processes. If hosting is disabled, ask the user to maintain the existing Hub configuration.

## Publish pages

1. Prepare a static directory containing only the deliverable, with a regular file named `index.html` as its entry point. Hub does not build projects, proxy development servers, or run backends. Pages that depend on local APIs cannot be hosted directly. Replace those dependencies with embedded or static data within the authorized task scope, or explain the blocker.
2. Inspect the entire directory, including hidden files, nested symbolic links, and special files. Exclude secrets, environment configuration, repository metadata, and other content that should not be published. Publication copies the entire directory; nested symbolic links and special files are rejected. The source directory and hosting storage must not contain one another.
3. Use relative asset paths. Hub does not rewrite root-relative paths or provide SPA routing fallback. External resources depend on the viewer's network and cross-origin policies. Review included scripts and code before publishing: hosted pages have the same-origin authority as Hub and must be treated as trusted code.
4. Specify the actual project directory, a stable name, and a title, and read the JSON result:

   ```bash
   ahub-cli page publish /absolute/path/to/static-output --project /absolute/path/to/project --name review-report --title "Review report" --json
   ```

   For custom storage, append the confirmed `--home-dir` option. Both the source and project directories must exist. For deliverables generated in a worktree, pass the original project path as `--project`, rather than the worktree path. Project association uses the project's canonical real path.

5. When updating the same deliverable, reuse the project and `--name`, even if the output directory changes. This preserves the page URL and creates a new snapshot. Omitting `--title` preserves the previous title. To check an existing resource's identity, use `ahub-cli page list --json` to read storage metadata without probing the service.

## Publish review diffs

Choose the comparison scope from the user's review goal, such as unstaged changes, staged changes, or changes relative to a particular commit or branch. Do not impose one comparison baseline on every task. Check the diff for information that should not be published.

Write the selected comparison as a Git unified diff to a unique temporary file, then publish it. For example, use the following only when reviewing tracked-file changes relative to `HEAD`:

```bash
review_diff=$(mktemp)
git diff --no-ext-diff --no-color HEAD -- > "$review_diff"
ahub-cli diff publish "$review_diff" --title "Change review" --json
```

Before publishing, confirm that diff generation succeeded and that the content matches the intended scope. Ordinary `git diff` excludes untracked files. If they belong in the review, explicitly generate their patches and verify the result. Do not claim that an ordinary diff covers them or stage files without authorization for this purpose. For custom storage, also append `--home-dir`.

Each diff publication creates an independent resource; it does not use the project-and-name update semantics of pages. After success, you may delete the temporary source file created for this operation. Deleting it does not delete the published copy.

## Deliver and clean up

- Read `url` from the successful command's JSON result and use it unchanged as the target of a relative Markdown link, such as `[View report](returned url)`. Escape the link title correctly. Do not guess IDs, hosts, ports, or addresses. Report failures without inventing links.
- Retain the returned resource `id` when needed for management.
- Describe the published scope and note that the copy survives source removal and does not expire automatically.
- Treat published diffs as temporary review artifacts. Once the user confirms the review is complete with no remaining questions, proactively delete the relevant diff without asking for separate cleanup approval. Keep it while review questions remain open or if the user requests retention.
- Retain published pages unless the user requests deletion or an agreed cleanup scope applies.
- To delete authorized published resources, use `ahub-cli page delete <id> --json` or `ahub-cli diff delete <id> --json`. Continue using the same `--home-dir` for custom storage. Deleting a page also deletes all its snapshots; verify the target and authorization scope first.

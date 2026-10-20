# Upload validation

Validated on macOS on 2026-10-19.

- Unit tests cover upload contents, UUID uniqueness, safe extensions, absolute paths,
  default directory reuse, custom nested directories, declared and chunked size
  limits, unwritable directories, injected disk-write failures, and cleanup after a
  disconnected sender.
- Composer tests cover clipboard files, ordinary file drops, ordered insertion,
  selection replacement, focus/caret restoration, frozen Send/Handoff, failure
  recovery, text-only paste, size preflight, and abort/late-result isolation.
- Type checking, production build, lint, and formatting checks pass. The existing
  real tmux and Codex management integration suites pass.
- Chromium browser automation used the system Clipboard API to write a PNG and
  pasted it with the browser keyboard shortcut. The browser issued a nonempty
  binary upload and inserted a quoted path. A DataTransfer containing two ordinary
  files verified drop ordering and insertion between existing words. Upload
  responses were mocked for these browser checks; filesystem behavior is covered
  by real HTTP tests.
- Codex CLI v0.163.0 in an isolated tmux server recognized a pasted, JSON-quoted
  PNG path as `[Image #1]`. Directories containing spaces, double quotes, and single
  quotes were checked. This did not submit a prompt or make a model request.
- README interaction/mobile screenshots and the introduction animation were
  regenerated with the repository capture scripts. Desktop interaction and mobile
  catalog captures were byte-identical to the existing assets.

## Remaining manual coverage

Native screenshot-tool clipboard contents, Finder drag-and-drop, Finder Copy/Paste,
Safari, and model-driven reading of an ordinary file have not been verified in this
run. Generated Clipboard API content and synthetic DataTransfer drops do not prove
those OS/browser integrations. No browser compatibility claim is made for Finder
Copy/Paste: files upload when the browser supplies File objects, and text-only
clipboard data remains ordinary text.

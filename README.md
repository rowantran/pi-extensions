# Pi extensions

Personal extensions packaged for the Pi coding agent.

## Install

```bash
pi install git:github.com/rowantran/pi-extensions
```

Update the installed package with:

```bash
pi update --extensions
```

Pi manages the checkout under `~/.pi/agent/git/`. Keep development checkouts
outside `~/.pi/agent/extensions` to prevent duplicate extension loading.

The machine-local Isara provider is intentionally excluded from this repository.

## Background agents

Background agents run Pi in RPC mode with a separate, saved conversation. New
agents inherit the parent's model and thinking level and use normal Pi discovery
for providers, extensions, skills, and prompt templates, subject to Pi's usual
settings and project trust rules. No provider-specific path is required.

### Storage and recovery

Each child saves its session under `<child cwd>/.pi/subagents/`. These files stay
outside Pi's normal session directory, so they do not appear in the default
`pi --resume` or `/resume` lists. Add `.pi/subagents/` to your project's
`.gitignore`; transcripts can contain private code and tool output. New session
files use owner-only permissions.

`background_start` returns a stable `agent-<session UUID>` ID, `sessionId`, and
absolute `sessionFile` path. The parent also saves the reference before launching
the child. The child's initial task, model, thinking level, and parent session
path are written before launch, rather than waiting for its first response.

When the parent session restarts, the extension restores references without
automatically running the children. Resume explicitly:

```json
{"id":"agent-<session UUID>","message":"Continue from the saved work. Check what completed before repeating any changes."}
```

Pass those arguments to `background_send`. Its `id` can also be the absolute
`.jsonl` session path, including from a different parent or after an activity was
pruned from memory. Resumption uses the child's saved model and thinking level,
not the resumed parent's current settings. Status and output tools accept the
same IDs and paths.

Idle child processes are released after five minutes, but their sessions remain
on disk. Parent shutdown stops its child processes without deleting their
sessions. Automatic pruning and `background_forget` only remove agent tracking
and runtime resources; they never delete child session files. Delete those files
manually when you no longer need the history, with no child using them.

### Writer safety and crash limits

A small runner takes a writer lock before Pi opens the saved session and holds it
until that child process exits. A second background agent cannot reopen a session
owned by a live process. After a hard crash, the lock can take ten seconds to
expire; retry `background_send` after that interval. Use `background_send` for
recovery: bare `pi --session` does not honor this extension's lock. Lock recovery
assumes local processes on the same host; it is not a distributed worker system.

Recovery restores completed saved messages, not an exact execution checkpoint.
Streaming text, queued instructions, and tool actions interrupted by a crash may
not have complete records. Check files or external systems before repeating a
side effect. Session persistence is not an exactly-once execution or power-loss
durability guarantee.

## Tests

With dependencies installed, run `npm test` (Node.js 22.19 or newer). The tests
cover assistant backgrounds across session switches, repeated lifecycle events,
and non-TUI sessions. Background-agent tests use offline fixture providers and
real RPC child processes to check discovery, persistence, parent restart/death,
child crashes, torn JSONL tails, writer exclusion, idle cleanup, and recovery.
They do not make external model requests.

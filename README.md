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

## Compact codemode

`codemode-compact.ts` registers Pi's `codemode` tool with the same compact tree
as the other tools. Each nested tool call is one row, drawn like a direct call
(`Read(...)`, `Bash(...)`), followed by the script's outcome. Ctrl+O adds the
error details and the full output; alt+o adds the original script. The heading
uses the script's first `// comment` line, and a prompt guideline asks the model
to write one.

Pi skips its replaceable built-in `codemode` extension when this one registers
the tool, and it prints a warning at startup. To remove the warning, disable the
built-in in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["-builtin:codemode"] }
```

## Pseudocode workflow and model routing

For nontrivial work, invoke:

```text
/skill:pseudocode Describe the change you want
```

The skill keeps one conversation through planning, implementation, and review.
It asks the agent to create a short pseudocode artifact (normally
`plans/<task-slug>.md`), revise it with you, and wait for your approval before
implementation. There is no separate handoff document, worker session, or context
reset. Approval is a behavioral instruction, **not an enforced tool restriction**.
A model-routing decision never grants permission to implement.

### Configure the models once

The extension requires Pi with virtual-model support (tested on 0.99.2). Use
exact model IDs from `/model`, including their provider:

```text
/workflow models isara/claude-opus-5-5 isara/gpt-6-astra
```

The first model handles exploration, planning, and review **with you**. The
second handles implementation, tests, self-review, and routine fixes. These are
example IDs; select models available through your own configured providers.
The command saves `~/.pi/agent/workflow.json` (or the directory selected by
`PI_CODING_AGENT_DIR`). It does not change Pi's default model for other sessions.
The file is outside this package, so normal package updates preserve it:

```json
{
  "interactive": "isara/claude-opus-5-5",
  "implementation": "isara/gpt-6-astra",
  "classifier": "typesafe/jev-latest"
}
```

The skill calls `workflow_phase` before each transition. The tool selects the
`workflow/auto` virtual model, then routes the **next response** to the right
physical model. In particular, the implementer signals `review` before
presenting its result or asking you to resolve a design question. Writing a
pseudocode file does not automatically trigger implementation. The skill also
works with an explicitly disabled classifier (`"classifier": null`).

### Optional Jev detection

When a phase was not explicitly signaled, automatic routing asks the configured
classifier which phase the next response needs. Authenticate its provider through
Pi (`/login typesafe` for the default), or set `classifier` to an exact classifier
ID from another supported provider. No credential is stored in `workflow.json`.

Jev receives the current phase, the latest user message, and bounded text from up
to eight recent messages. This **can include private conversation text, code, and
tool output**; choose a classifier provider you trust. System prompts, hidden
reasoning, images, and tool arguments are excluded. This only limits the
classifier's input: the implementation model still gets the normal conversation.

A decision must have at least 80% probability to change the phase. Classifier
failure, missing credentials, or a five-second timeout keeps the current phase.
Explicit phase signals still work without Jev, so missing classifier credentials
do not block the workflow. Retries retain the original physical model; compaction
requests do not classify or change the workflow phase. Pi's normal compaction can
still occur, especially if the implementation model has a smaller context window.

### Manual controls

```text
/workflow                 # Show selection, phase, routing mode, and configured models
/workflow interactive     # Pin the interactive model
/workflow implementation  # Pin the implementation model; this is not approval
/workflow auto            # Resume phase-based routing (or select it directly)
/workflow off             # Select the interactive physical model without routing
```

Overrides take precedence over the classifier and agent phase signals until you
select `auto`. Phase state and overrides follow the session branch and survive
resume and compaction. Forking from an earlier point restores that point's state.
No operation clears or rewrites the planning history. `/workflow off` does not
remove the skill from the conversation; tell the agent if you also want to stop
following the pseudocode workflow.

After installing or updating the package, run `/reload` or start a new Pi session.

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

## Slack bot

`slack_bot_send_message` and `slack_bot_list_channels` call the Slack Web API
as the bot user. They read the bot token (`xoxb-...`) from the OS credential store under
the service name `pi-slack-bot-token`:

- **macOS:** login Keychain. Store the token with
  `security add-generic-password -s pi-slack-bot-token -a "$USER" -w`, and
  approve the Keychain prompt the first time Pi reads it.
- **Linux:** Secret Service (libsecret), keyed by service and account (your
  username). Store the token with
  `secret-tool store --label='Slack bot token' service pi-slack-bot-token account "$USER"`.

Both commands prompt for the token, so it does not appear in shell history.

## Tests

With dependencies installed, run `npm test` (Node.js 22.19 or newer). The tests
cover assistant backgrounds across session switches, repeated lifecycle events,
and non-TUI sessions. Background-agent tests use offline fixture providers and
real RPC child processes to check discovery, persistence, parent restart/death,
child crashes, torn JSONL tails, writer exclusion, idle cleanup, and recovery.
They do not make external model requests. Workflow tests cover phase routing,
classifier failure/uncertainty, manual overrides, context preservation, and the
real Pi runtime with offline fixture providers. The lockfile pins development
peers to the tested Pi version; Pi supplies its own host modules when loading the
installed extension.

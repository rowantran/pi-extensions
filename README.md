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

## Pseudocode skill and model switcher

For nontrivial work, invoke:

```text
/skill:pseudocode Describe the change you want
```

The skill keeps one conversation through planning, implementation, and review.
The `model-switcher.ts` extension and its `model-switcher/` resources route each
phase to the configured model. There is no separate handoff document, worker
session, or context reset.

### Agree on a committed skeleton

The agent writes pseudocode and stubs at the real implementation paths. The
skeleton focuses on important contracts, control flow, and assumptions; it need
not compile. The first task commit contains this skeleton, not implementation.
The agent pushes it and opens a draft PR against the appropriate confirmed base
branch. The PR body identifies the skeleton and important decisions and
assumptions, with `Closes #N` only when an issue is assigned.

The agent reports the PR URL and exact skeleton commit SHA, then waits for your
approval of that version before expanding the same files into code. Requested
skeleton revisions become new commits on the same draft PR and need approval of
the revised version. The first skeleton commit stays in history; it is not
amended away. Approval is a behavioral instruction, **not an enforced tool
restriction**. Model selection, classifier output, and successful tool calls
never grant permission to implement.

On an existing branch or resumed task, the agent checks files, history, pushes,
and PRs before repeating actions. It avoids unrelated changes and duplicate PRs.
If existing implementation commits prevent a first skeleton commit, it pauses
to agree a branch approach rather than rewriting history to fabricate one.
Missing GitHub authentication or a usable remote blocks publication; the agent
reports the blocker instead of silently proceeding to implementation.

Implementation and fixes remain commits on the same draft PR, with its summary
and verification results updated. The PR stays a draft during implementation and
review. You own publishing and merging it.

### Configure the models once

The extension requires Pi with virtual-model support (tested on 0.99.2). Use
exact model IDs from `/model`, including their provider:

```text
/model-switcher models isara/claude-opus-5-5 isara/gpt-6-astra
```

The first model handles exploration, planning, and review **with you**. The
second handles implementation, tests, self-review, and routine fixes. These are
example IDs; select models available through your own configured providers.
The command saves `~/.pi/agent/model-switcher.json` (or the directory selected by
`PI_CODING_AGENT_DIR`). It does not change Pi's default model for other sessions.
The file is outside this package, so normal package updates preserve it:

```json
{
  "interactive": "isara/claude-opus-5-5",
  "implementation": "isara/gpt-6-astra",
  "classifier": "typesafe/jev-latest"
}
```

The skill calls `model_switcher_phase` before each transition. The tool selects
the `model-switcher/auto` virtual model, then routes the **next response** to the
right physical model. Skeleton discussion stays in planning. The agent signals
`review` before presenting completed work or asking you to resolve a design
question during implementation. Writing or publishing a skeleton does not
automatically trigger implementation. The skill also works with an explicitly disabled classifier
(`"classifier": null`).

### Optional Jev detection

When a phase was not explicitly signaled, automatic routing asks the configured
classifier which phase the next response needs. Authenticate its provider through
Pi (`/login typesafe` for the default), or set `classifier` to an exact classifier
ID from another supported provider. No credential is stored in
`model-switcher.json`.

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
/model-switcher                 # Show selection, phase, routing mode, and configured models
/model-switcher interactive     # Pin the interactive model
/model-switcher implementation  # Pin the implementation model; this is not approval
/model-switcher auto            # Resume phase-based routing (or select it directly)
/model-switcher off             # Select the interactive physical model without routing
```

Overrides take precedence over the classifier and agent phase signals until you
select `auto`. Phase state and overrides follow the session branch and survive
resume and compaction. Forking from an earlier point restores that point's state.
No operation clears or rewrites the planning history. `/model-switcher off` does
not remove the skill from the conversation; tell the agent if you also want to
stop following the pseudocode workflow.

After installing or updating the package, run `/reload` or start a new Pi session.

### Upgrade from the old names

If you configured explicit extension or resource paths, update them to
`model-switcher.ts` and `model-switcher/`. Use `/model-switcher` and
`model_switcher_phase` in place of the old command and tool names.

The extension reads `~/.pi/agent/workflow.json` only when
`~/.pi/agent/model-switcher.json` is absent. Saving the model pair with
`/model-switcher models <interactive-provider/model> <implementation-provider/model>`
writes the new file and preserves the existing classifier choice, including
`null`. If both files exist, the new file takes precedence. These paths use
`PI_CODING_AGENT_DIR` when set.

The old `workflow/auto` virtual model is no longer registered. After updating and
reloading, select `/model-switcher auto` in an old session to restore its saved
phase state under `model-switcher/auto`. This resumes automatic routing; reapply
an interactive or implementation pin if needed. The conversation is preserved.

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
They do not make external model requests. Model-switcher tests cover phase
routing, classifier failure/uncertainty, manual overrides, context preservation,
and the real Pi runtime with offline fixture providers. The lockfile pins development
peers to the tested Pi version; Pi supplies its own host modules when loading the
installed extension.

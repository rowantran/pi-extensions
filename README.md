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
It owns the work instructions and works with any selected model. It does not
activate or control the model switcher.

The optional `model-switcher.ts` extension uses Jev to choose a model before
each new user message. Tool follow-ups keep the dispatched model. It adds no
agent tools, commands, work instructions, or handoff messages. Its classifier prompt goes only to the classifier. Pi keeps
the conversation and routing state; there is no separate worker session.

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

### Configure the model switcher

Create `~/.pi/agent/model-switcher.json` (or use the directory selected by
`PI_CODING_AGENT_DIR`). Use exact provider/model IDs from your installed
providers:

```json
{
  "interactive": "isara/claude-opus-5-5",
  "implementation": "isara/gpt-6-astra",
  "classifier": "typesafe/jev-latest"
}
```

The interactive model handles planning and discussion with you. The
implementation model handles coding, tests, and routine fixes. The IDs above
are examples; each selected provider must have usable credentials. Choose a
registered classifier through a provider you trust. This package does not add
classifier support to the Isara provider or local proxy.

The configuration stays outside the package and is read-only to the extension.
There is no configuration command and no credential belongs in this file.

### Select automatic or manual routing

Use Pi's normal `/model` picker:

- Select `model-switcher/auto` for classifier-based routing.
- Select any physical model for manual control; this bypasses the classifier.
- Select `model-switcher/auto` again to resume automatic routing.

Invoking `/skill:pseudocode` does not change that selection. You can use the
skill without the switcher, and the switcher without the skill.

### How routing works

Jev classifies each new user message as planning, implementation, or review.
Planning and review use the interactive model; implementation uses the other
model. A valid decision needs at least 80% probability to change the phase.
Tool follow-ups keep the dispatched model and thinking level without another
classifier call. File writes do not independently switch models: they can be
planning edits. Tool output can inform classification on the next user message.

Jev receives the current phase, the latest user message, and bounded text from
up to eight recent messages. This **can include private conversation text, code,
and tool output**. System prompts, hidden reasoning, images, and tool arguments
are excluded. Only the classifier input is reduced; the coding model receives
the normal conversation.

An uncertain decision keeps the current phase. An unavailable, disabled
(`"classifier": null`), or failed classifier also keeps the current phase and
warns once per session when a UI is available. Classification has no local
timeout; cancelling the user request also cancels classification.
Without a saved phase, routing starts on the interactive model.
**There is no explicit phase-tool fallback anymore.** If classification cannot
run, choose a model manually through `/model`.

Switching is inferred, not guaranteed at an exact work boundary. Model choice
never approves work or certifies completion. The skill's agreement with the
user still applies regardless of the selected model.

The router returns its phase as Pi's native virtual-model state. Pi preserves
it across resume, branches, and compaction. No extension-specific signal or pin
journal is read or written. Tool follow-ups reuse the previous model; retries
reuse the failed model (or the previous one when no failed response exists).
Direct requests, including compaction, keep the previous physical model and do
not classify. Normal Pi compaction can still occur if a selected model has a
smaller context window.

This uses the same `registerVirtualModel` and `request.state` mechanism as
[Pi's virtual-model example](https://pi.dev/docs/latest/virtual-models), with
ongoing classification rather than a one-time switch after the first edit.

### Upgrade from explicit routing controls

Run `/reload` or start a new Pi session. The `/model-switcher` commands and
`model_switcher_phase` tool have been removed. Old phase signals and manual pins
are ignored; use the native `/model` picker instead. Existing
`model-switcher/auto` sessions retain the phase Pi already saved, then follow
classifier decisions. Very old `workflow/auto` sessions need the new virtual
model selected; their separate legacy phase records are no longer imported.

Existing `workflow.json` settings remain readable when `model-switcher.json`
is absent. If both exist, the new file wins. The extension does not rewrite
either file or change your default model.

## Background agents

Background agents run Pi in RPC mode with a separate, saved conversation. New
agents inherit the parent's model and thinking level and use normal Pi discovery
for providers, extensions, skills, and prompt templates, subject to Pi's usual
settings and project trust rules. No provider-specific path is required.

### Instruction limits

`background_start.task` and `background_send.message` accept at most 16,384
characters. Put larger reports, code, and logs in files, then send their paths
with a short instruction. Oversized instructions are rejected, not truncated.

For OpenAI Responses streams, the extension also cancels the current parent
turn when either tool call's JSON arguments exceed 128 KiB. This includes
`background_start` shell calls. The larger limit allows for JSON escaping and
other fields. The guard counts fragments before Pi parses their growing prefix;
it does not retain their text or affect other tools. Existing background agents
keep running. Other APIs receive the schema and execution limits only.

### Message rendering

Background notices show the first line, up to five more content lines, and a
count of hidden lines. The full message remains available to the model.

Other transcript clients can import `renderBackgroundMessage` from
`background/render.ts` and register it for the `background` custom-message type.
It has Pi's `MessageRenderer` signature: `(message, options, theme) => Component | undefined`
(the implementation always returns a `Text` component). This display-only module
imports no worker, process, session, or credential code and does not register any
tools or start activities. Import it instead of `background.ts` when only
rendering remote or saved messages.

### Active-task widget

The native TUI shows a bordered widget below the editor with elapsed time and
names for up to five running shells or agents, plus a count of additional tasks.
RPC sends the same data as plain `setWidget` string-array lines under the key
`background-running`, with `belowEditor` placement. Clients that support widgets
can show these lines directly; RPC does not support native component factories.
The widget updates once per second while tasks run and clears when the last task
finishes or stops, or when the session shuts down. JSON and print modes do not
start widget timers.

Terminal clients can import `BACKGROUND_WIDGET_ID` and
`renderBackgroundWidgetLines(lines, width, theme)` from `background/widget.ts` to
render RPC lines with the native borders and colors. `backgroundWidgetLines`
builds the plain payload from active `{ kind, name, startedAt }` objects. This
shared module loads no worker code and starts no processes or timers. The
renderer removes terminal controls, bounds output to the supplied terminal
width, and keeps unrecognized content as plain text.

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

## Automatic session names

`auto-session-name.ts` names an unnamed session after a run settles, then updates
the title as the conversation grows. Pi's own session name appears in `/resume`,
the footer, and `pi-remote ls` for remote slots. Titles use normal words and
spaces, preserve Unicode, and contain at most 80 characters, for example
`Fix the login redirect loop`.

- After the first title, updates run at user turns 4, 8, 16, 32, and so on—not on
  every turn. Tool follow-ups do not count as user turns. Missed checkpoints are
  combined into one request, not replayed.
- Each compaction also triggers an update using its summary. Automatic
  compaction waits for retries and queued work to settle. A compaction and a
  turn checkpoint in the same run produce one request.
- Requests use bounded, visible user and assistant text from the active branch
  (no thinking, tool calls, or tool output). The first title includes the opening
  request; later titles use recent messages. Compaction updates combine the
  summary with retained and newer messages, including recovery replies. Later
  turn checkpoints use recent messages after that compaction, not its summary.
  Empty summaries and the placeholder from `pi-openai-server-compaction` fall
  back to the recent message excerpt.
- Each request generates a title from that context. The prompt does not include
  the current title or ask the model to preserve it. Replies longer than 12
  words are rejected instead of storing part of an answer as the title.
- `/name` stops automatic updates permanently for that session and cancels an
  in-progress request. This also applies if you choose the same title or clear
  it. Existing names without a saved automatic-ownership record, including
  names set before this version, are left alone.
- Ownership and the next checkpoint are saved in the session file, outside
  model context, so they survive restarts. Session changes, tree navigation,
  and shutdown discard in-progress results. Navigating back to an older branch
  does not repeat its compaction check.
- Requests run in the background. They do not delay new prompts, idle
  notifications, or compaction completion.
- A failure keeps the current title and shows at most one warning per Pi
  process. Unnamed sessions retry after the next settled run. Failed updates
  wait for the next checkpoint or compaction instead of retrying every turn.

By default the request goes to the physical model that wrote the latest reply.
That can be expensive, so pin a cheap model in `~/.pi/agent/auto-session-name.json`
(or under `PI_CODING_AGENT_DIR`):

```json
{ "model": "isara/claude-haiku-4-5-20251001" }
```

Add `"enabled": false` to turn naming off. The file is read on each attempt.

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
They do not make external model requests. Auto-session-name tests cover naming,
model selection, the doubling schedule, compaction, durable ownership,
manual-name races, cancellation, and failures with a fake model registry. Offline
Pi runtime tests also check title updates, compaction, resume, manual ownership,
and non-blocking requests without network calls.
Model-switcher tests cover phase
routing, classifier failure/uncertainty, native model selection, context
preservation, and the real Pi runtime with offline fixture providers. The lockfile pins development
peers to the tested Pi version; Pi supplies its own host modules when loading the
installed extension.

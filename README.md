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

Background agents run Pi in RPC mode with a separate conversation. They inherit
the parent's model and thinking level and use normal Pi discovery for providers,
extensions, skills, and prompt templates, subject to Pi's usual settings and
project trust rules. No provider-specific path is required. `--no-session` keeps
the child conversation from being saved to disk.

## Tests

With dependencies installed, run `npm test` (Node.js 22.19 or newer). The tests
cover assistant backgrounds across session switches, repeated lifecycle events,
and non-TUI sessions. Background-agent tests check launch settings and start an
offline RPC child to verify provider, skill, and prompt discovery without making
a model request.

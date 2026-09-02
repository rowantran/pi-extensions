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

`isara-provider.ts` is a machine-local extension and is intentionally excluded
from this repository.

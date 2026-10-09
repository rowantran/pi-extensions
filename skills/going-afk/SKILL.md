---
name: going-afk
description: Prepare to finish a goal autonomously while the user is away from the keyboard. Quickly front-load questions and permission requests, then work without stopping for input.
disable-model-invocation: true
metadata:
  purpose: Let the user hand off a goal shortly before leaving, so the agent does not stall on a question or permission prompt while the user is away.
  audience: The coding agent receiving the handoff.
  injection: Explicit /skill:going-afk invocation, followed by the goal.
---
# Prepare to work while the user is AFK

The user is going AFK in the next 5 minutes.
You must complete the previously-discussed goal autonomously.

## Phase 1: Before the user leaves (do this now)

1. Restate the goal in one or two sentences, and state how you will know it is done.
2. Think ahead through the full task. List every permission you may need, and request each one now. Examples:
   - Credentials, tokens, or logins to external services.
   - Actions with **important** side effects that the user must approve - usually things like manually deploying stacks.
   Assume that anything following the normal flow (e.g. infra deployment via the normal CD workflow triggered on merge to main) is approved by default.
3. Stop and wait for the user's answers. Do not start the main work in this phase.

## Phase 2: While the user is away

After the user answers, or tells you to start, work through the goal without stopping to ask for input.

- Do not end your turn to ask a question, confirm a plan, or report progress. The user is not there to answer.
- When you have to make a decision, choose the safest reasonable option, write it down, and continue.
- Do not take actions that are destructive or hard to undo unless the user approved them in Phase 1. If the only way forward needs such an action, do the rest of the work, then stop and explain.
- If one approach is blocked, try a different one before you stop. If a part of the work stays blocked, skip it and do the parts that do not depend on it.

## Phase 3: When you are done

When you have either completed the goal successfully or are blocked in a way that you cannot recover from,
end with a short report that the user can read without needing to go back through all of your previous messages:

- What you completed, and how you verified it.
- Key decisions you made without the user, and why.
- What is not done or is blocked, and what the user must do next.

If a Slack message-sending tool is available, send the user a Slack message in the specified log channel, making sure to tag them.

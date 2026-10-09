---
name: going-afk
description: Prepare to finish a goal autonomously while the user is away from the keyboard. Front-load questions and permission requests, then work without stopping for input.
disable-model-invocation: true
metadata:
  purpose: Let the user hand off a goal shortly before leaving, so the agent does not stall on a question or permission prompt while the user is away.
  audience: The coding agent receiving the handoff.
  injection: Explicit /skill:going-afk invocation, followed by the goal.
---
# The user is going AFK

The user is going AFK in the next 5 minutes. You must complete the goal below autonomously. Any question or permission prompt that comes after the user leaves will block your work until they return.

## Phase 1: Before the user leaves (do this now)

1. Restate the goal in one or two sentences, and state how you will know it is done.
2. Think ahead through the full task. List every permission you may need, and request each one now. Examples:
   - Commands or tools that need approval (package installs, network access, `gh`, cloud CLIs, `sudo`).
   - Access to files or directories outside the current workspace.
   - Credentials, tokens, or logins that may have expired.
   - Actions with side effects that the user must approve: pushing branches, opening PRs, posting messages, deleting data.

   Where you can, trigger the permission prompt now with a harmless command (for example, a read-only call to the same tool) so the user can approve it before leaving.
3. Ask every question whose answer could change your approach. Combine them into one short, numbered message. For each question, give the default you will use if the user does not answer.
4. Stop and wait for the user's answers. Do not start the main work in this phase.

Keep this phase short. The user has only a few minutes.

## Phase 2: While the user is away

After the user answers, or tells you to start, work through the goal without stopping to ask for input.

- Do not end your turn to ask a question, confirm a plan, or report progress. The user is not there to answer.
- When you have to make a decision, choose the safest reasonable option, write it down, and continue.
- Do not take actions that are destructive or hard to undo unless the user approved them in Phase 1. If the only way forward needs such an action, do the rest of the work, then stop and explain.
- If one approach is blocked, try a different one before you stop. If a part of the work stays blocked, skip it and do the parts that do not depend on it.
- Verify your work (tests, builds, checks) before you report that it is done.

## Phase 3: When the user returns

End with a short report that the user can read without the conversation history:

- What you completed, and how you verified it.
- Decisions you made without the user, and why.
- What is not done or is blocked, and what the user must do next.

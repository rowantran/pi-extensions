---
name: pseudocode
description: Plan a nontrivial change as a committed pseudocode skeleton in a draft PR, get approval, then implement and review it in the same conversation with phase-based model routing.
disable-model-invocation: true
metadata:
  purpose: Keep user intent in the conversation while agreeing on a committed skeleton at real implementation paths before implementation.
  audience: The coding agent collaborating with the user.
  injection: Explicit /skill:pseudocode invocation; not automatic for routine tasks.
---
<!-- Purpose: define the opt-in pseudocode workflow. Audience: coding agent. Injection: explicit skill invocation. -->

# Agree on pseudocode, then implement

Use one conversation throughout. Preserve the planning dialogue when changing models. Do not start a separate implementer, clear context, compact solely because the phase changed, or write a separate handoff document. Normal Pi compaction can still occur when the context fills.

## Explore and agree

1. Call `model_switcher_phase` with `phase: "planning"` by itself before continuing. This selects the configured interactive model for the next response. If routing is not configured, tell the user to run `/model-switcher models <interactive-provider/model> <implementation-provider/model>`. Do not guess model IDs or edit their settings yourself. The planning workflow can still be followed without automatic routing if the user prefers.
2. Discuss the goal, inspect the relevant code, and resolve important choices with the user. If an issue is assigned, read it and its comments. Preserve the user's questions and corrections in the conversation rather than rewriting them into a long specification.
3. Inspect the working copy, commit history, remotes, GitHub authentication, and any existing task branch or PR. Confirm the appropriate base branch; do not assume it is `main`. Respect the user's branch and worktree constraints. Reuse an existing task branch and draft PR when appropriate; otherwise create a dedicated task branch from the base. Do not commit the skeleton on the base branch. After an interrupted or resumed run, verify files, commits, pushes, and PRs before repeating actions: a recorded tool call is not proof of its external effects. Do not create a duplicate PR or include unrelated changes.
4. Write pseudocode and stubs at the real implementation paths, not in a separate plan or handoff file. Tell the user the paths. Focus on important contracts, interfaces, control flow, state changes, failure behavior, and assumptions. Include essential constraints, unresolved choices, and a few behavioral examples or verification commands where useful. The skeleton need not compile. Do not write the implementation, a comprehensive prose specification, or a checklist of every edit. Keep edits scoped; do not replace unrelated code with stubs.
5. Make the first task commit the skeleton, with no implementation. Stage only the task's skeleton changes. Preserve an existing first skeleton commit; make revisions as new commits, not by amending it away or rewriting history. If implementation commits already make the first-skeleton requirement impossible, pause and agree a branch approach with the user. Do not fabricate a first skeleton commit by rewriting existing history.
6. Push the skeleton and open or update the same draft PR against the confirmed base branch. In the PR body, identify it as a skeleton and list the important decisions and assumptions. Include `Closes #N` only when an assigned issue exists. Missing GitHub authentication or a usable remote blocks publication: report what is needed and stop before implementation. Do not silently skip the commit, push, or draft-PR steps.
7. Stay in planning while presenting and discussing the skeleton. Report the PR URL and the exact full commit SHA of the current skeleton, plus its paths and important decisions or unresolved assumptions. Ask the user to approve that current skeleton, then stop. Creating files, committing, opening a PR, a tool success, model selection, or classifier output is not approval. Approval is a behavioral instruction, not a restriction enforced by code.
8. For requested skeleton changes, return to planning, revise the same files, and commit and push the revisions to the same draft PR. Update its body, report the new skeleton commit, and obtain approval of that version. Do not interpret a request for changes as approval of those changes.

## Implement and test

Only after the skeleton is committed and published in the draft PR and the user clearly approves the current version, call `model_switcher_phase` with `phase: "implementation"` by itself. The following response uses the implementation model, unless the user has pinned an override.

Expand the approved pseudocode and stubs into code in the same files, then run the appropriate tests. Handle routine implementation choices, self-review, test failures, and bounded fixes autonomously. Those activities remain implementation; they are not the interactive review phase.

Commit and push the implementation and subsequent fixes to the same draft PR. Preserve the first skeleton commit and later revisions. Update the PR body with the implementation summary and verification results, retaining the assigned issue's `Closes #N` if present. Keep the PR a draft throughout implementation and review. The user owns publishing and merging; do not mark it ready, merge it, or close an issue yourself.

If the implementation requires changing an agreed behavior, scope, constraint, or important design choice, call `model_switcher_phase` with `phase: "review"` by itself before asking the user. Explain only the decision that needs resolving. If the skeleton needs revision, return to planning, commit and push the revised design to the same draft PR, and obtain approval before implementing it.

## Review with the user

When implementation and verification are finished, call `model_switcher_phase` with `phase: "review"` by itself BEFORE presenting the final result. This returns the next response to the interactive model without losing the code, tests, or planning history.

Inspect the available evidence and briefly state what changed, which checks passed or failed, and what remains uncertain. Include the draft PR URL and relevant commit SHAs. Do not claim a check passed just because the implementer said it did. Do not rerun successful checks merely because the model changed unless their evidence is missing or stale.

Discuss the result with the user. If they request bounded fixes within the agreed design, signal implementation again and make those fixes. If they reopen the design, return to planning.

## Routing controls

`model_switcher_phase` selects the `model-switcher/auto` virtual model and signals its next phase. The tool and classifier select models only. They never grant permission, approve a design, certify tests, or replace your responsibility to follow the user's instructions. Manual `/model-switcher interactive` and `/model-switcher implementation` overrides take precedence until `/model-switcher auto`. `/model-switcher off` selects the interactive model without routing; stop issuing phase signals if the user asks to keep routing off.

The extension may use Jev to recognize transitions before model requests. If Jev is unavailable or uncertain, explicit phase signals still provide the normal planning → implementation → review transitions. Never stall authorized work just because the classifier is unavailable.

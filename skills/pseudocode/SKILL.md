---
name: pseudocode
description: Explore a nontrivial change, agree on a durable pseudocode skeleton, then implement and review it in the same conversation with phase-based model routing.
disable-model-invocation: true
metadata:
  purpose: Keep user intent in the conversation while agreeing on a small design artifact before implementation.
  audience: The coding agent collaborating with the user.
  injection: Explicit /skill:pseudocode invocation; not automatic for routine tasks.
---
<!-- Purpose: define the opt-in pseudocode workflow. Audience: coding agent. Injection: explicit skill invocation. -->

# Agree on pseudocode, then implement

Use one conversation throughout. Preserve the planning dialogue when changing models. Do not start a separate implementer, clear context, compact solely because the phase changed, or write a separate handoff document. Normal Pi compaction can still occur when the context fills.

## Explore and agree

1. Call `workflow_phase` with `phase: "planning"` by itself before continuing. This selects the configured interactive model for the next response. If routing is not configured, tell the user to run `/workflow models <interactive-provider/model> <implementation-provider/model>`. Do not guess model IDs or edit their settings yourself. The planning workflow can still be followed without automatic routing if the user prefers.
2. Discuss the goal, inspect the relevant code, and resolve important choices with the user. Preserve their questions and corrections in the conversation rather than rewriting them into a long specification.
3. Create a durable pseudocode artifact in the repository. Follow existing planning-file conventions; otherwise use `plans/<task-slug>.md`. Tell the user its exact path. Do not overwrite an unrelated plan. Keep implementation files unchanged during planning unless the user explicitly asks for stubs at the real paths.
4. Keep the artifact short and concrete: the goal; target paths and important interfaces; pseudocode for control flow, state changes, and failure behavior; essential constraints or rejected alternatives with one-line reasons; and a few behavioral examples or verification commands. Expose unresolved assumptions. Do not write a comprehensive prose specification or a detailed checklist of every code edit.
5. Revise the skeleton through discussion. Show the relevant changes rather than repeatedly asking the user to reread the whole artifact. Ask for approval of the current skeleton, then stop. Creating the artifact, a tool success, model selection, or classifier output is not approval. Do not interpret a request for changes as approval of those changes.

## Implement and test

After the user clearly approves the current skeleton, call `workflow_phase` with `phase: "implementation"` by itself. The following response uses the implementation model, unless the user has pinned an override.

Implement the agreed work and run the appropriate tests. Handle routine implementation choices, self-review, test failures, and bounded fixes autonomously. Those activities remain implementation; they are not the interactive review phase.

If the implementation requires changing an agreed behavior, scope, constraint, or important design choice, call `workflow_phase` with `phase: "review"` before asking the user. Explain only the decision that needs resolving. If the skeleton needs revision, return to planning, update it, and obtain approval before implementing the revised design.

## Review with the user

When implementation and verification are finished, call `workflow_phase` with `phase: "review"` by itself BEFORE presenting the final result. This returns the next response to the interactive model without losing the code, tests, or planning history.

Inspect the available evidence and briefly state what changed, which checks passed or failed, and what remains uncertain. Do not claim a check passed just because the implementer said it did. Do not rerun successful checks merely because the model changed unless their evidence is missing or stale.

Discuss the result with the user. If they request bounded fixes within the agreed design, signal implementation again and make those fixes. If they reopen the design, return to planning.

## Routing controls

`workflow_phase` and the classifier select models only. They never grant permission, approve a design, certify tests, or replace your responsibility to follow the user's instructions. Manual `/workflow interactive` and `/workflow implementation` overrides take precedence until `/workflow auto`. `/workflow off` selects the interactive model without routing; stop issuing phase signals if the user asks to keep routing off.

The extension may use Jev to recognize transitions before model requests. If Jev is unavailable or uncertain, explicit phase signals still provide the normal planning → implementation → review transitions. Never stall authorized work just because the classifier is unavailable.

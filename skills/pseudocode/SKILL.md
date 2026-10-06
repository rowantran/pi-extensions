---
name: pseudocode
description: Plan a nontrivial change as a committed pseudocode skeleton, get approval, then implement and review it.
disable-model-invocation: true
metadata:
  purpose: Keep user intent in the conversation while agreeing on a pseudocode skeleton before implementation.
  audience: The coding agent collaborating with the user.
  injection: Explicit /skill:pseudocode invocation; not automatic for routine tasks.
---
# Agree on pseudocode before implementing

The instructions below refer to a single PR, but if the change is large enough that splitting into a stacked PR of multiple separable changes would aid understandability, agree with the user on how to structure the stack, then perform each step below, in order, across the full stack of PRs.

## Phase 1: Write a skeleton

Before you write real code, write pseudocode and/or stubs that provide a concrete skeleton of what we will build them out. Put them in the files where the real implementation will live, at the correct paths.

For example, for a new system that records bank account balances:

```
# path: src/models/bank_account.py

class BankAccount:
    balance: number

def close(account: BankAccount) -> Result
    is_authorized = check_user_auth()

    if is_authorized:
        # ensure balance is zero, otherwise error
        # send user notification
        # send notice to account termination service
```

Rules for the skeleton:

- Include critical types, contracts (function signatures, protocols), and methods. Show the control flow of the important routines with short comments.
- Do **not** include supporting types/contracts/methods whose existence & implementations can be inferred from the issue description + the rest of the pseudocode skeleton. Bias towards less detail, so that the user has more capacity to pay to attention to the decisions that actually matter.
- It does not need to compile or pass checks.
- It does not stub every file you plan to touch.
- Commit the skeleton as the first commit on your branch.

## Phase 2: Agree on the skeleton with the user

Once ready for review, submit the pseudocode skeleton as a commit in a draft PR.

Ask the user to review the skeleton. Give a short list of the files you wrote, and name the decisions and assumptions you are least sure about.

Revise the skeleton until the user explicitly approves it. Do not start the implementation phase without that approval.

## Phase 3: Implement

Replace the skeleton with the real implementation. Keep to the approved skeleton. If you must deviate from it in a way that changes a type, a contract, or the behavior, stop and ask the user first.

Commit your work and update the same PR that had the pseudocode, so that it now has the real implementation, then publish it for review.

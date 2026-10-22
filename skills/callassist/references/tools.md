# CallAssist tools reference

Every tool returns `content` (one text block, the same words as `speech`) and `structuredContent` matching the tool's `outputSchema`. Every tool also points to an MCP Apps view (`_meta.ui.resourceUri = "ui://callassist/card.html"`): hosts that render MCP Apps show an interactive card; others use the data.

## Common output fields

| Field | Meaning |
| --- | --- |
| `speech` | What to say. Voice-ready |
| `tool` | Which tool produced the result |
| `reason` | Why something couldn't be done: `not_found`, `ambiguous`, `no_consent`, `opted_out`, `emergency`, `children`, `daily_cap`, `too_many_calls`, `confirmation_missing`, `confirmation_mismatch`, `confirmation_expired`, `timeout` |
| `needsConfirmation` | A read-back. Ask the user, then call again with `confirmed: true` and `confirmationToken` |
| `confirmationToken` | One-time, 5-minute token bound to the exact tool, person and words |
| `duplicate` | The same request is already open; no new call was made |
| `afterHours` | The call waits for the person's calling hours (8 AM–9 PM their time) |
| `taskId`, `title`, `person`, `status`, `eta`, `due`, `reply`, `updates` | The task |
| `tasks`, `total` | Lists |
| `contacts` | Team members with `name`, `role`, `canCall` |

`status` is one of `calling`, `accepted`, `blocked`, `done`, `declined`, `unreachable`, `cancelled`.

## Tools

### assign_task
Give someone a task by phone. Inputs: `person` (name, nickname or role), `task` (user's words, 3–400 chars), `due` (optional, e.g. "by 3 pm"), `confirmed`, `confirmationToken`.

### run_errand
Run a preset errand. Inputs: `request` ("a coffee", "chai", "lunch", "the car"), `place` ("office" default, or "home"), `notes` ("less sugar"), `confirmed`, `confirmationToken`.

### deliver_message
Deliver a message and bring back the reply. Inputs: `person`, `message` (as the recipient should hear it), `question` (optional, one), `confirmed`, `confirmationToken`. Never connects the user into a live call.

### get_task_status
One task. Inputs: `taskId` or `person` (optional; defaults to the latest task), `waitSeconds` (0–25; default 0).

### list_tasks
Several tasks. Inputs: `filter` (`open` default, `done`, `all`), `person` (optional). Speaks at most 5.

### follow_up
Call now for an update. Inputs: `taskId` or `person`.

### answer_question
Call a worker back with the user's answer to their question. Inputs: `answer`, `taskId` or `person` (optional; defaults to the task waiting on the user).

### cancel_task
Two-step cancel; tells the worker if they had started. Inputs: `taskId` or `person`, `notifyPerson` (default true), `confirmed`, `confirmationToken`.

### list_team
The team, or one lookup. Input: `name` (optional).

### list_errands
Preset errands. Input: `place` (optional).

## Auth

Two OAuth tiers, as Alexa+ expects:
- **Service token** (`client_credentials`, scope `mcp:service`): `initialize`, `tools/list` only.
- **User token** (authorization code + PKCE S256, scope `mcp:tools`): every tool call and resource read. A `401` means the account needs linking again.

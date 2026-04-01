# Goal: Implement asynchronous agent loop and proactive background intent processing.

## 1. Context and Problem
Currently, `message-processor.ts` blocks the main gateway execution thread until the LLM completes its reasoning and tool calling. This design leads to unresponsive behavior when tools take significant time to execute. The user asks a question, and cannot see updates or interact with the bot until the task is complete.

## 2. Proposed Architecture Changes

### Message Ingestion & Intent Extraction (`message-processor.ts`)
Instead of launching into an immediate, blocking agent loop, processing will be broken down into:
1.  **Intent Identification & Triage**: 
    - The LLM will perform a quick analysis of the user's intent. 
    - Determine if it requires: 
        a. A rapid response (e.g., standard conversation, casual greeting) -> Immediate blocking loop.
        b. An operation that cannot be handled by existing tools -> Fire an `evolution.ts` / new skill generation request.
        c. An operation mapping to an existing skill/tool -> Dispatch as an asynchronous background task.

### Background Task Management (`task-manager.ts` or similar)
1.  **Threaded/Background Execution**: 
    - Build a mechanism to spawn background processing loops (`startToolLoopWithPID()`).
    - The background task will have its own process ID (PID) or Task ID.
    - Status will be updated in a shared state or JSON queue file (e.g., `tasks.json` in `/tmp` or user profile).
2.  **Job Logs & Status Inspection**:
    - Let background tasks emit structured logs.
    - Provide a new tool to the main agent: `check_task_status(taskId)` or `peek_system_tasks()` which reads recent log lines and updates the LLM automatically if the user queries "how is my task going?", "why is taking so long".
3.  **Job Cancellation**:
    - Provide a tool to the LLM agent: `kill_task(taskId)` which cancels the running promise / background worker.
    - Ensures the LLM can kill the process based on user's request.
4.  **Callback / Notification upon completion**:
    - When a background task completes successfully or fails, it will send a message directly to the `queue_message` mechanism that `gateway.ts` already polls (the `pending_messages.json` system). This handles pushing the final response back to the user seamlessly.

### Gateway Updates (`gateway.ts`)
- Modify `processMessage` to handle yielding control early. Instead of awaiting the full task completion, if a task is backgrounded, the parser will return a "task started" acknowledgment (e.g., "I've started looking into that for you. Give me a moment.") which is sent immediately to the user.
- Keep the `startQueuePoller()` implementation unchanged; it naturally supports asynchronous text generation pushbacks to WhatsApp.

## 3. Flow Example
1. User: *"Check my email for today's flight tickets."*
2. **identify user's intent**: "Read Emails", which matches `imap_skill`.
3. **see if could solve by existing skills**: Yes.
4. **create a new task thread**: Assign ID `task_001`.
5. Return immediate response: *"I'm checking your emails right now, please hold on."* 
6. (Background loop executes `imap_skill`...)
7. User: *"Is it done yet?"*
8. LLM queries `get_task_status('task_001')` -> returns "Executing imap_search...".
9. LLM responds: *"Still searching your inbox for tickets, hold down a bit longer."*
10. Task `task_001` completes -> writes final answer to `QUEUE_PATH/pending_messages.json`.
11. `gateway.ts` picks it up and sends: *"Found them! Your flight gets off at 4 PM."*

## 4. Unhandled Intent (Generate Skill Request)
If the triage step determines the intent requires a non-existent skill, it will trigger the code generation loop. The LLM triage returns an internal schema causing `evolution.ts` / `generateSkill()` to be spawned in the background, also giving the user an immediate status "I don't know how to do that yet, but I'll write a new skill for it right now!"


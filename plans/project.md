## 1. System Vision

- **Privacy Architecture:** Zero-database. All user data is stored in human-readable Markdown, JSON, and CSV files, leveraging atomic file system writes to prevent data corruption during concurrent events.

- **GPU Resource Arbiter:** A lock-based system (`/temp/gpu_active.lock`) prevents conflicts between Local LLM (chat), MLX-Audio (voice), and Cloud Evolution (GLM-5) when using the Mac Mini's GPU.

- **Hardware Optimized:** Uses **MLX-Audio** for near-instant Voice-to-Text (STT) and Text-to-Voice (TTS) leveraging Mac M-series GPU/NPU.

- **Process-Separated Orchestration:** PM2 manages four distinct micro-processes for maximum stability:
  - **Gateway** (Node.js): WhatsApp message receiving and sending
  - **Scheduler** (Node.js): The Heartbeat - checks reminders every 60s, runs skills
  - **Janitor** (Node.js): Web portal cleanup every hour
  - **Evolution** (Node.js): Background skill generation with 10-round iterative refinement

- **Communication:** Uses shared JSON file queues (`/queue/*`) for inter-process messaging.
  - Scheduler/Evolution write to queues, Gateway polls and sends WhatsApp messages

- **Ephemeral Web (SSG):** Dynamic content is rendered to static HTML and served via a Cloudflare Tunnel with auto-expiring links.

- **Inter-Process Communication:** Shared JSON file queue (`/queue/pending_messages.json`) - Scheduler writes, Gateway polls and sends WhatsApp messages.

---

## 2. Technical Stack & Shared Configuration

Everything is governed by a single `.env` file and a shared `agents.json` to ensure consistency across Node.js and Python.

| Component           | Choice                      | Reason                                                                                             |
| :------------------ | :-------------------------- | :------------------------------------------------------------------------------------------------- |
| **Orchestrator**    | Node.js (nvm)               | Handles system execution alongside Python fallback.                                                |
| **Process Manager** | PM2                         | Daemonizes and independently monitors distinct workflows (Gateway, Scheduler, Janitor, Evolution). |
| **LLM (Chat)**      | LM Studio (qwen/qwen3.5-35b-a3b) | Local LLM server via OpenAI-compatible API.                                                        |
| **Evolution**       | GLM-5 (Z.ai Cloud API)      | High-reasoning "Coding" model for generating new skills via cloud API.                             |
| **Audio**           | MLX-Audio                   | Optimized for Mac (Qwen3-TTS / Whisper-v3).                                                        |
| **Storage**         | File System                 | Pure `csv`, `md`, and `json` with atomic locking. No SQL/NoSQL overhead.                           |

---

## 3. Directory Structure

```text

/Friday-Project

├── .env                  # Shared: AI_PROVIDER, CHAT_MODEL, TTS_MODEL, PATHS
├── agents.json           # Shared Personalities (Friday, Alfred, etc.)
├── ecosystem.config.js   # PM2 configuration specifying 4 Node processes

├── /core                 # Node.js processes: gateway.js, scheduler.js, janitor.js, evolution.js

├── /logs                 # PM2 process logs

├── /queue                # Inter-process message queue (JSON files)
│   ├── pending_messages.json   # Scheduler/Evolution writes, Gateway reads
│   ├── status.json             # Health status of each process
│   └── /evolution             # Skill generation queue
│       ├── /pending           # Pending jobs
│       ├── /processing       # Currently running jobs
│       └── /completed         # Finished jobs

├── /temp                 # Temporary files
│   └── gpu_active.lock       # GPU Resource Arbiter lock file

├── /web_portal           # Static HTML sub-folders per user/session

├── /skills

│   ├── /builtin          # Search, Browser (Playwright), Voice (MLX), Reminders

│   ├── /generated        # Python skills created by GLM-5 (Git Ignored)

│   └── ai_utils.py       # Shared Python wrapper for calling Local LLM

└── /users

    └── /[phone_number]   # Isolated: memory.log (JSONL), profile.json, reminders.json

```

---

## 4. The "Deterministic" Heartbeat & Skill Logic

Unlike basic bots, Friday uses a **Two-Tier Execution Model** to save power and tokens.

### **Tier 1: The Scheduler (PM2 Process - Heartbeat)**

Every 60 seconds, the Scheduler process scans each user's `reminders.json`.

- If a task is due, it triggers the associated **Skill** directly via `child_process.spawn`.

- **No LLM call occurs here**, keeping the system "quiet" in the background.

- If the skill produces output, it writes to `/queue/pending_messages.json` for the Gateway to send.

### **Tier 2: Skill Execution (Python Sandbox)**

If a skill (like `gold_tracker.py`) needs to communicate, it handles its own "thinking."

1.  **Skill Runs:** Python script scrapes data or performs the task.

2.  **Logic Check:** If a threshold is met (e.g., price change > 1%), the skill reads the `.env` and `agents.json`.

3.  **Local LLM Call:** The skill calls LM Studio (qwen/qwen3.5-35b-a3b) to: _"As Friday, draft a witty WhatsApp alert for this data."_

4.  **Queue Output:** The skill writes the message to `/queue/pending_messages.json`.

5.  **Gateway Picks Up:** The Gateway process polls the queue every 5 seconds and sends via WhatsApp.

---

## 5. Built-in Skills (The Core Power)

### **I. The Live Browser**

- **Execution:** Node.js + Playwright.

- **Visibility:** Runs a **non-headless** Chrome window on the Mac Mini desktop.

- **Persistence:** Uses a local `chrome_profile` so it stays logged into your favorite sites.

### **II. MLX-Audio (Voice)**

- **Transcription:** `mlx-whisper` converts WhatsApp voice notes to text instantly.

- **Synthesis:** `qwen3-tts` (or similar) generates the response audio using the Mac Mini's GPU.

### **III. Static Page Viewer & Janitor**

- **Generation:** Skills save complex data (charts/tables) to `/web_portal/[user_id]/[hash]/index.html`.

- **Access:** Friday sends a Cloudflare-tunneled link to WhatsApp.

- **The Janitor:** A Node.js loop runs every hour to **delete** any `/web_portal` sub-folders older than 24 hours.

---

## 6. The Skill Factory (Self-Evolution) - Async Background Process

The Evolution process is **non-blocking** - it runs in the background like "baking a cake" and does NOT interrupt live message handling.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    EVOLUTION WORKFLOW (Async)                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Gateway receives message: "Track my gym progress"                  │
│         │                                                            │
│         ▼                                                            │
│  ┌─────────────────┐    ┌────────────────────────┐                  │
│  │ Immediate Reply │───▶│ "I'm creating a skill   │                  │
│  │ (Non-blocking)  │    │  for you... This will  │                  │
│  └─────────────────┘    │  take a few minutes."   │                  │
│         │               └────────────────────────┘                  │
│         │                        │                                  │
│         ▼                        ▼                                  │
│  Live messaging         ┌─────────────────┐                        │
│  continues...           │ Evolution Queue │                        │
│                         │ /queue/evolution │                        │
│                         │ /jobs/pending/   │                        │
│                         └─────────────────┘                        │
│                                    │                                 │
│                                    ▼                                 │
│                         ┌────────────────────────┐                   │
│                         │ Evolution Worker      │                   │
│                         │ (Background Process)  │                   │
│                         └────────────────────────┘                   │
│                                    │                                 │
│         ┌──────────────────────────┼──────────────────────────┐    │
│         ▼                          ▼                          ▼    │
│  ┌───────────────┐        ┌───────────────┐          ┌──────────────┐│
│  │ Attempt 1     │        │ Attempt 2     │   ...    │ Max 2 retries ││
│  │ Generate Code │        │ Fix Errors    │          │   Give Up     ││
│  └───────────────┘        └───────────────┘          └──────────────┘│
│         │                          │                           │      │
│         ▼                          ▼                           ▼      │
│  ┌───────────────┐        ┌───────────────┐          ┌──────────────┐│
│  │ Test Run     │        │ Test Run      │          │ Notify User: ││
│  │ (sandbox)    │        │ (sandbox)     │          │ "Failed to    ││
│  └───────────────┘        └───────────────┘          │  create..."  ││
│         │                          │                  └──────────────┘│
│         ▼                          ▼                                  │
│  ┌───────────────┐        ┌───────────────┐                         │
│  │ PASS?         │        │ PASS?         │                         │
│  │  └─YES──▶Save │        │  └─YES──▶Save │                         │
│  │     to skill  │        │     to skill  │                         │
│  │     registry  │        │     registry │                         │
│  └───────────────┘        └───────────────┘                         │
│         │                          │                                  │
│         └──────────────────────────┘                                  │
│                            │                                           │
│                            ▼                                           │
│                 ┌────────────────────────┐                             │
│                 │ Notify User via Queue  │                             │
│                 │ "Your skill is ready!" │                             │
│                 └────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────────┘
```

### **Evolution Queue Structure**

```json
// /queue/evolution/pending/[job_id].json
{
  "id": "uuid",
  "user_id": "+1234567890",
  "request": "Track my gym progress from my messages",
  "status": "pending" | "processing" | "completed" | "failed",
  "current_round": 1,
  "max_rounds": 10,
  "round_timeout_sec": 60,
  "total_timeout_min": 30,
  "error_history": [],  // Array of {round, error_message, timestamp}
  "created_at": "ISO timestamp",
  "updated_at": "ISO timestamp",
  "result": null
}
```

### **Step-by-Step Flow:**

1.  **Trigger:** Gateway receives unknown request, immediately responds "Creating skill..." to user.

2.  **Queue Job:** Gateway writes to `/queue/evolution/pending/[job_id].json`.

3.  **Background Worker:** A separate Node process (or scheduler with flag) picks up the job.

4.  **Generation Loop (Max 10 Rounds):**
    For each round (1-10):

    a. **Generate:** Call Ollama Cloud API (GLM-5) with Python template + error history from previous rounds

    b. **Save:** Write code to `/skills/generated/temp_[job_id].py`

    c. **Test Run:** Execute in sandboxed `child_process.spawn` with timeout (60s)

    d. **Evaluate:** - If exit code = 0 and no stderr → **SUCCESS** → Move to `/skills/generated/[skill_name].py` - If failed → Capture error, append to error history → **Next Round**

    e. **User Notification (after each round):** - Write progress update to `/queue/pending_messages.json` - Example: "Round 3/10: Testing skill..." or "Round 3/10: Got an error, trying to fix..." - Gateway picks up and sends WhatsApp message

5.  **If All 10 Rounds Fail:**
    - Mark job as "failed"
    - Write error summary to `/queue/pending_messages.json`
    - Notify user: "Couldn't create skill after 10 attempts. Here's what was tried: [summary]"

6.  **On Success:**
    - Move code to `/skills/generated/[skill_name].py`
    - Register skill in `/skills/registry.json`
    - Notify user: "Your skill '[name]' is ready!"

### **Key Design Principles:**

- **Separate Process:** Evolution runs in its own PM2 process (`evolution.js`), fully isolated from Gateway
- **Non-blocking:** Gateway responds immediately, evolution runs in background
- **Job Queue:** JSON files in `/queue/evolution/pending/` track each job
- **Iteration-based:** Up to 10 rounds of generate → test → fix → test (like Claude Code)
- **Error History:** Each round gets all previous errors to learn from
- **Timeouts:** 60s per round test, 30min total job timeout
- **Human-like Updates:** User gets WhatsApp messages after each round:
  - "Started creating your skill..."
  - "Round 3/10: Almost there..."
  - "Round 3/10: Hit a small issue, trying to fix..."
  - "Your skill '[name]' is ready!" or "Couldn't create after 10 tries. [summary]"

---

## 7. Next Steps for Implementation

1.  **Infrastructure:** Install `nvm` (Node) and `conda` (Python). Setup the `.env`.

2.  **The Gateway:** Create the Node.js script to link WhatsApp to your Local LLM API.

3.  **The Heartbeat:** Write the `reminders.json` watcher loop.

4.  **The Audio:** Set up the `mlx-audio` environment to handle voice messages.

**Would you like me to generate the initial `.env` file and the `agents.json` personality profiles to start your project?**

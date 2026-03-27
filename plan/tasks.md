This task plan is designed for a **Code Agent** (like RooCode, Cline, or a custom script) to implement **Project Friday** on a Mac Mini. It follows the "No-Database, Local-First, Hybrid Node/Python" architecture.

---

## Phase 1: Environment & Shared Configuration

**Goal:** Establish the "Source of Truth" for all AI and path settings.

1.  **Task 1.1: Project Scaffolding**
    - Create the directory structure: `/core`, `/skills/builtin`, `/skills/generated`, `/users`, `/web_portal`, `/temp`, `/queue`.
    - Initialize `npm init -y` in the root.
2.  **Task 1.2: Shared `.env` File**
    - Define: `AI_PROVIDER`, `AI_BASE_URL`, `CHAT_MODEL`, `EVOLUTION_MODEL`, `TTS_MODEL`, `STT_MODEL`, `USER_DATA_PATH`, `WEB_PORTAL_PATH`, `QUEUE_PATH`.
    - Add Cloud API settings: `CLOUD_AI_KEY`, `CLOUD_AI_URL` (Z.ai), `ARBITER_LOCK_PATH`
3.  **Task 1.3: PM2 Ecosystem Setup**
    - Create `ecosystem.config.js` with 4 separate processes:
      - `gateway.js` - WhatsApp message handling (PM2 name: `friday-gateway`)
      - `scheduler.js` - Heartbeat (60s reminder checks) + skill execution (PM2 name: `friday-scheduler`)
      - `janitor.js` - Web portal cleanup (PM2 name: `friday-janitor`)
      - `evolution.js` - Background skill generation with 10-round iteration (PM2 name: `friday-evolution`)
    - Create `/logs` directory for process logs
4.  **Task 1.4: Message Queue Setup**
    - Create `/queue/pending_messages.json` as shared JSON queue
    - Implement atomic read/write using `write-file-atomic`
    - Gateway polls every 5s, Scheduler writes when skills produce output
5.  **Task 1.5: GPU Resource Arbiter Setup**
    - Create `/temp/` directory
    - Define lock file path: `ARBITER_LOCK_PATH=./temp/gpu_active.lock`
    - Implement lock acquire/release functions in Python (`ai_utils.py`)
6.  **Task 1.6: Memory System Setup**
    - Create `/core/memory-manager.js` with JSONL append-only pattern
    - Implement `appendMemory(userId, role, content)` function
    - Implement `getRecentContext(userId, limit)` function

---

## Phase 2: The Node.js Orchestrator (Core)

**Goal:** Build the three independent Node.js processes managed by PM2.

1.  **Task 2.1: WhatsApp Gateway (`gateway.js`)**
    - PM2 process name: `friday-gateway`
    - Implement `baileys` to handle QR code authentication and message listening.
    - Validate incoming numbers against a `.env` whitelist (e.g., `ALLOWED_NUMBERS`).
    - Map incoming phone numbers to specific folders in `/users/[phone_number]`.
    - **Poll `/queue/pending_messages.json` every 5 seconds** and send any queued messages.
    - Handle both: scheduled skill outputs AND evolution progress notifications
2.  **Task 2.2: The Master Scheduler (`scheduler.js`)**
    - PM2 process name: `friday-scheduler`
    - Implement `node-cron` or manual `setInterval` loop.
    - Logic: Check scheduled tasks in `users/*/reminders.json`. If a task is due, execute the specified `skill_path` using `child_process.spawn`. This ensures strict OS-level isolation for dynamically generated skills.
    - **Write outputs to `/queue/pending_messages.json`** for the Gateway to send.
    - **Acquire GPU lock** before running MLX-Audio skills using `ARBITER_LOCK_PATH`
3.  **Task 2.3: The Web Janitor (`janitor.js`)**
    - PM2 process name: `friday-janitor`
    - Create a standalone Node script that loops/cron checks `web_portal` subdirectories. Delete any folder with a `birthtime` older than 24 hours.
4.  **Task 2.4: Safe File I/O**
    - Implement `write-file-atomic` across all Node processes to ensure JSON/MD file writes don't corrupt during concurrent requests from the separate PM2 workers.

5.  **Task 2.5: Memory Manager (`memory-manager.js`)**
    - Create `/core/memory-manager.js` with JSONL append-only pattern
    - Implement `appendMemory(userId, role, content)` - atomic append to `memory.log`
    - Implement `getRecentContext(userId, limit)` - reads last N lines from JSONL
    - Replace old JSON array rewrite pattern with this for crash safety

---

## Phase 2.5: Evolution Process (PM2)

**Goal:** Build the standalone Evolution process for background skill generation.

1.  **Task 2.5.1: Evolution Process (`evolution.js`)**
    - PM2 process name: `friday-evolution`
    - Standalone Node process that polls `/queue/evolution/pending/`
    - Implements 10-round iteration loop with error feedback
    - Writes progress updates to `/queue/pending_messages.json` after each round
    - **Calls GLM-5 via Z.ai Cloud API** (not local)
    - **Acquire GPU lock** before calling cloud API to prevent conflicts
    - Handles job timeouts (30min total)

---

## Phase 3: Python Skill Environment (Conda & MLX)

**Goal:** Setup the sandboxed Python execution layer for data processing and audio.

1.  **Task 3.1: Conda Environment Setup**
    - Create `friday-skills` environment.
    - Install: `mlx-whisper`, `mlx-audio`, `python-dotenv`, `requests`, `pandas`, `playwright`.
2.  **Task 3.2: Shared `ai_utils.py`**
    - Create a utility script in `/skills` that reads the `.env`
    - Provides `call_local_ai()` function for Local LLM (LM Studio)
    - Provides `call_cloud_glm5()` function for GLM-5 Cloud API (Z.ai)
    - Implements `wait_for_gpu()` - GPU Resource Arbiter to prevent conflicts
    - All Python skills must import and use these functions
3.  **Task 3.3: MLX Voice Models (Built-in Skills)**
    - **STT:** Script to take `.ogg` from WhatsApp and return text using `mlx-whisper` to stdout.
    - **TTS:** Script to take text and generate `.mp3` using `qwen3-tts` or `ming-omni` via MLX.

---

## Phase 4: Built-in Skills Implementation

**Goal:** Deploy the core "Superpowers."

1.  **Task 4.1: Live Browser Skill**
    - Node.js script using Playwright to connect to Chrome via port `9222`.
    - Implement basic actions: `goto`, `screenshot`, `scrape_text`, `run_js`.
2.  **Task 4.2: Google Search Skill**
    - Node.js script using Google Custom Search API. Return results as a JSON object for the LLM to read.
3.  **Task 4.3: Static Page Generator (SSG)**
    - Create a Python helper that takes a JSON dataset and a Jinja2 template to output a styled `index.html` into a unique hashed folder in `web_portal`.

---

## Phase 5: The Skill Factory (Evolution) - Async Background Process

**Goal:** Enable the system to write its own code via Cloud AI WITHOUT blocking live message handling. Uses iterative refinement (like Claude Code) - up to 10 rounds.

1.  **Task 5.1: Evolution Queue Setup**
    - Create directory structure: `/queue/evolution/pending`, `/queue/evolution/processing`, `/queue/evolution/completed`
    - Define job schema: `{ id, user_id, request, status, current_round, max_rounds: 10, round_timeout_sec: 60, total_timeout_min: 30, error_history: [], created_at, updated_at, result }`

2.  **Task 5.2: Non-Blocking Trigger**
    - Logic: If Local LLM returns `{"error": "no_skill_found"}`, Gateway immediately sends "Creating skill... (this may take a few minutes)" to user
    - Create job file in `/queue/evolution/pending/[job_id].json` with `max_rounds: 10`
    - Gateway returns control immediately - live messaging continues

3.  **Task 5.3: Background Worker (Evolution Runner)**
    - Separate Node process polls `/queue/evolution/pending/`
    - Pick up job, move to `/queue/evolution/processing/`
    - **For each round (1-10):**
      - **Call GLM-5 via Z.ai Cloud API** with Python template + `error_history` from previous rounds
      - Save generated code to `/skills/generated/temp_[job_id].py`

4.  **Task 5.4: Sandboxed Test Run (per round)**
    - Execute generated code via `child_process.spawn` with 60s timeout
    - Capture stdout, stderr, and exit code
    - Evaluate: if exit code = 0 and no stderr → **SUCCESS** → Next Task
    - If failed → append error to `error_history` → continue to next round
    - **Use GPU lock** (`wait_for_gpu()` from ai_utils) before any MLX or LLM calls

5.  **Task 5.5: Round-based Retry (max 10 rounds)**
    - Each round feeds back the error from previous attempt
    - After 10 failed rounds: mark job as "failed"
    - Total timeout: 30 minutes (give up even if fewer than 10 rounds used time)

6.  **Task 5.6: Deployment & Notification**
    - On success: rename temp file to `/skills/generated/[skill_name].py`
    - Write result to `/queue/pending_messages.json`: "Your skill '[name]' is ready!"
    - On failure after 10 rounds: Write error summary: "Couldn't create skill after 10 attempts. Summary: [last 3 errors]"
    - Gateway picks up and sends WhatsApp message to user

---

## Phase 6: Multi-User Integration

**Goal:** Ensure data isolation, personality switching, and historical context.

1.  **Task 6.1: Context Assembler & Memory Log**
    - Logic: Use a rolling JSON array (`memory.json`) instead of flat markdown to prevent cutoff errors.
    - Before calling the Local LLM, assemble: `[Agent Prompt] + [Last N elements of memory.json injected as structured messages] + [Tool Definitions]`.
2.  **Task 6.2: Personality Switcher**
    - Implement a WhatsApp command (e.g., `!switch Alfred`) that updates the `agent` field in the user's `profile.json`.

---

## Final Delivery Checklist for Code Agent

- [ ] Does the `core` use `dotenv` to avoid hardcoded strings?
- [ ] Do file writes use atomic locking (`write-file-atomic`) to prevent corruption?
- [ ] Does the `Janitor` successfully delete folders?
- [ ] Can the Python environment access the Mac Mini GPU (Metal) for MLX?
- [ ] Does the Scheduler write to `/queue/pending_messages.json` and Gateway poll it?
- [ ] Are PM2 processes named (`friday-gateway`, `friday-scheduler`, `friday-janitor`, `friday-evolution`)?
- [ ] Is the Chat model set to Qwen3.5-35B-A3B via LM Studio?
- [ ] Does Evolution send progress updates after each round?
      **Would you like me to generate the actual `tools.json` structure so the Code Agent knows how to register these skills?**

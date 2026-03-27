# PM2 Ecosystem Configuration

## Overview

The PM2 ecosystem file orchestrates all 4 Node.js processes for Project Friday. Each process runs independently, providing isolation and crash recovery.

---

## ecosystem.config.js

```javascript
// ecosystem.config.js

module.exports = {
  apps: [
    // ========================================
    // 1. WhatsApp Gateway
    // ========================================
    {
      name: "friday-gateway",
      script: "./core/gateway.js",
      cwd: "./",
      interpreter: "none", // Native ES modules
      env: {
        NODE_ENV: "production",
        USER_DATA_ROOT: "./users",
        WEB_PORTAL_ROOT: "./web_portal",
        QUEUE_PATH: "./queue",
        AI_PROVIDER: "lmstudio",
        AI_BASE_URL: "http://localhost:1234/v1",
        CHAT_MODEL: "qwen/qwen3.5-35b-a3b",
      },
      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: "10s",
      // Logging
      out_file: "./logs/gateway-out.log",
      error_file: "./logs/gateway-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // Performance
      max_memory_restart: "500M",
    },

    // ========================================
    // 2. Heartbeat / Scheduler
    // ========================================
    {
      name: "friday-scheduler",
      script: "./core/heartbeat.js",
      cwd: "./",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        USER_DATA_ROOT: "./users",
        QUEUE_PATH: "./queue",
        CHECK_INTERVAL_MS: "60000",
        ARBITER_LOCK_PATH: "./temp/gpu_active.lock",
      },
      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: "10s",
      // Logging
      out_file: "./logs/scheduler-out.log",
      error_file: "./logs/scheduler-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // Performance
      max_memory_restart: "300M",
    },

    // ========================================
    // 3. Web Janitor
    // ========================================
    {
      name: "friday-janitor",
      script: "./core/janitor.js",
      cwd: "./",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        WEB_PORTAL_ROOT: "./web_portal",
        PAGE_EXPIRY_HOURS: "24",
      },
      // Run every hour (cron style)
      schedule: "0 * * * *", // Every hour at minute 0
      // Or use interval-based (uncomment below):
      // script will handle its own interval
      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 5,
      min_uptime: "5s",
      // Logging
      out_file: "./logs/janitor-out.log",
      error_file: "./logs/janitor-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // Performance
      max_memory_restart: "200M",
    },

    // ========================================
    // 4. Evolution / Skill Factory
    // ========================================
    {
      name: "friday-evolution",
      script: "./core/evolution.js",
      cwd: "./",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        USER_DATA_ROOT: "./users",
        QUEUE_PATH: "./queue",
        SKILLS_PATH: "./skills",
        CLOUD_AI_KEY: process.env.CLOUD_AI_KEY,
        CLOUD_AI_URL: "https://api.z.ai/v1",
        EVOLUTION_MODEL: "glm-5",
        EVOLUTION_MAX_ROUNDS: "10",
        EVOLUTION_ROUND_TIMEOUT_SEC: "60",
        EVOLUTION_TOTAL_TIMEOUT_MIN: "30",
        ARBITER_LOCK_PATH: "./temp/gpu_active.lock",
      },
      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 5,
      min_uptime: "10s",
      // Logging
      out_file: "./logs/evolution-out.log",
      error_file: "./logs/evolution-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // Performance - Evolution can use more memory for LLM context
      max_memory_restart: "1G",
    },
  ],
};
```

---

## Installation & Usage

### 1. Install PM2 globally (if not already)

```bash
npm install -g pm2
```

### 2. Create log directory

```bash
mkdir -p logs
```

### 3. Start all processes

```bash
pm2 start ecosystem.config.js
```

### 4. View status

```bash
pm2 status

# Output:
# ┌─────────────┬───────┬─────────┬──────┬───────┬────────┬──────────┬──────┐
# │ Name        │ mode  │ status  │ ↺    │ cpu   │ memory │ user     │ node │
# ├─────────────┼───────┼─────────┼──────┼───────┼────────┼──────────┼──────┤
# │ friday-gateway   │ fork  │ online │ 0    │ 0%    │ 150MB  │ ubuntu   │ v20  │
# │ friday-scheduler │ fork  │ online │ 0    │ 0%    │ 80MB   │ ubuntu   │ v20  │
# │ friday-janitor   │ fork  │ online │ 0    │ 0%    │ 50MB   │ ubuntu   │ v20  │
# │ friday-evolution  │ fork  │ online │ 0    │ 0%    │ 200MB  │ ubuntu   │ v20  │
# └─────────────┴───────┴─────────┴──────┴───────┴────────┴──────────┴──────┘
```

### 5. View logs

```bash
pm2 logs friday-gateway
pm2 logs --err friday-evolution
pm2 logs --lines 50
```

### 6. Restart specific process

```bash
pm2 restart friday-gateway
```

### 7. Restart all

```bash
pm2 restart all
```

### 8. Stop all

```bash
pm2 stop all
```

### 9. Save process list (auto-start on reboot)

```bash
pm2 save
pm2 startup
```

---

## Process Health Monitoring

Each process writes status to `/queue/status/[process].json`:

```json
// /queue/status/friday-gateway.json
{
  "name": "friday-gateway",
  "status": "running",
  "pid": 12345,
  "uptime": "2026-03-27T10:00:00Z",
  "memory": "150MB",
  "cpu": "2%",
  "restarts": 0,
  "last_error": null
}
```

---

## Process Dependencies

```
┌─────────────────────────────────────────────────────────┐
│                    PM2 Process Tree                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  friday-gateway  ─┬──> WhatsApp (Baileys)              │
│       │           │    • Sends messages                 │
│       │           │    • Receives messages              │
│       │           │    • Polls queue                    │
│       │           └──> Memory (JSONL)                   │
│       │                • Reads context                  │
│       │                • Appends messages              │
│       │                                                     │
│  friday-scheduler │──> Skills (child_process)           │
│       │           │    • Runs Node.js skills            │
│       │           │    • Runs Python (Conda) skills     │
│       │           │    • GPU lock for MLX              │
│       │           └──> Reminders (JSON)                 │
│       │                • Checks time triggers           │
│       │                                                     │
│  friday-janitor   │──> Web Portal (files)              │
│       │           │    • Deletes expired pages         │
│       │           │    • 24-hour expiry                 │
│       │                                                     │
│  friday-evolution │──> Skills (generated)             │
│       │           │    • Creates new skills            │
│       │           │    • 10-round refinement           │
│       │           └──> Cloud API (GLM-5/Z.ai)         │
│       │                • Code generation               │
│       │                                                     │
└─────────────────────────────────────────────────────────┘
```

---

## Common Issues & Solutions

| Issue                    | Solution                                   |
| ------------------------ | ------------------------------------------ |
| Gateway keeps restarting | Check `gateway-err.log` for errors         |
| Scheduler not triggering | Verify `reminders.json` format             |
| Evolution not starting   | Check `CLOUD_AI_KEY` is set in `.env`      |
| Memory too high          | Check for memory leaks, restart process    |
| All processes down       | Run `pm2 resurrect` to restore saved state |

---

## Startup Script (for Mac Mini)

Create `start-friday.sh`:

```bash
#!/bin/bash
cd /home/ubuntu/Friday-Project
source ~/.nvm/nvm.sh
pm2 start ecosystem.config.js
pm2 save
```

Make executable:

```bash
chmod +x start-friday.sh
```

Add to Launch Agents for auto-start on login.

# Scheduler / Heartbeat Design

## Overview

The Scheduler (Heartbeat) is the deterministic background process that checks reminders and triggers skills. It runs as `friday-scheduler` in PM2 - NOT using the LLM, but directly executing skills based on time-based triggers.

## PM2 Configuration

- **Process Name:** `friday-scheduler`
- **File:** `core/heartbeat.js` (or `scheduler.js`)
- **Restart Policy:** Restart on crash with 10s delay

---

## Core Responsibilities

1. **Scan Reminders** - Check each user's `reminders.json` every 60 seconds
2. **Trigger Skills** - Execute skill when reminder time is due
3. **Handle Recurring** - Keep recurring reminders, remove one-time after execution
4. **Queue Output** - Write skill results to `/queue/pending_messages.json`

---

## Implementation - heartbeat.js

```javascript
// core/heartbeat.js

import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { spawn } from "child_process";
import "dotenv/config";

const CHECK_INTERVAL = 60000; // 1 minute

/**
 * Main heartbeat loop - runs every 60 seconds
 */
function checkReminders() {
  const usersDir = process.env.USER_DATA_ROOT;

  if (!fs.existsSync(usersDir)) return;

  const users = fs.readdirSync(usersDir).filter((f) => !f.startsWith("."));

  users.forEach((user) => {
    const reminderPath = path.join(usersDir, user, "reminders.json");
    if (!fs.existsSync(reminderPath)) return;

    try {
      let reminders = JSON.parse(fs.readFileSync(reminderPath, "utf8"));
      const now = new Date();
      let changed = false;

      // Filter and trigger due reminders
      const remaining = reminders.filter((rem) => {
        const remTime = new Date(rem.time);

        if (now >= remTime) {
          console.log(`⏰ Triggering: ${rem.skill} for ${user} at ${remTime}`);
          executeSkill(rem.skill, user, rem.args || {});

          // Keep if recurring, remove if one-time
          return rem.repeat !== null;
        }
        return true;
      });

      // Update if any removed
      if (remaining.length !== reminders.length) {
        fs.writeFileSync(reminderPath, JSON.stringify(remaining, null, 2));
      }
    } catch (e) {
      console.error(`Error processing reminders for ${user}:`, e.message);
    }
  });
}

/**
 * Execute a skill (Node.js or Python)
 */
function executeSkill(skillName, userId, args) {
  // Determine skill type and path
  const isBuiltin = fs.existsSync(
    path.join(process.cwd(), "skills/builtin", skillName),
  );
  const skillPath = isBuiltin
    ? path.join(process.cwd(), "skills/builtin", skillName, "index.js")
    : path.join(process.cwd(), "skills/generated", skillName, "run.py");

  if (!fs.existsSync(skillPath)) {
    console.error(`Skill not found: ${skillName}`);
    return;
  }

  // Prepare command
  const isPython = skillPath.endsWith(".py");
  const payload = JSON.stringify({ userId, ...args });

  if (isPython) {
    // Use Conda environment
    const cmd = `conda run -n friday-skills python ${skillPath}`;

    const proc = spawn("bash", ["-c", `${cmd} '${payload}'`], {
      cwd: process.cwd(),
    });

    proc.stdout.on("data", (data) => {
      const output = data.toString().trim();
      if (output) queueMessage(userId, output);
    });

    proc.stderr.on("data", (data) => {
      console.error(`Skill error: ${data}`);
    });
  } else {
    // Node.js skill
    const proc = spawn("node", [skillPath], {
      cwd: process.cwd(),
      env: { ...process.env, PAYLOAD: payload },
    });

    proc.stdout.on("data", (data) => {
      const output = data.toString().trim();
      if (output) queueMessage(userId, output);
    });

    proc.stderr.on("data", (data) => {
      console.error(`Skill error: ${data}`);
    });
  }
}

/**
 * Write result to message queue for Gateway to send
 */
function queueMessage(userId, content) {
  const queuePath = path.join(process.cwd(), "queue", "pending_messages.json");

  let messages = [];
  if (fs.existsSync(queuePath)) {
    messages = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  }

  messages.push({
    id: require("crypto").randomUUID(),
    to: userId,
    message: content,
    type: "text",
    timestamp: new Date().toISOString(),
    retry: 0,
    status: "pending",
  });

  fs.writeFileSync(queuePath, JSON.stringify(messages, null, 2));
}

// Start the heartbeat
console.log("❤️ Heartbeat started - checking every 60s");
setInterval(checkReminders, CHECK_INTERVAL);
```

---

## Reminder JSON Format

```json
// users/+1234567890/reminders.json
[
    {
        "id": "uuid",
        "skill": "gold_tracker",
        "time": "2026-03-27T10:00:00Z",
        "args": { "symbol": "GC=F" },
        "repeat": "daily" | "weekly" | null
    },
    {
        "id": "uuid",
        "skill": "weather_alert",
        "time": "2026-03-27T07:00:00Z",
        "args": { "location": "Hong Kong" },
        "repeat": "daily"
    },
    {
        "id": "uuid",
        "skill": "workout_reminder",
        "time": "2026-03-28T18:00:00Z",
        "args": {},
        "repeat": null
    }
]
```

### Repeat Values

| Value      | Meaning                          |
| ---------- | -------------------------------- |
| `"daily"`  | Same time every day              |
| `"weekly"` | Same time every week             |
| `null`     | One-time, delete after execution |

---

## Skill Output Handling

Skills can return messages in two ways:

### 1. Direct Output (stdout)

```python
# Python skill
print("Gold is at $1950!")
# Heartbeat captures this and queues it
```

### 2. JSON Response

```python
import json
result = {"success": True, "message": "Your gold alert: $1950!"}
print(json.dumps(result))
# Heartbeat parses and extracts .message
```

---

## GPU Lock Integration

For skills that use MLX-Audio or Local LLM:

```javascript
// In executeSkill(), add GPU lock for certain skills
const gpuSkills = ["voice", "gold_tracker", "stock_alert"];

if (gpuSkills.includes(skillName)) {
  const lockPath = path.join(process.cwd(), "temp", "gpu_active.lock");
  fs.writeFileSync(lockPath, new Date().toISOString());
  // Skill will delete it when done
}
```

---

## Error Handling

| Scenario                  | Handling                |
| ------------------------- | ----------------------- |
| User folder doesn't exist | Skip silently           |
| reminders.json corrupted  | Log error, skip user    |
| Skill not found           | Log error, continue     |
| Skill execution timeout   | Kill process, log error |
| Queue write failure       | Retry 3 times, then log |

---

## Adding Reminders (via WhatsApp)

Users can add reminders via commands:

```
!remind daily 10:00 gold_price
!remind weekly monday 18:00 workout
!remind 2026-03-28 09:00 meeting
```

The Gateway parses these and writes to `reminders.json`.

---

## Configuration (.env)

```env
# Scheduler
CHECK_INTERVAL_MS=60000
USER_DATA_ROOT=./users
QUEUE_PATH=./queue
ARBITER_LOCK_PATH=./temp/gpu_active.lock
```

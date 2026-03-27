# Skill Factory Design (Custom Skills)

## Overview

The Skill Factory (Evolution) allows Friday to automatically generate new Python skills based on user requests. This is a self-evolving system that can extend Friday's capabilities without manual programming.

## Type

- **Evolution System** (Node.js + Python + GLM-5 Cloud API (Z.ai))
- **Language:** Python (generated skills)
- **PM2 Integration:** Runs in `friday-evolution` process

---

## GPU Resource Arbiter

The Evolution process uses GLM-5 Cloud API, but it must check the GPU lock to prevent conflicts with local MLX-Audio and Local LLM.

```python
import os, time

def wait_for_gpu():
    """Arbiter: Prevents Cloud Evolution from starting if Local GPU is busy"""
    lock_path = os.getenv("ARBITER_LOCK_PATH", "./temp/gpu_active.lock")
    while os.path.exists(lock_path):
        time.sleep(2)
    # Create lock to indicate we're using GPU (if needed for cloud)
    # For cloud API, we just wait until local processes release

def call_cloud_glm5(prompt, system_msg="You are Friday's Evolution Engine."):
    """Calls the GLM-5 Cloud API (Z.ai) for high-reasoning coding tasks"""
    wait_for_gpu()  # Ensure we don't choke the Mac Mini

## Core Responsibilities

1. **Detect** - Identify when user wants a new skill
2. **Generate** - Create Python code via GLM-5
3. **Test** - Run generated code in sandbox
4. **Refine** - Fix errors with up to 10 rounds
5. **Deploy** - Register and activate new skill
6. **Notify** - Inform user of result

---

## Directory Structure

```
/skills/
├── builtin/              # Pre-installed skills
│   ├── browser/
│   ├── search/
│   ├── voice/
│   └── static_page/
├── generated/            # AI-generated skills
│   ├── gym_tracker.py
│   ├── stock_alert.py
│   └── ...
├── templates/           # Code generation templates
│   ├── skill_template.py
│   └── skill_test.py
├── registry.json        # Skill registry
└── ai_utils.py         # Shared utilities for all skills

/queue/evolution/
├── pending/             # Jobs waiting to be processed
│   └── [uuid].json
├── processing/         # Currently running jobs
│   └── [uuid].json
└── completed/          # Finished jobs
    └── [uuid].json
```

---

## Skill Template (For AI)

Every generated skill follows this structure:

```python
#!/usr/bin/env python3
"""
Auto-generated skill: [SKILL_NAME]
Generated: [TIMESTAMP]
User: [USER_ID]

IMPORTANT: Always call wait_for_gpu() before using MLX or Local LLM
"""

import sys
import os
import json
from datetime import datetime

# Add skills directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import shared utilities - includes GPU arbiter
from ai_utils import (
    call_local_ai,
    call_cloud_glm5,
    read_env,
    get_user_profile,
    wait_for_gpu
)

# === CONFIGURATION ===
SKILL_NAME = "[SKILL_NAME]"
VERSION = "1.0.0"

# === SKILL PARAMETERS ===
PARAMETERS = {
    # Define required parameters here
    # "symbol": {"type": "string", "required": True},
    # "threshold": {"type": "number", "required": False, "default": 5}
}

def validate_params(params):
    """Validate input parameters."""
    for key, config in PARAMETERS.items():
        if config.get("required", False) and key not in params:
            return False, f"Missing required parameter: {key}"
    return True, None

def logic(params: dict, user_id: str) -> dict:
    """
    Main skill logic.

    Args:
        params: Dictionary of parameters from user
        user_id: User's phone number

    Returns:
        dict with keys:
        - success: bool
        - message: str (for WhatsApp)
        - data: dict (optional, for static page)
    """
    # === USER CODE HERE ===
    # Access user data:
    # profile = get_user_profile(user_id)
    # memory = get_user_memory(user_id)

    # Call LLM for complex reasoning:
    # response = call_local_ai("As Friday, analyze this data...")

    # Return result
    return {
        "success": True,
        "message": "Your skill result here!",
        # Optional: generate static page
        # "static_page": {"type": "chart", "data": [...]}
    }

def main():
    """Entry point - called by Node.js"""
    # Read input from stdin (JSON)
    input_data = json.loads(sys.stdin.read())

    params = input_data.get("params", {})
    user_id = input_data.get("user_id", "")

    # Validate
    valid, error = validate_params(params)
    if not valid:
        print(json.dumps({"success": False, "error": error}))
        sys.exit(1)

    # Execute
    try:
        result = logic(params, user_id)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
```

---

## Evolution Workflow (10 Rounds)

```
User: "Track my gym workouts"
         │
         ▼
┌─────────────────────────────────────────┐
│ Gateway: Immediate reply               │
│ "Creating skill... (non-blocking)"     │
└────────┬────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Evolution Job Created                  │
│ /queue/evolution/pending/[uuid].json  │
└────────┬────────────────────────────────┘
         │
         ▼
    ┌────┴────┐
    │  Round  │
    │   1-10  │
    └────┬────┘
         │
         ├───────────────────────┐
         │                       │
         ▼                       ▼
   ┌──────────┐           ┌──────────┐
   │ Generate │           │  Error   │
   │  Code   │           │   from   │
   └────┬────┘           │  Test   │
        │                 └────┬────┘
        │                      │
        ▼                      │
   ┌──────────┐                │
   │ Test Run │                │
   │(sandbox)│                │
   └────┬────┘                │
        │                      │
    ┌───┴───┐                  │
    │       │                  │
    ▼       ▼                  │
 Success   Fail ────────────────┘
    │       │
    │       └────────────────────┐
    │                            │
    ▼                            ▼
┌──────────┐              ┌──────────┐
│ Deploy  │              │ Next Round│
│ Skill   │              │ + Error   │
└──────────┘              │ History  │
    │                     └──────────┘
    │                            │
    └────────────────────────────┘
         (max 10 rounds)
```

---

## Prompt to GLM-5

### Initial Generation Prompt

```
You are an expert Python programmer. Create a skill for Friday (a personal AI assistant).

User Request: "{user_request}"
User ID: {user_id}

Follow this template exactly:
{template_content}

Requirements:
1. Only write the `logic()` function
2. Use `call_local_ai()` from ai_utils for LLM calls
3. Return dict with "success", "message", optionally "static_page"
4. Use type hints where possible
5. Keep it simple and functional
```

### Error Fix Prompt

```
The code you generated failed with this error:

Error: {error_message}
Stderr: {stderr_output}

Previous code:
{previous_code}

Please fix the error and return the corrected `logic()` function only.
```

---

## Job JSON Schema

```json
{
  "id": "uuid-v4",
  "user_id": "+1234567890",
  "request": "Track my gym workouts from WhatsApp messages",
  "status": "pending" | "processing" | "completed" | "failed",
  "current_round": 1,
  "max_rounds": 10,
  "round_timeout_sec": 60,
  "total_timeout_min": 30,
  "error_history": [
    {
      "round": 1,
      "error": "ModuleNotFoundError: No module named 'pandas'",
      "timestamp": "2026-03-27T09:00:00Z"
    }
  ],
  "code_history": [
    {
      "round": 1,
      "code": "import pandas as pd...",
      "test_result": "failed"
    }
  ],
  "created_at": "2026-03-27T09:00:00Z",
  "updated_at": "2026-03-27T09:05:00Z",
  "completed_at": null,
  "result": null
}
```

---

## Skill Registry

```json
// /skills/registry.json
{
  "skills": {
    "browser": {
      "name": "Live Browser",
      "file": "/skills/builtin/browser/index.js",
      "type": "builtin"
    },
    "gym_tracker": {
      "name": "Gym Workout Tracker",
      "file": "/skills/generated/gym_tracker.py",
      "type": "generated",
      "generated_by": "evolution",
      "user_id": "+1234567890",
      "created_at": "2026-03-27T09:00:00Z",
      "version": "1.0.0",
      "parameters": {
        "action": { "type": "string", "enum": ["track", "summary"] }
      }
    }
  }
}
```

---

## Execution (Sandboxed)

```javascript
// How Node.js calls generated Python skill
const { spawn } = require("child_process");

async function runSkill(skillPath, params, userId) {
  return new Promise((resolve, reject) => {
    const process = spawn("python3", [skillPath], {
      timeout: 60000, // 60s timeout
      env: { ...process.env, USER_ID: userId },
    });

    process.stdin.write(JSON.stringify({ params, user_id: userId }));
    process.stdin.end();

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => (stdout += data));
    process.stderr.on("data", (data) => (stderr += data));

    process.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error("Invalid JSON output"));
        }
      } else {
        reject(new Error(stderr || `Exit code: ${code}`));
      }
    });

    process.on("error", reject);
  });
}
```

---

## User Notifications

Evolution sends progress updates via queue:

| Round      | Message                                                       |
| ---------- | ------------------------------------------------------------- |
| Start      | "🤖 I'm creating a skill for you..."                          |
| Round 3    | "🔧 Round 3/10: Working on it..."                             |
| Round 6    | "🔧 Round 6/10: Almost there..."                              |
| Round fail | "🔧 Round 3/10: Hit an issue, trying a different approach..." |
| Success    | "✅ Your skill '[name]' is ready! Try: [example command]"     |
| Failed     | "❌ Couldn't create skill after 10 attempts. [summary]"       |

---

## Error Handling

| Scenario         | Handling                                  |
| ---------------- | ----------------------------------------- |
| Syntax error     | Add to error history, next round          |
| Import error     | Auto-install if possible, else next round |
| Timeout (60s)    | Kill process, add to history, next round  |
| Runtime crash    | Catch stderr, add to history, next round  |
| 10 rounds failed | Mark failed, notify user with summary     |
| Disk full        | Abort, notify user immediately            |

---

## Configuration (.env)

```env
# Evolution
EVOLUTION_MODEL=glm-5
OLLAMA_CLOUD_API_KEY=your_zai_api_key_here
Z_API_BASE_URL=https://api.z.ai/v1
EVOLUTION_MAX_ROUNDS=10
EVOLUTION_ROUND_TIMEOUT_SEC=60
EVOLUTION_TOTAL_TIMEOUT_MIN=30
SKILLS_GENERATED_PATH=/home/ubuntu/Friday-Project/skills/generated

# GPU Arbiter
ARBITER_LOCK_PATH=./temp/gpu_active.lock
```

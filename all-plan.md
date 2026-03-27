./plan/design-browser.md
---
# Live Browser Skill Design

## Overview

The Live Browser skill allows Friday to interact with websites in real-time using a non-headless Chrome browser. This is crucial for tasks that require JavaScript rendering, login sessions, or interactive web features.

## Type

- **Built-in Skill** (Node.js + Playwright + Chrome)
- **Language:** Node.js
- **PM2 Integration:** Runs via `child_process.spawn` from Scheduler

---

## Core Responsibilities

1. **Navigate** - Go to URLs with proper wait conditions
2. **Screenshot** - Capture page visuals for user analysis
3. **Scrape** - Extract text, tables, data from pages
4. **Interact** - Click, fill forms, scroll, execute JS
5. **Session Persistence** - Keep cookies/login state across runs

---

## Directory Structure

```
/skills/builtin/
├── browser/
│   ├── index.js           # Main skill entry point
│   ├── chrome-manager.js  # Chrome launch & lifecycle
│   ├── actions.js         # Action handlers (goto, click, etc.)
│   └── selectors.js        # Common selector patterns
├── chrome-profile/         # Chrome user data directory
│   └── default/           # Default profile with sessions
```

---

## Chrome Configuration

### Launch Options (Non-Headless)

```javascript
{
  headless: false,
  userDataDir: './skills/builtin/chrome-profile/default',
  args: [
    '--remote-debugging-port=9222',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--start-maximized'
  ]
}
```

### Why Non-Headless?

- Maintains login sessions (Google, banking, etc.)
- Renders complex JavaScript properly
- User can see what's happening on desktop

---

## Available Actions

### 1. goto(url, waitUntil = 'networkidle')

Navigate to a URL and wait for page load.

```javascript
// Example
await browser.goto("https://example.com", "networkidle");
```

### 2. screenshot(name = 'screenshot')

Capture current page and save to `/web_portal/[user]/[hash]/[name].png`

```javascript
// Returns path to screenshot
const path = await browser.screenshot("gold-prices");
```

### 3. scrape_text(selector)

Extract text content from elements.

```javascript
// Get all paragraph text
const text = await browser.scrape_text("p");

// Get specific element
const price = await browser.scrape_text(".gold-price");
```

### 4. click(selector)

Click an element (button, link, etc.).

```javascript
await browser.click("#submit-button");
await browser.click('button:has-text("Login")');
```

### 5. fill(selector, text)

Fill an input field.

```javascript
await browser.fill("#search-input", "gold price today");
```

### 6. evaluate(script)

Run custom JavaScript in page context.

```javascript
const title = await browser.evaluate(() => document.title);
const prices = await browser.evaluate(() => {
  return Array.from(document.querySelectorAll(".price")).map(
    (el) => el.textContent,
  );
});
```

### 7. wait_for_selector(selector, timeout = 10000)

Wait for element to appear.

```javascript
await browser.wait_for_selector(".loading-complete", 30000);
```

### 8. scroll_down(pixels = 500)

Scroll the page.

```javascript
await browser.scroll_down(1000);
```

---

## Skill Registration

```json
// /skills/registry.json
{
  "browser": {
    "name": "Live Browser",
    "version": "1.0.0",
    "description": "Interact with websites, take screenshots, scrape data",
    "file": "/skills/builtin/browser/index.js",
    "parameters": {
      "action": {
        "type": "string",
        "enum": [
          "goto",
          "screenshot",
          "scrape_text",
          "click",
          "fill",
          "evaluate",
          "wait_for_selector",
          "scroll_down"
        ],
        "required": true
      },
      "url": { "type": "string" },
      "selector": { "type": "string" },
      "text": { "type": "string" },
      "script": { "type": "string" },
      "timeout": { "type": "number" }
    }
  }
}
```

---

## Usage Example from LLM

```javascript
// LLM generates this call:
{
  "skill": "browser",
  "action": "goto",
  "url": "https://www.gold.org/gold-price"
}

// Result returned to LLM:
{
  "success": true,
  "screenshot": "/web_portal/+1234567890/abc123/gold-prices.png",
  "text": "Gold price today: $1950.30 per ounce"
}
```

---

## Error Handling

| Scenario             | Handling                                                |
| -------------------- | ------------------------------------------------------- |
| Chrome not installed | Return error: "Chrome not found"                        |
| Page timeout         | Return error after 30s                                  |
| Invalid selector     | Return error with selector details                      |
| JavaScript error     | Return error message from page                          |
| Session expired      | Return error: "Session expired, user needs to re-login" |

---

## Web Portal Integration

Screenshots and scraped data are saved to:

```
/web_portal/[phone_number]/[session_hash]/
├── screenshots/
│   └── gold-prices.png
├── data.json
└── index.html  (auto-generated view)
```

Friday sends Cloudflare tunnel link to user.

---

## Maintenance Notes

1. **Chrome Profile:** Regularly clean old sessions
2. **Debugging:** Connect to Chrome DevTools at `http://localhost:9222`
3. **Memory:** Chrome can use significant RAM; limit concurrent sessions
4. **Security:** Don't store sensitive cookies in git-ignored profile


---
./plan/design-gateway.md
---
# WhatsApp Gateway Design

## Overview

The WhatsApp Gateway (`gateway.js`) is the primary interface for users to interact with Friday. It handles receiving and sending messages via WhatsApp using the baileys library.

## PM2 Configuration

- **Process Name:** `friday-gateway`
- **File:** `core/gateway.js`
- **Restart Policy:** Restart on crash with 10s delay

---

## Core Responsibilities

### 1. WhatsApp Connection Management

- QR code authentication (first-time setup)
- Session persistence (store auth info in JSON)
- Auto-reconnect on disconnect
- Connection health monitoring

### 2. Message Reception

- Listen for incoming messages from whitelist (`.env: ALLOWED_NUMBERS`)
- Extract message text, audio (voice notes), images
- Route to appropriate handler:
  - Text → LLM processing
  - Audio → MLX STT → LLM processing
  - Images → Process and send to LLM

### 3. Message Sending

- Poll `/queue/pending_messages.json` every 5 seconds
- Send WhatsApp messages to users
- Handle sending failures (retry up to 3 times)

### 4. Context Assembly

- Load user profile from `/users/[phone]/profile.json`
- Load memory from `/users/[phone]/memory.json`
- Combine with agent prompt for LLM request

---

## Directory Structure

```
/core/
├── gateway.js           # Main gateway process
├── whatsapp/
│   ├── client.js       # Baileys client wrapper
│   ├── auth.js         # Session management
│   └── handlers/
│       ├── message.js  # Incoming message handler
│       ├── media.js    # Media processing
│       └── queue.js    # Outgoing message queue
```

---

## Message Flow

```
Incoming WhatsApp Message
         │
         ▼
┌─────────────────┐
│ gateway.js     │
│ (receives)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Validate       │ ─── If not in whitelist → ignore
│ phone number   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Process Media  │ ─── Audio → MLX STT
│ if needed      │ ─── Image → download & describe
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Assemble       │ ─── profile + memory + current message
│ Context        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Call Local LLM │ ─── Qwen3.5-35B-A3B via LM Studio
│ (gateway.js)   │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐ ┌────────┐
│ Skill │ │ Direct │
│ Found │ │ Reply  │
└───┬───┘ └───┬────┘
    │         │
    ▼         │
┌───────────┐ │
│ Execute   │ │
│ Skill     │ │
└─────┬─────┘ │
      │       │
      ▼       ▼
  Write to /queue/pending_messages.json
            │
            ▼
      Gateway polls & sends
```

---

## Configuration (.env)

```env
# WhatsApp
ALLOWED_NUMBERS=+1234567890,+0987654321
SESSION_PATH=./sessions

# LLM
AI_PROVIDER=lmstudio
AI_BASE_URL=http://localhost:1234/v1
CHAT_MODEL=qwen3.5-35b-a3b
```

---

## Queue Message Format

```json
// /queue/pending_messages.json
[
  {
    "id": "uuid",
    "to": "+1234567890",
    "message": "Your gold price alert: $1950 (+1.2%)",
    "type": "text" | "image" | "audio",
    "media_path": "/path/to/file.mp3",
    "timestamp": "2026-03-27T09:00:00Z",
    "retry": 0,
    "status": "pending" | "sent" | "failed"
  }
]
```

---

## Error Handling

| Scenario              | Handling                             |
| --------------------- | ------------------------------------ |
| WhatsApp disconnected | Auto-reconnect, log error            |
| Invalid phone number  | Ignore, don't respond                |
| LLM timeout (60s)     | Return "I'm thinking..." placeholder |
| Queue write failure   | Retry 3 times, log to error file     |
| Message send failure  | Increment retry, max 3 attempts      |

---

## Session Management

```
First Run:
1. Generate QR code
2. User scans with WhatsApp
3. Save session to SESSION_PATH/creds.json
4. On subsequent runs, load existing session

Session File:
SESSION_PATH/
├── creds.json        # Baileys credentials
└── app.state.json    # App state cache
```

---

## Health Monitoring

Gateway writes status to `/queue/status/gateway.json`:

```json
{
  "name": "friday-gateway",
  "status": "running" | "error",
  "connected": true,
  "last_poll": "2026-03-27T09:00:00Z",
  "messages_sent_today": 42,
  "errors": []
}
```


---
./plan/design-search.md
---
# Google Search Skill Design

## Overview

The Google Search skill provides real-time web search capabilities using Google Custom Search API. It's used when Friday needs current information, news, or data not in its training set.

## Type

- **Built-in Skill** (Node.js)
- **Language:** Node.js
- **PM2 Integration:** Runs via `child_process.spawn` from Scheduler or Gateway

---

## Core Responsibilities

1. **Search** - Execute Google searches via API
2. **Parse** - Extract title, snippet, URL from results
3. **Filter** - Remove ads, spam, irrelevant results
4. **Limit** - Return top N results (configurable)

---

## Directory Structure

```
/skills/builtin/
├── search/
│   ├── index.js          # Main skill entry point
│   ├── google-api.js     # Google Custom Search API wrapper
│   └── parser.js         # Result parsing & filtering
```

---

## Google Custom Search API Setup

### Prerequisites

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project
3. Enable "Custom Search API"
4. Create credentials (API Key)
5. Get CX (Context) from [Google Programmable Search Engine](https://programmablesearchengine.google.com/)

### .env Configuration

```env
GOOGLE_SEARCH_API_KEY=AIzaSyxxxxxxxxxxxxx
GOOGLE_SEARCH_CX=xxxxxxxxxxxxxxxxxxxxx
SEARCH_MAX_RESULTS=10
```

---

## Available Actions

### 1. search(query, numResults = 10)

Execute a Google search and return results.

```javascript
// Example
const results = await search.search("gold price today", 5)[
  // Returns:
  ({
    title: "Gold Price Today - MoneyControl",
    url: "https://moneycontrol.com/gold-price",
    snippet: "Gold price today: ₹62,340 per 10g (₹1,240 change)",
    position: 1,
  },
  {
    title: "Live Gold Rate - IndiaGoldRate",
    url: "https://indiagoldrate.com",
    snippet: "Today's gold rate: ₹62,500 per 10g",
    position: 2,
  })
];
```

### 2. search_news(query, dateRange = 'week')

Search for recent news articles.

```javascript
const news = await search.search_news("bitcoin latest", "day");
// Returns news results with publish date
```

### 3. search_images(query, numImages = 5)

Search for images (returns image URLs).

```javascript
const images = await search.search_images("golden retriever", 3);
```

---

## API Response Structure

```javascript
// Raw Google API response
{
  items: [
    {
      title: "Gold Price Today",
      link: "https://example.com/gold",
      snippet: "Current gold price...",
      displayLink: "example.com",
      pagemap: {
        cse_image: [{ src: "https://..." }],
        cse_thumbnail: [{ src: "https://..." }]
      }
    }
  ]
}

// Transformed output
{
  success: true,
  query: "gold price today",
  total_results: 1000000,
  results: [
    { title, url, snippet, position }
  ],
  search_time_ms: 450
}
```

---

## Skill Registration

```json
// /skills/registry.json
{
  "search": {
    "name": "Google Search",
    "version": "1.0.0",
    "description": "Search the web for current information, news, and data",
    "file": "/skills/builtin/search/index.js",
    "parameters": {
      "action": {
        "type": "string",
        "enum": ["search", "search_news", "search_images"],
        "required": true
      },
      "query": {
        "type": "string",
        "required": true
      },
      "numResults": { "type": "number" },
      "dateRange": {
        "type": "string",
        "enum": ["day", "week", "month", "year"]
      }
    }
  }
}
```

---

## Usage Example from LLM

```javascript
// LLM generates this call:
{
  "skill": "search",
  "action": "search",
  "query": "latest iPhone 16 release date",
  "numResults": 5
}

// Result returned to LLM:
{
  "success": true,
  "query": "latest iPhone 16 release date",
  "results": [
    {
      "title": "iPhone 16: Release Date, Price, Specs",
      "url": "https://apple.com/iphone-16",
      "snippet": "Apple announces iPhone 16 lineup...",
      "position": 1
    }
  ],
  "search_time_ms": 320
}
```

---

## Caching Strategy

To reduce API calls and improve response time:

```javascript
// In-memory cache (TTL: 5 minutes)
const cache = new Map();

async function search_with_cache(query, numResults) {
  const cacheKey = `${query}:${numResults}`;

  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.data;
    }
  }

  const result = await google_search(query, numResults);
  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}
```

**Cache invalidation:**

- Manual: `!search clear` command
- Automatic: TTL-based (5 min)

---

## Error Handling

| Scenario                      | Handling                               |
| ----------------------------- | -------------------------------------- |
| No API key configured         | Return error: "Search not configured"  |
| API rate limit (100/day free) | Return warning: "Search limit reached" |
| Invalid query                 | Return empty results                   |
| Network error                 | Return error with retry suggestion     |
| No results found              | Return: "No results found for [query]" |

---

## Cost Optimization

**Google Custom Search API Limits:**

- Free tier: 100 searches/day
- Paid: $5 per 1000 searches

**Recommendations:**

1. Cache aggressively (5 min TTL)
2. Limit results to what's needed (default: 5-10)
3. Use LLM to filter before calling search
4. Monitor usage via Google Cloud Console

---

## Fallback: HTML Scraping (No API)

If API not available, can use browser skill to scrape Google results:

```javascript
// Fallback using browser skill
await browser.goto("https://www.google.com/search?q=gold+price");
await browser.scrape_text(".g");
```

**Pros:** No API key needed
**Cons:** Slower, may be blocked by Google, less reliable


---
./plan/design-skill-factory.md
---
# Skill Factory Design (Custom Skills)

## Overview

The Skill Factory (Evolution) allows Friday to automatically generate new Python skills based on user requests. This is a self-evolving system that can extend Friday's capabilities without manual programming.

## Type

- **Evolution System** (Node.js + Python + Ollama Cloud API)
- **Language:** Python (generated skills)
- **PM2 Integration:** Runs in `friday-evolution` process

---

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
"""

import sys
import os
import json
from datetime import datetime

# Add skills directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ai_utils import call_local_ai, read_env, get_user_profile

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
OLLAMA_CLOUD_API_KEY=sk-xxxxx
EVOLUTION_MAX_ROUNDS=10
EVOLUTION_ROUND_TIMEOUT_SEC=60
EVOLUTION_TOTAL_TIMEOUT_MIN=30
SKILLS_GENERATED_PATH=/home/ubuntu/Friday-Project/skills/generated
```


---
./plan/design-static-page.md
---
# Static Page Generator (SSG) Skill Design

## Overview

The Static Page Generator skill converts complex data (charts, tables, lists) into standalone HTML pages that can be shared via WhatsApp links. This is essential for displaying data that doesn't fit in a text message.

## Type

- **Built-in Skill** (Python + Jinja2)
- **Language:** Python
- **PM2 Integration:** Runs via `child_process.spawn` from any skill

---

## Core Responsibilities

1. **Generate** - Create HTML from JSON data + Jinja2 template
2. **Style** - Apply CSS for professional appearance
3. **Serve** - Save to web_portal with unique URL
4. **Share** - Return shareable Cloudflare tunnel link

---

## Directory Structure

```
/skills/builtin/
├── static_page/
│   ├── index.py           # Main skill entry point
│   ├── generator.py      # HTML generation logic
│   ├── templates/         # Jinja2 templates
│   │   ├── chart.html    # Chart display template
│   │   ├── table.html    # Table display template
│   │   ├── list.html     # List display template
│   │   └── dashboard.html # Multi-widget template
│   └── styles/           # CSS files
│       └── main.css      # Common styles
```

---

## Available Actions

### 1. generate(data, template = 'auto')

Generate a static HTML page from data.

```python
# Example: Gold price data
result = await static_page.generate({
    "type": "chart",
    "title": "Gold Prices - Last 7 Days",
    "data": [
        {"date": "2026-03-21", "price": 1900},
        {"date": "2026-03-22", "price": 1910},
        {"date": "2026-03-23", "price": 1920},
        {"date": "2026-03-24", "price": 1930},
        {"date": "2026-03-25", "price": 1940},
        {"date": "2026-03-26", "price": 1945},
        {"date": "2026-03-27", "price": 1950}
    ]
})

# Returns:
{
    "success": true,
    "path": "/web_portal/+1234567890/abc123/index.html",
    "url": "https://friday-xxx.trycloudflare.com/+1234567890/abc123/",
    "expires": "2026-03-28T09:50:37Z"
}
```

### 2. generate_from_template(template_name, data)

Use a specific template.

```python
result = await static_page.generate_from_template('table', {
    "title": "Stock Portfolio",
    "headers": ["Symbol", "Shares", "Price", "Value"],
    "rows": [
        ["AAPL", "100", "$175", "$17,500"],
        ["GOOGL", "50", "$140", "$7,000"],
        ["MSFT", "75", "$400", "$30,000"]
    ]
})
```

### 3. list_pages(user_id)

List generated pages for a user.

```python
pages = await static_page.list_pages('+1234567890')
# Returns: [{path, url, created, expires}, ...]
```

---

## Auto-Template Detection

The skill automatically selects template based on data structure:

| Data Pattern                            | Template                |
| --------------------------------------- | ----------------------- |
| Array of objects with `date` + `value`  | chart.html (line chart) |
| Array of objects with `label` + `value` | chart.html (bar chart)  |
| Array with `headers` + `rows`           | table.html              |
| Simple array                            | list.html               |
| Multiple sections                       | dashboard.html          |

---

## Template Examples

### Chart Template

```html
<!DOCTYPE html>
<html>
  <head>
    <title>{{ title }}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
      body {
        font-family: system-ui;
        padding: 20px;
      }
    </style>
  </head>
  <body>
    <h1>{{ title }}</h1>
    <canvas id="chart"></canvas>
    <script>
      new Chart(document.getElementById('chart'), {
          type: 'line',
          data: {
              labels: {{ data | map(attribute='date') | list | tojson }},
              datasets: [{
                  label: 'Price',
                  data: {{ data | map(attribute='price') | list | tojson }},
                  borderColor: '#FFD700',
                  backgroundColor: 'rgba(255, 215, 0, 0.1)',
                  fill: true
              }]
          }
      });
    </script>
  </body>
</html>
```

### Table Template

```html
<!DOCTYPE html>
<html>
  <head>
    <title>{{ title }}</title>
    <style>
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th,
      td {
        border: 1px solid #ddd;
        padding: 8px;
        text-align: left;
      }
      th {
        background-color: #f2f2f2;
      }
    </style>
  </head>
  <body>
    <h1>{{ title }}</h1>
    <table>
      <thead>
        <tr>
          {% for h in headers %}
          <th>{{ h }}</th>
          {% endfor %}
        </tr>
      </thead>
      <tbody>
        {% for row in rows %}
        <tr>
          {% for cell in row %}
          <td>{{ cell }}</td>
          {% endfor %}
        </tr>
        {% endfor %}
      </tbody>
    </table>
  </body>
</html>
```

---

## Skill Registration

```json
// /skills/registry.json
{
  "static_page": {
    "name": "Static Page Generator",
    "version": "1.0.0",
    "description": "Generate shareable HTML pages for data, charts, and tables",
    "file": "/skills/builtin/static_page/index.py",
    "parameters": {
      "action": {
        "type": "string",
        "enum": ["generate", "generate_from_template", "list_pages"],
        "required": true
      },
      "data": { "type": "object" },
      "template": { "type": "string" },
      "user_id": { "type": "string" }
    }
  }
}
```

---

## URL Structure

```
https://friday-xxx.trycloudflare.com/[phone_number]/[hash]/
                                            ├── index.html
                                            ├── data.json
                                            └── thumbnail.png (optional)
```

**Components:**

- **Phone Number:** User identifier (no + symbol)
- **Hash:** 8-character random string for uniqueness
- **Expiry:** 24 hours (Janitor deletes after)

---

## Usage from Other Skills

### From Gold Tracker Skill

```python
# gold_tracker.py generates alert
if price_change > 1:
    # Create chart page
    page = await static_page.generate({
        "type": "chart",
        "title": f"Gold Price - {date}",
        "data": price_history
    })

    # Return message with link
    message = f"📈 Gold up {price_change}%!\n{page['url']}"
    write_to_queue(user_id, message)
```

### From Reminder Skill

```python
# weekly_summary.py creates report
summary = await static_page.generate_from_template('dashboard', {
    "widgets": [
        {"type": "chart", "data": spending_data},
        {"type": "table", "data": top_transactions}
    ]
})
```

---

## Error Handling

| Scenario                 | Handling                                           |
| ------------------------ | -------------------------------------------------- |
| Template not found       | Fall back to auto-detect                           |
| Data too large (>1MB)    | Return error: "Data too large"                     |
| Jinja2 syntax error      | Log error, return partial HTML                     |
| Web portal write failure | Return error with path details                     |
| Cloudflare tunnel down   | Return local file path (user must access manually) |

---

## Janitor Integration

The Janitor process (`janitor.js`) runs hourly:

```javascript
// janitor.js
const fs = require("fs").promises;
const path = require("path");

async function cleanup() {
  const portalPath = "./web_portal";
  const dirs = await fs.readdir(portalPath);
  const now = Date.now();
  const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

  for (const dir of dirs) {
    const dirPath = path.join(portalPath, dir);
    const stats = await fs.stat(dirPath);

    if (now - stats.birthtimeMs > MAX_AGE) {
      await fs.rm(dirPath, { recursive: true });
      console.log(`Deleted: ${dir}`);
    }
  }
}
```

---

## Configuration (.env)

```env
# Static Page
WEB_PORTAL_PATH=/home/ubuntu/Friday-Project/web_portal
CLOUDFLARE_TUNNEL_URL=https://friday-xxx.trycloudflare.com
PAGE_EXPIRY_HOURS=24
MAX_DATA_SIZE_BYTES=1048576  # 1MB
```

---

## Performance Notes

- **Generation:** < 100ms for typical data
- **File Size:** HTML typically 5-50KB
- **Disk Space:** Monitor with `du -sh web_portal`
- **Auto-cleanup:** Janitor prevents accumulation


---
./plan/design-voice.md
---
# Voice Skill Design (STT/TTS)

## Overview

The Voice skill handles voice-to-text (STT) and text-to-voice (TTS) conversion using MLX-Audio optimized for Apple Silicon (M-series chips). This enables Friday to understand voice messages and respond with audio.

## Type

- **Built-in Skill** (Python + MLX)
- **Language:** Python (executed via `child_process.spawn`)
- **PM2 Integration:** Runs via Scheduler or Gateway

---

## Core Responsibilities

### STT (Speech-to-Text)

1. **Receive** - Get audio file path (WhatsApp voice note)
2. **Convert** - Transcribe using MLX Whisper
3. **Return** - Send text to LLM for processing

### TTS (Text-to-Speech)

1. **Receive** - Get text from LLM response
2. **Generate** - Convert to audio using MLX TTS
3. **Send** - Return audio file path for WhatsApp sending

---

## Directory Structure

```
/skills/builtin/
├── voice/
│   ├── index.py             # Main skill entry point
│   ├── stt.py              # Speech-to-Text (MLX Whisper)
│   ├── tts.py              # Text-to-Speech (MLX TTS)
│   └── models.py           # Model loading & caching
├── temp/                    # Temporary audio files
│   └── voice/              # Incoming voice notes
└── output/                  # Generated audio files
    └── tts/                # TTS output
```

---

## MLX-Audio Setup

### Requirements

- macOS with Apple Silicon (M1/M2/M3/M4)
- Python 3.10+
- Conda environment: `friday-skills`

### Installation

```bash
# Create conda environment
conda create -n friday-skills python=3.11
conda activate friday-skills

# Install MLX (requires macOS)
pip install mlx-audio

# Verify Metal acceleration
python -c "import mlx.core as mlx; print(mlx.metal.is_available())"
```

### Models (STT)

| Model                | Size   | Speed   | Accuracy |
| -------------------- | ------ | ------- | -------- |
| `mlx-whisper-base`   | 74MB   | Fastest | Good     |
| `mlx-whisper-small`  | 244MB  | Fast    | Better   |
| `mlx-whisper-medium` | 769MB  | Medium  | Best     |
| `mlx-whisper-large`  | 1550MB | Slow    | Best     |

**Recommended:** `mlx-whisper-small` for balance of speed/accuracy

### Models (TTS)

| Model         | Quality                |
| ------------- | ---------------------- |
| `qwen2.5-tts` | Good (recommended)     |
| `ming-omni`   | Better (multi-lingual) |

**Recommended:** `qwen2.5-tts` for English/Chinese

---

## Available Actions

### 1. transcribe(audio_path)

Convert voice note to text.

```python
# Input: /temp/voice/abc123.ogg
# Output: "What's the gold price today?"

result = await voice.transcribe('/temp/voice/abc123.ogg')
# Returns: { "text": "...", "language": "en", "duration": 3.2 }
```

### 2. speak(text, voice = 'af_sarah')

Convert text to speech.

```python
# Input: "Your gold alert: $1950 (+1.2%)"
# Output: /output/tts/xyz789.mp3

result = await voice.speak("Your gold alert: $1950 (+1.2%)")
# Returns: { "audio_path": "...", "duration": 2.5 }
```

### 3. voices()

List available TTS voices.

```python
voices = await voice.voices()
# Returns: ["af_sarah", "af_allison", "am_michael", ...]
```

---

## Skill Registration

```json
// /skills/registry.json
{
  "voice": {
    "name": "Voice (STT/TTS)",
    "version": "1.0.0",
    "description": "Convert voice to text (STT) and text to voice (TTS) using MLX-Audio",
    "file": "/skills/builtin/voice/index.py",
    "parameters": {
      "action": {
        "type": "string",
        "enum": ["transcribe", "speak", "voices"],
        "required": true
      },
      "audio_path": { "type": "string" },
      "text": { "type": "string" },
      "voice": { "type": "string" }
    }
  }
}
```

---

## WhatsApp Voice Message Flow

```
User sends voice note on WhatsApp
         │
         ▼
┌─────────────────┐
│ gateway.js     │
│ receives audio │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Download audio │ ─── WhatsApp voice is .ogg format
│ to temp folder │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Call voice      │ ─── skill: voice, action: transcribe
│ skill (STT)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MLX Whisper     │ ─── Uses Mac GPU/NPU
│ transcribes    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Return text to  │
│ LLM for reply  │
└────────┬────────┘
         │
         ▼
    ... normal flow ...
```

---

## WhatsApp TTS Response Flow

```
LLM returns text response
         │
         ▼
┌─────────────────┐
│ LLM decides to  │ ─── "Send as voice" or user requests voice
│ use TTS        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Call voice      │ ─── skill: voice, action: speak
│ skill (TTS)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MLX TTS        │ ─── Uses Mac GPU/NPU
│ generates MP3  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Write to queue │
│ for gateway    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Gateway sends  │ ─── Send audio via WhatsApp
│ audio message  │
```

---

## Audio Format Handling

| Input                 | Output            | Notes               |
| --------------------- | ----------------- | ------------------- |
| WhatsApp voice (.ogg) | .wav for Whisper  | Convert first       |
| TTS output (.wav)     | .mp3 for WhatsApp | Convert with ffmpeg |

### Conversion Script

```python
import subprocess

def convert_ogg_to_wav(input_path, output_path):
    subprocess.run([
        'ffmpeg', '-i', input_path,
        '-acodec', 'pcm_s16le', '-ar', '16000',
        output_path
    ])

def convert_wav_to_mp3(input_path, output_path):
    subprocess.run([
        'ffmpeg', '-i', input_path,
        '-codec:a', 'libmp3lame', '-q:a', '2',
        output_path
    ])
```

---

## Error Handling

| Scenario                    | Handling                             |
| --------------------------- | ------------------------------------ |
| No MLX installed            | Return error: "Voice not available"  |
| Audio file corrupted        | Return error: "Cannot read audio"    |
| Model load failure          | Return error: "Model failed to load" |
| Transcription timeout (30s) | Return partial result or error       |
| No Metal acceleration       | Fallback to CPU (slower)             |

---

## Performance Notes

- **First run:** Model loads to GPU (2-5 seconds)
- **Subsequent runs:** Instant (model stays in memory)
- **Memory:** ~2GB VRAM for Whisper-small + TTS
- **Speed:** Real-time or faster on M-series

---

## Configuration (.env)

```env
# Voice
STT_MODEL=mlx-whisper-small
TTS_MODEL=qwen2.5-tts
TTS_VOICE=af_sarah
TEMP_VOICE_PATH=/temp/voice
OUTPUT_TTS_PATH=/output/tts
```


---
./plan/project.md
---
## 1. System Vision

- **Privacy Architecture:** Zero-database. All user data is stored in human-readable Markdown, JSON, and CSV files, leveraging atomic file system writes to prevent data corruption during concurrent events.

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

| Component           | Choice               | Reason                                                                                  |
| :------------------ | :------------------- | :-------------------------------------------------------------------------------------- |
| **Orchestrator**    | Node.js (nvm)        | Handles system execution alongside Python fallback.                                     |
| **Process Manager** | PM2                  | Daemonizes and independently monitors distinct workflows (Gateway, Scheduler, Janitor, Evolution). |
| **LLM (Chat)**       | LM Studio (Qwen3.5-35B-A3B) | Local LLM server via OpenAI-compatible API.                              |
| **Evolution**       | Ollama Cloud (GLM-5) | High-reasoning "Coding" model for generating new skills.                                |
| **Audio**           | MLX-Audio            | Optimized for Mac (Qwen3-TTS / Whisper-v3).                                             |
| **Storage**         | File System          | Pure `csv`, `md`, and `json` with atomic locking. No SQL/NoSQL overhead.                |

---

## 3. Directory Structure

```text

/Friday-Project

├── .env                  # Shared: AI_PROVIDER, CHAT_MODEL, TTS_MODEL, PATHS
├── agents.json           # Shared Personalities (Friday, Alfred, etc.)
├── ecosystem.config.js   # PM2 configuration specifying 4 Node processes

├── /core                 # Node.js processes: gateway.js, scheduler.js, janitor.js, evolution.js

├── /queue                # Inter-process message queue (JSON files)
│   ├── pending_messages.json   # Scheduler/Evolution writes, Gateway reads
│   ├── status.json             # Health status of each process
│   └── /evolution             # Skill generation queue
│       ├── /pending           # Pending jobs
│       ├── /processing       # Currently running jobs
│       └── /completed         # Finished jobs

├── /web_portal           # Static HTML sub-folders per user/session

├── /skills

│   ├── /builtin          # Search, Browser (Playwright), Voice (MLX), Reminders

│   ├── /generated        # Python skills created by GLM-5 (Git Ignored)

│   └── ai_utils.py       # Shared Python wrapper for calling Local LLM

└── /users

    └── /[phone_number]   # Isolated: memory.md, profile.json, reminders.json

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

3.  **Local LLM Call:** The skill calls LM Studio (Qwen3.5-35B-A3B) to: _"As Friday, draft a witty WhatsApp alert for this data."_

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
    
    d. **Evaluate:**
        - If exit code = 0 and no stderr → **SUCCESS** → Move to `/skills/generated/[skill_name].py`
        - If failed → Capture error, append to error history → **Next Round**

    e. **User Notification (after each round):**
        - Write progress update to `/queue/pending_messages.json`
        - Example: "Round 3/10: Testing skill..." or "Round 3/10: Got an error, trying to fix..."
        - Gateway picks up and sends WhatsApp message

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


---
./plan/tasks.md
---
This task plan is designed for a **Code Agent** (like RooCode, Cline, or a custom script) to implement **Project Friday** on a Mac Mini. It follows the "No-Database, Local-First, Hybrid Node/Python" architecture.

---

## Phase 1: Environment & Shared Configuration

**Goal:** Establish the "Source of Truth" for all AI and path settings.

1.  **Task 1.1: Project Scaffolding**
    - Create the directory structure: `/core`, `/skills/builtin`, `/skills/generated`, `/users`, `/web_portal`, `/temp`, `/queue`.
    - Initialize `npm init -y` in the root.
2.  **Task 1.2: Shared `.env` File**
    - Define: `AI_PROVIDER`, `AI_BASE_URL`, `CHAT_MODEL`, `EVOLUTION_MODEL`, `TTS_MODEL`, `STT_MODEL`, `USER_DATA_PATH`, `WEB_PORTAL_PATH`, `QUEUE_PATH`.
3.  **Task 1.3: PM2 Ecosystem Setup**
    - Create `ecosystem.config.js` with 4 separate processes:
      - `gateway.js` - WhatsApp message handling (PM2 name: `friday-gateway`)
      - `scheduler.js` - Heartbeat (60s reminder checks) + skill execution (PM2 name: `friday-scheduler`)
      - `janitor.js` - Web portal cleanup (PM2 name: `friday-janitor`)
      - `evolution.js` - Background skill generation with 10-round iteration (PM2 name: `friday-evolution`)
4.  **Task 1.4: Message Queue Setup**
    - Create `/queue/pending_messages.json` as shared JSON queue
    - Implement atomic read/write using `write-file-atomic`
    - Gateway polls every 5s, Scheduler writes when skills produce output

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
3.  **Task 2.3: The Web Janitor (`janitor.js`)**
    - PM2 process name: `friday-janitor`
    - Create a standalone Node script that loops/cron checks `web_portal` subdirectories. Delete any folder with a `birthtime` older than 24 hours.
4.  **Task 2.4: Safe File I/O**
    - Implement `write-file-atomic` across all Node processes to ensure JSON/MD file writes don't corrupt during concurrent requests from the separate PM2 workers.

---

## Phase 2.5: Evolution Process (PM2)

**Goal:** Build the standalone Evolution process for background skill generation.

1.  **Task 2.5.1: Evolution Process (`evolution.js`)**
    - PM2 process name: `friday-evolution`
    - Standalone Node process that polls `/queue/evolution/pending/`
    - Implements 10-round iteration loop with error feedback
    - Writes progress updates to `/queue/pending_messages.json` after each round
    - Handles job timeouts (30min total)

---

## Phase 3: Python Skill Environment (Conda & MLX)

**Goal:** Setup the sandboxed Python execution layer for data processing and audio.

1.  **Task 3.1: Conda Environment Setup**
    - Create `friday-skills` environment.
    - Install: `mlx-whisper`, `mlx-audio`, `python-dotenv`, `requests`, `pandas`, `playwright`.
2.  **Task 3.2: Shared `ai_utils.py`**
    - Create a utility script in `/skills` that reads the `.env` and provides a `call_local_ai()` function for all Python skills to use for post-processing.
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
      - Call Ollama Cloud API (GLM-5) with Python template + `error_history` from previous rounds
      - Save generated code to `/skills/generated/temp_[job_id].py`

4.  **Task 5.4: Sandboxed Test Run (per round)**
    - Execute generated code via `child_process.spawn` with 60s timeout
    - Capture stdout, stderr, and exit code
    - Evaluate: if exit code = 0 and no stderr → **SUCCESS** → Next Task
    - If failed → append error to `error_history` → continue to next round

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


---

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

### WebSocket/CDP Persistent Connection

Instead of launching and closing Chrome for each action, use WebSocket (CDP) connection to keep browser warm:

```javascript
import { chromium } from 'playwright';

let browserInstance = null;

export async function getBrowser() {
    // Connect to existing persistent instance or launch new
    if (!browserInstance) {
        try {
            // Try connecting to existing Chrome with DevTools
            browserInstance = await chromium.connectOverCDP('http://localhost:9222');
            console.log('Connected to existing Chrome');
        } catch (e) {
            // Launch new persistent instance
            browserInstance = await chromium.launchPersistentContext(
                './skills/builtin/browser/chrome-profile/default',
                {
                    headless: false,
                    args: ['--remote-debugging-port=9222']
                }
            );
            console.log('Launched new Chrome instance');
        }
    }
    return browserInstance;
}

export async function runBrowserAction(actionFn) {
    const context = await getBrowser();
    const page = context.pages()[0] || await context.newPage();
    try {
        return await actionFn(page);
    } catch (e) {
        console.error('Browser Action Failed:', e);
    }
    // Do NOT close browser - keep it warm for next request
}
```

**Benefits:**
- First request instant (browser already running)
- Login sessions persist across requests
- No need to re-render JavaScript each time
- Lower memory usage than launching multiple instances

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

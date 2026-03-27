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

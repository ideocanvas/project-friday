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

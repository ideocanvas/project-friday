# Fix: Search Query Transformation Issue

## Problem Statement

When users ask "How is the weather today", the system inconsistently transforms this into search queries:

| Expected Behavior | Actual Behavior (Sometimes) |
|-------------------|----------------------------|
| "Hong Kong weather today" | "How is the weather today" |
| "current weather today" | Literal question as search query |

This results in poor search results because search engines don't understand natural language questions well.

## Root Cause Analysis

### 1. Missing Query Transformation Instructions

The search skill's prompt in [`skills/builtin/search/skill.json`](../skills/builtin/search/skill.json) only provides a basic example:

```json
"prompt": "Example: {\"action\": \"search\", \"skill\": \"search\", \"params\": {\"action\": \"search\", \"query\": \"your search query\"}}"
```

This doesn't instruct the LLM to:
- Transform conversational questions into keyword-based queries
- Add user context (location, preferences) to queries
- Remove filler words and question phrasing

### 2. No Examples of Proper Transformation

The LLM has no examples showing:
- "How is the weather today" → "Hong Kong weather today March 2026"
- "Any top news today" → "top news headlines today"

### 3. Context Not Always Utilized

Even when user location is available in the profile, the LLM sometimes fails to include it in the search query.

## Proposed Solution

### Option A: Enhance Search Skill Prompt (Recommended)

Update [`skills/builtin/search/skill.json`](../skills/builtin/search/skill.json) with detailed instructions:

```json
{
  "prompt": "IMPORTANT: Transform conversational questions into search-optimized keywords.\n\n## Query Transformation Rules\n\n1. **Remove question words**: 'How is', 'What is', 'Tell me about' → Remove these\n2. **Add context**: If user has a location, include it\n3. **Add time context**: 'today' → include current date\n4. **Use keywords**: Convert to search-friendly terms\n\n## Examples\n\n- User asks: 'How is the weather today' + User location: Hong Kong\n  → Query: 'Hong Kong weather today March 2026'\n\n- User asks: 'Any top news today'\n  → Query: 'top news headlines today'\n\n- User asks: 'What's the stock market doing'\n  → Query: 'stock market today'\n\n## Usage\n\n{\"action\": \"search\", \"skill\": \"search\", \"params\": {\"action\": \"search\", \"query\": \"<transformed query>\"}}"
}
```

### Option B: Add Pre-Processing Layer

Create a query transformation step before calling the search skill:

1. LLM receives user message
2. If search skill is needed, first transform the query
3. Then execute search with transformed query

This would require changes to [`core/skill-executor.ts`](../core/skill-executor.ts).

### Option C: Enhance System Prompt

Add query transformation instructions to [`soul.md`](../soul.md) so the LLM understands how to construct search queries.

## Recommended Approach

**Option A** is recommended because:
1. Self-contained in the skill definition
2. No code changes required
3. Easy to update and test
4. Follows the existing skill architecture

## Implementation Plan

1. **Update search skill prompt** - Add transformation rules and examples
2. **Add to soul.md** - Reinforce the behavior in the assistant's personality
3. **Test with various queries** - Verify the transformation works correctly

## Files to Modify

1. [`skills/builtin/search/skill.json`](../skills/builtin/search/skill.json) - Add detailed prompt
2. [`soul.md`](../soul.md) - Add note about search query construction

## Testing Scenarios

| User Message | Expected Query |
|--------------|----------------|
| "How is the weather today" | "Hong Kong weather today March 2026" |
| "What's happening in the news" | "top news headlines today" |
| "How's the stock market" | "stock market today" |
| "Tell me about AI trends" | "AI trends 2026" |
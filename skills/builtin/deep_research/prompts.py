#!/usr/bin/env python3
"""
Prompts - LLM prompt templates for Deep Research orchestration

Each prompt template is a function that returns a formatted prompt string.
This keeps all LLM interaction prompts in one place for easy maintenance.
"""

from typing import Optional, List, Dict, Any


def plan_research_prompt(query: str, mode: str = "deep") -> str:
    """
    Prompt for the LLM to create a research plan from a user query.

    Args:
        query: User's research question
        mode: 'quick' (1-2 sources) or 'deep' (3-5 sources)

    Returns:
        Formatted prompt string
    """
    max_sources = 2 if mode == "quick" else 3

    return f"""Analyze this research query and create a search plan.

QUERY: {query}
MODE: {mode} (max {max_sources} sources)

Return a JSON object with:
{{
    "search_terms": ["term1", "term2", ...],
    "search_type": "web" or "news",
    "date_range": "day" or "week" or "month" or "year" or null,
    "focus_areas": ["what to look for in each source"],
    "expected_answer_type": "factual" or "summary" or "comparison" or "analysis"
}}

Guidelines:
- Provide 1-3 search terms, ordered by relevance
- Use "news" search_type for current events, recent developments
- Use "web" for general knowledge, how-to, definitions
- Set date_range only when recency matters
- Be specific in focus_areas to guide what info to extract

Return ONLY the JSON object, no other text."""


def rank_urls_prompt(query: str, search_results: List[Dict[str, Any]]) -> str:
    """
    Prompt for the LLM to rank search results by relevance.

    Args:
        query: Original research query
        search_results: List of search results with title, url, snippet

    Returns:
        Formatted prompt string
    """
    results_text = ""
    for i, r in enumerate(search_results):
        results_text += f"\n{i + 1}. [{r.get('title', 'No title')}]({r.get('url', '')})\n   Snippet: {r.get('snippet', 'No snippet')}"

    return f"""Rank these search results by relevance to the query.

QUERY: {query}

SEARCH RESULTS:{results_text}

Return a JSON object with:
{{
    "ranked_indices": [3, 1, 5, ...],
    "reasoning": "brief explanation of ranking"
}}

Guidelines:
- Rank by likelihood of containing authoritative, direct answers
- Prefer official sources, well-known publications
- Skip obvious ads, clickbait, or low-quality sites
- Return indices (1-based) in order of preference

Return ONLY the JSON object, no other text."""


def extract_info_prompt(
    query: str, page_title: str, page_text: str, focus_areas: List[str]
) -> str:
    """
    Prompt for the LLM to extract relevant information from a page.

    Args:
        query: Original research query
        page_title: Title of the visited page
        page_text: Extracted text content from the page
        focus_areas: What to look for

    Returns:
        Formatted prompt string
    """
    # Truncate page text to avoid exceeding context limits
    max_text = 4000
    if len(page_text) > max_text:
        page_text = page_text[:max_text] + "\n\n[... content truncated]"

    focus_text = "\n".join(f"- {f}" for f in focus_areas)

    return f"""Extract information relevant to the research query from this web page.

QUERY: {query}

PAGE TITLE: {page_title}

FOCUS AREAS:
{focus_text}

PAGE CONTENT:
{page_text}

Return a JSON object with:
{{
    "relevant_info": "The key information found, directly answering the query",
    "key_facts": ["fact1", "fact2", ...],
    "source_quality": "high" or "medium" or "low",
    "has_answer": true/false,
    "missing_info": ["what's still missing to fully answer the query"],
    "suggested_followup": "suggested search term if more research needed, or null"
}}

Guidelines:
- Extract ONLY factual information directly from the content
- Be precise — quote numbers, dates, names when available
- If the page doesn't contain relevant info, set has_answer to false
- Note what information is still missing

Return ONLY the JSON object, no other text."""


def evaluate_sufficiency_prompt(
    query: str, findings: List[Dict[str, Any]], iteration: int, max_iterations: int
) -> str:
    """
    Prompt for the LLM to evaluate if current findings are sufficient.

    Args:
        query: Original research query
        findings: List of extracted findings so far
        iteration: Current iteration number
        max_iterations: Maximum allowed iterations

    Returns:
        Formatted prompt string
    """
    findings_text = ""
    for i, f in enumerate(findings):
        findings_text += f"\n--- Source {i + 1} ---"
        findings_text += f"\nURL: {f.get('url', 'N/A')}"
        findings_text += f"\nTitle: {f.get('title', 'N/A')}"
        findings_text += f"\nInfo: {f.get('relevant_info', 'N/A')}"
        findings_text += f"\nFacts: {json_dumps_safe(f.get('key_facts', []))}"

    return f"""Evaluate whether the current research findings are sufficient to answer the query.

QUERY: {query}
PROGRESS: Iteration {iteration}/{max_iterations}

CURRENT FINDINGS:{findings_text}

Return a JSON object with:
{{
    "is_sufficient": true/false,
    "confidence": "high" or "medium" or "low",
    "coverage": "what aspects of the query are covered",
    "gaps": ["what's still missing"],
    "next_search_term": "suggested search term for more info, or null if sufficient",
    "reasoning": "brief explanation"
}}

Guidelines:
- For simple queries, mark sufficient if you have consistent answers from 2+ sources
- Be thorough but decisive — mark sufficient if the core query can be answered
- Consider source agreement and quality
- Only suggest follow-up if critical gaps remain
- For quick mode, prefer sufficiency after 2 sources

Return ONLY the JSON object, no other text."""


def synthesize_prompt(
    query: str, findings: List[Dict[str, Any]], mode: str = "deep"
) -> str:
    """
    Prompt for the LLM to synthesize final answer from all findings.

    Args:
        query: Original research query
        findings: All collected findings
        mode: Research mode

    Returns:
        Formatted prompt string
    """
    sources_text = ""
    for i, f in enumerate(findings):
        sources_text += f"\n### Source {i + 1}: {f.get('title', 'Untitled')}"
        sources_text += f"\nURL: {f.get('url', 'N/A')}"
        sources_text += f"\nQuality: {f.get('source_quality', 'unknown')}"
        sources_text += f"\nKey Info: {f.get('relevant_info', 'No info extracted')}"
        facts = f.get("key_facts", [])
        if facts:
            sources_text += "\nKey Facts:"
            for fact in facts:
                sources_text += f"\n  - {fact}"
        sources_text += "\n"

    return f"""Synthesize a comprehensive answer from the research findings.

ORIGINAL QUERY: {query}
RESEARCH MODE: {mode}

SOURCES:{sources_text}

Provide a well-structured answer that:
1. Directly answers the query
2. Cross-references information across sources
3. Notes any contradictions between sources
4. Includes specific facts, numbers, dates when available
5. Attributes information to sources

Format your response as:
- Start with a clear, direct answer (2-3 sentences)
- Follow with detailed supporting information
- End with a brief note on source quality/confidence if relevant

Write in a clear, informative style. Do not mention the research process."""


def format_decision_prompt(summary: str) -> str:
    """
    Prompt for the LLM to decide output format.

    Args:
        summary: The synthesized summary text

    Returns:
        Formatted prompt string
    """
    # Truncate for the prompt
    preview = summary[:500] + "..." if len(summary) > 500 else summary

    return f"""Decide the best output format for this research summary.

SUMMARY PREVIEW ({len(summary)} chars total):
{preview}

Return a JSON object with:
{{
    "format": "text" or "page",
    "reasoning": "brief explanation"
}}

Guidelines:
- Use "text" if the summary is concise enough for a chat message (under ~1000 chars)
- Use "page" if the summary is long, has multiple sections, or includes detailed data
- When in doubt, prefer "text" for quick mode and "page" for deep mode

Return ONLY the JSON object, no other text."""


def json_dumps_safe(obj) -> str:
    """Safely convert object to JSON string for prompt inclusion."""
    import json

    try:
        return json.dumps(obj, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(obj)

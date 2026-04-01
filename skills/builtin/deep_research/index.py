#!/usr/bin/env python3
"""
Deep Research Skill - Built-in Skill for Friday

Combines Google Search, Browser, and LLM reasoning to deep-dive
into topics and return verified, synthesized information.

Based on: plans/design-deep-research.md
"""

import sys
import os
import json
import asyncio

# Add current directory to path for local imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from researcher import DeepResearcher, MAX_SOURCES_DEFAULT
from search_client import is_configured as search_configured, get_config as get_search_config
from llm_client import get_config as get_llm_config

# === CONFIGURATION ===
SKILL_NAME = "deep_research"
VERSION = "1.0.0"

# === SKILL PARAMETERS ===
PARAMETERS = {
    "action": {
        "type": "string",
        "enum": ["research", "analyze_url", "status"],
        "required": True,
        "description": "Action to perform"
    },
    "query": {
        "type": "string",
        "required": False,
        "description": "Research query (required for 'research' action)"
    },
    "url": {
        "type": "string",
        "required": False,
        "description": "URL to analyze (required for 'analyze_url' action)"
    },
    "mode": {
        "type": "string",
        "enum": ["quick", "deep"],
        "required": False,
        "default": "deep",
        "description": "Research depth: quick=1-2 sources, deep=3-5 sources"
    },
    "max_sources": {
        "type": "number",
        "required": False,
        "default": MAX_SOURCES_DEFAULT,
        "description": f"Maximum sources to visit (default: {MAX_SOURCES_DEFAULT})"
    }
}


def validate_params(params):
    """Validate input parameters."""
    action = params.get("action")

    if not action:
        return False, "Missing required parameter: action"

    if action not in ["research", "analyze_url", "status"]:
        return False, f"Invalid action: {action}. Must be one of: research, analyze_url, status"

    if action == "research" and not params.get("query"):
        return False, "Missing required parameter: query (required for research action)"

    if action == "analyze_url" and not params.get("url"):
        return False, "Missing required parameter: url (required for analyze_url action)"

    if params.get("mode") and params["mode"] not in ["quick", "deep"]:
        return False, f"Invalid mode: {params['mode']}. Must be 'quick' or 'deep'"

    if params.get("max_sources"):
        try:
            ms = int(params["max_sources"])
            if ms < 1 or ms > 10:
                return False, "max_sources must be between 1 and 10"
        except (ValueError, TypeError):
            return False, "max_sources must be a number"

    return True, None


async def logic(params, user_id):
    """
    Main skill logic.

    Args:
        params: Dictionary of parameters
        user_id: User's phone number

    Returns:
        dict with keys: success, message, data
    """
    action = params.get("action", "research")

    try:
        if action == "status":
            return _handle_status()

        elif action == "research":
            return await _handle_research(params, user_id)

        elif action == "analyze_url":
            return await _handle_analyze_url(params, user_id)

        else:
            return {
                "success": False,
                "message": f"Unknown action: {action}"
            }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "message": f"❌ Deep research error: {str(e)}",
            "data": {"error": str(e)}
        }


def _handle_status():
    """Handle status action."""
    search_conf = get_search_config()
    llm_conf = get_llm_config()

    checks = []
    if search_conf['is_configured']:
        checks.append("✅ Search: configured")
    else:
        checks.append("❌ Search: not configured (set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX)")

    checks.append(f"✅ LLM: {llm_conf['model']} via {llm_conf['api_type']} ({llm_conf['base_url']})")

    return {
        "success": True,
        "message": f"🔬 Deep Research Status\n\n" + "\n".join(checks),
        "data": {
            "search": search_conf,
            "llm": llm_conf,
        }
    }


async def _handle_research(params, user_id):
    """Handle research action."""
    query = params.get("query", "").strip()
    mode = params.get("mode", "deep")
    max_sources = int(params.get("max_sources", MAX_SOURCES_DEFAULT))

    if not search_configured():
        return {
            "success": False,
            "message": "❌ Search not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX environment variables.",
            "data": {"configured": False}
        }

    print(f"[DeepResearch] Starting research: query='{query}', mode={mode}, max_sources={max_sources}")

    researcher = DeepResearcher(query, mode, max_sources)
    result = await researcher.research()

    return result.to_dict()


async def _handle_analyze_url(params, user_id):
    """Handle analyze_url action."""
    url = params.get("url", "").strip()
    query = params.get("query", "").strip() or None

    if not url:
        return {
            "success": False,
            "message": "❌ URL is required for analyze_url action.",
        }

    print(f"[DeepResearch] Analyzing URL: {url}")

    researcher = DeepResearcher(query or url, mode="quick")
    result = await researcher.analyze_url(url, query)

    return result.to_dict()


def main():
    """Entry point - called by Node.js via spawn."""
    try:
        input_data = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {str(e)}"}))
        sys.exit(1)

    params = input_data.get("params", {})
    user_id = input_data.get("user_id", "default")

    # Validate
    valid, error = validate_params(params)
    if not valid:
        print(json.dumps({"success": False, "error": error}))
        sys.exit(1)

    # Execute (async)
    try:
        result = asyncio.run(logic(params, user_id))
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()

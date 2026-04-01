#!/usr/bin/env python3
"""
LLM Client - Generic LLM API client for Deep Research

Supports any OpenAI-compatible or Ollama API.
Fully configurable via environment variables — no hardcoded model names.
"""

import os
import json
import requests
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv

load_dotenv()

# Configuration — all driven by environment variables
LLM_MODEL = os.getenv('DEEP_RESEARCH_LLM_MODEL', os.getenv('CHAT_MODEL', 'qwen/qwen3.5-35b-a3b'))
LLM_BASE_URL = os.getenv('DEEP_RESEARCH_LLM_BASE_URL', os.getenv('AI_BASE_URL', 'http://localhost:1234/v1'))
LLM_API_TYPE = os.getenv('DEEP_RESEARCH_LLM_API_TYPE', 'openai').lower().strip()  # "openai" or "ollama"
LLM_API_KEY = os.getenv('DEEP_RESEARCH_LLM_API_KEY', os.getenv('CLOUD_AI_KEY', ''))
LLM_TIMEOUT = int(os.getenv('DEEP_RESEARCH_LLM_TIMEOUT_MS', '120000')) // 1000  # Convert to seconds


def get_config() -> Dict[str, Any]:
    """Get current LLM configuration."""
    return {
        'model': LLM_MODEL,
        'base_url': LLM_BASE_URL,
        'api_type': LLM_API_TYPE,
        'has_api_key': bool(LLM_API_KEY),
        'timeout_s': LLM_TIMEOUT,
    }


def call_llm(prompt: str, system_msg: str = "You are a helpful research assistant.",
             temperature: float = 0.7,
             max_tokens: int = 2048,
             timeout: Optional[int] = None) -> str:
    """
    Call the configured LLM with a prompt.

    Supports OpenAI-compatible APIs (LM Studio, OpenAI, etc.) and Ollama.
    The API type, model, and endpoint are all configurable via environment variables.

    Args:
        prompt: User message/prompt
        system_msg: System message for context
        temperature: Sampling temperature (0.0-2.0)
        max_tokens: Maximum tokens to generate
        timeout: Request timeout in seconds (defaults to config)

    Returns:
        str: LLM response text
    """
    timeout = timeout or LLM_TIMEOUT

    if LLM_API_TYPE == 'ollama':
        return _call_ollama(prompt, system_msg, temperature, timeout)
    else:
        return _call_openai(prompt, system_msg, temperature, max_tokens, timeout)


def _call_openai(prompt: str, system_msg: str, temperature: float,
                 max_tokens: int, timeout: int) -> str:
    """Call an OpenAI-compatible API."""
    headers = {'Content-Type': 'application/json'}
    if LLM_API_KEY:
        headers['Authorization'] = f'Bearer {LLM_API_KEY}'

    payload = {
        'model': LLM_MODEL,
        'messages': [
            {'role': 'system', 'content': system_msg},
            {'role': 'user', 'content': prompt},
        ],
        'temperature': temperature,
        'max_tokens': max_tokens,
    }

    url = LLM_BASE_URL.rstrip('/')
    if not url.endswith('/chat/completions'):
        url = f"{url}/chat/completions"

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=timeout)
        response.raise_for_status()
        data = response.json()
        return data['choices'][0]['message']['content']
    except requests.exceptions.Timeout:
        return "Error: LLM request timed out."
    except requests.exceptions.RequestException as e:
        return f"Error calling LLM: {str(e)}"
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        return f"Error parsing LLM response: {str(e)}"


def _call_ollama(prompt: str, system_msg: str, temperature: float,
                 timeout: int) -> str:
    """Call an Ollama API."""
    payload = {
        'model': LLM_MODEL,
        'messages': [
            {'role': 'system', 'content': system_msg},
            {'role': 'user', 'content': prompt},
        ],
        'stream': False,
        'options': {
            'temperature': temperature,
        },
    }

    url = LLM_BASE_URL.rstrip('/')
    if url.endswith('/v1'):
        url = url[:-3]
    url = f"{url}/api/chat"

    try:
        response = requests.post(url, json=payload, timeout=timeout)
        response.raise_for_status()
        data = response.json()
        return data.get('message', {}).get('content', '') or data.get('response', '')
    except requests.exceptions.Timeout:
        return "Error: LLM request timed out."
    except requests.exceptions.RequestException as e:
        return f"Error calling LLM: {str(e)}"
    except (KeyError, json.JSONDecodeError) as e:
        return f"Error parsing LLM response: {str(e)}"


def call_llm_json(prompt: str, system_msg: str = "You are a helpful research assistant.",
                  temperature: float = 0.3,
                  max_tokens: int = 2048,
                  timeout: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """
    Call LLM and parse the response as JSON.

    The prompt should instruct the LLM to return JSON.
    Handles extraction of JSON from markdown code blocks.

    Returns:
        Parsed JSON dict, or None if parsing fails.
    """
    response = call_llm(prompt, system_msg, temperature, max_tokens, timeout)

    if response.startswith("Error:"):
        print(f"[LLMClient] LLM call failed: {response}")
        return None

    # Try to extract JSON from the response
    return _extract_json(response)


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """
    Extract JSON from LLM response text.
    Handles: pure JSON, markdown code blocks, mixed text with JSON.
    """
    text = text.strip()

    # Try direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code block
    import re
    json_block = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if json_block:
        try:
            return json.loads(json_block.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try finding JSON object in text
    brace_start = text.find('{')
    brace_end = text.rfind('}')
    if brace_start != -1 and brace_end > brace_start:
        try:
            return json.loads(text[brace_start:brace_end + 1])
        except json.JSONDecodeError:
            pass

    print(f"[LLMClient] Failed to extract JSON from response: {text[:200]}...")
    return None

#!/usr/bin/env python3
"""
Search Client - Google Custom Search API wrapper for Deep Research

Provides web search capabilities using Google Custom Search API.
Standalone implementation — does not depend on the JS search skill.
"""

import os
import time
import requests
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv

load_dotenv()

# Configuration
GOOGLE_SEARCH_API_KEY = os.getenv('GOOGLE_SEARCH_API_KEY', '')
GOOGLE_SEARCH_CX = os.getenv('GOOGLE_SEARCH_CX', '')
SEARCH_MAX_RESULTS = int(os.getenv('SEARCH_MAX_RESULTS', '10'))

# In-memory cache (5 minute TTL)
_cache: Dict[str, Dict[str, Any]] = {}
_CACHE_TTL_MS = 5 * 60 * 1000  # 5 minutes


def is_configured() -> bool:
    """Check if Google Search API is configured."""
    return bool(GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX)


def get_config() -> Dict[str, Any]:
    """Get configuration status."""
    return {
        'has_api_key': bool(GOOGLE_SEARCH_API_KEY),
        'has_cx': bool(GOOGLE_SEARCH_CX),
        'max_results': SEARCH_MAX_RESULTS,
        'is_configured': is_configured(),
    }


def clear_cache() -> Dict[str, str]:
    """Clear the search cache."""
    _cache.clear()
    return {'success': True, 'message': 'Search cache cleared'}


def _build_search_url(query: str, num_results: int = 5,
                      date_restrict: Optional[str] = None,
                      search_type: Optional[str] = None) -> str:
    """Build Google Custom Search API URL."""
    params = {
        'key': GOOGLE_SEARCH_API_KEY,
        'cx': GOOGLE_SEARCH_CX,
        'q': query,
        'num': num_results,
    }

    if date_restrict:
        params['dateRestrict'] = date_restrict

    if search_type:
        params['searchType'] = search_type

    from urllib.parse import urlencode
    return f"https://www.googleapis.com/customsearch/v1?{urlencode(params)}"


def search(query: str, num_results: int = 5,
           date_range: Optional[str] = None) -> Dict[str, Any]:
    """
    Search the web using Google Custom Search API.

    Args:
        query: Search query string
        num_results: Number of results to return (1-10)
        date_range: Date range filter ('day', 'week', 'month', 'year')

    Returns:
        Dict with keys: success, query, results (list of SearchResult dicts), error (optional)
    """
    if not is_configured():
        return {
            'success': False,
            'error': 'Search not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX.',
            'results': [],
        }

    # Clamp num_results
    num_results = max(1, min(10, num_results))

    # Build cache key
    cache_key = f"{query}:{num_results}:{date_range or 'none'}"

    # Check cache
    cached = _cache.get(cache_key)
    if cached and (time.time() * 1000 - cached['timestamp']) < _CACHE_TTL_MS:
        return {**cached['data'], 'from_cache': True}

    # Map date range to API format
    date_restrict = None
    if date_range:
        date_map = {'day': 'd1', 'week': 'w1', 'month': 'm1', 'year': 'y1'}
        date_restrict = date_map.get(date_range)

    url = _build_search_url(query, num_results, date_restrict)

    try:
        start_time = time.time()
        response = requests.get(url, timeout=10)
        elapsed_ms = int((time.time() - start_time) * 1000)

        if response.status_code == 403:
            return {
                'success': False,
                'error': 'API rate limit reached. Try again later.',
                'results': [],
            }

        response.raise_for_status()
        data = response.json()

        total_results = int(data.get('searchInformation', {}).get('totalResults', '0'))
        items = data.get('items', [])

        results = []
        for item in items:
            results.append({
                'title': item.get('title', ''),
                'url': item.get('link', ''),
                'snippet': item.get('snippet', ''),
                'display_url': item.get('displayLink', ''),
            })

        result = {
            'success': True,
            'query': query,
            'total_results': total_results,
            'search_time_ms': elapsed_ms,
            'results': results,
            'from_cache': False,
        }

        # Cache the result
        _cache[cache_key] = {'data': result, 'timestamp': time.time() * 1000}

        return result

    except requests.exceptions.Timeout:
        return {
            'success': False,
            'error': 'Search request timed out.',
            'results': [],
        }
    except requests.exceptions.RequestException as e:
        return {
            'success': False,
            'error': f'Search failed: {str(e)}',
            'results': [],
        }
    except (ValueError, KeyError) as e:
        return {
            'success': False,
            'error': f'Failed to parse search results: {str(e)}',
            'results': [],
        }


def search_news(query: str, date_range: str = 'week',
                num_results: int = 5) -> Dict[str, Any]:
    """
    Search for news with date restriction.

    Args:
        query: Search query
        date_range: 'day', 'week', 'month', or 'year'
        num_results: Number of results

    Returns:
        Same format as search()
    """
    return search(query, num_results, date_range=date_range)

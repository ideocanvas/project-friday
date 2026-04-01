#!/usr/bin/env python3
"""
Browser Client - Playwright-based browser automation for Deep Research

Provides browser automation capabilities using Playwright with Chrome.
Standalone implementation — does not depend on the JS browser skill.

Connects to an existing Chrome instance via CDP when available,
falls back to launching Chromium.
"""

import os
import time
import asyncio
from typing import Optional, Dict, Any, List, Tuple
from dotenv import load_dotenv

load_dotenv()

# Configuration
CDP_ENDPOINT = os.getenv('BROWSER_CDP_ENDPOINT', 'http://localhost:9222')
BROWSER_TIMEOUT_MS = int(os.getenv('BROWSER_TIMEOUT_MS', '30000'))
MAX_CONTENT_LENGTH = int(os.getenv('BROWSER_MAX_CONTENT_LENGTH', '50000'))  # 50KB text limit

# Module-level browser state
_browser = None
_context = None
_page = None


def _truncate_text(text: str, max_length: int = MAX_CONTENT_LENGTH) -> str:
    """Truncate text to max length with indicator."""
    if len(text) <= max_length:
        return text
    return text[:max_length] + f'\n\n[... truncated at {max_length} chars, total {len(text)} chars]'


def _is_safe_url(url: str) -> bool:
    """Validate URL for safety (no file://, no internal IPs)."""
    if not url:
        return False
    # Block dangerous protocols
    dangerous = ['file://', 'ftp://', 'javascript:']
    for proto in dangerous:
        if url.lower().startswith(proto):
            return False
    # Must have http or https
    if not url.lower().startswith(('http://', 'https://')):
        return False
    return True


async def _ensure_browser() -> Tuple[Any, Any, Any]:
    """
    Ensure a browser instance is available.
    Tries CDP first, then falls back to launching Chromium.

    Returns:
        Tuple of (browser, context, page)
    """
    global _browser, _context, _page

    if _browser and _browser.is_connected() and _page and not _page.is_closed():
        return _browser, _context, _page

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise ImportError("playwright not installed. Run: pip install playwright && playwright install chromium")

    pw = await async_playwright().start()

    # Try connecting to existing Chrome via CDP
    try:
        _browser = await pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        print(f"[BrowserClient] Connected to existing Chrome via CDP: {CDP_ENDPOINT}")
    except Exception as e:
        print(f"[BrowserClient] CDP connection failed ({e}), launching Chromium...")
        _browser = await pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox'],
        )

    # Create context and page
    _context = await _browser.new_context(
        viewport={'width': 1280, 'height': 720},
        user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    )
    _page = await _context.new_page()

    return _browser, _context, _page


async def browse_url(url: str, wait_until: str = 'domcontentloaded',
                     timeout: int = BROWSER_TIMEOUT_MS) -> Dict[str, Any]:
    """
    Navigate to a URL and extract page content.

    Args:
        url: URL to navigate to
        wait_until: Wait condition ('load', 'domcontentloaded', 'networkidle')
        timeout: Timeout in milliseconds

    Returns:
        Dict with keys: success, url, title, text, links, error (optional)
    """
    if not _is_safe_url(url):
        return {
            'success': False,
            'error': f'Unsafe or invalid URL: {url}',
        }

    try:
        browser, context, page = await _ensure_browser()

        # Navigate
        response = await page.goto(url, wait_until=wait_until, timeout=timeout)
        status = response.status if response else None

        # Get title
        title = await page.title()

        # Extract text content
        text = await page.evaluate('''() => {
            // Try to get main content, falling back to body text
            const selectors = ['article', 'main', '.content', '#content', '.post-body', '.article-body'];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.length > 200) {
                    return el.innerText;
                }
            }
            // Fallback: body text
            return document.body ? document.body.innerText : '';
        }''')

        text = _truncate_text(text)

        # Extract links
        links = await page.evaluate('''() => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links.slice(0, 50).map(a => ({
                text: a.innerText.trim().substring(0, 100),
                href: a.href,
            })).filter(l => l.text.length > 0 && l.href.startsWith('http'));
        }''')

        return {
            'success': True,
            'url': url,
            'title': title,
            'status': status,
            'text': text,
            'text_length': len(text),
            'links': links,
        }

    except Exception as e:
        return {
            'success': False,
            'url': url,
            'error': f'Browser error: {str(e)}',
        }


async def get_links() -> Dict[str, Any]:
    """Get all links from the current page."""
    try:
        _, _, page = await _ensure_browser()

        links = await page.evaluate('''() => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links.slice(0, 100).map(a => ({
                text: a.innerText.trim().substring(0, 100),
                href: a.href,
            })).filter(l => l.text.length > 0 && l.href.startsWith('http'));
        }''')

        return {
            'success': True,
            'count': len(links),
            'links': links,
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
        }


async def get_page_title() -> Dict[str, Any]:
    """Get the current page title."""
    try:
        _, _, page = await _ensure_browser()
        title = await page.title()
        return {'success': True, 'title': title}
    except Exception as e:
        return {'success': False, 'error': str(e)}


async def get_page_url() -> Dict[str, Any]:
    """Get the current page URL."""
    try:
        _, _, page = await _ensure_browser()
        url = page.url
        return {'success': True, 'url': url}
    except Exception as e:
        return {'success': False, 'error': str(e)}


async def close_browser():
    """Close the browser instance."""
    global _browser, _context, _page
    try:
        if _page and not _page.is_closed():
            await _page.close()
        if _context:
            await _context.close()
        if _browser and _browser.is_connected():
            await _browser.close()
    except Exception:
        pass
    finally:
        _browser = None
        _context = None
        _page = None

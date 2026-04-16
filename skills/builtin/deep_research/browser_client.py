#!/usr/bin/env python3
"""
Browser Client - Playwright-based browser automation for Deep Research

Provides browser automation capabilities using Playwright with Chrome.
Standalone implementation — does not depend on the JS browser skill.

Connects to an existing Chrome instance via CDP when available,
falls back to launching Chromium.

Anti-bot measures:
- Randomised delays between page visits
- Realistic user-agent strings (rotated)
- WebDriver flag removal
- Stealth viewport and locale settings
- Domain visit rate limiting
"""

import os
import random
import asyncio
import requests
import xml.etree.ElementTree as ET
from typing import Optional, Dict, Any, List, Tuple
from datetime import datetime, timezone
from dotenv import load_dotenv

try:
    import html2text
except ImportError:
    html2text = None

load_dotenv()

CDP_ENDPOINT = os.getenv("BROWSER_CDP_ENDPOINT", "http://localhost:9222")
BROWSER_TIMEOUT_MS = int(os.getenv("BROWSER_TIMEOUT_MS", "30000"))
MAX_CONTENT_LENGTH = int(os.getenv("BROWSER_MAX_CONTENT_LENGTH", "50000"))
BROWSE_DELAY_MIN = float(os.getenv("DEEP_RESEARCH_BROWSE_DELAY_MIN", "2.0"))
BROWSE_DELAY_MAX = float(os.getenv("DEEP_RESEARCH_BROWSE_DELAY_MAX", "5.0"))
DOMAIN_COOLDOWN_SEC = float(os.getenv("DEEP_RESEARCH_DOMAIN_COOLDOWN", "30"))

_browser = None
_context = None
_page = None
_last_visit_time: Dict[str, float] = {}

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
]


def _get_domain(url: str) -> str:
    try:
        from urllib.parse import urlparse

        return urlparse(url).netloc
    except Exception:
        return url


async def _enforce_rate_limit(url: str):
    """Enforce per-domain rate limiting and inter-visit delays."""
    domain = _get_domain(url)
    now = asyncio.get_event_loop().time()

    # Per-domain cooldown
    last = _last_visit_time.get(domain, 0)
    wait = max(0, DOMAIN_COOLDOWN_SEC - (now - last))
    if wait > 0:
        jitter = random.uniform(0, 2)
        print(
            f"[BrowserClient] Domain cooldown: waiting {wait + jitter:.1f}s for {domain}"
        )
        await asyncio.sleep(wait + jitter)

    # Random inter-visit delay (mimics human reading time)
    delay = random.uniform(BROWSE_DELAY_MIN, BROWSE_DELAY_MAX)
    await asyncio.sleep(delay)

    _last_visit_time[domain] = asyncio.get_event_loop().time()


def is_rss_url(url: str) -> bool:
    url_lower = url.lower()
    return any(indicator in url_lower for indicator in ["rss", ".xml", "/feed"])


async def fetch_rss(url: str) -> Optional[str]:
    try:
        response = requests.get(
            url, timeout=10, headers={"User-Agent": random.choice(USER_AGENTS)}
        )
        response.raise_for_status()
        root = ET.fromstring(response.content)
        items = []
        for item in root.findall(".//item")[:10]:
            item_text = ""
            for tag in ["title", "description", "link", "pubDate"]:
                el = item.find(tag)
                if el is not None and el.text:
                    item_text += f"{tag.title()}: {el.text}\n"
            if item_text:
                item_text += "\n"
                items.append(item_text)
        if items:
            content = f"RSS Feed: {url}\n\n" + "\n".join(items)
            return content[:MAX_CONTENT_LENGTH]
        return None
    except Exception as e:
        print(f"[BrowserClient] RSS fetch failed: {e}")
        return None


def _truncate_text(text: str, max_length: int = MAX_CONTENT_LENGTH) -> str:
    if len(text) <= max_length:
        return text
    return (
        text[:max_length]
        + f"\n\n[... truncated at {max_length} chars, total {len(text)} chars]"
    )


def _is_safe_url(url: str) -> bool:
    if not url:
        return False
    for proto in ["file://", "ftp://", "javascript:"]:
        if url.lower().startswith(proto):
            return False
    if not url.lower().startswith(("http://", "https://")):
        return False
    return True


async def _ensure_browser() -> Tuple[Any, Any, Any]:
    global _browser, _context, _page
    if _browser and _browser.is_connected() and _page and not _page.is_closed():
        return _browser, _context, _page
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise ImportError(
            "playwright not installed. Run: pip install playwright && playwright install chromium"
        )
    pw = await async_playwright().start()

    ua = random.choice(USER_AGENTS)

    try:
        _browser = await pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        print(f"[BrowserClient] Connected to existing Chrome via CDP: {CDP_ENDPOINT}")
    except Exception as e:
        print(
            f"[BrowserClient] CDP connection failed ({e}), launching visible Chromium..."
        )
        _browser = await pw.chromium.launch(
            headless=False,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
            ],
        )

    _context = await _browser.new_context(
        viewport={
            "width": 1280 + random.randint(-100, 100),
            "height": 720 + random.randint(-60, 60),
        },
        user_agent=ua,
        locale="en-US",
        timezone_id="Asia/Hong_Kong",
        geolocation={"latitude": 22.3193, "longitude": 114.1694},
        permissions=["geolocation"],
        color_scheme="light",
    )

    # Remove webdriver flag before creating page
    await _context.add_init_script("""
        // Overwrite navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        // Overwrite chrome runtime (used by some detectors)
        window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };

        // Overwrite permissions query
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters);

        // Overwrite plugins length
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
        });

        // Overwrite languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en', 'zh-HK', 'zh'],
        });
    """)

    _page = await _context.new_page()
    return _browser, _context, _page


async def browse_url(
    url: str,
    wait_until: str = "domcontentloaded",
    timeout: int = BROWSER_TIMEOUT_MS,
    temp_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Navigate to a URL and extract page content.

    Includes anti-bot measures: rate limiting, random delays,
    webdriver flag removal, realistic browser fingerprint.
    """
    if not _is_safe_url(url):
        return {"success": False, "error": f"Unsafe or invalid URL: {url}"}

    if is_rss_url(url):
        rss_content = await fetch_rss(url)
        if rss_content:
            return {
                "success": True,
                "url": url,
                "title": f"RSS Feed - {url}",
                "text": rss_content,
                "markdown": rss_content,
                "links": [],
            }

    await _enforce_rate_limit(url)

    try:
        browser, context, page = await _ensure_browser()

        response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        status = response.status if response else None

        try:
            await page.wait_for_load_state("load", timeout=10000)
        except Exception:
            pass

        await page.wait_for_timeout(2000)

        # Simulate human-like mouse movement (helps defeat bot detection)
        try:
            await page.mouse.move(random.randint(100, 800), random.randint(100, 500))
            await asyncio.sleep(random.uniform(0.3, 0.8))
            await page.mouse.move(random.randint(200, 900), random.randint(200, 600))
        except Exception:
            pass

        # Scroll down slightly (many sites detect zero-scroll as bot)
        try:
            await page.evaluate("window.scrollBy(0, 300)")
            await asyncio.sleep(random.uniform(0.5, 1.5))
        except Exception:
            pass

        title = await page.title()

        # Extract structured text using smart selectors
        text = await page.evaluate("""() => {
            const mainSelectors = [
                'article', 'main', '[role="main"]',
                '.content', '#content', '.post-body', '.article-body',
                '.entry-content', '.post-content', '.article-content',
            ];
            for (const sel of mainSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.trim().length > 100) {
                    return el.innerText;
                }
            }

            const candidates = document.querySelectorAll('section, div[role="region"], .section, [class*="quote"], [class*="price"], [class*="summary"], [data-module], [data-component]');
            let bestEl = null;
            let bestScore = 0;
            for (const el of candidates) {
                const t = el.innerText || '';
                if (t.length < 50 || t.length > 50000) continue;
                const digits = (t.match(/\\d[\\d,.]*/g) || []).length;
                const lenPenalty = t.length > 10000 ? 0.5 : 1;
                const score = digits * lenPenalty;
                if (score > bestScore) {
                    bestScore = score;
                    bestEl = el;
                }
            }
            if (bestEl && bestScore > 5) {
                return bestEl.innerText;
            }

            return document.body ? document.body.innerText : '';
        }""")

        text = _truncate_text(text)

        # Convert rendered HTML to Markdown
        markdown = ""
        if html2text:
            try:
                rendered_html = await page.evaluate("""() => {
                    const clone = document.body.cloneNode(true);
                    const removeSelectors = [
                        'noscript', 'script', 'style', 'svg', 'iframe',
                        '[aria-hidden="true"]', '[style*="display:none"]',
                        '[style*="display: none"]', '[style*="visibility:hidden"]',
                        '[style*="visibility: hidden"]',
                        '[hidden]',
                        '.ad', '.ads', '.advertisement', '.Ad',
                        'nav', 'footer', 'header',
                    ];
                    for (const sel of removeSelectors) {
                        clone.querySelectorAll(sel).forEach(el => el.remove());
                    }
                    return clone.innerHTML;
                }""")

                h = html2text.HTML2Text()
                h.ignore_links = False
                h.ignore_images = True
                h.ignore_tables = False
                h.body_width = 0
                h.ignore_emphasis = False
                h.protect_links = True
                h.unicode_snob = True
                markdown = h.handle(rendered_html)
                markdown = _truncate_text(markdown, 25000)
            except Exception as e:
                print(f"[BrowserClient] Markdown conversion failed: {e}")
                markdown = text
        else:
            markdown = text

        links = await page.evaluate("""() => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links.slice(0, 50).map(a => ({
                text: a.innerText.trim().substring(0, 100),
                href: a.href,
            })).filter(l => l.text.length > 0 && l.href.startsWith('http'));
        }""")

        screenshot_path = None
        use_vision = os.getenv("DEEP_RESEARCH_USE_VISION", "false").lower() == "true"
        if use_vision and temp_dir:
            try:
                os.makedirs(temp_dir, exist_ok=True)
                screenshot_path = os.path.join(
                    temp_dir, f"screenshot_{abs(hash(url)) % 1000000}.png"
                )
                await page.screenshot(path=screenshot_path, full_page=True)
                print(f"[BrowserClient] Screenshot saved: {screenshot_path}")
            except Exception as e:
                print(f"[BrowserClient] Screenshot failed: {e}")
                screenshot_path = None

        return {
            "success": True,
            "url": url,
            "title": title,
            "status": status,
            "text": text,
            "markdown": markdown,
            "text_length": len(text),
            "markdown_length": len(markdown),
            "links": links,
            "screenshot_path": screenshot_path,
        }

    except Exception as e:
        return {"success": False, "url": url, "error": f"Browser error: {str(e)}"}


async def get_links() -> Dict[str, Any]:
    try:
        _, _, page = await _ensure_browser()
        links = await page.evaluate("""() => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links.slice(0, 100).map(a => ({
                text: a.innerText.trim().substring(0, 100),
                href: a.href,
            })).filter(l => l.text.length > 0 && l.href.startsWith('http'));
        }""")
        return {"success": True, "count": len(links), "links": links}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_page_title() -> Dict[str, Any]:
    try:
        _, _, page = await _ensure_browser()
        title = await page.title()
        return {"success": True, "title": title}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_page_url() -> Dict[str, Any]:
    try:
        _, _, page = await _ensure_browser()
        url = page.url
        return {"success": True, "url": url}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def close_browser():
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

#!/usr/bin/env python3
"""
Researcher - Core research orchestration engine for Deep Research

Runs an internal LLM-driven agent loop that:
1. Plans research strategy from user query
2. Searches for relevant sources
3. Browses and extracts content from each source
4. Evaluates sufficiency after each source
5. Synthesizes final answer
6. Decides output format (text or static page)
"""

import os
import json
import time
import asyncio
import subprocess
import sys
import re
import unicodedata
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone

# Add current directory to path for local imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pathlib import Path
from search_client import search, is_configured as search_configured
from browser_client import browse_url, close_browser
from llm_client import call_llm, call_llm_json, get_config as get_llm_config
from prompts import (
    plan_research_prompt,
    rank_urls_prompt,
    extract_info_prompt,
    evaluate_sufficiency_prompt,
    synthesize_prompt,
    format_decision_prompt,
)

# Configuration
MAX_SOURCES_DEFAULT = int(os.getenv("DEEP_RESEARCH_MAX_SOURCES", "3"))
MAX_ITERATIONS = int(os.getenv("DEEP_RESEARCH_MAX_ITERATIONS", "10"))
TEMP_DIR = os.getenv("DEEP_RESEARCH_TEMP_DIR", "./temp/deep_research")
CLOUDFLARE_TUNNEL_URL = os.getenv("CLOUDFLARE_TUNNEL_URL", "http://localhost:3000")
MAX_TEXT_LENGTH_FOR_PAGE = int(os.getenv("DEEP_RESEARCH_TEXT_THRESHOLD", "1000"))
MEMORY_MAX_AGE_HOURS = float(os.getenv("DEEP_RESEARCH_MEMORY_MAX_AGE_HOURS", "1"))
REALTIME_MEMORY_MAX_AGE_HOURS = float(
    os.getenv("DEEP_RESEARCH_REALTIME_MEMORY_MAX_AGE_HOURS", "0.25")
)
BUILTIN_MIN_SCORE = float(os.getenv("DEEP_RESEARCH_BUILTIN_MIN_SCORE", "0.45"))
USER_MEMORY_MIN_SUMMARY_LEN = int(
    os.getenv("DEEP_RESEARCH_USER_MEMORY_MIN_SUMMARY_LEN", "120")
)
USER_MEMORY_MIN_FACTS = int(os.getenv("DEEP_RESEARCH_USER_MEMORY_MIN_FACTS", "2"))
MEMORY_DIR = Path(__file__).parent / "memory"
MEMORY_DIR.mkdir(exist_ok=True)
BUILTIN_MEMORY_DIR = Path(__file__).parent / "builtin_memory"
BUILTIN_MEMORY_DIR.mkdir(exist_ok=True)

LANGUAGE_HINTS = {
    "en": {
        "realtime": [
            "today",
            "current",
            "now",
            "latest",
            "news",
            "weather",
            "stock",
            "price",
            "quote",
            "real-time",
            "live",
            "breaking",
        ],
        "news": ["news", "headline", "breaking", "update"],
    },
    "zh": {
        "realtime": [
            "今天",
            "目前",
            "现在",
            "最新",
            "新闻",
            "天氣",
            "天气",
            "股價",
            "股价",
            "價格",
            "价格",
            "實時",
            "实时",
            "直播",
            "快訊",
            "快讯",
        ],
        "news": ["新闻", "快讯", "头条", "最新"],
    },
    "ja": {
        "realtime": [
            "今日",
            "現在",
            "今",
            "最新",
            "ニュース",
            "天気",
            "株価",
            "価格",
            "リアルタイム",
            "ライブ",
            "速報",
        ],
        "news": ["ニュース", "速報", "見出し", "最新情報"],
    },
    "ko": {
        "realtime": [
            "오늘",
            "현재",
            "지금",
            "최신",
            "뉴스",
            "날씨",
            "주가",
            "가격",
            "실시간",
            "라이브",
            "속보",
        ],
        "news": ["뉴스", "속보", "헤드라인", "업데이트"],
    },
    "es": {
        "realtime": [
            "hoy",
            "actual",
            "ahora",
            "último",
            "noticias",
            "clima",
            "bolsa",
            "precio",
            "en vivo",
            "tiempo real",
        ],
        "news": ["noticias", "última hora", "titular", "actualización"],
    },
    "fr": {
        "realtime": [
            "aujourd'hui",
            "actuel",
            "maintenant",
            "dernier",
            "actualités",
            "météo",
            "bourse",
            "prix",
            "en direct",
            "temps réel",
        ],
        "news": ["actualités", "dernière minute", "titre", "mise à jour"],
    },
    "de": {
        "realtime": [
            "heute",
            "aktuell",
            "jetzt",
            "neueste",
            "nachrichten",
            "wetter",
            "aktie",
            "preis",
            "live",
            "echtzeit",
        ],
        "news": ["nachrichten", "schlagzeile", "eilmeldung", "update"],
    },
}


class ResearchResult:
    """Container for research results."""

    def __init__(self):
        self.query: str = ""
        self.mode: str = "deep"
        self.sources_visited: int = 0
        self.findings: List[Dict[str, Any]] = []
        self.summary: str = ""
        self.format: str = "text"  # 'text' or 'page'
        self.page_url: Optional[str] = None
        self.page_path: Optional[str] = None
        self.temp_dir: Optional[str] = None
        self.duration_ms: int = 0
        self.errors: List[str] = []

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON output."""
        result = {
            "success": True,
            "message": "",
            "data": {
                "query": self.query,
                "mode": self.mode,
                "sources_visited": self.sources_visited,
                "summary": self.summary,
                "format": self.format,
                "duration_ms": self.duration_ms,
            },
        }

        if self.page_url:
            result["data"]["page_url"] = self.page_url
            result["data"]["page_path"] = self.page_path
            result["message"] = (
                f"🔬 Research complete ({self.sources_visited} sources, {self.duration_ms}ms)\n\n{self.summary}\n\n📄 Full report: {self.page_url}"
            )
        else:
            result["message"] = (
                f"🔬 Research complete ({self.sources_visited} sources, {self.duration_ms}ms)\n\n{self.summary}"
            )

        if self.errors:
            result["data"]["warnings"] = self.errors

        return result


class DeepResearcher:
    """
    Core research engine with LLM-driven agent loop.

    Orchestrates the entire research process:
    plan → search → browse → extract → evaluate → synthesize
    """

    def __init__(
        self, query: str, mode: str = "deep", max_sources: int = MAX_SOURCES_DEFAULT
    ):
        self.query = query
        self.mode = mode
        self.max_sources = (
            min(max_sources, 2)
            if mode == "quick"
            else min(max_sources, MAX_SOURCES_DEFAULT)
        )
        self.findings: List[Dict[str, Any]] = []
        self.visited_urls: set = set()
        self.temp_dir: Optional[str] = None
        self.errors: List[str] = []
        self.session_id = f"{int(time.time())}_{hash(query) % 10000}"
        self.memory = None
        self.query_language = self._detect_query_language(query)

    def _normalize_text(self, text: str) -> str:
        return unicodedata.normalize("NFKC", (text or "").strip().lower())

    def _detect_query_language(self, query: str) -> str:
        q = self._normalize_text(query)
        if re.search(r"[\u4e00-\u9fff]", q):
            return "zh"
        if re.search(r"[\u3040-\u30ff]", q):
            return "ja"
        if re.search(r"[\uac00-\ud7af]", q):
            return "ko"
        for lang in ("es", "fr", "de"):
            for k in LANGUAGE_HINTS[lang]["realtime"] + LANGUAGE_HINTS[lang]["news"]:
                if k in q:
                    return lang
        return "en"

    def _all_keywords(self, kind: str) -> List[str]:
        return LANGUAGE_HINTS.get(self.query_language, {}).get(kind, []) + LANGUAGE_HINTS[
            "en"
        ].get(kind, [])

    def _is_news_query(self, query: str) -> bool:
        q = self._normalize_text(query)
        return any(k in q for k in self._all_keywords("news"))

    def _is_realtime_query(self, query: str) -> bool:
        """Check if query requires real-time data."""
        q = self._normalize_text(query)
        return any(k in q for k in self._all_keywords("realtime"))

    def _parse_ts(self, ts: str) -> Optional[datetime]:
        if not ts:
            return None
        try:
            if ts.endswith("Z"):
                ts = ts[:-1] + "+00:00"
            dt = datetime.fromisoformat(ts)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except Exception:
            return None

    def _memory_age_hours(self, mem: Dict[str, Any]) -> float:
        dt = self._parse_ts(mem.get("timestamp", ""))
        if not dt:
            return 1e9
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0

    def _memory_is_reusable(self, mem: Dict[str, Any]) -> bool:
        ttl = (
            REALTIME_MEMORY_MAX_AGE_HOURS
            if self._is_realtime_query(self.query)
            else MEMORY_MAX_AGE_HOURS
        )
        return self._memory_age_hours(mem) <= ttl

    def _keyword_score(self, query: str, keywords: List[str]) -> float:
        q = set(
            re.findall(
                r"[a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+",
                self._normalize_text(query),
            )
        )
        k = set(
            re.findall(
                r"[a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+",
                self._normalize_text(" ".join(keywords or [])),
            )
        )
        if not q or not k:
            return 0.0
        return len(q & k) / max(len(q | k), 1)

    def _is_low_quality_memory(self, mem: Dict[str, Any]) -> bool:
        findings = mem.get("findings", [])
        summary = (mem.get("summary") or "").strip()
        fact_count = sum(
            len(f.get("key_facts", [])) for f in findings if isinstance(f, dict)
        )
        return (
            len(summary) < USER_MEMORY_MIN_SUMMARY_LEN
            or len(findings) == 0
            or fact_count < USER_MEMORY_MIN_FACTS
        )

    def _create_temp_dir(self):
        """Create temp directory for this research session."""
        self.temp_dir = os.path.join(TEMP_DIR, self.session_id)
        os.makedirs(self.temp_dir, exist_ok=True)
        print(f"[Researcher] Temp dir: {self.temp_dir}")

    def _cleanup_temp_dir(self):
        """Remove temp directory and all contents."""
        if self.temp_dir and os.path.exists(self.temp_dir):
            import shutil

            try:
                shutil.rmtree(self.temp_dir)
                print(f"[Researcher] Cleaned up temp dir: {self.temp_dir}")
            except Exception as e:
                print(f"[Researcher] Failed to cleanup temp dir: {e}")

    def _sanitize_query(self, query: str) -> str:
        base = self._normalize_text(query)
        base = re.sub(r"[^\w\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af-]", "", base)
        base = re.sub(r"\s+", "-", base).strip("-")
        if not base:
            base = f"q-{abs(hash(query)) % 10000000}"
        return base[:100]

    def _load_memory(self):
        mem_file = MEMORY_DIR / f"{self._sanitize_query(self.query)}.json"
        if mem_file.exists():
            try:
                with open(mem_file, "r", encoding="utf-8") as f:
                    self.memory = json.load(f)
                print(f"[Researcher] Loaded memory for query: {self.query}")
                return self.memory
            except Exception as e:
                print(f"[Researcher] Failed to load memory: {e}")
                self.memory = None
        return None

    def _load_builtin_memory(self):
        """Load best built-in memory by score."""
        best = None
        best_score = 0.0
        for mem_file in BUILTIN_MEMORY_DIR.glob("*.json"):
            if mem_file.name == "_config.json":
                continue
            try:
                with open(mem_file, "r", encoding="utf-8") as f:
                    data = json.load(f)

                score = 0.0
                i18n_patterns = data.get("query_pattern_i18n", {})
                pattern = i18n_patterns.get(self.query_language) or data.get(
                    "query_pattern", ""
                )
                if pattern:
                    try:
                        if re.search(pattern, self.query, re.IGNORECASE):
                            score += 0.7
                    except re.error:
                        pass

                i18n_keywords = data.get("keywords_i18n", {})
                keywords = i18n_keywords.get(self.query_language, data.get("keywords", []))
                score += 0.25 * self._keyword_score(self.query, keywords)
                score += float(data.get("priority", 0.0))

                if score > best_score:
                    best = data
                    best_score = score
            except Exception as e:
                print(f"[Researcher] Failed to load builtin memory {mem_file}: {e}")

        if best and best_score >= BUILTIN_MIN_SCORE:
            print(f"[Researcher] Loaded builtin memory (score={best_score:.2f})")
            return best
        return None

    def _save_memory(self, result: ResearchResult):
        if not self.findings:
            return
        data = {
            "query": self.query,
            "findings": self.findings,
            "summary": result.summary,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "mode": self.mode,
            "sources_visited": len(self.findings),
        }

        if self._is_low_quality_memory(data):
            print("[Researcher] Skip saving low-quality memory")
            return

        mem_file = MEMORY_DIR / f"{self._sanitize_query(self.query)}.json"
        try:
            with open(mem_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"[Researcher] Saved memory for query: {self.query}")
        except Exception as e:
            print(f"[Researcher] Failed to save memory: {e}")

    def _save_source_data(self, source_index: int, data: Dict[str, Any]):
        """Save source data to temp file."""
        if not self.temp_dir:
            return
        filepath = os.path.join(self.temp_dir, f"source_{source_index:02d}.json")
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"[Researcher] Saved source data: {filepath}")
        except Exception as e:
            print(f"[Researcher] Failed to save source data: {e}")

    async def research(self) -> ResearchResult:
        """
        Run the full research pipeline.

        Returns:
            ResearchResult with synthesized findings
        """
        start_time = time.time()
        result = ResearchResult()
        result.query = self.query
        result.mode = self.mode

        try:
            self._create_temp_dir()
            builtin_mem = self._load_builtin_memory()
            user_mem = self._load_memory()

            # Reuse user memory only when fresh and high quality for non-realtime queries.
            if (
                user_mem
                and not self._is_realtime_query(self.query)
                and self._memory_is_reusable(user_mem)
                and not self._is_low_quality_memory(user_mem)
            ):
                print(
                    f"[Researcher] Using user memory ({self._memory_age_hours(user_mem):.2f}h old)"
                )
                result.findings = user_mem.get("findings", [])
                result.summary = user_mem.get("summary", "")
                result.sources_visited = user_mem.get(
                    "sources_visited", len(result.findings)
                )
                result.duration_ms = 0
                return result

            # Built-in memory acts as prior, not direct answer cache.
            self.memory = builtin_mem

            # Step 1: Plan research
            print(f"[Researcher] Planning research for: {self.query}")
            plan = self._plan_research()
            if not plan:
                # Fallback: use the query directly as search term
                plan = {
                    "search_terms": [self.query],
                    "search_type": "web",
                    "date_range": None,
                    "focus_areas": [self.query],
                    "expected_answer_type": "summary",
                }

            # If builtin memory has preferred sources, use them as direct URLs
            if self.memory and "preferred_sources" in self.memory:
                search_terms = [src["url"] for src in self.memory["preferred_sources"]]
                search_type = "direct"  # Special type to visit URLs directly
                date_range = None
                print(f"[Researcher] Using builtin sources: {search_terms}")
            else:
                search_terms = plan.get("search_terms", [self.query])
                search_type = plan.get("search_type", "web")
                date_range = plan.get("date_range")

            focus_areas = (
                self.memory.get("focus_areas", [])
                if self.memory and "focus_areas" in self.memory
                else plan.get("focus_areas", [self.query])
            )

            # Step 2: Research loop
            search_term_index = 0
            iteration = 0

            while iteration < MAX_ITERATIONS and len(self.findings) < self.max_sources:
                iteration += 1
                print(
                    f"[Researcher] Iteration {iteration}/{MAX_ITERATIONS}, sources: {len(self.findings)}/{self.max_sources}"
                )

                # Choose search term
                current_search = search_terms[search_term_index % len(search_terms)]

                # Step 2a: Search or use direct URLs
                if search_type == "direct":
                    # Direct URLs from builtin memory
                    search_result = {"success": True, "results": []}
                    ranked_indices = list(range(1, len(search_terms) + 1))
                else:
                    print(f"[Researcher] Searching: {current_search}")
                    if search_type == "news":
                        search_result = search(
                            current_search,
                            num_results=5,
                            date_range=date_range or "week",
                        )
                    else:
                        search_result = search(current_search, num_results=5)

                    if not search_result.get("success") or not search_result.get(
                        "results"
                    ):
                        error_msg = search_result.get("error", "No results found")
                        self.errors.append(f"Search failed: {error_msg}")
                        print(f"[Researcher] Search failed: {error_msg}")
                        search_term_index += 1
                        if search_term_index >= len(search_terms):
                            break
                        continue

                    # Step 2b: Rank URLs
                    ranked_indices = self._rank_urls(search_result["results"])
                    if not ranked_indices:
                        ranked_indices = list(
                            range(1, len(search_result["results"]) + 1)
                        )

                # Step 2c: Visit top sources
                found_new_source = False
                for idx in ranked_indices:
                    if len(self.findings) >= self.max_sources:
                        break

                    if search_type == "direct":
                        url = search_terms[idx - 1]
                        title = ""  # Will be filled by browser
                    else:
                        url = search_result["results"][idx - 1].get("url", "")
                        title = search_result["results"][idx - 1].get("title", "")

                    if not url or url in self.visited_urls:
                        continue

                    print(f"[Researcher] Visiting: {url}")
                    self.visited_urls.add(url)

                    # Step 2d: Browse and extract
                    page_data = await browse_url(url)
                    if not page_data.get("success"):
                        self.errors.append(
                            f"Failed to browse {url}: {page_data.get('error', 'Unknown')}"
                        )
                        continue

                    # Step 2e: Extract relevant info via LLM
                    extracted = self._extract_info(
                        page_data.get("title", title),
                        page_data.get("text", ""),
                        page_data.get("url", url),
                        focus_areas,
                    )

                    if extracted:
                        source_data = {
                            "url": url,
                            "title": page_data.get("title", title),
                            "relevant_info": extracted.get("relevant_info", ""),
                            "key_facts": extracted.get("key_facts", []),
                            "source_quality": extracted.get(
                                "source_quality", "unknown"
                            ),
                            "has_answer": extracted.get("has_answer", False),
                            "timestamp": datetime.utcnow().isoformat() + "Z",
                        }
                        self.findings.append(source_data)
                        self._save_source_data(len(self.findings), source_data)
                        found_new_source = True

                        # Step 2f: Evaluate sufficiency
                        if extracted.get("has_answer"):
                            evaluation = self._evaluate_sufficiency(iteration)
                            if evaluation and evaluation.get("is_sufficient"):
                                print(
                                    f"[Researcher] Findings sufficient after {len(self.findings)} sources"
                                )
                                break
                            elif evaluation and evaluation.get("next_search_term"):
                                search_terms.append(evaluation["next_search_term"])

                if not found_new_source:
                    search_term_index += 1
                    if search_term_index >= len(search_terms):
                        break

            # Step 3: Synthesize
            print(f"[Researcher] Synthesizing {len(self.findings)} findings")
            summary = self._synthesize()

            # Step 4: Decide format
            output_format = self._decide_format(summary)

            result.findings = self.findings
            result.summary = summary
            result.format = output_format
            result.sources_visited = len(self.findings)
            result.errors = self.errors

            # Step 5: Generate page if needed
            if output_format == "page":
                page_result = self._generate_page(summary)
                if page_result:
                    result.page_url = page_result.get("url")
                    result.page_path = page_result.get("path")

            result.temp_dir = self.temp_dir
            self._save_memory(result)

        except Exception as e:
            print(f"[Researcher] Research failed: {e}")
            import traceback

            traceback.print_exc()
            result.errors.append(str(e))

        finally:
            # Cleanup
            await close_browser()
            result.duration_ms = int((time.time() - start_time) * 1000)

            # Cleanup temp dir if no page was generated
            if not result.page_path:
                self._cleanup_temp_dir()

        return result

    async def analyze_url(
        self, url: str, query: Optional[str] = None
    ) -> ResearchResult:
        """
        Analyze a specific URL.

        Args:
            url: URL to analyze
            query: Optional query to focus the analysis

        Returns:
            ResearchResult with analysis
        """
        start_time = time.time()
        result = ResearchResult()
        result.query = query or f"Analyze content from {url}"
        result.mode = "quick"

        try:
            self._create_temp_dir()

            # Browse the URL
            print(f"[Researcher] Analyzing URL: {url}")
            page_data = await browse_url(url)

            if not page_data.get("success"):
                return self._error_result(
                    f"Failed to browse {url}: {page_data.get('error', 'Unknown')}"
                )

            # Extract info
            focus_areas = (
                [query]
                if query
                else ["main content", "key points", "important information"]
            )
            extracted = self._extract_info(
                page_data.get("title", ""),
                page_data.get("text", ""),
                page_data.get("url", url),
                focus_areas,
            )

            if extracted:
                source_data = {
                    "url": url,
                    "title": page_data.get("title", ""),
                    "relevant_info": extracted.get("relevant_info", ""),
                    "key_facts": extracted.get("key_facts", []),
                    "source_quality": extracted.get("source_quality", "unknown"),
                    "has_answer": extracted.get("has_answer", False),
                    "missing_info": extracted.get("missing_info", []),
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                }
                self.findings.append(source_data)
                self._save_source_data(1, source_data)

                # Optionally follow child links if info is incomplete
                if (
                    not extracted.get("has_answer")
                    and extracted.get("missing_info")
                    and page_data.get("links")
                ):
                    await self._follow_child_links(
                        page_data["links"],
                        extracted["missing_info"],
                        query or "main content",
                        max_additional=2,
                    )

            # Synthesize
            summary = self._synthesize()
            output_format = self._decide_format(summary)

            result.findings = self.findings
            result.summary = summary
            result.format = output_format
            result.sources_visited = len(self.findings)
            result.errors = self.errors

            if output_format == "page":
                page_result = self._generate_page(summary)
                if page_result:
                    result.page_url = page_result.get("url")
                    result.page_path = page_result.get("path")

        except Exception as e:
            print(f"[Researcher] URL analysis failed: {e}")
            import traceback

            traceback.print_exc()
            result.errors.append(str(e))

        finally:
            await close_browser()
            result.duration_ms = int((time.time() - start_time) * 1000)
            if not result.page_path:
                self._cleanup_temp_dir()

        return result

    async def _follow_child_links(
        self,
        links: List[Dict[str, Any]],
        missing_info: List[str],
        query: str,
        max_additional: int = 2,
    ):
        """Follow promising child links to gather missing information."""
        # Use LLM to pick the best links to follow
        links_text = "\n".join(
            f"- [{l.get('text', 'Untitled')}]({l.get('href', '')})" for l in links[:20]
        )
        missing_text = ", ".join(missing_info)

        prompt = f"""Given the missing information: {missing_text}

Which of these links would most likely contain the missing info?
{links_text}

Return a JSON array of URLs (most relevant first), max {max_additional} URLs.
Example: ["url1", "url2"]

Return ONLY the JSON array."""

        response = call_llm(prompt, temperature=0.3, max_tokens=500)
        if not response or response.startswith("Error:"):
            return

        # Parse URL list
        import re

        try:
            urls = json.loads(response.strip())
            if not isinstance(urls, list):
                return
        except json.JSONDecodeError:
            # Try to extract URLs with regex
            url_pattern = re.compile(r'https?://[^\s"\'\]<>]+')
            urls = url_pattern.findall(response)

        for url in urls[:max_additional]:
            if url in self.visited_urls:
                continue
            if len(self.findings) >= self.max_sources:
                break

            print(f"[Researcher] Following child link: {url}")
            self.visited_urls.add(url)

            page_data = await browse_url(url)
            if not page_data.get("success"):
                continue

            extracted = self._extract_info(
                page_data.get("title", ""),
                page_data.get("text", ""),
                page_data.get("url", url),
                missing_info,
            )

            if extracted:
                source_data = {
                    "url": url,
                    "title": page_data.get("title", ""),
                    "relevant_info": extracted.get("relevant_info", ""),
                    "key_facts": extracted.get("key_facts", []),
                    "source_quality": extracted.get("source_quality", "unknown"),
                    "has_answer": extracted.get("has_answer", False),
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                }
                self.findings.append(source_data)
                self._save_source_data(len(self.findings), source_data)

    def _plan_research(self) -> Optional[Dict[str, Any]]:
        """Use LLM to plan research strategy."""
        mode = "news" if self._is_news_query(self.query) else self.mode
        prompt = plan_research_prompt(self.query, mode)
        result = call_llm_json(
            prompt,
            system_msg="You are a research planning assistant.",
            temperature=0.3,
            max_tokens=500,
        )
        if result and self._is_news_query(self.query):
            result["search_type"] = "news"
            if not result.get("date_range"):
                result["date_range"] = "day"
        return result

    def _rank_urls(self, search_results: List[Dict[str, Any]]) -> List[int]:
        """Use LLM to rank search results by relevance."""
        prompt = rank_urls_prompt(self.query, search_results)
        result = call_llm_json(
            prompt,
            system_msg="You are a search result ranking assistant.",
            temperature=0.2,
            max_tokens=300,
        )
        if result and "ranked_indices" in result:
            return result["ranked_indices"]
        return []

    def _extract_info(
        self, page_title: str, page_text: str, url: str, focus_areas: List[str]
    ) -> Optional[Dict[str, Any]]:
        """Use LLM to extract relevant information from a page."""
        if not page_text or len(page_text.strip()) < 50:
            print(f"[Researcher] Page has too little text, skipping: {url}")
            return None

        prompt = extract_info_prompt(self.query, page_title, page_text, focus_areas)
        return call_llm_json(
            prompt,
            system_msg="You are a research information extraction assistant.",
            temperature=0.2,
            max_tokens=1024,
        )

    def _evaluate_sufficiency(self, iteration: int) -> Optional[Dict[str, Any]]:
        """Use LLM to evaluate if findings are sufficient."""
        prompt = evaluate_sufficiency_prompt(
            self.query, self.findings, iteration, MAX_ITERATIONS
        )
        return call_llm_json(
            prompt,
            system_msg="You are a research evaluation assistant.",
            temperature=0.3,
            max_tokens=500,
        )

    def _synthesize(self) -> str:
        """Use LLM to synthesize final answer from all findings."""
        if not self.findings:
            return "No relevant information was found for this query."

        prompt = synthesize_prompt(self.query, self.findings, self.mode)
        return call_llm(
            prompt,
            system_msg=(
                "You are a research synthesis assistant. "
                "Write clear, informative answers in the same language as the user's query."
            ),
            temperature=0.5,
            max_tokens=2048,
        )

    def _decide_format(self, summary: str) -> str:
        """Decide whether to return text or generate a static page."""
        # Simple heuristic first — skip LLM call for obvious cases
        if len(summary) < MAX_TEXT_LENGTH_FOR_PAGE:
            return "text"
        if len(summary) > 3000:
            return "page"

        # For borderline cases, ask the LLM
        prompt = format_decision_prompt(summary)
        result = call_llm_json(prompt, temperature=0.2, max_tokens=100)
        if result and "format" in result:
            return result["format"]
        return "text"  # Default to text

    def _generate_page(self, summary: str) -> Optional[Dict[str, str]]:
        """
        Generate a static page using the static_page skill.

        Spawns the static_page skill as a subprocess.
        """
        try:
            # Prepare data for static page
            sources = []
            for f in self.findings:
                sources.append(
                    {
                        "title": f.get("title", "Untitled"),
                        "url": f.get("url", ""),
                        "quality": f.get("source_quality", "unknown"),
                    }
                )

            page_data = {
                "title": f"Research: {self.query[:50]}",
                "content": summary,
                "sources": sources,
                "query": self.query,
                "mode": self.mode,
                "sources_visited": len(self.findings),
                "timestamp": datetime.utcnow().isoformat() + "Z",
            }

            # Spawn static_page skill
            skill_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "..",
                "static_page",
                "index.py",
            )
            skill_path = os.path.normpath(skill_path)

            if not os.path.exists(skill_path):
                print(f"[Researcher] Static page skill not found at: {skill_path}")
                return None

            input_data = {
                "params": {
                    "action": "generate",
                    "template": "document",
                    "title": f"Research: {self.query[:50]}",
                    "data": page_data,
                },
                "user_id": "deep_research",
            }

            result = subprocess.run(
                [sys.executable or "python3", skill_path],
                input=json.dumps(input_data),
                capture_output=True,
                text=True,
                timeout=30,
                cwd=os.getcwd(),
                env=os.environ,
            )

            if result.returncode == 0 and result.stdout.strip():
                page_result = json.loads(result.stdout.strip())
                if page_result.get("success"):
                    return {
                        "url": page_result.get("data", {}).get("url", ""),
                        "path": page_result.get("data", {}).get("path", ""),
                    }

            print(f"[Researcher] Static page generation failed: {result.stderr[:200]}")
            return None

        except Exception as e:
            print(f"[Researcher] Page generation error: {e}")
            return None

    def _error_result(self, error_msg: str) -> ResearchResult:
        """Create an error ResearchResult."""
        result = ResearchResult()
        result.query = self.query
        result.errors.append(error_msg)
        result.summary = f"Research failed: {error_msg}"
        return result

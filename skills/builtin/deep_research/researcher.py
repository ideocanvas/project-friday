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
from typing import Optional, Dict, Any, List
from datetime import datetime

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
MEMORY_DIR = Path(__file__).parent / "memory"
MEMORY_DIR.mkdir(exist_ok=True)


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

    def _is_realtime_query(self, query: str) -> bool:
        """Check if query requires real-time data."""
        realtime_keywords = [
            "today",
            "current",
            "now",
            "latest",
            "news",
            "weather",
            "stock price",
            "price of",
            "quote",
            "real-time",
            "live",
            "breaking",
        ]
        query_lower = query.lower()
        return any(keyword in query_lower for keyword in realtime_keywords)

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
        import re

        sanitized = re.sub(r"[^a-zA-Z0-9\s]", "", query.lower()).replace(" ", "-")
        return sanitized[:100]

    def _load_memory(self):
        mem_file = MEMORY_DIR / f"{self._sanitize_query(self.query)}.json"
        if mem_file.exists():
            try:
                with open(mem_file, "r", encoding="utf-8") as f:
                    self.memory = json.load(f)
                print(f"[Researcher] Loaded memory for query: {self.query}")
            except Exception as e:
                print(f"[Researcher] Failed to load memory: {e}")
                self.memory = None

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
            self._load_memory()

            # Check if we can use recent memory (skip for real-time queries)
            if self.memory and not self._is_realtime_query(self.query):
                mem_time = datetime.fromisoformat(self.memory["timestamp"][:-1])
                now = datetime.utcnow()
                age_hours = (now - mem_time).total_seconds() / 3600
                if age_hours < 1:  # Reuse if less than 1 hour old
                    print(f"[Researcher] Using recent memory ({age_hours:.1f}h old)")
                    result.findings = self.memory["findings"]
                    result.summary = self.memory["summary"]
                    result.sources_visited = self.memory["sources_visited"]
                    result.duration_ms = 0
                    return result

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

            search_terms = plan.get("search_terms", [self.query])
            search_type = plan.get("search_type", "web")
            date_range = plan.get("date_range")
            focus_areas = plan.get("focus_areas", [self.query])

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

                # Step 2a: Search
                print(f"[Researcher] Searching: {current_search}")
                if search_type == "news":
                    search_result = search(
                        current_search, num_results=5, date_range=date_range or "week"
                    )
                else:
                    search_result = search(current_search, num_results=5)

                if not search_result.get("success") or not search_result.get("results"):
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
                    ranked_indices = list(range(1, len(search_result["results"]) + 1))

                # Step 2c: Visit top sources
                found_new_source = False
                for idx in ranked_indices:
                    if len(self.findings) >= self.max_sources:
                        break

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
        prompt = plan_research_prompt(self.query, self.mode)
        return call_llm_json(
            prompt,
            system_msg="You are a research planning assistant.",
            temperature=0.3,
            max_tokens=500,
        )

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
            system_msg="You are a research synthesis assistant. Write clear, informative answers.",
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

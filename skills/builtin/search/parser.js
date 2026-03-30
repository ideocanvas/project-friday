/**
 * Search Result Parser & Filter
 * 
 * Transforms raw Google API results into clean, usable format.
 * Filters out ads, spam, and irrelevant results.
 */

/**
 * Parse a single search result item
 * @param {object} item - Raw Google API item
 * @param {number} position - Result position (1-based)
 * @returns {object}
 */
export function parseResult(item, position) {
    const result = {
        position: position,
        title: item.title || '',
        url: item.link || '',
        displayUrl: item.displayLink || '',
        snippet: item.snippet || '',
    };
    
    // Extract image if available
    if (item.pagemap?.cse_image?.[0]?.src) {
        result.image = item.pagemap.cse_image[0].src;
    }
    
    // Extract thumbnail if available
    if (item.pagemap?.cse_thumbnail?.[0]?.src) {
        result.thumbnail = item.pagemap.cse_thumbnail[0].src;
    }
    
    // Extract publish date for news
    if (item.pagemap?.metatags?.[0]?.['article:published_time']) {
        result.publishedDate = item.pagemap.metatags[0]['article:published_time'];
    }
    
    // Extract author if available
    if (item.pagemap?.metatags?.[0]?.['article:author']) {
        result.author = item.pagemap.metatags[0]['article:author'];
    }
    
    return result;
}

/**
 * Parse all search results
 * @param {array} items - Raw Google API items
 * @returns {array}
 */
export function parseResults(items) {
    if (!items || !Array.isArray(items)) {
        return [];
    }
    
    return items.map((item, index) => parseResult(item, index + 1));
}

/**
 * Filter out low-quality results
 * @param {object} result - Parsed result
 * @returns {boolean}
 */
function isHighQuality(result) {
    // Filter out results with no title
    if (!result.title || result.title.trim().length < 3) {
        return false;
    }
    
    // Filter out results with no URL
    if (!result.url || result.url.trim().length < 10) {
        return false;
    }
    
    // Filter out common ad patterns
    const adPatterns = [
        /^Ad\s/i,
        /^Sponsored/i,
        /^Promoted/i,
        /\[Ad\]/i
    ];
    
    for (const pattern of adPatterns) {
        if (pattern.test(result.title)) {
            return false;
        }
    }
    
    return true;
}

/**
 * Filter and clean results
 * @param {array} results - Parsed results
 * @returns {array}
 */
export function filterResults(results) {
    return results
        .filter(isHighQuality)
        .map(cleanResult);
}

/**
 * Clean up result text
 * @param {object} result - Result to clean
 * @returns {object}
 */
function cleanResult(result) {
    // Clean up snippet
    if (result.snippet) {
        result.snippet = result.snippet
            .replace(/\s+/g, ' ')  // Normalize whitespace
            .replace(/�/g, '')     // Remove replacement characters
            .trim();
    }
    
    // Clean up title
    if (result.title) {
        result.title = result.title
            .replace(/\s+/g, ' ')
            .trim();
    }
    
    return result;
}

/**
 * Deduplicate results by URL
 * @param {array} results - Results to deduplicate
 * @returns {array}
 */
export function deduplicateResults(results) {
    const seen = new Set();
    return results.filter(result => {
        if (seen.has(result.url)) {
            return false;
        }
        seen.add(result.url);
        return true;
    });
}

/**
 * Score result relevance
 * @param {object} result - Result to score
 * @param {string} query - Original query
 * @returns {number}
 */
function scoreRelevance(result, query) {
    let score = 0;
    const queryTerms = query.toLowerCase().split(/\s+/);
    
    // Title matches (weight: 3)
    const titleLower = result.title.toLowerCase();
    for (const term of queryTerms) {
        if (titleLower.includes(term)) {
            score += 3;
        }
    }
    
    // Snippet matches (weight: 1)
    const snippetLower = result.snippet.toLowerCase();
    for (const term of queryTerms) {
        if (snippetLower.includes(term)) {
            score += 1;
        }
    }
    
    // Position bonus (higher position = higher score)
    score += Math.max(0, 11 - result.position);
    
    return score;
}

/**
 * Sort results by relevance
 * @param {array} results - Results to sort
 * @param {string} query - Original query
 * @returns {array}
 */
export function sortByRelevance(results, query) {
    return results
        .map(result => ({
            ...result,
            relevanceScore: scoreRelevance(result, query)
        }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .map(result => {
            const { relevanceScore, ...rest } = result;
            return rest;
        });
}

/**
 * Format results for display
 * @param {array} results - Results to format
 * @param {object} options - Formatting options
 * @returns {string}
 */
export function formatResults(results, options = {}) {
    const { maxResults = 10, includeSnippet = true } = options;
    
    const limited = results.slice(0, maxResults);
    
    if (limited.length === 0) {
        return 'No results found.';
    }
    
    const lines = [];
    
    for (const result of limited) {
        lines.push(`${result.position}. **${result.title}**`);
        lines.push(`   ${result.url}`);
        if (includeSnippet && result.snippet) {
            lines.push(`   ${result.snippet}`);
        }
        lines.push('');
    }
    
    return lines.join('\n');
}

/**
 * Format results for LLM context
 * @param {array} results - Results to format
 * @param {object} metadata - Search metadata
 * @returns {string}
 */
export function formatForLLM(results, metadata = {}) {
    const lines = [];
    
    lines.push(`# Search Results for "${metadata.query || 'unknown'}"`);
    lines.push(`Found ${metadata.totalResults || results.length} results`);
    lines.push(`Search time: ${metadata.searchTimeMs || 0}ms`);
    lines.push('');
    
    if (results.length === 0) {
        lines.push('No results found.');
        return lines.join('\n');
    }
    
    for (const result of results) {
        lines.push(`## [${result.position}] ${result.title}`);
        lines.push(`URL: ${result.url}`);
        if (result.snippet) {
            lines.push(`Snippet: ${result.snippet}`);
        }
        if (result.publishedDate) {
            lines.push(`Published: ${result.publishedDate}`);
        }
        lines.push('');
    }
    
    return lines.join('\n');
}

/**
 * Process search results (parse, filter, deduplicate, sort)
 * @param {object} response - Raw Google API response
 * @param {string} query - Original query
 * @returns {object}
 */
export function processResults(response, query) {
    // Parse raw results
    const parsed = parseResults(response.results || []);
    
    // Filter low-quality results
    const filtered = filterResults(parsed);
    
    // Deduplicate
    const deduped = deduplicateResults(filtered);
    
    // Sort by relevance
    const sorted = sortByRelevance(deduped, query);
    
    return {
        ...response,
        results: sorted,
        processedCount: sorted.length,
        rawCount: parsed.length
    };
}

export default {
    parseResult,
    parseResults,
    filterResults,
    deduplicateResults,
    sortByRelevance,
    formatResults,
    formatForLLM,
    processResults
};
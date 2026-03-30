#!/usr/bin/env node
/**
 * Google Search Skill - Built-in Skill for Friday
 * 
 * Provides web search capabilities using Google Custom Search API.
 * Used when Friday needs current information, news, or data not in its training set.
 * 
 * Based on: plan/design-search.md
 */

import { search as googleSearch, searchNews, searchImages, isConfigured, clearCache, getCacheStats } from './google-api.js';
import { processResults, formatForLLM, formatResults } from './parser.js';

// === CONFIGURATION ===
const SKILL_NAME = "search";
const VERSION = "1.0.0";

// === SKILL PARAMETERS ===
const PARAMETERS = {
    action: {
        type: "string",
        enum: ["search", "search_news", "search_images", "status", "clear_cache"],
        required: true,
        description: "Action to perform"
    },
    query: {
        type: "string",
        required: false,
        description: "Search query (required for search actions)"
    },
    numResults: {
        type: "number",
        required: false,
        default: 10,
        description: "Number of results to return (default: 10)"
    },
    dateRange: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        required: false,
        default: "week",
        description: "Date range for news search (default: week)"
    }
};

/**
 * Validate input parameters
 * @param {object} params - Input parameters
 * @returns {object} { valid: boolean, error: string|null }
 */
function validateParams(params) {
    const action = params.action;
    
    if (!action) {
        return { valid: false, error: "Missing required parameter: action" };
    }
    
    const validActions = ["search", "search_news", "search_images", "status", "clear_cache"];
    if (!validActions.includes(action)) {
        return { valid: false, error: `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}` };
    }
    
    // Search actions require query
    if (["search", "search_news", "search_images"].includes(action)) {
        if (!params.query || params.query.trim().length === 0) {
            return { valid: false, error: `Missing required parameter: query (required for ${action})` };
        }
    }
    
    // Validate numResults
    if (params.numResults !== undefined) {
        const num = parseInt(params.numResults, 10);
        if (isNaN(num) || num < 1 || num > 10) {
            return { valid: false, error: "numResults must be between 1 and 10" };
        }
    }
    
    return { valid: true, error: null };
}

/**
 * Main skill logic
 * @param {object} params - Input parameters
 * @param {string} userId - User's phone number
 * @returns {object} Result object with success, message, and data
 */
async function logic(params, userId) {
    const action = params.action;
    
    // Check configuration for search actions
    if (["search", "search_news", "search_images"].includes(action)) {
        if (!isConfigured()) {
            return {
                success: false,
                message: "❌ Search not configured. Please set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX environment variables.",
                data: { configured: false }
            };
        }
    }
    
    try {
        switch (action) {
            case "search": {
                const query = params.query.trim();
                const numResults = parseInt(params.numResults || 10, 10);
                
                const response = await googleSearch(query, numResults);
                
                if (!response.success) {
                    return {
                        success: false,
                        message: `❌ Search failed: ${response.error}`,
                        data: response
                    };
                }
                
                // Process results
                const processed = processResults(response, query);
                
                // Format for LLM
                const llmContext = formatForLLM(processed.results, {
                    query: query,
                    totalResults: processed.totalResults,
                    searchTimeMs: processed.searchTimeMs
                });
                
                // Format for user
                const userMessage = formatResults(processed.results, { maxResults: numResults });
                
                return {
                    success: true,
                    message: `🔍 Found ${processed.results.length} results for "${query}"\n\n${userMessage}`,
                    data: {
                        query: query,
                        totalResults: processed.totalResults,
                        searchTimeMs: processed.searchTimeMs,
                        results: processed.results,
                        llmContext: llmContext
                    }
                };
            }
            
            case "search_news": {
                const query = params.query.trim();
                const numResults = parseInt(params.numResults || 10, 10);
                const dateRange = params.dateRange || "week";
                
                const response = await searchNews(query, dateRange, numResults);
                
                if (!response.success) {
                    return {
                        success: false,
                        message: `❌ News search failed: ${response.error}`,
                        data: response
                    };
                }
                
                // Process results
                const processed = processResults(response, query);
                
                // Format for LLM
                const llmContext = formatForLLM(processed.results, {
                    query: query,
                    totalResults: processed.totalResults,
                    searchTimeMs: processed.searchTimeMs
                });
                
                // Format for user
                const userMessage = formatResults(processed.results, { maxResults: numResults });
                
                return {
                    success: true,
                    message: `📰 Found ${processed.results.length} news articles for "${query}" (last ${dateRange})\n\n${userMessage}`,
                    data: {
                        query: query,
                        dateRange: dateRange,
                        totalResults: processed.totalResults,
                        searchTimeMs: processed.searchTimeMs,
                        results: processed.results,
                        llmContext: llmContext
                    }
                };
            }
            
            case "search_images": {
                const query = params.query.trim();
                const numResults = parseInt(params.numResults || 5, 10);
                
                const response = await searchImages(query, numResults);
                
                if (!response.success) {
                    return {
                        success: false,
                        message: `❌ Image search failed: ${response.error}`,
                        data: response
                    };
                }
                
                // Process results
                const processed = processResults(response, query);
                
                // Format image results
                const imageResults = processed.results.map((r, i) => ({
                    position: i + 1,
                    title: r.title,
                    url: r.url,
                    thumbnail: r.thumbnail || null,
                    image: r.image || null,
                    snippet: r.snippet
                }));
                
                return {
                    success: true,
                    message: `🖼️ Found ${imageResults.length} images for "${query}"`,
                    data: {
                        query: query,
                        totalResults: processed.totalResults,
                        searchTimeMs: processed.searchTimeMs,
                        results: imageResults
                    }
                };
            }
            
            case "status": {
                const stats = getCacheStats();
                const config = isConfigured();
                
                return {
                    success: true,
                    message: config 
                        ? `✅ Search is configured and ready.\n📊 Cache: ${stats.size} entries`
                        : "❌ Search not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX.",
                    data: {
                        configured: config,
                        cacheStats: stats
                    }
                };
            }
            
            case "clear_cache": {
                const result = clearCache();
                return {
                    success: true,
                    message: "✅ Search cache cleared.",
                    data: result
                };
            }
            
            default:
                return {
                    success: false,
                    message: `Unknown action: ${action}`
                };
        }
    } catch (err) {
        return {
            success: false,
            message: `❌ Search error: ${err.message}`,
            data: { error: err.message }
        };
    }
}

/**
 * Entry point - called by Node.js via spawn
 * Reads JSON from stdin, writes result to stdout
 */
async function main() {
    // Read input from stdin
    let input = '';
    
    process.stdin.setEncoding('utf8');
    
    for await (const chunk of process.stdin) {
        input += chunk;
    }
    
    try {
        const inputData = JSON.parse(input);
        const params = inputData.params || {};
        const userId = inputData.user_id || 'default';
        
        // Validate parameters
        const validation = validateParams(params);
        if (!validation.valid) {
            console.log(JSON.stringify({
                success: false,
                error: validation.error
            }));
            process.exit(1);
        }
        
        // Execute
        const result = await logic(params, userId);
        console.log(JSON.stringify(result));
        process.exit(0);
        
    } catch (err) {
        console.log(JSON.stringify({
            success: false,
            error: `Invalid input: ${err.message}`
        }));
        process.exit(1);
    }
}

// Export for testing
export { SKILL_NAME, VERSION, PARAMETERS, validateParams, logic };

// Run if called directly
main();
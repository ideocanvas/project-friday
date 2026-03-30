/**
 * Google Custom Search API Wrapper
 *
 * Provides a simple interface to Google's Custom Search API.
 * Handles authentication, rate limiting, and error handling.
 */

import https from 'https';
import http from 'http';
import 'dotenv/config';

// Configuration from environment
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || '';
const GOOGLE_SEARCH_CX = process.env.GOOGLE_SEARCH_CX || '';
const SEARCH_MAX_RESULTS = parseInt(process.env.SEARCH_MAX_RESULTS || '10', 10);

// In-memory cache (5 minute TTL)
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if search is configured
 * @returns {boolean}
 */
export function isConfigured() {
    return !!(GOOGLE_SEARCH_API_KEY && GOOGLE_SEARCH_CX);
}

/**
 * Get configuration status
 * @returns {object}
 */
export function getConfig() {
    return {
        hasApiKey: !!GOOGLE_SEARCH_API_KEY,
        hasCx: !!GOOGLE_SEARCH_CX,
        maxResults: SEARCH_MAX_RESULTS,
        isConfigured: isConfigured()
    };
}

/**
 * Clear the search cache
 */
export function clearCache() {
    cache.clear();
    return { success: true, message: 'Search cache cleared' };
}

/**
 * Make an HTTP request
 * @param {string} url - URL to request
 * @returns {Promise<object>}
 */
function makeRequest(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        
        client.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    } else {
                        resolve(JSON.parse(data));
                    }
                } catch (err) {
                    reject(new Error(`Failed to parse response: ${err.message}`));
                }
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Build search URL
 * @param {string} query - Search query
 * @param {object} options - Search options
 * @returns {string}
 */
function buildSearchUrl(query, options = {}) {
    const params = new URLSearchParams({
        key: GOOGLE_SEARCH_API_KEY,
        cx: GOOGLE_SEARCH_CX,
        q: query,
        num: options.numResults || SEARCH_MAX_RESULTS
    });
    
    // Add optional parameters
    if (options.start) {
        params.set('start', options.start);
    }
    
    if (options.dateRestrict) {
        params.set('dateRestrict', options.dateRestrict);
    }
    
    if (options.searchType) {
        params.set('searchType', options.searchType);
    }
    
    if (options.safe) {
        params.set('safe', options.safe);
    }
    
    return `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
}

/**
 * Execute a search with caching
 * @param {string} query - Search query
 * @param {object} options - Search options
 * @returns {Promise<object>}
 */
async function searchWithCache(query, options = {}) {
    if (!isConfigured()) {
        return {
            success: false,
            error: 'Search not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX environment variables.',
            results: []
        };
    }
    
    const numResults = options.numResults || SEARCH_MAX_RESULTS;
    const cacheKey = `${query}:${numResults}:${options.searchType || 'web'}`;
    
    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return {
            ...cached.data,
            fromCache: true
        };
    }
    
    const startTime = Date.now();
    
    try {
        const url = buildSearchUrl(query, options);
        const response = await makeRequest(url);
        
        const searchTime = Date.now() - startTime;
        
        const result = {
            success: true,
            query: query,
            totalResults: parseInt(response.searchInformation?.totalResults || '0', 10),
            searchTimeMs: searchTime,
            fromCache: false,
            results: response.items || []
        };
        
        // Cache the result
        cache.set(cacheKey, { data: result, timestamp: Date.now() });
        
        return result;
        
    } catch (err) {
        // Handle specific errors
        if (err.message.includes('403')) {
            return {
                success: false,
                error: 'API rate limit reached. Please try again later.',
                query: query,
                results: []
            };
        }
        
        if (err.message.includes('400')) {
            return {
                success: false,
                error: `Invalid search query: ${err.message}`,
                query: query,
                results: []
            };
        }
        
        return {
            success: false,
            error: `Search failed: ${err.message}`,
            query: query,
            results: []
        };
    }
}

/**
 * Search the web
 * @param {string} query - Search query
 * @param {number} numResults - Number of results (default: 10)
 * @returns {Promise<object>}
 */
export async function search(query, numResults = SEARCH_MAX_RESULTS) {
    return searchWithCache(query, { numResults });
}

/**
 * Search for news (with date restriction)
 * @param {string} query - Search query
 * @param {string} dateRange - Date range: 'day', 'week', 'month', 'year'
 * @param {number} numResults - Number of results
 * @returns {Promise<object>}
 */
export async function searchNews(query, dateRange = 'week', numResults = SEARCH_MAX_RESULTS) {
    const dateRestrictMap = {
        'day': 'd1',
        'week': 'w1',
        'month': 'm1',
        'year': 'y1'
    };
    
    const dateRestrict = dateRestrictMap[dateRange] || 'w1';
    
    return searchWithCache(query, { 
        numResults, 
        dateRestrict 
    });
}

/**
 * Search for images
 * @param {string} query - Search query
 * @param {number} numResults - Number of results
 * @returns {Promise<object>}
 */
export async function searchImages(query, numResults = 5) {
    return searchWithCache(query, { 
        numResults, 
        searchType: 'image' 
    });
}

/**
 * Get cache statistics
 * @returns {object}
 */
export function getCacheStats() {
    return {
        size: cache.size,
        entries: Array.from(cache.keys()).map(key => {
            const cached = cache.get(key);
            return {
                key: key,
                age: Date.now() - cached.timestamp,
                valid: (Date.now() - cached.timestamp) < CACHE_TTL_MS
            };
        })
    };
}

export default {
    isConfigured,
    getConfig,
    clearCache,
    search,
    searchNews,
    searchImages,
    getCacheStats
};
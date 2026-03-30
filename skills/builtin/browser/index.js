#!/usr/bin/env node
/**
 * Live Browser Skill - Built-in Skill for Friday
 * 
 * Provides browser automation capabilities using Playwright with Chrome.
 * Allows Friday to interact with websites, take screenshots, and scrape data.
 * 
 * Key Features:
 * - Persistent Chrome instance (stays open between requests)
 * - Session persistence (login state maintained)
 * - Screenshot capture for user analysis
 * - Text scraping and JavaScript execution
 * 
 * Based on: plan/design-browser.md
 */

import { getBrowser, getPage, runBrowserAction, isBrowserRunning, closeBrowser } from './chrome-manager.js';
import * as actions from './actions.js';
import path from 'path';
import fs from 'fs';

// === CONFIGURATION ===
const SKILL_NAME = "browser";
const VERSION = "1.1.0";

// Actions that should include a screenshot for vision models
const SCREENSHOT_ACTIONS = [
    'goto',
    'get_structure', 
    'get_links',
    'get_forms',
    'get_images',
    'get_table',
    'find_by_text',
    'scrape_text',
    'click',
    'fill',
    'scroll_down',
    'status'
];

// === SKILL PARAMETERS ===
const PARAMETERS = {
    action: {
        type: "string",
        enum: [
            // Navigation
            "goto",
            "get_url",
            "get_title",
            "wait_for_navigation",
            // Interaction
            "click",
            "fill",
            "press",
            "scroll_down",
            "wait_for_selector",
            // Data extraction
            "screenshot",
            "scrape_text",
            "evaluate",
            // Page discovery (for LLM usability)
            "get_html",
            "get_structure",
            "find_by_text",
            "get_links",
            "get_forms",
            "get_images",
            "get_table",
            // Utility
            "status"
        ],
        required: true,
        description: "Browser action to perform"
    },
    url: {
        type: "string",
        required: false,
        description: "URL to navigate to (required for goto action)"
    },
    selector: {
        type: "string",
        required: false,
        description: "CSS selector for element operations"
    },
    text: {
        type: "string",
        required: false,
        description: "Text to fill in input field (for fill action)"
    },
    script: {
        type: "string",
        required: false,
        description: "JavaScript code to execute (for evaluate action)"
    },
    timeout: {
        type: "number",
        required: false,
        default: 30000,
        description: "Timeout in milliseconds (default: 30000)"
    },
    name: {
        type: "string",
        required: false,
        description: "Name for screenshot file (without extension)"
    },
    savePath: {
        type: "string",
        required: false,
        description: "Full path to save screenshot"
    },
    fullPage: {
        type: "boolean",
        required: false,
        default: true,
        description: "Capture full page screenshot (default: true)"
    },
    pixels: {
        type: "number",
        required: false,
        default: 500,
        description: "Pixels to scroll (for scroll_down action)"
    },
    key: {
        type: "string",
        required: false,
        description: "Key to press (for press action, e.g., 'Enter', 'Escape')"
    },
    waitUntil: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        required: false,
        default: "networkidle",
        description: "Wait condition for navigation"
    },
    state: {
        type: "string",
        enum: ["attached", "detached", "visible", "hidden"],
        required: false,
        default: "visible",
        description: "State to wait for (for wait_for_selector action)"
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
    
    const validActions = Object.keys(actions.actions);
    if (!validActions.includes(action)) {
        return { valid: false, error: `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}` };
    }
    
    // goto requires url
    if (action === "goto" && !params.url) {
        return { valid: false, error: "Missing required parameter: url (required for goto action)" };
    }
    
    // click requires selector
    if (action === "click" && !params.selector) {
        return { valid: false, error: "Missing required parameter: selector (required for click action)" };
    }
    
    // fill requires selector and text
    if (action === "fill") {
        if (!params.selector) {
            return { valid: false, error: "Missing required parameter: selector (required for fill action)" };
        }
        if (params.text === undefined || params.text === null) {
            return { valid: false, error: "Missing required parameter: text (required for fill action)" };
        }
    }
    
    // evaluate requires script
    if (action === "evaluate" && !params.script) {
        return { valid: false, error: "Missing required parameter: script (required for evaluate action)" };
    }
    
    // wait_for_selector requires selector
    if (action === "wait_for_selector" && !params.selector) {
        return { valid: false, error: "Missing required parameter: selector (required for wait_for_selector action)" };
    }
    
    // press requires key
    if (action === "press" && !params.key) {
        return { valid: false, error: "Missing required parameter: key (required for press action)" };
    }
    
    return { valid: true, error: null };
}

/**
 * Capture a screenshot for vision model support
 * @param {object} page - Playwright page object
 * @param {string} userId - User ID for organizing screenshots
 * @returns {Promise<object>} Screenshot info { path, base64, filename }
 */
async function captureVisionScreenshot(page, userId) {
    try {
        // Generate screenshot path
        const screenshotDir = path.join(process.cwd(), 'web_portal', userId || 'default', 'browser');
        
        // Ensure directory exists
        if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, { recursive: true });
        }
        
        const timestamp = Date.now();
        const filename = `browser-${timestamp}.png`;
        const screenshotPath = path.join(screenshotDir, filename);
        
        // Capture screenshot
        const screenshotBuffer = await page.screenshot({
            path: screenshotPath,
            fullPage: false  // Just viewport for faster capture
        });
        
        // Convert to base64 for inline image in response
        const base64 = screenshotBuffer.toString('base64');
        
        console.log(`[Browser] Captured vision screenshot: ${screenshotPath}`);
        
        return {
            path: screenshotPath,
            filename: filename,
            base64: base64,
            mimeType: 'image/png'
        };
    } catch (err) {
        console.error(`[Browser] Failed to capture vision screenshot:`, err.message);
        return null;
    }
}

/**
 * Main skill logic
 * @param {object} params - Input parameters
 * @param {string} userId - User's phone number
 * @returns {object} Result object with success, message, and data
 */
async function logic(params, userId) {
    const action = params.action;
    
    try {
        // Ensure browser is running
        console.log(`[Browser] Starting action: ${action}`);
        
        // Get the action handler
        const actionHandler = actions.actions[action];
        if (!actionHandler) {
            return {
                success: false,
                message: `Unknown action: ${action}`,
                data: { error: `Unknown action: ${action}` }
            };
        }
        
        // Execute the action
        const result = await runBrowserAction(async (page) => {
            return await actionHandler(page, params);
        });
        
        // Capture screenshot for vision models if action supports it
        let visionScreenshot = null;
        if (SCREENSHOT_ACTIONS.includes(action) && result.success) {
            visionScreenshot = await runBrowserAction(async (page) => {
                return await captureVisionScreenshot(page, userId);
            });
        }
        
        // Format response based on action type
        const response = formatResponse(action, result, params);
        
        // Add vision screenshot to response if captured
        if (visionScreenshot) {
            response.screenshot = {
                path: visionScreenshot.path,
                filename: visionScreenshot.filename,
                base64: visionScreenshot.base64,
                mimeType: visionScreenshot.mimeType
            };
            // Add image data for LLM vision models
            response.image = {
                data: visionScreenshot.base64,
                mimeType: 'image/png'
            };
        }
        
        return response;
        
    } catch (err) {
        console.error(`[Browser] Action ${action} failed:`, err);
        return {
            success: false,
            message: `❌ Browser action failed: ${err.message}`,
            data: { error: err.message }
        };
    }
}

/**
 * Format response based on action type
 * @param {string} action - Action name
 * @param {object} result - Action result
 * @param {object} params - Original parameters
 * @returns {object} Formatted response
 */
function formatResponse(action, result, params) {
    if (!result.success) {
        return {
            success: false,
            message: `❌ ${action} failed: ${result.error}`,
            data: result
        };
    }
    
    switch (action) {
        case "goto":
            return {
                success: true,
                message: `✅ Navigated to: ${result.url}\n📄 Title: ${result.title}`,
                data: {
                    url: result.url,
                    title: result.title,
                    status: result.status
                }
            };
            
        case "screenshot":
            return {
                success: true,
                message: `📸 Screenshot saved: ${result.filename}`,
                data: {
                    path: result.path,
                    filename: result.filename
                }
            };
            
        case "scrape_text":
            return {
                success: true,
                message: `📝 Scraped ${result.length} characters`,
                data: {
                    text: result.text,
                    length: result.length
                }
            };
            
        case "click":
            return {
                success: true,
                message: `👆 Clicked: ${result.selector}`,
                data: result
            };
            
        case "fill":
            return {
                success: true,
                message: `✏️ Filled "${result.text}" in: ${result.selector}`,
                data: result
            };
            
        case "evaluate":
            return {
                success: true,
                message: `🔧 Script executed successfully`,
                data: {
                    result: result.result
                }
            };
            
        case "wait_for_selector":
            return {
                success: true,
                message: `⏳ Element found: ${result.selector} (state: ${result.state})`,
                data: result
            };
            
        case "scroll_down":
            return {
                success: true,
                message: `📜 Scrolled down ${result.pixels} pixels`,
                data: result
            };
            
        case "get_url":
            return {
                success: true,
                message: `🔗 Current URL: ${result.url}`,
                data: { url: result.url }
            };
            
        case "get_title":
            return {
                success: true,
                message: `📄 Page title: ${result.title}`,
                data: { title: result.title }
            };
            
        case "wait_for_navigation":
            return {
                success: true,
                message: `✅ Navigation complete: ${result.url}\n📄 Title: ${result.title}`,
                data: {
                    url: result.url,
                    title: result.title
                }
            };
            
        case "press":
            return {
                success: true,
                message: `⌨️ Pressed: ${result.key}`,
                data: result
            };
            
        case "status":
            return {
                success: true,
                message: `📊 Browser Status:\n🔗 URL: ${result.url}\n📄 Title: ${result.title}\n✅ Running: ${result.isRunning}`,
                data: result
            };
            
        // Page Discovery Actions
        case "get_html":
            return {
                success: true,
                message: `📄 Got HTML (${result.length} chars${result.truncated ? ', truncated' : ''})`,
                data: {
                    html: result.html,
                    length: result.length,
                    truncated: result.truncated
                }
            };
            
        case "get_structure":
            return {
                success: true,
                message: `🏗️ Page structure:\n${Object.entries(result.counts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
                data: {
                    structure: result.structure,
                    counts: result.counts,
                    url: result.url
                }
            };
            
        case "find_by_text":
            return {
                success: true,
                message: `🔍 Found ${result.count} elements matching "${result.text}"`,
                data: {
                    text: result.text,
                    type: result.type,
                    exact: result.exact,
                    count: result.count,
                    elements: result.elements
                }
            };
            
        case "get_links":
            return {
                success: true,
                message: `🔗 Found ${result.count} links on page`,
                data: {
                    count: result.count,
                    links: result.links,
                    url: result.url
                }
            };
            
        case "get_forms":
            return {
                success: true,
                message: `📝 Found ${result.count} forms on page`,
                data: {
                    count: result.count,
                    forms: result.forms,
                    url: result.url
                }
            };
            
        case "get_images":
            return {
                success: true,
                message: `🖼️ Found ${result.count} images on page`,
                data: {
                    count: result.count,
                    images: result.images,
                    url: result.url
                }
            };
            
        case "get_table":
            return {
                success: true,
                message: `📊 Table extracted: ${result.rowCount} rows, ${result.columnCount} columns`,
                data: {
                    headers: result.headers,
                    rows: result.rows,
                    rowCount: result.rowCount,
                    columnCount: result.columnCount,
                    selector: result.selector
                }
            };
            
        default:
            return {
                success: true,
                message: `✅ ${action} completed`,
                data: result
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
/**
 * Chrome Manager - Manages persistent Chrome browser instance
 * 
 * This module maintains a single Chrome instance that stays open
 * for the lifetime of the gateway process. This allows:
 * - Instant browser actions (no startup delay)
 * - Persistent login sessions across requests
 * - Lower memory usage than multiple instances
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to Chrome profile directory
const CHROME_PROFILE_DIR = path.join(__dirname, 'chrome-profile', 'default');

// Ensure profile directory exists
if (!fs.existsSync(CHROME_PROFILE_DIR)) {
    fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
}

// Singleton browser instance
let browserInstance = null;
let context = null;
let isLaunching = false;

// CDP endpoint for connecting to existing Chrome
const CDP_ENDPOINT = 'http://localhost:9222';

/**
 * Get or create the browser instance
 * Uses CDP connection to connect to existing Chrome or launches new instance
 * 
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function getBrowser() {
    // Return existing context if available
    if (context) {
        return context;
    }

    // Wait for any ongoing launch to complete
    if (isLaunching) {
        while (isLaunching) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return context;
    }

    isLaunching = true;

    try {
        // Try connecting to existing Chrome with DevTools Protocol
        try {
            browserInstance = await chromium.connectOverCDP(CDP_ENDPOINT);
            console.log('[Browser] Connected to existing Chrome instance via CDP');
            
            // Get the default context
            const contexts = browserInstance.contexts();
            if (contexts.length > 0) {
                context = contexts[0];
            } else {
                context = await browserInstance.newContext();
            }
        } catch (cdpError) {
            // CDP connection failed, launch new persistent instance
            console.log('[Browser] CDP connection failed, launching new Chrome instance...');
            
            context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
                headless: false,
                args: [
                    '--remote-debugging-port=9222',
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--start-maximized',
                    '--disable-background-networking',
                    '--disable-extensions',
                    '--disable-sync'
                ],
                viewport: null // Use full page size
            });
            
            console.log('[Browser] Launched new Chrome instance with persistent context');
        }

        // Set up cleanup handlers
        setupCleanupHandlers();

        return context;
    } catch (error) {
        console.error('[Browser] Failed to get browser:', error);
        throw error;
    } finally {
        isLaunching = false;
    }
}

/**
 * Get the current page or create a new one
 * 
 * @returns {Promise<import('playwright').Page>}
 */
export async function getPage() {
    const ctx = await getBrowser();
    
    // Get existing pages or create new one
    const pages = ctx.pages();
    if (pages.length > 0) {
        return pages[0];
    }
    
    return await ctx.newPage();
}

/**
 * Run a browser action with automatic page management
 * 
 * @param {Function} actionFn - Async function that receives page and returns result
 * @returns {Promise<any>} - Result of the action
 */
export async function runBrowserAction(actionFn) {
    const page = await getPage();
    
    try {
        const result = await actionFn(page);
        return result;
    } catch (error) {
        console.error('[Browser] Action failed:', error);
        throw error;
    }
    // Do NOT close browser - keep it warm for next request
}

/**
 * Check if browser is currently running
 * 
 * @returns {boolean}
 */
export function isBrowserRunning() {
    return context !== null;
}

/**
 * Close the browser instance
 * This should only be called when the gateway is shutting down
 */
export async function closeBrowser() {
    if (browserInstance) {
        try {
            await browserInstance.close();
            console.log('[Browser] Browser instance closed');
        } catch (error) {
            console.error('[Browser] Error closing browser:', error);
        }
        browserInstance = null;
        context = null;
    } else if (context) {
        try {
            await context.close();
            console.log('[Browser] Browser context closed');
        } catch (error) {
            console.error('[Browser] Error closing context:', error);
        }
        context = null;
    }
}

// Track if cleanup handlers are set up
let cleanupSetup = false;

/**
 * Set up process exit handlers to close browser gracefully
 */
function setupCleanupHandlers() {
    if (cleanupSetup) return;
    cleanupSetup = true;

    // Handle various shutdown scenarios
    process.on('exit', () => {
        // Browser will close automatically on process exit
        console.log('[Browser] Process exiting, browser will close');
    });

    process.on('SIGINT', async () => {
        console.log('[Browser] SIGINT received, closing browser...');
        await closeBrowser();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('[Browser] SIGTERM received, closing browser...');
        await closeBrowser();
        process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
        console.error('[Browser] Uncaught exception:', error);
        await closeBrowser();
        process.exit(1);
    });
}

export default {
    getBrowser,
    getPage,
    runBrowserAction,
    isBrowserRunning,
    closeBrowser
};
/**
 * Chrome Manager - Manages persistent Chrome browser instance
 * 
 * This module connects to an EXISTING Chrome instance running with remote debugging,
 * OR launches a new one if not found. This ensures the browser is always available.
 * 
 * The browser stays running independently of the skill child process,
 * maintaining login sessions and avoiding startup delays.
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
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

// CDP endpoint for connecting to existing Chrome
const CDP_ENDPOINT = 'http://localhost:9222';

// Singleton browser instance (connection, not launch)
let browserInstance = null;
let context = null;
let isConnecting = false;

/**
 * Find the browser executable on the system
 * @returns {string|null} Path to browser executable or null if not found
 */
function findBrowserExecutable() {
    const browsers = [
        { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
        { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
        { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    ];
    
    for (const browser of browsers) {
        if (fs.existsSync(browser.path)) {
            console.log(`[Browser] Found ${browser.name} at ${browser.path}`);
            return browser;
        }
    }
    
    return null;
}

/**
 * Launch a new browser instance with remote debugging
 * @returns {Promise<void>}
 */
async function launchBrowser() {
    const browser = findBrowserExecutable();
    
    if (!browser) {
        throw new Error(
            'No supported browser found. Please install Google Chrome, Microsoft Edge, or Chromium.'
        );
    }
    
    console.log(`[Browser] Launching ${browser.name} with remote debugging...`);
    
    // Launch browser as a detached process (won't be killed when parent exits)
    const browserProcess = spawn(browser.path, [
        `--remote-debugging-port=9222`,
        `--user-data-dir=${CHROME_PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-extensions',
        '--disable-sync',
        '--start-maximized',
    ], {
        detached: true,
        stdio: 'ignore',
    });
    
    // Don't wait for the child process
    browserProcess.unref();
    
    console.log(`[Browser] ${browser.name} launched with PID ${browserProcess.pid}`);
    
    // Wait for browser to start up
    console.log('[Browser] Waiting for browser to be ready...');
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max
    
    while (attempts < maxAttempts) {
        try {
            // Try to connect to see if browser is ready
            const testConnection = await chromium.connectOverCDP(CDP_ENDPOINT);
            await testConnection.close();
            console.log('[Browser] Browser is ready!');
            return;
        } catch (e) {
            // Browser not ready yet
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }
    }
    
    throw new Error('Browser failed to start within 30 seconds');
}

/**
 * Get or create the browser connection
 * Connects to existing Chrome via CDP, or launches new one if not found
 * 
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function getBrowser() {
    // Return existing context if available
    if (context) {
        return context;
    }

    // Wait for any ongoing connection attempt
    if (isConnecting) {
        while (isConnecting) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return context;
    }

    isConnecting = true;

    try {
        // Try connecting to existing Chrome with DevTools Protocol
        console.log('[Browser] Connecting to browser at', CDP_ENDPOINT);
        
        try {
            browserInstance = await chromium.connectOverCDP(CDP_ENDPOINT);
            console.log('[Browser] Connected to existing browser via CDP');
        } catch (connectError) {
            // Browser not running, launch it
            console.log('[Browser] No existing browser found, launching new instance...');
            await launchBrowser();
            
            // Now try connecting again
            browserInstance = await chromium.connectOverCDP(CDP_ENDPOINT);
            console.log('[Browser] Connected to newly launched browser');
        }
        
        // Get the default context
        const contexts = browserInstance.contexts();
        if (contexts.length > 0) {
            context = contexts[0];
            console.log('[Browser] Using existing browser context');
        } else {
            context = await browserInstance.newContext();
            console.log('[Browser] Created new browser context');
        }

        // Set up cleanup handlers
        setupCleanupHandlers();

        return context;
    } catch (error) {
        console.error('[Browser] Failed to get browser:', error.message);
        throw error;
    } finally {
        isConnecting = false;
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
        console.log('[Browser] Using existing page');
        return pages[0];
    }
    
    console.log('[Browser] Creating new page');
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
 * Check if browser is currently running (connected)
 * 
 * @returns {boolean}
 */
export function isBrowserRunning() {
    return context !== null && browserInstance !== null;
}

/**
 * Disconnect from the browser instance
 * Note: This does NOT close Chrome, just disconnects from it
 */
export async function closeBrowser() {
    if (browserInstance) {
        try {
            await browserInstance.close();
            console.log('[Browser] Disconnected from browser');
        } catch (error) {
            console.error('[Browser] Error disconnecting:', error);
        }
        browserInstance = null;
        context = null;
    }
}

// Track if cleanup handlers are set up
let cleanupSetup = false;

/**
 * Set up process exit handlers to disconnect gracefully
 */
function setupCleanupHandlers() {
    if (cleanupSetup) return;
    cleanupSetup = true;

    // Handle various shutdown scenarios
    process.on('exit', () => {
        // Just disconnect, don't close Chrome
        console.log('[Browser] Process exiting, disconnecting from browser');
    });

    process.on('SIGINT', async () => {
        console.log('[Browser] SIGINT received, disconnecting...');
        await closeBrowser();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('[Browser] SIGTERM received, disconnecting...');
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
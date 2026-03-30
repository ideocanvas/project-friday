/**
 * Browser Actions - Action handlers for browser operations
 * 
 * Each action receives a page object and parameters, executes the action,
 * and returns a result object with success status and data.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default timeout for page operations (30 seconds)
const DEFAULT_TIMEOUT = 30000;

// Default wait condition for navigation
const DEFAULT_WAIT_UNTIL = 'networkidle';

/**
 * Navigate to a URL
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} params.url - URL to navigate to
 * @param {string} [params.waitUntil] - Wait condition: 'load', 'domcontentloaded', 'networkidle'
 * @param {number} [params.timeout] - Timeout in milliseconds
 * @returns {Promise<Object>}
 */
export async function goto(page, params) {
    const { url, waitUntil = DEFAULT_WAIT_UNTIL, timeout = DEFAULT_TIMEOUT } = params;
    
    if (!url) {
        return { success: false, error: 'URL is required for goto action' };
    }
    
    try {
        console.log(`[Browser] Navigating to: ${url}`);
        
        const response = await page.goto(url, {
            waitUntil,
            timeout
        });
        
        const title = await page.title();
        const finalUrl = page.url();
        
        console.log(`[Browser] Navigated to: ${finalUrl} (Title: ${title})`);
        
        return {
            success: true,
            url: finalUrl,
            title,
            status: response?.status() || null
        };
    } catch (error) {
        console.error(`[Browser] Navigation failed:`, error.message);
        return {
            success: false,
            error: `Navigation failed: ${error.message}`
        };
    }
}

/**
 * Take a screenshot of the current page
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} [params.name] - Screenshot filename (without extension)
 * @param {string} [params.savePath] - Full path to save screenshot
 * @param {boolean} [params.fullPage] - Capture full page (default: true)
 * @returns {Promise<Object>}
 */
export async function screenshot(page, params) {
    const { name = 'screenshot', savePath, fullPage = true } = params;
    
    try {
        let screenshotPath;
        
        if (savePath) {
            // Use provided path
            screenshotPath = savePath;
        } else {
            // Generate default path in web_portal
            const webPortalDir = path.join(process.cwd(), 'web_portal');
            
            // Ensure directory exists
            if (!fs.existsSync(webPortalDir)) {
                fs.mkdirSync(webPortalDir, { recursive: true });
            }
            
            screenshotPath = path.join(webPortalDir, `${name}.png`);
        }
        
        // Ensure parent directory exists
        const parentDir = path.dirname(screenshotPath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        
        console.log(`[Browser] Taking screenshot: ${screenshotPath}`);
        
        await page.screenshot({
            path: screenshotPath,
            fullPage
        });
        
        console.log(`[Browser] Screenshot saved: ${screenshotPath}`);
        
        return {
            success: true,
            path: screenshotPath,
            filename: path.basename(screenshotPath)
        };
    } catch (error) {
        console.error(`[Browser] Screenshot failed:`, error.message);
        return {
            success: false,
            error: `Screenshot failed: ${error.message}`
        };
    }
}

/**
 * Scrape text content from the page
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} [params.selector] - CSS selector (optional, scrapes entire page if not provided)
 * @returns {Promise<Object>}
 */
export async function scrape_text(page, params) {
    const { selector } = params;
    
    try {
        let text;
        
        if (selector) {
            // Scrape specific elements
            console.log(`[Browser] Scraping text from selector: ${selector}`);
            
            const elements = await page.$$(selector);
            const texts = [];
            
            for (const element of elements) {
                const elText = await element.textContent();
                if (elText) {
                    texts.push(elText.trim());
                }
            }
            
            text = texts.join('\n');
        } else {
            // Scrape entire page
            console.log(`[Browser] Scraping text from entire page`);
            text = await page.textContent('body');
        }
        
        // Clean up text
        const cleanedText = text?.replace(/\s+/g, ' ').trim() || '';
        
        console.log(`[Browser] Scraped ${cleanedText.length} characters`);
        
        return {
            success: true,
            text: cleanedText,
            length: cleanedText.length
        };
    } catch (error) {
        console.error(`[Browser] Scrape text failed:`, error.message);
        return {
            success: false,
            error: `Scrape text failed: ${error.message}`
        };
    }
}

/**
 * Click an element on the page
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} params.selector - CSS selector for element to click
 * @param {number} [params.timeout] - Timeout to wait for element
 * @returns {Promise<Object>}
 */
export async function click(page, params) {
    const { selector, timeout = DEFAULT_TIMEOUT } = params;
    
    if (!selector) {
        return { success: false, error: 'Selector is required for click action' };
    }
    
    try {
        console.log(`[Browser] Clicking element: ${selector}`);
        
        // Wait for element to be visible
        await page.waitForSelector(selector, { state: 'visible', timeout });
        
        // Click the element
        await page.click(selector);
        
        console.log(`[Browser] Clicked: ${selector}`);
        
        return {
            success: true,
            selector
        };
    } catch (error) {
        console.error(`[Browser] Click failed:`, error.message);
        return {
            success: false,
            error: `Click failed: ${error.message}`
        };
    }
}

/**
 * Fill an input field with text
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} params.selector - CSS selector for input field
 * @param {string} params.text - Text to fill
 * @param {number} [params.timeout] - Timeout to wait for element
 * @returns {Promise<Object>}
 */
export async function fill(page, params) {
    const { selector, text, timeout = DEFAULT_TIMEOUT } = params;
    
    if (!selector) {
        return { success: false, error: 'Selector is required for fill action' };
    }
    
    if (text === undefined || text === null) {
        return { success: false, error: 'Text is required for fill action' };
    }
    
    try {
        console.log(`[Browser] Filling input: ${selector}`);
        
        // Wait for element to be visible
        await page.waitForSelector(selector, { state: 'visible', timeout });
        
        // Clear and fill
        await page.fill(selector, String(text));
        
        console.log(`[Browser] Filled: ${selector} with "${text}"`);
        
        return {
            success: true,
            selector,
            text: String(text)
        };
    } catch (error) {
        console.error(`[Browser] Fill failed:`, error.message);
        return {
            success: false,
            error: `Fill failed: ${error.message}`
        };
    }
}

/**
 * Evaluate JavaScript in the page context
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} params.script - JavaScript code to execute
 * @returns {Promise<Object>}
 */
export async function evaluate(page, params) {
    const { script } = params;
    
    if (!script) {
        return { success: false, error: 'Script is required for evaluate action' };
    }
    
    try {
        console.log(`[Browser] Evaluating script: ${script.substring(0, 100)}...`);
        
        // Wrap script in an async function for complex operations
        const result = await page.evaluate(`
            (function() {
                try {
                    return ${script};
                } catch (e) {
                    return { error: e.message };
                }
            })()
        `);
        
        console.log(`[Browser] Script evaluated successfully`);
        
        return {
            success: true,
            result
        };
    } catch (error) {
        console.error(`[Browser] Evaluate failed:`, error.message);
        return {
            success: false,
            error: `Evaluate failed: ${error.message}`
        };
    }
}

/**
 * Wait for a selector to appear on the page
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} params.selector - CSS selector to wait for
 * @param {number} [params.timeout] - Timeout in milliseconds
 * @param {string} [params.state] - State to wait for: 'attached', 'detached', 'visible', 'hidden'
 * @returns {Promise<Object>}
 */
export async function wait_for_selector(page, params) {
    const { selector, timeout = DEFAULT_TIMEOUT, state = 'visible' } = params;
    
    if (!selector) {
        return { success: false, error: 'Selector is required for wait_for_selector action' };
    }
    
    try {
        console.log(`[Browser] Waiting for selector: ${selector} (state: ${state})`);
        
        await page.waitForSelector(selector, { state, timeout });
        
        console.log(`[Browser] Selector found: ${selector}`);
        
        return {
            success: true,
            selector,
            state
        };
    } catch (error) {
        console.error(`[Browser] Wait for selector failed:`, error.message);
        return {
            success: false,
            error: `Wait for selector failed: ${error.message}`
        };
    }
}

/**
 * Scroll down the page
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {number} [params.pixels] - Number of pixels to scroll (default: 500)
 * @returns {Promise<Object>}
 */
export async function scroll_down(page, params) {
    const { pixels = 500 } = params;
    
    try {
        console.log(`[Browser] Scrolling down ${pixels} pixels`);
        
        await page.evaluate((scrollPixels) => {
            window.scrollBy(0, scrollPixels);
        }, pixels);
        
        // Wait a bit for any lazy-loaded content
        await page.waitForTimeout(500);
        
        console.log(`[Browser] Scrolled down ${pixels} pixels`);
        
        return {
            success: true,
            pixels
        };
    } catch (error) {
        console.error(`[Browser] Scroll failed:`, error.message);
        return {
            success: false,
            error: `Scroll failed: ${error.message}`
        };
    }
}

/**
 * Get current page URL
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @returns {Promise<Object>}
 */
export async function get_url(page, params) {
    try {
        const url = page.url();
        return {
            success: true,
            url
        };
    } catch (error) {
        return {
            success: false,
            error: `Get URL failed: ${error.message}`
        };
    }
}

/**
 * Get page title
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @returns {Promise<Object>}
 */
export async function get_title(page, params) {
    try {
        const title = await page.title();
        return {
            success: true,
            title
        };
    } catch (error) {
        return {
            success: false,
            error: `Get title failed: ${error.message}`
        };
    }
}

/**
 * Wait for navigation to complete
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {number} [params.timeout] - Timeout in milliseconds
 * @returns {Promise<Object>}
 */
export async function wait_for_navigation(page, params) {
    const { timeout = DEFAULT_TIMEOUT } = params;
    
    try {
        console.log(`[Browser] Waiting for navigation to complete`);
        
        await page.waitForLoadState('networkidle', { timeout });
        
        const url = page.url();
        const title = await page.title();
        
        console.log(`[Browser] Navigation complete: ${url}`);
        
        return {
            success: true,
            url,
            title
        };
    } catch (error) {
        console.error(`[Browser] Wait for navigation failed:`, error.message);
        return {
            success: false,
            error: `Wait for navigation failed: ${error.message}`
        };
    }
}

/**
 * Press a key on the page
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} params.key - Key to press (e.g., 'Enter', 'Escape', 'Tab')
 * @returns {Promise<Object>}
 */
export async function press(page, params) {
    const { key } = params;
    
    if (!key) {
        return { success: false, error: 'Key is required for press action' };
    }
    
    try {
        console.log(`[Browser] Pressing key: ${key}`);
        
        await page.keyboard.press(key);
        
        console.log(`[Browser] Pressed: ${key}`);
        
        return {
            success: true,
            key
        };
    } catch (error) {
        console.error(`[Browser] Press failed:`, error.message);
        return {
            success: false,
            error: `Press failed: ${error.message}`
        };
    }
}

/**
 * Get browser status
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @returns {Promise<Object>}
 */
export async function status(page, params) {
    try {
        const url = page.url();
        const title = await page.title();
        
        return {
            success: true,
            url,
            title,
            isRunning: true
        };
    } catch (error) {
        return {
            success: false,
            error: `Status check failed: ${error.message}`
        };
    }
}

// ============================================
// PAGE DISCOVERY ACTIONS - For LLM Usability
// ============================================

/**
 * Get HTML structure of the page or a specific element
 * Helps LLM understand page structure before using selectors
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} [params.selector] - CSS selector (optional, gets full page if not provided)
 * @param {number} [params.maxLength] - Max length of HTML to return (default: 10000)
 * @returns {Promise<Object>}
 */
export async function get_html(page, params) {
    const { selector, maxLength = 10000 } = params;
    
    try {
        let html;
        
        if (selector) {
            console.log(`[Browser] Getting HTML for selector: ${selector}`);
            const element = await page.$(selector);
            if (!element) {
                return {
                    success: false,
                    error: `Element not found: ${selector}`
                };
            }
            html = await element.innerHTML();
        } else {
            console.log(`[Browser] Getting full page HTML`);
            html = await page.content();
        }
        
        // Truncate if too long
        const truncated = html.length > maxLength;
        const resultHtml = truncated ? html.substring(0, maxLength) + '\n... (truncated)' : html;
        
        console.log(`[Browser] Got HTML (${html.length} chars${truncated ? ', truncated' : ''})`);
        
        return {
            success: true,
            html: resultHtml,
            length: html.length,
            truncated
        };
    } catch (error) {
        console.error(`[Browser] Get HTML failed:`, error.message);
        return {
            success: false,
            error: `Get HTML failed: ${error.message}`
        };
    }
}

/**
 * Get a simplified structure of the page
 * Returns element types, IDs, classes, and text content for key elements
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string[]} [params.types] - Element types to include (default: buttons, links, inputs, headings)
 * @returns {Promise<Object>}
 */
export async function get_structure(page, params) {
    const { types = ['button', 'a', 'input', 'select', 'textarea', 'h1', 'h2', 'h3', 'img'] } = params;
    
    try {
        console.log(`[Browser] Getting page structure for types: ${types.join(', ')}`);
        
        const structure = await page.evaluate((elementTypes) => {
            const result = {};
            
            for (const type of elementTypes) {
                const elements = document.querySelectorAll(type);
                result[type] = [];
                
                elements.forEach((el, index) => {
                    const info = {
                        index,
                        text: el.textContent?.trim().substring(0, 100) || '',
                        id: el.id || null,
                        className: el.className || null,
                        name: el.name || null,
                        type: el.type || null,
                        href: el.href || null,
                        src: el.src || null,
                        alt: el.alt || null,
                        placeholder: el.placeholder || null,
                        value: el.value || null
                    };
                    
                    // Build a suggested selector
                    let selector = type;
                    if (el.id) {
                        selector = `#${el.id}`;
                    } else if (el.className && typeof el.className === 'string') {
                        const firstClass = el.className.split(' ')[0];
                        if (firstClass) {
                            selector = `${type}.${firstClass}`;
                        }
                    }
                    info.suggestedSelector = selector;
                    
                    // Remove null values for cleaner output
                    Object.keys(info).forEach(key => {
                        if (info[key] === null || info[key] === '') {
                            delete info[key];
                        }
                    });
                    
                    result[type].push(info);
                });
            }
            
            return result;
        }, types);
        
        // Count elements
        const counts = {};
        for (const [type, elements] of Object.entries(structure)) {
            counts[type] = elements.length;
        }
        
        console.log(`[Browser] Got structure: ${JSON.stringify(counts)}`);
        
        return {
            success: true,
            structure,
            counts,
            url: page.url()
        };
    } catch (error) {
        console.error(`[Browser] Get structure failed:`, error.message);
        return {
            success: false,
            error: `Get structure failed: ${error.message}`
        };
    }
}

/**
 * Find elements by text content
 * Helps LLM locate elements without knowing exact selectors
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} params.text - Text to search for
 * @param {string} [params.type] - Element type to search (button, a, etc.)
 * @param {boolean} [params.exact] - Exact match (default: false)
 * @returns {Promise<Object>}
 */
export async function find_by_text(page, params) {
    const { text, type, exact = false } = params;
    
    if (!text) {
        return { success: false, error: 'Text is required for find_by_text action' };
    }
    
    try {
        console.log(`[Browser] Finding elements with text: "${text}" (type: ${type || 'any'})`);
        
        const elements = await page.evaluate(({ searchText, searchType, exactMatch }) => {
            const results = [];
            const selector = searchType || '*';
            const allElements = document.querySelectorAll(selector);
            
            allElements.forEach((el, index) => {
                const elText = el.textContent?.trim() || '';
                const elInnerText = el.innerText?.trim() || '';
                
                const matches = exactMatch 
                    ? elText === searchText || elInnerText === searchText
                    : elText.toLowerCase().includes(searchText.toLowerCase()) || 
                      elInnerText.toLowerCase().includes(searchText.toLowerCase());
                
                if (matches) {
                    // Build selector path
                    const path = [];
                    let current = el;
                    while (current && current !== document.body) {
                        let selector = current.tagName.toLowerCase();
                        if (current.id) {
                            selector = `#${current.id}`;
                            path.unshift(selector);
                            break;
                        }
                        if (current.className && typeof current.className === 'string') {
                            const firstClass = current.className.split(' ')[0];
                            if (firstClass) {
                                selector += `.${firstClass}`;
                            }
                        }
                        path.unshift(selector);
                        current = current.parentElement;
                    }
                    
                    results.push({
                        tagName: el.tagName.toLowerCase(),
                        text: elInnerText.substring(0, 200),
                        id: el.id || null,
                        className: el.className || null,
                        selector: path.join(' > '),
                        index
                    });
                }
            });
            
            return results;
        }, { searchText: text, searchType: type, exactMatch: exact });
        
        console.log(`[Browser] Found ${elements.length} matching elements`);
        
        return {
            success: true,
            text,
            type: type || 'any',
            exact,
            count: elements.length,
            elements
        };
    } catch (error) {
        console.error(`[Browser] Find by text failed:`, error.message);
        return {
            success: false,
            error: `Find by text failed: ${error.message}`
        };
    }
}

/**
 * Get all links on the page
 * Useful for discovering navigation options
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @returns {Promise<Object>}
 */
export async function get_links(page, params) {
    try {
        console.log(`[Browser] Getting all links on page`);
        
        const links = await page.evaluate(() => {
            const allLinks = document.querySelectorAll('a');
            return Array.from(allLinks).map((link, index) => ({
                index,
                text: link.textContent?.trim() || '',
                href: link.href,
                title: link.title || null,
                id: link.id || null,
                className: link.className || null
            })).filter(link => link.href && !link.href.startsWith('javascript:'));
        });
        
        console.log(`[Browser] Found ${links.length} links`);
        
        return {
            success: true,
            count: links.length,
            links,
            url: page.url()
        };
    } catch (error) {
        console.error(`[Browser] Get links failed:`, error.message);
        return {
            success: false,
            error: `Get links failed: ${error.message}`
        };
    }
}

/**
 * Get all forms and their inputs on the page
 * Useful for understanding how to fill forms
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @returns {Promise<Object>}
 */
export async function get_forms(page, params) {
    try {
        console.log(`[Browser] Getting all forms on page`);
        
        const forms = await page.evaluate(() => {
            const allForms = document.querySelectorAll('form');
            return Array.from(allForms).map((form, formIndex) => {
                const inputs = form.querySelectorAll('input, select, textarea, button');
                return {
                    index: formIndex,
                    id: form.id || null,
                    name: form.name || null,
                    action: form.action || null,
                    method: form.method || 'get',
                    inputs: Array.from(inputs).map((input, inputIndex) => ({
                        index: inputIndex,
                        type: input.type || input.tagName.toLowerCase(),
                        name: input.name || null,
                        id: input.id || null,
                        placeholder: input.placeholder || null,
                        label: input.labels?.[0]?.textContent?.trim() || null,
                        required: input.required || false,
                        value: input.value || null
                    }))
                };
            });
        });
        
        console.log(`[Browser] Found ${forms.length} forms`);
        
        return {
            success: true,
            count: forms.length,
            forms,
            url: page.url()
        };
    } catch (error) {
        console.error(`[Browser] Get forms failed:`, error.message);
        return {
            success: false,
            error: `Get forms failed: ${error.message}`
        };
    }
}

/**
 * Get all images on the page
 * Useful for finding image sources and alt text
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @returns {Promise<Object>}
 */
export async function get_images(page, params) {
    try {
        console.log(`[Browser] Getting all images on page`);
        
        const images = await page.evaluate(() => {
            const allImages = document.querySelectorAll('img');
            return Array.from(allImages).map((img, index) => ({
                index,
                src: img.src || null,
                alt: img.alt || null,
                title: img.title || null,
                id: img.id || null,
                className: img.className || null,
                width: img.naturalWidth || null,
                height: img.naturalHeight || null
            }));
        });
        
        console.log(`[Browser] Found ${images.length} images`);
        
        return {
            success: true,
            count: images.length,
            images,
            url: page.url()
        };
    } catch (error) {
        console.error(`[Browser] Get images failed:`, error.message);
        return {
            success: false,
            error: `Get images failed: ${error.message}`
        };
    }
}

/**
 * Extract structured data from tables
 * Useful for scraping tabular data
 * 
 * @param {import('playwright').Page} page 
 * @param {Object} params 
 * @param {string} [params.selector] - Table selector (default: first table)
 * @returns {Promise<Object>}
 */
export async function get_table(page, params) {
    const { selector = 'table' } = params;
    
    try {
        console.log(`[Browser] Getting table data from: ${selector}`);
        
        const tableData = await page.evaluate((tableSelector) => {
            const table = document.querySelector(tableSelector);
            if (!table) {
                return { error: 'Table not found' };
            }
            
            const headers = [];
            const rows = [];
            
            // Get headers
            const headerCells = table.querySelectorAll('thead th, th');
            headerCells.forEach(th => {
                headers.push(th.textContent?.trim() || '');
            });
            
            // Get rows
            const bodyRows = table.querySelectorAll('tbody tr, tr');
            bodyRows.forEach((row, rowIndex) => {
                // Skip header rows
                if (row.querySelector('th')) return;
                
                const cells = row.querySelectorAll('td');
                if (cells.length > 0) {
                    const rowData = {};
                    cells.forEach((cell, cellIndex) => {
                        const key = headers[cellIndex] || `column_${cellIndex}`;
                        rowData[key] = cell.textContent?.trim() || '';
                    });
                    rows.push(rowData);
                }
            });
            
            return {
                headers,
                rows,
                rowCount: rows.length,
                columnCount: headers.length || rows[0] ? Object.keys(rows[0]).length : 0
            };
        }, selector);
        
        if (tableData.error) {
            return {
                success: false,
                error: tableData.error
            };
        }
        
        console.log(`[Browser] Got table with ${tableData.rowCount} rows, ${tableData.columnCount} columns`);
        
        return {
            success: true,
            ...tableData,
            selector
        };
    } catch (error) {
        console.error(`[Browser] Get table failed:`, error.message);
        return {
            success: false,
            error: `Get table failed: ${error.message}`
        };
    }
}

// Export all actions
export const actions = {
    // Navigation
    goto,
    get_url,
    get_title,
    wait_for_navigation,
    
    // Interaction
    click,
    fill,
    press,
    scroll_down,
    wait_for_selector,
    
    // Data extraction
    screenshot,
    scrape_text,
    evaluate,
    
    // Page discovery (for LLM usability)
    get_html,
    get_structure,
    find_by_text,
    get_links,
    get_forms,
    get_images,
    get_table,
    
    // Utility
    status
};

export default actions;
#!/usr/bin/env node
/**
 * Generate Test Pages for Friday Web Portal
 * 
 * This script creates sample static pages to test the web server.
 * Run: npm run test:pages
 * 
 * Generated pages will be accessible at:
 * http://localhost:{WEB_SERVER_PORT}/portal/{user_id}/{page_hash}/
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import 'dotenv/config';

// Configuration from environment
const WEB_PORTAL_ROOT = process.env.WEB_PORTAL_ROOT || './web_portal';
const WEB_SERVER_PORT = process.env.WEB_SERVER_PORT || '3000';
const WEB_SERVER_HOST = process.env.WEB_SERVER_HOST || 'localhost';
const CLOUDFLARE_TUNNEL_URL = process.env.CLOUDFLARE_TUNNEL_URL || '';

// Test user ID
const TEST_USER_ID = 'test-user-001';

// Helper to generate a hash for page ID
function generateHash(data: object): string {
    const content = JSON.stringify(data);
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 12);
}

// Helper to ensure directory exists
function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Test page templates
const TEST_PAGES = {
    chart: {
        template: 'chart',
        title: 'Monthly Sales Chart',
        data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
            datasets: [
                {
                    label: 'Sales 2024',
                    data: [65, 59, 80, 81, 56, 55],
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 2
                },
                {
                    label: 'Sales 2023',
                    data: [45, 49, 60, 71, 46, 45],
                    backgroundColor: 'rgba(255, 99, 132, 0.2)',
                    borderColor: 'rgba(255, 99, 132, 1)',
                    borderWidth: 2
                }
            ]
        }
    },
    table: {
        template: 'table',
        title: 'Employee Directory',
        data: {
            headers: ['ID', 'Name', 'Department', 'Role', 'Status'],
            rows: [
                ['001', 'Alice Johnson', 'Engineering', 'Senior Developer', 'Active'],
                ['002', 'Bob Smith', 'Marketing', 'Manager', 'Active'],
                ['003', 'Carol White', 'Sales', 'Representative', 'On Leave'],
                ['004', 'David Brown', 'Engineering', 'Junior Developer', 'Active'],
                ['005', 'Eve Davis', 'HR', 'Coordinator', 'Active']
            ]
        }
    },
    list: {
        template: 'list',
        title: 'Project Tasks',
        data: {
            items: [
                { text: 'Complete API integration', status: 'done', priority: 'high' },
                { text: 'Write documentation', status: 'in-progress', priority: 'medium' },
                { text: 'Review pull requests', status: 'pending', priority: 'high' },
                { text: 'Update dependencies', status: 'pending', priority: 'low' },
                { text: 'Deploy to staging', status: 'pending', priority: 'medium' }
            ]
        }
    },
    dashboard: {
        template: 'dashboard',
        title: 'System Dashboard',
        data: {
            metrics: [
                { label: 'Total Users', value: '1,234', trend: '+12%' },
                { label: 'Active Sessions', value: '89', trend: '+5%' },
                { label: 'CPU Usage', value: '45%', trend: '-3%' },
                { label: 'Memory', value: '2.1GB', trend: '+8%' }
            ],
            charts: [
                {
                    title: 'Traffic Overview',
                    type: 'line',
                    data: {
                        labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
                        datasets: [{ label: 'Visitors', data: [1200, 1900, 1700, 2100, 2400] }]
                    }
                }
            ]
        }
    },
    document: {
        template: 'document',
        title: 'Project Overview',
        data: {
            content: `# Project Friday Overview

## Introduction

Project Friday is a privacy-first, local AI assistant with WhatsApp integration.

## Key Features

- **Local LLM Integration**: Uses LM Studio for local language model inference
- **WhatsApp Gateway**: Seamless messaging through WhatsApp
- **Skill System**: Extensible architecture for adding new capabilities
- **Static Page Generation**: Create web pages from structured data

## Architecture

The system consists of several components:

1. **Gateway**: WhatsApp message handling
2. **Scheduler**: Heartbeat and task scheduling
3. **Evolution**: Skill factory for dynamic skill creation
4. **Janitor**: Cleanup of expired resources
5. **Web Server**: Serves generated static pages

## Getting Started

\`\`\`bash
npm install
npm run build
npm start
\`\`\`

## License

MIT License
`,
            author: 'Friday Team',
            date: new Date().toISOString().split('T')[0]
        }
    }
};

interface PageInfo {
    template: string;
    title: string;
    data: object;
}

interface GeneratedPage {
    name: string;
    hash: string;
    url: string;
    filePath: string;
}

function generateTestPages(): GeneratedPage[] {
    const generatedPages: GeneratedPage[] = [];
    
    console.log('🧪 Generating test pages...\n');
    console.log(`Web Portal Root: ${WEB_PORTAL_ROOT}`);
    console.log(`Test User ID: ${TEST_USER_ID}\n`);
    
    for (const [name, pageInfo] of Object.entries(TEST_PAGES)) {
        const info = pageInfo as PageInfo;
        const hash = generateHash(info.data);
        const pageDir = path.join(WEB_PORTAL_ROOT, TEST_USER_ID, hash);
        
        // Create page directory
        ensureDir(pageDir);
        
        // Create index.html with the page data
        const pageData = {
            template: info.template,
            title: info.title,
            data: info.data,
            generated_at: new Date().toISOString(),
            user_id: TEST_USER_ID
        };
        
        // Write the JSON data file (would normally be processed by the skill)
        const jsonPath = path.join(pageDir, 'data.json');
        fs.writeFileSync(jsonPath, JSON.stringify(pageData, null, 2));
        
        // Write a simple HTML file for testing
        const htmlContent = generateSimpleHtml(info);
        const htmlPath = path.join(pageDir, 'index.html');
        fs.writeFileSync(htmlPath, htmlContent);
        
        // Build URL - use Cloudflare tunnel if configured
        let url: string;
        if (CLOUDFLARE_TUNNEL_URL) {
            url = `${CLOUDFLARE_TUNNEL_URL}/portal/${TEST_USER_ID}/${hash}/`;
        } else {
            const host = WEB_SERVER_HOST === '0.0.0.0' ? 'localhost' : WEB_SERVER_HOST;
            url = `http://${host}:${WEB_SERVER_PORT}/portal/${TEST_USER_ID}/${hash}/`;
        }
        
        generatedPages.push({
            name,
            hash,
            url,
            filePath: pageDir
        });
        
        console.log(`✅ Generated: ${name}`);
        console.log(`   Hash: ${hash}`);
        console.log(`   URL: ${url}\n`);
    }
    
    // Create a manifest file
    const manifestPath = path.join(WEB_PORTAL_ROOT, TEST_USER_ID, 'manifest.json');
    const manifest = {
        user_id: TEST_USER_ID,
        generated_at: new Date().toISOString(),
        pages: generatedPages.map(p => ({
            name: p.name,
            hash: p.hash,
            url: p.url
        }))
    };
    ensureDir(path.dirname(manifestPath));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    
    console.log('📋 Manifest created at:', manifestPath);
    console.log('\n--- Generated Pages Summary ---');
    console.log(`Total pages: ${generatedPages.length}`);
    console.log(`User ID: ${TEST_USER_ID}`);
    console.log('\nAccess URLs:');
    generatedPages.forEach(p => {
        console.log(`  ${p.name}: ${p.url}`);
    });
    
    return generatedPages;
}

function generateSimpleHtml(info: PageInfo): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${info.title}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; padding: 2rem; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #333; margin-bottom: 1rem; }
        .template-badge { display: inline-block; background: #007bff; color: white; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.875rem; margin-bottom: 1rem; }
        pre { background: #f8f9fa; padding: 1rem; border-radius: 4px; overflow-x: auto; }
        .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; color: #666; font-size: 0.875rem; }
    </style>
</head>
<body>
    <div class="container">
        <span class="template-badge">${info.template.toUpperCase()}</span>
        <h1>${info.title}</h1>
        <pre>${JSON.stringify(info.data, null, 2)}</pre>
        <div class="footer">
            <p>Generated by Friday Static Page Generator</p>
            <p>Timestamp: ${new Date().toISOString()}</p>
        </div>
    </div>
</body>
</html>`;
}

// Run the generator
generateTestPages();
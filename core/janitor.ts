/**
 * Friday Janitor - Web Portal Cleanup
 * 
 * Cleans up expired web portal pages (older than 24 hours).
 * Runs as 'friday-janitor' in PM2.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const WEB_PORTAL_ROOT = process.env.WEB_PORTAL_ROOT || './web_portal';
const PAGE_EXPIRY_HOURS = parseInt(process.env.PAGE_EXPIRY_HOURS || '24', 10);
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

// Type definitions
interface StatusData {
    'friday-janitor': {
        status: string;
        uptime: string;
        last_run: string;
        pages_deleted: number;
    };
    'friday-gateway'?: {
        status: string;
        uptime: string;
        last_error: string | null;
    };
    'friday-scheduler'?: {
        status: string;
        uptime: string;
        last_check: string;
    };
}

/**
 * Clean up expired web portal pages
 */
function cleanup(): void {
    console.log('🧹 Janitor running - checking for expired pages...');
    
    if (!fs.existsSync(WEB_PORTAL_ROOT)) {
        console.log('No web portal directory found');
        return;
    }
    
    const users = fs.readdirSync(WEB_PORTAL_ROOT).filter(f => !f.startsWith('.'));
    const now = Date.now();
    const expiryMs = PAGE_EXPIRY_HOURS * 60 * 60 * 1000;
    let deletedCount = 0;
    
    for (const user of users) {
        const userDir = path.join(WEB_PORTAL_ROOT, user);
        
        if (!fs.statSync(userDir).isDirectory()) continue;
        
        const sessions = fs.readdirSync(userDir).filter(f => !f.startsWith('.'));
        
        for (const session of sessions) {
            const sessionPath = path.join(userDir, session);
            
            if (!fs.statSync(sessionPath).isDirectory()) continue;
            
            try {
                const stats = fs.statSync(sessionPath);
                const age = now - stats.birthtimeMs;
                
                if (age > expiryMs) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    console.log(`Deleted expired session: ${user}/${session}`);
                    deletedCount++;
                }
            } catch (e) {
                const error = e as Error;
                console.error(`Error checking ${sessionPath}:`, error.message);
            }
        }
    }
    
    console.log(`🧹 Janitor complete - deleted ${deletedCount} expired pages`);
    updateStatus(deletedCount);
}

/**
 * Update process status
 */
function updateStatus(deletedCount: number = 0): void {
    const statusFile = path.join(process.env.QUEUE_PATH || './queue', 'status.json');
    
    if (!fs.existsSync(statusFile)) return;
    
    try {
        const statusData: StatusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        statusData['friday-janitor'] = {
            ...statusData['friday-janitor'],
            status: 'running',
            uptime: new Date().toISOString(),
            last_run: new Date().toISOString(),
            pages_deleted: deletedCount
        };
        fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
    } catch (e) {
        const error = e as Error;
        console.error('Error updating status:', error.message);
    }
}

// Start the janitor
console.log('🧹 Janitor started - checking every hour');
console.log(`Expiry time: ${PAGE_EXPIRY_HOURS} hours`);

// Run immediately on start
cleanup();

// Then run every hour
setInterval(cleanup, CHECK_INTERVAL);
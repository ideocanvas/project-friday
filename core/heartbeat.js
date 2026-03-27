/**
 * Friday Heartbeat / Scheduler
 * 
 * Deterministic background process that checks reminders and triggers skills.
 * Runs as 'friday-scheduler' in PM2.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
const QUEUE_PATH = process.env.QUEUE_PATH || './queue';
const SKILLS_PATH = process.env.SKILLS_PATH || './skills';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10);
const ARBITER_LOCK_PATH = process.env.ARBITER_LOCK_PATH || './temp/gpu_active.lock';

// Skills that require GPU lock
const GPU_SKILLS = ['voice', 'gold_tracker', 'stock_alert'];

/**
 * Main heartbeat loop
 */
function checkReminders() {
    console.log('❤️ Heartbeat check...');
    
    if (!fs.existsSync(USER_DATA_ROOT)) {
        console.log('No users directory found');
        return;
    }
    
    const users = fs.readdirSync(USER_DATA_ROOT).filter(f => !f.startsWith('.'));
    
    for (const user of users) {
        const reminderPath = path.join(USER_DATA_ROOT, user, 'reminders.json');
        
        if (!fs.existsSync(reminderPath)) continue;
        
        try {
            let reminders = JSON.parse(fs.readFileSync(reminderPath, 'utf8'));
            const now = new Date();
            const remaining = [];
            
            for (const rem of reminders) {
                const remTime = new Date(rem.time);
                
                if (now >= remTime) {
                    console.log(`⏰ Triggering: ${rem.skill} for ${user} at ${remTime}`);
                    executeSkill(rem.skill, user, rem.args || {});
                    
                    // Keep if recurring, remove if one-time
                    if (rem.repeat) {
                        remaining.push({
                            ...rem,
                            time: calculateNextTime(rem.time, rem.repeat)
                        });
                    }
                } else {
                    remaining.push(rem);
                }
            }
            
            // Update if any removed
            if (remaining.length !== reminders.length) {
                fs.writeFileSync(reminderPath, JSON.stringify(remaining, null, 2));
            }
        } catch (e) {
            console.error(`Error processing reminders for ${user}:`, e.message);
        }
    }
}

/**
 * Calculate next time for recurring reminder
 */
function calculateNextTime(currentTime, repeat) {
    const date = new Date(currentTime);
    
    switch (repeat) {
        case 'daily':
            date.setDate(date.getDate() + 1);
            break;
        case 'weekly':
            date.setDate(date.getDate() + 7);
            break;
        case 'monthly':
            date.setMonth(date.getMonth() + 1);
            break;
        default:
            // Custom interval (e.g., '30m', '1h')
            const match = repeat.match(/^(\d+)([mhd])$/);
            if (match) {
                const value = parseInt(match[1]);
                switch (match[2]) {
                    case 'm': date.setMinutes(date.getMinutes() + value); break;
                    case 'h': date.setHours(date.getHours() + value); break;
                    case 'd': date.setDate(date.getDate() + value); break;
                }
            }
    }
    
    return date.toISOString();
}

/**
 * Execute a skill (Node.js or Python)
 */
function executeSkill(skillName, userId, args) {
    // Determine skill type and path
    const isBuiltin = fs.existsSync(path.join(SKILLS_PATH, 'builtin', skillName));
    const skillPath = isBuiltin
        ? path.join(SKILLS_PATH, 'builtin', skillName, 'index.js')
        : path.join(SKILLS_PATH, 'generated', skillName, 'run.py');
    
    if (!fs.existsSync(skillPath)) {
        console.error(`Skill not found: ${skillName}`);
        return;
    }
    
    // Check GPU lock for GPU-intensive skills
    if (GPU_SKILLS.includes(skillName)) {
        acquireGpuLock();
    }
    
    // Prepare command
    const isPython = skillPath.endsWith('.py');
    const payload = JSON.stringify({ userId, ...args });
    
    console.log(`Executing skill: ${skillName} (${isPython ? 'Python' : 'Node.js'})`);
    
    if (isPython) {
        // Use Conda environment
        const proc = spawn('conda', ['run', '-n', 'friday-skills', 'python', skillPath, payload], {
            cwd: process.cwd(),
            shell: true
        });
        
        proc.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                try {
                    const result = JSON.parse(output);
                    if (result.message) {
                        queueMessage(userId, result.message);
                    }
                } catch {
                    queueMessage(userId, output);
                }
            }
        });
        
        proc.stderr.on('data', (data) => {
            console.error(`Skill error: ${data}`);
        });
        
        proc.on('close', () => {
            if (GPU_SKILLS.includes(skillName)) {
                releaseGpuLock();
            }
        });
        
    } else {
        // Node.js skill
        const proc = spawn('node', [skillPath], {
            cwd: process.cwd(),
            env: { ...process.env, PAYLOAD: payload }
        });
        
        proc.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                queueMessage(userId, output);
            }
        });
        
        proc.stderr.on('data', (data) => {
            console.error(`Skill error: ${data}`);
        });
        
        proc.on('close', () => {
            if (GPU_SKILLS.includes(skillName)) {
                releaseGpuLock();
            }
        });
    }
}

/**
 * Write result to message queue for Gateway to send
 */
function queueMessage(userId, content) {
    const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');
    
    let messages = [];
    if (fs.existsSync(queueFile)) {
        messages = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    }
    
    messages.push({
        id: generateUUID(),
        to: userId,
        message: content,
        type: 'text',
        timestamp: new Date().toISOString(),
        retry: 0,
        status: 'pending'
    });
    
    fs.writeFileSync(queueFile, JSON.stringify(messages, null, 2));
    console.log(`Queued message for ${userId}`);
}

/**
 * GPU Lock functions
 */
function acquireGpuLock() {
    const lockDir = path.dirname(ARBITER_LOCK_PATH);
    if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
    }
    fs.writeFileSync(ARBITER_LOCK_PATH, new Date().toISOString());
    console.log('🔒 GPU lock acquired');
}

function releaseGpuLock() {
    if (fs.existsSync(ARBITER_LOCK_PATH)) {
        fs.unlinkSync(ARBITER_LOCK_PATH);
        console.log('🔓 GPU lock released');
    }
}

/**
 * Generate UUID
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Update process status
 */
function updateStatus() {
    const statusFile = path.join(QUEUE_PATH, 'status.json');
    const statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    statusData['friday-scheduler'] = {
        ...statusData['friday-scheduler'],
        status: 'running',
        uptime: new Date().toISOString(),
        last_check: new Date().toISOString()
    };
    fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
}

// Start the heartbeat
console.log('❤️ Heartbeat started - checking every', CHECK_INTERVAL / 1000, 'seconds');
updateStatus();
setInterval(() => {
    checkReminders();
    updateStatus();
}, CHECK_INTERVAL);
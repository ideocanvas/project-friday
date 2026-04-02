/**
 * Friday Heartbeat / Scheduler
 * 
 * Deterministic background process that checks reminders and triggers skills.
 * Runs as 'friday-scheduler' in PM2.
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
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

const SKILL_LOGS_ROOT = path.join(process.cwd(), 'logs', 'skills');

function ensureSkillLogDir(skillName: string): string {
    const dir = path.join(SKILL_LOGS_ROOT, skillName);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function createWriteStreamSafe(filePath: string): fs.WriteStream | null {
    try {
        return fs.createWriteStream(filePath, { flags: 'a' });
    } catch {
        return null;
    }
}

function logHeader(outStream: fs.WriteStream | null, errStream: fs.WriteStream | null, command: string): void {
    const timestamp = new Date().toISOString();
    const separator = '─'.repeat(60);
    const header = `\n${separator}\n[${timestamp}] ${command}\n${separator}\n`;
    if (outStream) outStream.write(header);
    if (errStream) errStream.write(header);
}

function closeStream(stream: fs.WriteStream | null): void {
    if (stream) stream.end();
}

// Skills that require GPU lock
const GPU_SKILLS: string[] = ['voice', 'gold_tracker', 'stock_alert'];

// Type definitions
interface Reminder {
    time: string;
    skill: string;
    args?: Record<string, unknown>;
    repeat?: 'daily' | 'weekly' | 'monthly' | string;
}

interface SkillResult {
    message?: string;
    success?: boolean;
    error?: string;
}

interface QueuedMessage {
    id: string;
    to: string;
    message: string;
    type: 'text' | 'image' | 'audio';
    timestamp: string;
    retry: number;
    status: 'pending' | 'sent' | 'failed';
}

interface StatusData {
    'friday-scheduler': {
        status: string;
        uptime: string;
        last_check: string;
    };
    'friday-gateway'?: {
        status: string;
        uptime: string;
        last_error: string | null;
    };
    'friday-janitor'?: {
        status: string;
        uptime: string;
        last_run: string;
        pages_deleted: number;
    };
}

/**
 * Main heartbeat loop
 */
function checkReminders(): void {
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
            const remindersRaw: Reminder[] = JSON.parse(fs.readFileSync(reminderPath, 'utf8'));
            const now = new Date();
            const remaining: Reminder[] = [];
            
            for (const rem of remindersRaw) {
                const remTime = new Date(rem.time);
                
                if (now >= remTime) {
                    console.log(`⏰ Triggering reminder for ${user} at ${remTime.toISOString()}`);
                    
                    // Send reminder notification (no skill execution in phase 1)
                    const message = rem.args?.message || `Reminder: ${rem.skill}`;
                    queueMessage(user, String(message));
                    
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
            if (remaining.length !== remindersRaw.length) {
                fs.writeFileSync(reminderPath, JSON.stringify(remaining, null, 2));
            }
        } catch (e) {
            const error = e as Error;
            console.error(`Error processing reminders for ${user}:`, error.message);
        }
    }
}

/**
 * Calculate next time for recurring reminder
 */
function calculateNextTime(currentTime: string, repeat: string): string {
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
            if (match && match[1] && match[2]) {
                const value = parseInt(match[1], 10);
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
function executeSkill(skillName: string, userId: string, args: Record<string, unknown>): void {
    // Determine skill type and path
    const isBuiltin = fs.existsSync(path.join(SKILLS_PATH, 'builtin', skillName));
    const skillPath = isBuiltin
        ? path.join(SKILLS_PATH, 'builtin', skillName, 'index.js')
        : path.join(SKILLS_PATH, 'generated', `${skillName}.py`);
    
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

    const logDir = ensureSkillLogDir(skillName);
    const outStream = createWriteStreamSafe(path.join(logDir, 'out.log'));
    const errStream = createWriteStreamSafe(path.join(logDir, 'err.log'));
    logHeader(outStream, errStream, `Executing skill: ${skillName} (${isPython ? 'Python' : 'Node.js'})`);

    if (isPython) {
        // Use Conda environment
        const proc: ChildProcess = spawn('conda', ['run', '-n', 'friday-skills', 'python', skillPath, payload], {
            cwd: process.cwd(),
            shell: true
        });
        
        proc.stdout?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            if (outStream) outStream.write(chunk);
            const output = chunk.trim();
            if (output) {
                try {
                    const result: SkillResult = JSON.parse(output);
                    if (result.message) {
                        queueMessage(userId, result.message);
                    }
                } catch {
                    queueMessage(userId, output);
                }
            }
        });
        
        proc.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            console.error(`Skill error: ${data}`);
            if (errStream) errStream.write(chunk);
        });
        
        proc.on('close', (code) => {
            const timestamp = new Date().toISOString();
            const footer = `\n[${timestamp}] Exit code: ${code}\n${'─'.repeat(60)}\n`;
            if (outStream) outStream.write(footer);
            if (errStream) errStream.write(footer);
            closeStream(outStream);
            closeStream(errStream);
            if (GPU_SKILLS.includes(skillName)) {
                releaseGpuLock();
            }
        });
        
    } else {
        // Node.js skill
        const proc: ChildProcess = spawn('node', [skillPath], {
            cwd: process.cwd(),
            env: { ...process.env, PAYLOAD: payload }
        });
        
        proc.stdout?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            if (outStream) outStream.write(chunk);
            const output = chunk.trim();
            if (output) {
                queueMessage(userId, output);
            }
        });
        
        proc.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            console.error(`Skill error: ${data}`);
            if (errStream) errStream.write(chunk);
        });
        
        proc.on('close', (code) => {
            const timestamp = new Date().toISOString();
            const footer = `\n[${timestamp}] Exit code: ${code}\n${'─'.repeat(60)}\n`;
            if (outStream) outStream.write(footer);
            if (errStream) errStream.write(footer);
            closeStream(outStream);
            closeStream(errStream);
            if (GPU_SKILLS.includes(skillName)) {
                releaseGpuLock();
            }
        });
    }
}

/**
 * Write result to message queue for Gateway to send
 */
function queueMessage(userId: string, content: string): void {
    const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');
    
    let messages: QueuedMessage[] = [];
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
function acquireGpuLock(): void {
    const lockDir = path.dirname(ARBITER_LOCK_PATH);
    if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
    }
    fs.writeFileSync(ARBITER_LOCK_PATH, new Date().toISOString());
    console.log('🔒 GPU lock acquired');
}

function releaseGpuLock(): void {
    if (fs.existsSync(ARBITER_LOCK_PATH)) {
        fs.unlinkSync(ARBITER_LOCK_PATH);
        console.log('🔓 GPU lock released');
    }
}

/**
 * Generate UUID
 */
function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c: string): string {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Update process status
 */
function updateStatus(): void {
    const statusFile = path.join(QUEUE_PATH, 'status.json');
    const statusData: StatusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
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
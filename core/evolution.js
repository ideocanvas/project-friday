/**
 * Friday Evolution - Skill Factory
 * 
 * Background process for generating new skills via GLM-5 Cloud API.
 * Runs as 'friday-evolution' in PM2.
 * 
 * Uses 10-round iterative refinement (like Claude Code).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const QUEUE_PATH = process.env.QUEUE_PATH || './queue';
const SKILLS_PATH = process.env.SKILLS_PATH || './skills';
const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
const CLOUD_AI_KEY = process.env.CLOUD_AI_KEY;
const CLOUD_AI_URL = process.env.CLOUD_AI_URL || 'https://api.z.ai/v1';
const EVOLUTION_MODEL = process.env.EVOLUTION_MODEL || 'glm-5';
const MAX_ROUNDS = parseInt(process.env.EVOLUTION_MAX_ROUNDS || '10', 10);
const ROUND_TIMEOUT = parseInt(process.env.EVOLUTION_ROUND_TIMEOUT_SEC || '60', 10) * 1000;
const TOTAL_TIMEOUT = parseInt(process.env.EVOLUTION_TOTAL_TIMEOUT_MIN || '30', 10) * 60 * 1000;
const ARBITER_LOCK_PATH = process.env.ARBITER_LOCK_PATH || './temp/gpu_active.lock';

const POLL_INTERVAL = 5000; // 5 seconds

/**
 * Main evolution loop
 */
async function runEvolution() {
    console.log('🧬 Evolution process started');
    
    while (true) {
        const job = getNextJob();
        
        if (job) {
            console.log(`Processing job: ${job.id}`);
            await processJob(job);
        }
        
        await sleep(POLL_INTERVAL);
    }
}

/**
 * Get next pending job from queue
 */
function getNextJob() {
    const pendingDir = path.join(QUEUE_PATH, 'evolution', 'pending');
    
    if (!fs.existsSync(pendingDir)) {
        fs.mkdirSync(pendingDir, { recursive: true });
        return null;
    }
    
    const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
    
    if (files.length === 0) return null;
    
    const jobFile = path.join(pendingDir, files[0]);
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    
    // Move to processing
    const processingDir = path.join(QUEUE_PATH, 'evolution', 'processing');
    if (!fs.existsSync(processingDir)) {
        fs.mkdirSync(processingDir, { recursive: true });
    }
    
    fs.renameSync(jobFile, path.join(processingDir, files[0]));
    
    return job;
}

/**
 * Process an evolution job
 */
async function processJob(job) {
    const startTime = Date.now();
    const processingFile = path.join(QUEUE_PATH, 'evolution', 'processing', `${job.id}.json`);
    
    // Notify user
    queueMessage(job.user_id, `🧬 I'm creating a skill for you... (this may take a few minutes)`);
    
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        // Check total timeout
        if (Date.now() - startTime > TOTAL_TIMEOUT) {
            console.log(`Job ${job.id} exceeded total timeout`);
            await failJob(job, 'Total timeout exceeded');
            return;
        }
        
        console.log(`Job ${job.id} - Round ${round}/${MAX_ROUNDS}`);
        
        // Update job status
        job.current_round = round;
        job.status = 'processing';
        fs.writeFileSync(processingFile, JSON.stringify(job, null, 2));
        
        // Notify progress
        if (round > 1) {
            queueMessage(job.user_id, `🔧 Round ${round}/${MAX_ROUNDS}: Working on it...`);
        }
        
        try {
            // Generate code
            const code = await generateCode(job);
            
            // Save temp code
            const tempPath = path.join(SKILLS_PATH, 'generated', `temp_${job.id}.py`);
            fs.writeFileSync(tempPath, code);
            
            // Test code
            const testResult = await testCode(tempPath, job);
            
            if (testResult.success) {
                // Success!
                const skillName = job.request.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 30);
                const finalPath = path.join(SKILLS_PATH, 'generated', `${skillName}.py`);
                
                fs.renameSync(tempPath, finalPath);
                
                // Register skill
                registerSkill(skillName, job);
                
                // Complete job
                await completeJob(job, skillName);
                
                queueMessage(job.user_id, `✅ Your skill "${skillName}" is ready! Try: !${skillName}`);
                console.log(`Job ${job.id} completed successfully`);
                return;
            } else {
                // Failed - add to error history
                job.error_history.push({
                    round: round,
                    error: testResult.error,
                    timestamp: new Date().toISOString()
                });
                
                console.log(`Job ${job.id} round ${round} failed:`, testResult.error);
                
                // Notify if not last round
                if (round < MAX_ROUNDS) {
                    queueMessage(job.user_id, `🔧 Round ${round}/${MAX_ROUNDS}: Hit an issue, trying to fix...`);
                }
            }
        } catch (error) {
            console.error(`Job ${job.id} round ${round} error:`, error);
            job.error_history.push({
                round: round,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }
    
    // All rounds failed
    await failJob(job, `Failed after ${MAX_ROUNDS} rounds`);
    const lastErrors = job.error_history.slice(-3).map(e => e.error).join('\n');
    queueMessage(job.user_id, `❌ Couldn't create skill after ${MAX_ROUNDS} attempts.\n\nLast errors:\n${lastErrors}`);
}

/**
 * Generate code using GLM-5 Cloud API
 */
async function generateCode(job) {
    // Acquire GPU lock
    acquireGpuLock();
    
    try {
        const template = getSkillTemplate(job);
        const errorContext = job.error_history.length > 0
            ? `\n\nPrevious errors:\n${job.error_history.map(e => `Round ${e.round}: ${e.error}`).join('\n')}`
            : '';
        
        const prompt = `You are an expert Python programmer. Create a skill for Friday (a personal AI assistant).

User Request: "${job.request}"

${errorContext}

Follow this template exactly:
${template}

Requirements:
1. Only write the logic() function
2. Use call_local_ai() from ai_utils for LLM calls
3. Use wait_for_gpu() before any MLX operations
4. Return dict with "success", "message", optionally "static_page"
5. Keep it simple and functional`;

        // Ollama API format
        const response = await fetch(`${CLOUD_AI_URL}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: EVOLUTION_MODEL,
                messages: [
                    { role: 'system', content: 'You are an expert Python programmer.' },
                    { role: 'user', content: prompt }
                ],
                stream: false
            })
        });
        
        const data = await response.json();
        const code = data.message?.content || data.response || '';
        
        // Extract code from markdown if present
        const codeMatch = code.match(/```python\n([\s\S]*?)```/);
        return codeMatch ? codeMatch[1] : code;
        
    } finally {
        releaseGpuLock();
    }
}

/**
 * Test generated code
 */
async function testCode(codePath, job) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ success: false, error: 'Timeout' });
        }, ROUND_TIMEOUT);
        
        // TODO: Implement actual test execution
        // For now, just check syntax
        try {
            const code = fs.readFileSync(codePath, 'utf8');
            
            // Basic syntax check
            new Function(code);
            
            clearTimeout(timeout);
            resolve({ success: true });
        } catch (error) {
            clearTimeout(timeout);
            resolve({ success: false, error: error.message });
        }
    });
}

/**
 * Get skill template
 */
function getSkillTemplate(job) {
    return `#!/usr/bin/env python3
"""
Auto-generated skill: ${job.request}
Generated: ${new Date().toISOString()}
User: ${job.user_id}
"""

import sys
import os
import json
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ai_utils import call_local_ai, wait_for_gpu, get_user_profile

SKILL_NAME = "${job.request.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 30)}"
VERSION = "1.0.0"

def logic(params: dict, user_id: str) -> dict:
    """
    Main skill logic.
    
    Args:
        params: Dictionary of parameters from user
        user_id: User's phone number
    
    Returns:
        dict with keys: success, message, (optional) static_page
    """
    # TODO: Implement skill logic
    result = {
        "success": True,
        "message": "Skill executed successfully"
    }
    return result

def main():
    input_data = json.loads(sys.stdin.read())
    params = input_data.get("params", {})
    user_id = input_data.get("user_id", "")
    
    try:
        result = logic(params, user_id)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()`;
}

/**
 * Register skill in registry
 */
function registerSkill(skillName, job) {
    const registryPath = path.join(SKILLS_PATH, 'registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    
    registry.skills[skillName] = {
        name: skillName,
        description: job.request,
        file: `/skills/generated/${skillName}.py`,
        type: 'generated',
        generated_by: 'evolution',
        user_id: job.user_id,
        created_at: new Date().toISOString(),
        version: '1.0.0'
    };
    
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Complete job
 */
async function completeJob(job, skillName) {
    const processingFile = path.join(QUEUE_PATH, 'evolution', 'processing', `${job.id}.json`);
    const completedDir = path.join(QUEUE_PATH, 'evolution', 'completed');
    
    if (!fs.existsSync(completedDir)) {
        fs.mkdirSync(completedDir, { recursive: true });
    }
    
    job.status = 'completed';
    job.result = { skill_name: skillName };
    job.completed_at = new Date().toISOString();
    
    fs.writeFileSync(path.join(completedDir, `${job.id}.json`), JSON.stringify(job, null, 2));
    fs.unlinkSync(processingFile);
}

/**
 * Fail job
 */
async function failJob(job, error) {
    const processingFile = path.join(QUEUE_PATH, 'evolution', 'processing', `${job.id}.json`);
    const completedDir = path.join(QUEUE_PATH, 'evolution', 'completed');
    
    if (!fs.existsSync(completedDir)) {
        fs.mkdirSync(completedDir, { recursive: true });
    }
    
    job.status = 'failed';
    job.error = error;
    job.completed_at = new Date().toISOString();
    
    fs.writeFileSync(path.join(completedDir, `${job.id}.json`), JSON.stringify(job, null, 2));
    fs.unlinkSync(processingFile);
}

/**
 * Queue message for Gateway
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
}

function releaseGpuLock() {
    if (fs.existsSync(ARBITER_LOCK_PATH)) {
        fs.unlinkSync(ARBITER_LOCK_PATH);
    }
}

/**
 * Utility functions
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function updateStatus() {
    const statusFile = path.join(QUEUE_PATH, 'status.json');
    if (!fs.existsSync(statusFile)) return;
    
    const statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    statusData['friday-evolution'] = {
        ...statusData['friday-evolution'],
        status: 'running',
        uptime: new Date().toISOString()
    };
    fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
}

// Start evolution
console.log('🧬 Evolution process started');
console.log(`Max rounds: ${MAX_ROUNDS}`);
console.log(`Round timeout: ${ROUND_TIMEOUT / 1000}s`);
console.log(`Total timeout: ${TOTAL_TIMEOUT / 60000}m`);

updateStatus();
runEvolution().catch(console.error);
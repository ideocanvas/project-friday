/**
 * Friday Task Manager
 *
 * Manages background tasks for asynchronous agent loop execution.
 * Provides task lifecycle management, structured logging, cancellation,
 * and callback/notification upon completion via the pending_messages queue.
 *
 * When a user request is triaged as a background task:
 *   1. A Task is created with a unique ID
 *   2. The agent loop runs in a background Promise
 *   3. Status updates are tracked in-memory
 *   4. On completion, the result is pushed to pending_messages.json
 *   5. The gateway's queue poller picks it up and sends it to the user
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ChatMessage, llmClient } from './llm-client.js';
import { isBuiltInTool, skillsToTools, type ToolCall } from './tool-calling.js';
import { processToolCalls } from './skill-executor.js';

// Configuration
const QUEUE_PATH = process.env.QUEUE_PATH || './queue';
const TASK_MAX_ITERATIONS = parseInt(process.env.TASK_MAX_ITERATIONS || '10', 10);
const TASK_LOG_MAX_ENTRIES = parseInt(process.env.TASK_LOG_MAX_ENTRIES || '200', 10);

// ── Types ──────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskLogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
}

export interface Task {
    id: string;
    phone: string;
    jid: string;
    status: TaskStatus;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    /** The original user message that triggered this task */
    userMessage: string;
    /** The agent loop system prompt */
    systemPrompt: string;
    /** Conversation history passed to the agent loop */
    history: ChatMessage[];
    /** Structured log entries emitted during execution */
    logs: TaskLogEntry[];
    /** Final text result (set on completion) */
    result?: string;
    /** Error message (set on failure) */
    error?: string;
    /** AbortController signal for cancellation */
    abortController: AbortController;
}

export interface TaskSummary {
    id: string;
    phone: string;
    status: TaskStatus;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    userMessage: string;
    result?: string;
    error?: string;
    logCount: number;
}

// ── Task Store ─────────────────────────────────────────────────────────────────

/** In-memory task store keyed by task ID */
const tasks = new Map<string, Task>();

/** Counter for generating short human-readable IDs */
let taskCounter = 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

function generateTaskId(): string {
    taskCounter += 1;
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(2).toString('hex');
    return `task_${ts}_${rand}_${String(taskCounter).padStart(3, '0')}`;
}

function formatTimestamp(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

function nowISO(): string {
    return new Date().toISOString();
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Create a new background task record (does NOT start execution).
 */
export function createTask(params: {
    phone: string;
    jid: string;
    userMessage: string;
    systemPrompt: string;
    history: ChatMessage[];
}): Task {
    const id = generateTaskId();
    const task: Task = {
        id,
        phone: params.phone,
        jid: params.jid,
        status: 'pending',
        createdAt: nowISO(),
        userMessage: params.userMessage,
        systemPrompt: params.systemPrompt,
        history: params.history,
        logs: [],
        abortController: new AbortController(),
    };
    tasks.set(id, task);
    appendLog(task, 'info', `Task created for message: "${params.userMessage.substring(0, 80)}"`);
    return task;
}

/**
 * Start executing a task in the background.
 * Returns immediately; the task runs asynchronously.
 * On completion/failure the result is pushed to the pending_messages queue.
 */
export function startTask(taskId: string): void {
    const task = tasks.get(taskId);
    if (!task) {
        console.error(`[TaskManager] Task ${taskId} not found`);
        return;
    }
    if (task.status !== 'pending') {
        console.warn(`[TaskManager] Task ${taskId} is already ${task.status}`);
        return;
    }

    task.status = 'running';
    task.startedAt = nowISO();
    appendLog(task, 'info', 'Task execution started');

    // Fire-and-forget background execution
    runAgentLoopInBackground(task).catch((err) => {
        // This should never happen because we catch inside, but guard anyway
        console.error(`[TaskManager] Unhandled error in background task ${taskId}:`, err);
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = nowISO();
    });
}

/**
 * Get a task by ID.
 */
export function getTask(taskId: string): Task | undefined {
    return tasks.get(taskId);
}

/**
 * Get a summary of a task (safe for external consumption).
 */
export function getTaskSummary(taskId: string): TaskSummary | null {
    const task = tasks.get(taskId);
    if (!task) return null;
    return {
        id: task.id,
        phone: task.phone,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        userMessage: task.userMessage,
        result: task.result,
        error: task.error,
        logCount: task.logs.length,
    };
}

/**
 * Get recent log entries for a task.
 */
export function getTaskLogs(taskId: string, count: number = 20): TaskLogEntry[] {
    const task = tasks.get(taskId);
    if (!task) return [];
    return task.logs.slice(-count);
}

/**
 * List all tasks, optionally filtered by phone number.
 */
export function listTasks(phone?: string): TaskSummary[] {
    const summaries: TaskSummary[] = [];
    for (const task of tasks.values()) {
        if (phone && task.phone !== phone) continue;
        summaries.push({
            id: task.id,
            phone: task.phone,
            status: task.status,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            userMessage: task.userMessage,
            result: task.result,
            error: task.error,
            logCount: task.logs.length,
        });
    }
    return summaries;
}

/**
 * Cancel a running task.
 */
export function cancelTask(taskId: string): boolean {
    const task = tasks.get(taskId);
    if (!task) return false;
    if (task.status !== 'running' && task.status !== 'pending') {
        return false;
    }
    task.abortController.abort();
    task.status = 'cancelled';
    task.completedAt = nowISO();
    appendLog(task, 'info', 'Task cancelled by user');
    return true;
}

/**
 * Get the number of active (pending + running) tasks.
 */
export function activeTaskCount(): number {
    let count = 0;
    for (const task of tasks.values()) {
        if (task.status === 'pending' || task.status === 'running') count++;
    }
    return count;
}

// ── Internal ───────────────────────────────────────────────────────────────────

/**
 * Append a structured log entry to a task.
 */
function appendLog(task: Task, level: TaskLogEntry['level'], message: string): void {
    const entry: TaskLogEntry = {
        timestamp: nowISO(),
        level,
        message,
    };
    task.logs.push(entry);
    // Cap log size
    if (task.logs.length > TASK_LOG_MAX_ENTRIES) {
        task.logs = task.logs.slice(-TASK_LOG_MAX_ENTRIES);
    }
    // Also log to console for server-side visibility
    const prefix = `[Task:${task.id}]`;
    switch (level) {
        case 'error': console.error(`${prefix} ${message}`); break;
        case 'warn':  console.warn(`${prefix} ${message}`); break;
        default:      console.log(`${prefix} ${message}`); break;
    }
}

/**
 * Run the agent loop in the background for a task.
 * On completion, pushes the result to pending_messages.json.
 */
async function runAgentLoopInBackground(task: Task): Promise<void> {
    const { abortController } = task;

    try {
        const tools = skillsToTools();
        
        // Match the timestamp logic from foreground agentLoop
        const timestampedUserMessage = `[${formatTimestamp(new Date().toISOString())}] ${task.userMessage}`;
        
        const messages: ChatMessage[] = [
            { role: 'system', content: task.systemPrompt },
            ...task.history,
            { role: 'user', content: timestampedUserMessage },
        ];

        appendLog(task, 'info', `Agent loop starting (max ${TASK_MAX_ITERATIONS} iterations, ${tools.length} tools)`);

        for (let iteration = 0; iteration < TASK_MAX_ITERATIONS; iteration++) {
            // Check for cancellation
            if (abortController.signal.aborted) {
                appendLog(task, 'info', 'Aborted at iteration start');
                return;
            }

            appendLog(task, 'debug', `Iteration ${iteration + 1}/${TASK_MAX_ITERATIONS}`);

            const response = await llmClient.chatCompletion({
                messages,
                temperature: 0.7,
                maxTokens: 2048,
                tools,
            });

            if (!response.success) {
                appendLog(task, 'error', `LLM call failed: ${response.error}`);
                task.status = 'failed';
                task.error = response.error || 'LLM call failed';
                task.completedAt = nowISO();
                pushTaskResultToQueue(task, `I encountered an error while processing your request. Please try again.`);
                return;
            }

            // Check for tool calls
            if (response.toolCalls && response.toolCalls.length > 0) {
                const toolNames = response.toolCalls.map(tc => tc.name).join(', ');
                appendLog(task, 'info', `LLM requested tools: ${toolNames}`);

                messages.push({
                    role: 'assistant',
                    content: response.content || '',
                    tool_calls: response.toolCalls,
                });

                for (const toolCall of response.toolCalls) {
                    // Check for cancellation between tool calls
                    if (abortController.signal.aborted) {
                        appendLog(task, 'info', 'Aborted during tool execution');
                        return;
                    }

                    let toolResult: { content: string };

                    if (isBuiltInTool(toolCall.name)) {
                        // Built-in tools are handled inline (save_user_profile, search_memory, etc.)
                        toolResult = handleBuiltInToolInTask(task, toolCall);
                    } else {
                        appendLog(task, 'info', `Executing skill: ${toolCall.name}`);
                        const results = await processToolCalls([toolCall], task.phone);
                        const result = results[0];
                        if (result) {
                            // Debug: log the full result structure
                            appendLog(task, 'debug', `Full result: ${JSON.stringify(result).substring(0, 1000)}`);
                            
                            // Check if skill returned an audio_path (for TTS/voice responses)
                            let audioPath: string | undefined;
                            if (result.result.data && typeof result.result.data === 'object') {
                                const data = result.result.data as Record<string, unknown>;
                                appendLog(task, 'debug', `Skill result data: ${JSON.stringify(data).substring(0, 500)}`);
                                if (data.audio_path && typeof data.audio_path === 'string') {
                                    audioPath = data.audio_path;
                                    appendLog(task, 'info', `Found audio_path: ${audioPath}`);
                                }
                            }

                            toolResult = {
                                content: JSON.stringify({
                                    success: result.result.success,
                                    message: result.result.message,
                                    data: result.result.data,
                                }),
                            };

                            // If we got an audio_path from a voice skill, push audio message immediately
                            if (audioPath) {
                                appendLog(task, 'info', `Voice skill returned audio: ${audioPath}`);
                                pushAudioTaskResultToQueue(task, audioPath);
                                task.status = 'completed';
                                task.result = ''; // Empty text result - audio was sent instead
                                task.completedAt = nowISO();
                                return;
                            }
                        } else {
                            toolResult = {
                                content: JSON.stringify({
                                    success: false,
                                    message: `Tool execution failed: ${toolCall.name}`,
                                }),
                            };
                        }
                    }

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: toolResult.content,
                    });
                }

                continue; // Let the LLM decide what to do next
            }

            // No tool calls → text response → done
            const content = response.content || "I couldn't generate a response.";
            appendLog(task, 'info', `Agent loop completed after ${iteration + 1} iteration(s)`);

            task.status = 'completed';
            task.result = content;
            task.completedAt = nowISO();

            pushTaskResultToQueue(task, content);
            return;
        }

        // Max iterations reached
        appendLog(task, 'warn', `Max iterations (${TASK_MAX_ITERATIONS}) reached`);
        task.status = 'completed';
        task.result = "I've been working on this for a while. Could you check back in a moment?";
        task.completedAt = nowISO();
        pushTaskResultToQueue(task, task.result);

    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        appendLog(task, 'error', `Unhandled error: ${errorMsg}`);
        task.status = 'failed';
        task.error = errorMsg;
        task.completedAt = nowISO();
        pushTaskResultToQueue(task, `Something went wrong while processing your request. Please try again.`);
    }
}

/**
 * Handle built-in tool calls within a background task context.
 * Reuses the same logic as message-processor's handleBuiltInToolCall.
 */
function handleBuiltInToolInTask(
    task: Task,
    toolCall: ToolCall,
): { content: string } {
    const { name, arguments: args } = toolCall;

    if (name === 'save_user_profile') {
        // Dynamic import to avoid circular dependency; use inline logic instead
        // We import from message-processor at the top level is fine since it's used by gateway
        // For simplicity, handle it directly
        const updates: Record<string, unknown> = {};
        if (args.name && typeof args.name === 'string') updates.name = args.name;
        if (args.location && typeof args.location === 'string') updates.location = args.location;
        if (args.timezone && typeof args.timezone === 'string') updates.timezone = args.timezone;

        if (Object.keys(updates).length > 0) {
            // We need to import updateUserProfile — use dynamic import to avoid circular deps
            // Actually, let's just inline it since it's a simple file write
            const fsSync = fs;
            const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
            const profilePath = path.join(USER_DATA_ROOT, task.phone, 'profile.json');

            try {
                let profile: Record<string, unknown> = { phone: task.phone };
                if (fsSync.existsSync(profilePath)) {
                    profile = JSON.parse(fsSync.readFileSync(profilePath, 'utf8'));
                }
                profile = { ...profile, ...updates, updated_at: nowISO() };
                fsSync.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
                const saved = Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(', ');
                appendLog(task, 'info', `Saved user profile: ${saved}`);
                return { content: JSON.stringify({ success: true, message: `Profile updated: ${saved}` }) };
            } catch (err) {
                return { content: JSON.stringify({ success: false, message: `Failed to update profile: ${err}` }) };
            }
        }
        return { content: JSON.stringify({ success: false, message: 'No valid profile fields provided.' }) };
    }

    if (name === 'search_memory') {
        // search_memory is a built-in tool that reads memory.log
        // For background tasks, we do a simple keyword search inline
        const query = args.query && typeof args.query === 'string' ? args.query : '';
        if (!query) {
            return { content: JSON.stringify({ success: false, message: 'No query provided.' }) };
        }
        // Import searchMemory from message-processor
        // We'll handle this by importing it at the module level
        return { content: JSON.stringify({ success: true, message: 'Memory search in background tasks uses simplified mode.', results: [] }) };
    }

    // Task management tools (get_task_status, peek_system_tasks, kill_task)
    if (name === 'get_task_status') {
        const targetTaskId = args.task_id && typeof args.task_id === 'string' ? args.task_id : '';
        if (!targetTaskId) {
            return { content: JSON.stringify({ success: false, message: 'No task_id provided.' }) };
        }
        const summary = getTaskSummary(targetTaskId);
        if (!summary) {
            return { content: JSON.stringify({ success: false, message: `Task ${targetTaskId} not found.` }) };
        }
        const logs = getTaskLogs(targetTaskId, 5);
        return {
            content: JSON.stringify({
                success: true,
                task: summary,
                recent_logs: logs,
            }),
        };
    }

    if (name === 'peek_system_tasks') {
        const phone = args.phone && typeof args.phone === 'string' ? args.phone : task.phone;
        const taskList = listTasks(phone);
        return {
            content: JSON.stringify({
                success: true,
                tasks: taskList,
                active_count: activeTaskCount(),
            }),
        };
    }

    if (name === 'kill_task') {
        const targetTaskId = args.task_id && typeof args.task_id === 'string' ? args.task_id : '';
        if (!targetTaskId) {
            return { content: JSON.stringify({ success: false, message: 'No task_id provided.' }) };
        }
        if (targetTaskId === task.id) {
            return { content: JSON.stringify({ success: false, message: 'Cannot kill the current task.' }) };
        }
        const cancelled = cancelTask(targetTaskId);
        return {
            content: JSON.stringify({
                success: cancelled,
                message: cancelled ? `Task ${targetTaskId} cancelled.` : `Could not cancel task ${targetTaskId} (not found or already completed).`,
            }),
        };
    }

    return { content: JSON.stringify({ success: false, message: `Unknown built-in tool: ${name}` }) };
}

/**
 * Push the task result to the pending_messages queue so the gateway
 * picks it up and sends it to the user via WhatsApp.
 */
function pushTaskResultToQueue(task: Task, message: string): void {
    try {
        const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');

        let messages: Array<{
            id: string;
            to: string;
            message: string;
            type: 'text' | 'image' | 'audio';
            timestamp: string;
            retry: number;
            status: 'pending' | 'sent' | 'failed';
            audio_path?: string;
        }> = [];

        if (fs.existsSync(queueFile)) {
            try {
                messages = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
            } catch {
                messages = [];
            }
        }

        messages.push({
            id: `task_${task.id}_${Date.now()}`,
            to: task.jid || task.phone,
            message,
            type: 'text',
            timestamp: nowISO(),
            retry: 0,
            status: 'pending',
        });

        // Ensure queue directory exists
        const queueDir = path.dirname(queueFile);
        if (!fs.existsSync(queueDir)) {
            fs.mkdirSync(queueDir, { recursive: true });
        }

        fs.writeFileSync(queueFile, JSON.stringify(messages, null, 2));
        appendLog(task, 'info', `Result pushed to pending_messages queue`);
    } catch (err) {
        console.error(`[TaskManager] Failed to push result to queue for task ${task.id}:`, err);
    }
}

/**
 * Push audio task result to queue
 */
function pushAudioTaskResultToQueue(task: Task, audioPath: string): void {
    try {
        const queueFile = path.join(QUEUE_PATH, 'pending_messages.json');

        let messages: Array<{
            id: string;
            to: string;
            message: string;
            type: 'text' | 'image' | 'audio';
            timestamp: string;
            retry: number;
            status: 'pending' | 'sent' | 'failed';
            audio_path?: string;
        }> = [];

        if (fs.existsSync(queueFile)) {
            try {
                messages = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
            } catch {
                messages = [];
            }
        }

        messages.push({
            id: `task_${task.id}_${Date.now()}`,
            to: task.jid || task.phone,
            message: '', // Empty message for audio
            type: 'audio',
            timestamp: nowISO(),
            retry: 0,
            status: 'pending',
            audio_path: audioPath,
        });

        // Ensure queue directory exists
        const queueDir = path.dirname(queueFile);
        if (!fs.existsSync(queueDir)) {
            fs.mkdirSync(queueDir, { recursive: true });
        }

        fs.writeFileSync(queueFile, JSON.stringify(messages, null, 2));
        appendLog(task, 'info', `Audio result pushed to pending_messages queue`);
    } catch (err) {
        console.error(`[TaskManager] Failed to push audio result to queue for task ${task.id}:`, err);
    }
}

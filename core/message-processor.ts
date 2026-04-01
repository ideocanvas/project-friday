/**
 * Friday Message Processor
 *
 * Handles message processing for the gateway using an LLM Agent Loop.
 * The agent loop allows the LLM to chain multiple tool calls:
 *   LLM → tool call → execute → feed result → LLM → more tools or text response
 *
 * This replaces the previous hardcoded flows:
 *   - No more regex-based name/location extraction
 *   - No more single-shot tool calling
 *   - No more text-based skill extraction
 *   - The LLM drives the conversation via tool calls
 *
 * ## Async Background Tasks
 * Messages are first triaged to determine the processing strategy:
 *   a. rapid_response  → blocking agent loop (fast)
 *   b. background_task → async background task via task-manager
 *   c. skill_generation → triggers evolution / skill generation pipeline
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { LLMClient, llmClient, ChatMessage } from './llm-client.js';
import { isToolCallingEnabled, isBuiltInTool, skillsToTools, type ToolCall } from './tool-calling.js';
import { processToolCalls } from './skill-executor.js';
import { triageIntent, type TriageResult } from './intent-triage.js';
import { createTask, startTask, getTaskSummary, getTaskLogs, listTasks, cancelTask, activeTaskCount, type Task } from './task-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
const DEFAULT_AGENT = process.env.DEFAULT_AGENT || 'friday';
const MAX_CONTEXT_MESSAGES = parseInt(process.env.MAX_CONTEXT_MESSAGES || '20', 10);
const AGENT_MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS || '5', 10);
const CONTEXT_BLOCK_GAP_MINUTES = parseInt(process.env.CONTEXT_BLOCK_GAP_MINUTES || '30', 10);
const CONTEXT_SUMMARY_THRESHOLD_BLOCKS = parseInt(process.env.CONTEXT_SUMMARY_THRESHOLD_BLOCKS || '3', 10);
const TRIAGE_ENABLED = process.env.TRIAGE_ENABLED !== 'false'; // Enabled by default

// Type definitions
interface Agent {
    name: string;
    description: string;
    system_prompt: string;
    soul_file?: string;
    voice: string;
    personality: {
        tone: string;
        style: string;
        humor: string;
    };
}

interface AgentsConfig {
    agents: Record<string, Agent>;
    default_agent: string;
    version: string;
}

interface UserProfile {
    phone: string;
    name?: string;
    agent?: string;
    location?: string;
    timezone?: string;
    preferences?: Record<string, unknown>;
    first_interaction?: boolean;
    created_at: string;
    updated_at: string;
}

interface ProcessResult {
    response: string;
    success: boolean;
    error?: string;
    /** If true, the message was dispatched as a background task */
    backgrounded?: boolean;
    /** The background task ID (set when backgrounded=true) */
    taskId?: string;
}

/**
 * Memory entry stored in memory.log with timestamp
 */
interface MemoryEntry {
    timestamp: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
}

/**
 * Context block - messages grouped by time gaps
 */
interface ContextBlock {
    startTime: Date;
    endTime: Date;
    messages: ChatMessage[];
    summary?: string;  // Optional summary for old blocks
}

/**
 * Load agents configuration
 */
export function loadAgents(): AgentsConfig {
    const agentsPath = path.join(process.cwd(), 'agents.json');
    
    if (!fs.existsSync(agentsPath)) {
        console.warn('agents.json not found, using default agent');
        return {
            agents: {
                friday: {
                    name: 'Friday',
                    description: 'Default assistant',
                    system_prompt: 'You are Friday, a helpful AI assistant.',
                    voice: 'default',
                    personality: { tone: 'friendly', style: 'concise', humor: 'light' }
                }
            },
            default_agent: 'friday',
            version: '1.0.0'
        };
    }
    
    return JSON.parse(fs.readFileSync(agentsPath, 'utf8')) as AgentsConfig;
}

/**
 * Load soul.md content for an agent
 */
export function loadSoulContent(soulFile: string | undefined): string {
    if (!soulFile) {
        return '';
    }
    
    const soulPath = path.join(process.cwd(), soulFile);
    
    if (!fs.existsSync(soulPath)) {
        console.warn(`Soul file not found: ${soulFile}`);
        return '';
    }
    
    try {
        return fs.readFileSync(soulPath, 'utf8');
    } catch (error) {
        console.error(`Error loading soul file ${soulFile}:`, error);
        return '';
    }
}

/**
 * Get agent by name
 */
export function getAgent(agentName: string): Agent | null {
    const agents = loadAgents();
    return agents.agents[agentName] || null;
}

/**
 * Get default agent
 */
export function getDefaultAgent(): Agent {
    const agents = loadAgents();
    const defaultAgent = agents.agents[agents.default_agent] || agents.agents.friday;
    
    if (!defaultAgent) {
        return {
            name: 'Friday',
            description: 'Default assistant',
            system_prompt: 'You are Friday, a helpful AI assistant.',
            voice: 'default',
            personality: { tone: 'friendly', style: 'concise', humor: 'light' }
        };
    }
    
    return defaultAgent;
}

/**
 * Load user profile
 */
export function loadUserProfile(phone: string): UserProfile | null {
    const profilePath = path.join(USER_DATA_ROOT, phone, 'profile.json');
    
    if (!fs.existsSync(profilePath)) {
        return null;
    }
    
    try {
        return JSON.parse(fs.readFileSync(profilePath, 'utf8')) as UserProfile;
    } catch (error) {
        console.error(`Error loading profile for ${phone}:`, error);
        return null;
    }
}

/**
 * Create default user profile
 */
export function createUserProfile(phone: string): UserProfile {
    const userDir = path.join(USER_DATA_ROOT, phone);
    
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }
    
    const profile: UserProfile = {
        phone,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    
    const profilePath = path.join(userDir, 'profile.json');
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    
    return profile;
}

/**
 * Update user profile
 */
export function updateUserProfile(phone: string, updates: Partial<UserProfile>): UserProfile | null {
    let profile = loadUserProfile(phone);
    if (!profile) {
        profile = createUserProfile(phone);
    }
    
    const updatedProfile: UserProfile = {
        ...profile,
        ...updates,
        updated_at: new Date().toISOString()
    };
    
    const profilePath = path.join(USER_DATA_ROOT, phone, 'profile.json');
    fs.writeFileSync(profilePath, JSON.stringify(updatedProfile, null, 2));
    
    return updatedProfile;
}

/**
 * Format a timestamp for display in context
 */
export function formatTimestamp(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

/**
 * Load raw memory entries from file
 */
function loadMemoryEntries(phone: string): MemoryEntry[] {
    const memoryPath = path.join(USER_DATA_ROOT, phone, 'memory.log');
    
    if (!fs.existsSync(memoryPath)) {
        return [];
    }
    
    try {
        const lines = fs.readFileSync(memoryPath, 'utf8').trim().split('\n');
        const entries: MemoryEntry[] = [];
        
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line) as MemoryEntry;
                if (['user', 'assistant', 'system'].includes(entry.role)) {
                    entries.push({
                        timestamp: entry.timestamp || new Date().toISOString(),
                        role: entry.role as 'user' | 'assistant' | 'system',
                        content: entry.content
                    });
                }
            } catch {
                // Skip invalid entries
            }
        }
        
        return entries;
    } catch (error) {
        console.error(`Error loading memory for ${phone}:`, error);
        return [];
    }
}

/**
 * Group memory entries into time-based context blocks.
 * Messages within CONTEXT_BLOCK_GAP_MINUTES of each other are grouped together.
 */
function groupIntoBlocks(entries: MemoryEntry[]): ContextBlock[] {
    if (entries.length === 0) return [];
    
    const gapMs = CONTEXT_BLOCK_GAP_MINUTES * 60 * 1000;
    const blocks: ContextBlock[] = [];
    const firstEntry = entries[0];
    
    if (!firstEntry) return [];
    
    let currentBlock: ContextBlock = {
        startTime: new Date(firstEntry.timestamp),
        endTime: new Date(firstEntry.timestamp),
        messages: []
    };
    
    for (const entry of entries) {
        const entryTime = new Date(entry.timestamp);
        const timeDiff = entryTime.getTime() - currentBlock.endTime.getTime();
        
        if (timeDiff > gapMs && currentBlock.messages.length > 0) {
            // Start a new block
            blocks.push(currentBlock);
            currentBlock = {
                startTime: entryTime,
                endTime: entryTime,
                messages: []
            };
        }
        
        // Add message to current block with timestamp prefix
        const timestampPrefix = `[${formatTimestamp(entry.timestamp)}] `;
        currentBlock.messages.push({
            role: entry.role,
            content: timestampPrefix + entry.content
        });
        currentBlock.endTime = entryTime;
    }
    
    // Don't forget the last block
    if (currentBlock.messages.length > 0) {
        blocks.push(currentBlock);
    }
    
    return blocks;
}

/**
 * Load recent memory/context for a user with time-based context blocks.
 * Messages are prefixed with timestamps and grouped by time gaps.
 */
export function loadRecentMemory(phone: string, limit: number = MAX_CONTEXT_MESSAGES): ChatMessage[] {
    const entries = loadMemoryEntries(phone);
    
    if (entries.length === 0) return [];
    
    // Group into time-based blocks
    const blocks = groupIntoBlocks(entries);
    
    // Flatten blocks into messages, taking from the most recent blocks
    const allMessages: ChatMessage[] = [];
    
    // Process blocks from most recent to oldest
    for (let i = blocks.length - 1; i >= 0 && allMessages.length < limit; i--) {
        const block = blocks[i];
        if (!block) continue;
        
        // Add a time gap separator if this is an older block
        if (i < blocks.length - 1) {
            allMessages.unshift({
                role: 'system',
                content: `[Conversation paused. Resuming at a later time.]`
            });
        }
        
        // Add messages from this block (in reverse order, then reverse at the end)
        for (let j = block.messages.length - 1; j >= 0 && allMessages.length < limit; j--) {
            const msg = block.messages[j];
            if (msg) {
                allMessages.unshift(msg);
            }
        }
    }
    
    // Ensure proper alternation - remove consecutive messages with same role
    const alternated: ChatMessage[] = [];
    for (const msg of allMessages) {
        if (msg.role === 'system') {
            alternated.push(msg);
            continue;
        }
        
        const lastMsg = alternated[alternated.length - 1];
        if (!lastMsg || lastMsg.role !== msg.role) {
            alternated.push(msg);
        }
    }
    
    // Ensure the last message before the new user message is from assistant
    while (alternated.length > 0 && alternated[alternated.length - 1]?.role === 'user') {
        alternated.pop();
    }
    
    return alternated.slice(-limit);
}

/**
 * Search through memory for relevant context.
 * Returns messages that match the query keywords.
 */
export function searchMemory(phone: string, query: string, maxResults: number = 5): ChatMessage[] {
    const entries = loadMemoryEntries(phone);
    
    if (entries.length === 0) return [];
    
    // Extract keywords from query (simple approach: split on whitespace, remove common words)
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of',
        'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
        'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then',
        'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
        'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
        'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while',
        'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'it', 'its']);
    
    const keywords = query.toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));
    
    if (keywords.length === 0) return [];
    
    // Score each entry by keyword matches
    const scored = entries.map(entry => {
        const contentLower = entry.content.toLowerCase();
        let score = 0;
        for (const keyword of keywords) {
            if (contentLower.includes(keyword)) {
                score += 1;
            }
        }
        return { entry, score };
    });
    
    // Sort by score and take top results
    const results = scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(s => ({
            role: s.entry.role,
            content: `[${formatTimestamp(s.entry.timestamp)}] ${s.entry.content}`
        }));
    
    return results;
}

/**
 * Build system prompt with user context
 * No longer injects skills documentation — tools are passed separately via the tool calling API.
 */
export function buildSystemPrompt(agent: Agent, userProfile: UserProfile | null): string {
    let systemPrompt = agent.system_prompt;
    
    // Load soul content if available
    const soulContent = loadSoulContent(agent.soul_file);
    if (soulContent) {
        systemPrompt = soulContent;
    }
    
    // Add current date and time context
    const now = new Date();
    const currentDate = now.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    const currentTime = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        timeZone: userProfile?.timezone || 'Asia/Hong_Kong'
    });
    const userTimezone = userProfile?.timezone || 'Asia/Hong_Kong';
    systemPrompt += `\n\n## Current Date and Time\n\nToday's date is ${currentDate}.\nThe current time is ${currentTime} (${userTimezone}).\n\nWhen answering questions about "today", "now", or current events, use this date as reference.`;
    
    // Add user context if available
    if (userProfile?.name) {
        systemPrompt += `\n\nThe user's name is ${userProfile.name}.`;
    }
    
    // Add location if available
    if (userProfile?.location) {
        systemPrompt += `\nThe user is located in ${userProfile.location}.`;
    }
    
    // Add personality hints
    systemPrompt += `\n\nRespond in a ${agent.personality.tone} tone with a ${agent.personality.style} style.`;
    
    // Add tool usage guidance
    systemPrompt += `\n\n## Tool Usage\n\nYou have access to tools. Use them when needed to help the user. When you learn the user's name, location, or timezone, call save_user_profile to remember it. You can chain multiple tool calls if needed.`;
    
    // Add strict anti-hallucination guidance
    systemPrompt += `\n\n## CRITICAL RULES\n\n1. NEVER make up facts, data, or information. If you don't know something, use a tool to find out, or say you don't know.\n2. NEVER invent weather data, news, prices, or any real-time information. Always use search or browser tools to get real data.\n3. If the user asks about current/recent information (weather, news, events), you MUST use a tool (search or browser) to get real data before responding.\n4. Do NOT guess or estimate real-time data. Always verify with tools first.`;
    
    return systemPrompt;
}

/**
 * Handle built-in tool calls (not skill-based tools).
 * Returns a result message for the LLM.
 */
function handleBuiltInToolCall(
    toolCall: ToolCall,
    phone: string
): { content: string } {
    const { name, arguments: args } = toolCall;
    
    if (name === 'save_user_profile') {
        const updates: Partial<UserProfile> = {};
        
        if (args.name && typeof args.name === 'string') {
            updates.name = args.name;
        }
        if (args.location && typeof args.location === 'string') {
            updates.location = args.location;
        }
        if (args.timezone && typeof args.timezone === 'string') {
            updates.timezone = args.timezone;
        }
        
        if (Object.keys(updates).length > 0) {
            const updated = updateUserProfile(phone, updates);
            const saved = Object.keys(updates)
                .map(k => `${k}: ${(updates as Record<string, unknown>)[k]}`)
                .join(', ');
            console.log(`[AgentLoop] Saved user profile: ${saved}`);
            return {
                content: JSON.stringify({
                    success: true,
                    message: `User profile updated: ${saved}`,
                }),
            };
        }
        
        return {
            content: JSON.stringify({
                success: false,
                message: 'No valid profile fields provided.',
            }),
        };
    }
    
    if (name === 'search_memory') {
        const query = args.query && typeof args.query === 'string' ? args.query : '';
        const maxResults = typeof args.max_results === 'number' ? args.max_results : 
                          (typeof args.max_results === 'string' ? parseInt(args.max_results, 10) : 5);
        
        if (!query) {
            return {
                content: JSON.stringify({
                    success: false,
                    message: 'No query provided for memory search.',
                }),
            };
        }
        
        console.log(`[AgentLoop] Searching memory for: "${query}"`);
        const results = searchMemory(phone, query, maxResults);
        
        if (results.length === 0) {
            return {
                content: JSON.stringify({
                    success: true,
                    message: 'No relevant memories found.',
                    results: [],
                }),
            };
        }
        
        return {
            content: JSON.stringify({
                success: true,
                message: `Found ${results.length} relevant memory entries.`,
                results: results.map(r => ({
                    role: r.role,
                    content: r.content,
                })),
            }),
        };
    }
    
    // ── Task Management Tools ─────────────────────────────────────────────
    
    if (name === 'get_task_status') {
        const taskId = args.task_id && typeof args.task_id === 'string' ? args.task_id : '';
        if (!taskId) {
            return {
                content: JSON.stringify({
                    success: false,
                    message: 'No task_id provided.',
                }),
            };
        }
        
        const summary = getTaskSummary(taskId);
        if (!summary) {
            return {
                content: JSON.stringify({
                    success: false,
                    message: `Task ${taskId} not found.`,
                }),
            };
        }
        
        const logs = getTaskLogs(taskId, 5);
        return {
            content: JSON.stringify({
                success: true,
                task: summary,
                recent_logs: logs,
            }),
        };
    }
    
    if (name === 'peek_system_tasks') {
        const filterPhone = args.phone && typeof args.phone === 'string' ? args.phone : phone;
        const taskList = listTasks(filterPhone);
        return {
            content: JSON.stringify({
                success: true,
                tasks: taskList,
                active_count: activeTaskCount(),
            }),
        };
    }
    
    if (name === 'kill_task') {
        const taskId = args.task_id && typeof args.task_id === 'string' ? args.task_id : '';
        if (!taskId) {
            return {
                content: JSON.stringify({
                    success: false,
                    message: 'No task_id provided.',
                }),
            };
        }
        
        const cancelled = cancelTask(taskId);
        return {
            content: JSON.stringify({
                success: cancelled,
                message: cancelled
                    ? `Task ${taskId} has been cancelled.`
                    : `Could not cancel task ${taskId} (not found or already completed).`,
            }),
        };
    }
    
    return {
        content: JSON.stringify({
            success: false,
            message: `Unknown built-in tool: ${name}`,
        }),
    };
}

/**
 * Agent Loop — the core LLM interaction cycle.
 * 
 * Replaces the previous rigid flow with a proper agent loop:
 *   1. Send messages + tools to LLM
 *   2. If LLM returns tool calls → execute → append results → loop
 *   3. If LLM returns text → done
 * 
 * The LLM decides how many tool calls to make and in what order.
 * It can chain: search → browse → extract → summarize, etc.
 */
async function agentLoop(
    systemPrompt: string,
    history: ChatMessage[],
    userMessage: string,
    phone: string,
    options?: {
        temperature?: number;
        maxTokens?: number;
    }
): Promise<ProcessResult> {
    const tools = skillsToTools();
    const temperature = options?.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? 2048;
    
    // Ensure the current user message has the same timestamp formatting as history
    const userMessageWithTime = `[${formatTimestamp(new Date().toISOString())}] ${userMessage}`;
    
    // Build initial message array
    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMessageWithTime },
    ];
    
    console.log(`[AgentLoop] Starting agent loop (max ${AGENT_MAX_ITERATIONS} iterations)`);
    console.log(`[AgentLoop] Tools available: ${tools.map(t => 'function' in t ? t.function.name : 'unknown').join(', ')}`);
    
    for (let iteration = 0; iteration < AGENT_MAX_ITERATIONS; iteration++) {
        console.log(`[AgentLoop] Iteration ${iteration + 1}/${AGENT_MAX_ITERATIONS}`);
        
        // Call LLM with current messages and tools
        const response = await llmClient.chatCompletion({
            messages,
            temperature,
            maxTokens,
            tools,
        });
        
        if (!response.success) {
            console.error(`[AgentLoop] LLM call failed: ${response.error}`);
            return {
                response: "I'm sorry, I encountered an error processing your request. Please try again.",
                success: false,
                error: response.error,
            };
        }
        
        // Check if LLM returned tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
            console.log(`[AgentLoop] LLM requested ${response.toolCalls.length} tool call(s): ${response.toolCalls.map(tc => tc.name).join(', ')}`);
            
            // Append assistant message with tool_calls to conversation
            messages.push({
                role: 'assistant',
                content: response.content || '',
                tool_calls: response.toolCalls,
            });
            
            // Execute each tool call
            for (const toolCall of response.toolCalls) {
                let toolResult: { content: string };
                
                if (isBuiltInTool(toolCall.name)) {
                    // Handle built-in tools (save_user_profile, etc.)
                    toolResult = handleBuiltInToolCall(toolCall, phone);
                } else {
                    // Handle skill-based tools
                    const results = await processToolCalls([toolCall], phone);
                    const result = results[0];
                    if (result) {
                        toolResult = {
                            content: JSON.stringify({
                                success: result.result.success,
                                message: result.result.message,
                                data: result.result.data,
                            }),
                        };
                    } else {
                        toolResult = {
                            content: JSON.stringify({
                                success: false,
                                message: `Tool execution failed: ${toolCall.name}`,
                            }),
                        };
                    }
                }
                
                // Append tool result to conversation
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: toolResult.content,
                });
            }
            
            // Continue the loop — let the LLM decide what to do next
            continue;
        }
        
        // No tool calls — LLM returned a text response, we're done
        console.log(`[AgentLoop] LLM returned text response (iteration ${iteration + 1})`);
        const content = response.content || "I'm sorry, I couldn't generate a response. Please try again.";
        
        return {
            response: content,
            success: true,
        };
    }
    
    // Max iterations reached
    console.warn(`[AgentLoop] Max iterations (${AGENT_MAX_ITERATIONS}) reached`);
    return {
        response: "I've been thinking about this for a while. Could you try rephrasing your question?",
        success: true,
    };
}

/**
 * Process a message using the agent loop.
 * This is the main entry point for message processing.
 *
 * If TRIAGE_ENABLED, the message is first triaged to determine whether
 * it should be processed synchronously (rapid_response) or dispatched
 * as a background task (background_task / skill_generation).
 */
export async function processMessage(
    phone: string,
    message: string,
    options?: {
        agent?: string;
        temperature?: number;
        maxTokens?: number;
        /** Override triage: force blocking agent loop */
        forceBlocking?: boolean;
        /** Pass the actual remote Jid for queue compatibility */
        jid?: string;
    }
): Promise<ProcessResult> {
    try {
        // Load or create user profile
        let userProfile = loadUserProfile(phone);
        if (!userProfile) {
            userProfile = createUserProfile(phone);
        }
        
        // Get agent
        const agentName = options?.agent || userProfile.agent || DEFAULT_AGENT;
        const agent = getAgent(agentName) || getDefaultAgent();
        
        // Build system prompt (no skills injection — tools are passed separately)
        const systemPrompt = buildSystemPrompt(agent, userProfile);
        
        // Load recent context
        const history = loadRecentMemory(phone);
        
        // ── Intent Triage ──────────────────────────────────────────────────
        if (TRIAGE_ENABLED && !options?.forceBlocking) {
            const triageResult = await triageIntent(message, history);
            console.log(`[MessageProcessor] Triage: category=${triageResult.category}, confidence=${triageResult.confidence}, reason="${triageResult.reason}"`);
            
            if (triageResult.category === 'background_task') {
                return await dispatchBackgroundTask(phone, message, systemPrompt, history, options?.jid);
            }
            
            if (triageResult.category === 'skill_generation') {
                // For now, still dispatch as a background task with a note
                // TODO: Integrate with evolution.ts for actual skill generation
                console.log('[MessageProcessor] Skill generation requested, dispatching as background task with evolution trigger');
                return await dispatchBackgroundTask(phone, message, systemPrompt, history, options?.jid);
            }
            
            // rapid_response → fall through to blocking agent loop
        }
        
        // ── Blocking Agent Loop ────────────────────────────────────────────
        return await agentLoop(systemPrompt, history, message, phone, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
        });
    } catch (error) {
        console.error('Error processing message:', error);
        return {
            response: "I'm sorry, something went wrong. Please try again later.",
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Dispatch a message as a background task.
 * Creates the task, starts it, and returns an immediate acknowledgment.
 */
async function dispatchBackgroundTask(
    phone: string,
    message: string,
    systemPrompt: string,
    history: ChatMessage[],
    providedJid?: string,
): Promise<ProcessResult> {
    const jid = providedJid || phone; // Will be properly set by gateway if needed
    const task = createTask({
        phone,
        jid,
        userMessage: message,
        systemPrompt,
        history,
    });
    
    // Start execution in the background
    startTask(task.id);
    
    console.log(`[MessageProcessor] Dispatched background task ${task.id} for phone ${phone}`);
    
    return {
        response: `I'm working on that for you now. I'll let you know as soon as I have an answer. (Task ID: ${task.id})`,
        success: true,
        backgrounded: true,
        taskId: task.id,
    };
}

/**
 * Process a message with custom system prompt (for skills)
 */
export async function processWithCustomPrompt(
    systemPrompt: string,
    history: ChatMessage[],
    message: string,
    options?: {
        temperature?: number;
        maxTokens?: number;
    }
): Promise<ProcessResult> {
    try {
        const response = await llmClient.chatWithContext(
            systemPrompt,
            history,
            message,
            {
                temperature: options?.temperature ?? 0.7,
                maxTokens: options?.maxTokens ?? 2048,
            }
        );
        
        if (!response.success) {
            return {
                response: '',
                success: false,
                error: response.error,
            };
        }
        
        return {
            response: response.content,
            success: true,
        };
    } catch (error) {
        return {
            response: '',
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// Export convenience functions
export { llmClient, LLMClient };
export type { ChatMessage };

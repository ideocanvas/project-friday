/**
 * Friday Message Processor
 * 
 * Handles message processing for the gateway:
 * - Loads user profile and memory
 * - Loads agent personality
 * - Calls LLM for response
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { LLMClient, llmClient, ChatMessage } from './llm-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
const DEFAULT_AGENT = process.env.DEFAULT_AGENT || 'friday';
const MAX_CONTEXT_MESSAGES = parseInt(process.env.MAX_CONTEXT_MESSAGES || '20', 10);

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
    first_interaction?: boolean;  // Track if name has been asked
    created_at: string;
    updated_at: string;
}

interface ProcessResult {
    response: string;
    success: boolean;
    error?: string;
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
        // Return a fallback agent if none configured
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
        first_interaction: true,  // Mark as first interaction
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
    const profile = loadUserProfile(phone);
    if (!profile) {
        return null;
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
 * Check if the LLM response is asking for the user's name
 * This helps detect when the first interaction greeting has been made
 */
export function isAskingForName(response: string): boolean {
    const patterns = [
        /what should i call you/i,
        /what's your name/i,
        /what is your name/i,
        /how should i (address|call) you/i,
        /may i (have|know) your name/i,
        /your name is\?/i
    ];
    
    return patterns.some(pattern => pattern.test(response));
}

/**
 * Extract name from user's response
 * Simple heuristic: if user says "I'm X", "My name is X", "Call me X", or just "X"
 */
export function extractNameFromResponse(message: string): string | null {
    const patterns = [
        /^(?:i'm|im|i am)\s+([a-zA-Z]+)/i,
        /^my name is\s+([a-zA-Z]+)/i,
        /^call me\s+([a-zA-Z]+)/i,
        /^it's\s+([a-zA-Z]+)/i,
        /^its\s+([a-zA-Z]+)/i,
        /^this is\s+([a-zA-Z]+)/i,
        // Single word response (likely just the name)
        /^([a-zA-Z]+)$/i
    ];
    
    for (const pattern of patterns) {
        const match = message.trim().match(pattern);
        if (match && match[1]) {
            const name = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
            // Filter out common non-name words
            const nonNames = ['yes', 'no', 'ok', 'okay', 'sure', 'hi', 'hello', 'hey', 'thanks', 'thank'];
            if (!nonNames.includes(name.toLowerCase())) {
                return name;
            }
        }
    }
    
    return null;
}

/**
 * Load recent memory/context for a user
 * Ensures proper alternation between user and assistant messages
 */
export function loadRecentMemory(phone: string, limit: number = MAX_CONTEXT_MESSAGES): ChatMessage[] {
    const memoryPath = path.join(USER_DATA_ROOT, phone, 'memory.log');
    
    if (!fs.existsSync(memoryPath)) {
        return [];
    }
    
    try {
        const lines = fs.readFileSync(memoryPath, 'utf8').trim().split('\n');
        const recentLines = lines.slice(-limit * 2); // Get more to account for filtering
        
        const messages = recentLines
            .map((line: string) => {
                try {
                    const entry = JSON.parse(line) as { role: string; content: string };
                    return {
                        role: entry.role as 'user' | 'assistant' | 'system',
                        content: entry.content
                    };
                } catch {
                    return null;
                }
            })
            .filter((msg): msg is ChatMessage => msg !== null);
        
        // Ensure proper alternation - remove consecutive messages with same role
        const alternated: ChatMessage[] = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                alternated.push(msg);
                continue;
            }
            
            const lastMsg = alternated[alternated.length - 1];
            if (!lastMsg || lastMsg.role !== msg.role) {
                alternated.push(msg);
            }
            // Skip if same role as previous (duplicate)
        }
        
        // Ensure the last message before the new user message is from assistant
        // (or start with user message if empty)
        while (alternated.length > 0 && alternated[alternated.length - 1]?.role === 'user') {
            alternated.pop();
        }
        
        return alternated.slice(-limit);
    } catch (error) {
        console.error(`Error loading memory for ${phone}:`, error);
        return [];
    }
}

/**
 * Build system prompt with user context
 */
export function buildSystemPrompt(agent: Agent, userProfile: UserProfile | null): string {
    let systemPrompt = agent.system_prompt;
    
    // Load soul content if available
    const soulContent = loadSoulContent(agent.soul_file);
    if (soulContent) {
        // Insert soul content after the main system prompt
        systemPrompt = soulContent;
    }
    
    // Check if this is a first interaction (user has no name)
    const isFirstInteraction = userProfile && !userProfile.name && userProfile.first_interaction !== false;
    
    // Add first interaction instruction if needed
    if (isFirstInteraction) {
        systemPrompt += `\n\n## IMPORTANT: First Interaction\n\nThis is your first conversation with this user. You do not know their name yet.\n\nYou MUST:\n1. Greet them warmly: "Hi! I'm ${agent.name}, your personal assistant."\n2. Immediately ask for their name: "What should I call you?"\n3. Wait for their response before proceeding with other tasks\n\nDo NOT ask for other information (location, preferences) yet. Only ask for their name.`;
    }
    
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
    
    return systemPrompt;
}

/**
 * Process a message and return AI response
 */
export async function processMessage(
    phone: string,
    message: string,
    options?: {
        agent?: string;
        temperature?: number;
        maxTokens?: number;
    }
): Promise<ProcessResult> {
    try {
        // Load or create user profile
        let userProfile = loadUserProfile(phone);
        const isNewUser = !userProfile;
        if (!userProfile) {
            userProfile = createUserProfile(phone);
        }
        
        // Get agent
        const agentName = options?.agent || userProfile.agent || DEFAULT_AGENT;
        const agent = getAgent(agentName) || getDefaultAgent();
        
        // Check if this is a first interaction (user has no name yet)
        const isFirstInteraction = !userProfile.name && userProfile.first_interaction !== false;
        
        // If user has no name and this is not their first message,
        // try to extract name from their response
        if (!userProfile.name && !isFirstInteraction) {
            const extractedName = extractNameFromResponse(message);
            if (extractedName) {
                userProfile = updateUserProfile(phone, { 
                    name: extractedName,
                    first_interaction: false 
                }) || userProfile;
                console.log(`Extracted name "${extractedName}" for user ${phone}`);
            }
        }
        
        // Build system prompt
        const systemPrompt = buildSystemPrompt(agent, userProfile);
        
        // Load recent context
        const history = loadRecentMemory(phone);
        
        // Call LLM
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
                response: "I'm sorry, I encountered an error processing your request. Please try again.",
                success: false,
                error: response.error,
            };
        }
        
        // Check if this was a first interaction and the response is asking for name
        // Mark first_interaction as false after the first response
        if (isFirstInteraction && isAskingForName(response.content)) {
            updateUserProfile(phone, { first_interaction: false });
        }
        
        return {
            response: response.content,
            success: true,
        };
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
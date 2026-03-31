/**
 * Friday Skill Executor
 * 
 * Parses LLM responses for skill action blocks and executes skills.
 * Skills are called via JSON action blocks in the LLM response.
 * Also handles native tool calling when TOOL_CALLING_ENABLED=true.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ToolCall } from './tool-calling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const SKILLS_PATH = process.env.SKILLS_PATH || './skills';

// Type definitions
interface SkillAction {
    action: string;
    skill: string;
    params: Record<string, unknown>;
}

interface SkillResult {
    success: boolean;
    message: string;
    data?: Record<string, unknown>;
}

interface RegistrySkill {
    name: string;
    description: string;
    file: string;
    type: 'builtin' | 'generated';
    parameters: Record<string, unknown>;
}

interface SkillsRegistry {
    skills: Record<string, RegistrySkill>;
    version: string;
}

// Cache for registry
let registryCache: SkillsRegistry | null = null;

/**
 * Load the skills registry
 */
function loadRegistry(): SkillsRegistry {
    if (registryCache) return registryCache;
    
    const registryPath = path.join(process.cwd(), 'skills', 'registry.json');
    
    if (!fs.existsSync(registryPath)) {
        console.warn('Skills registry not found at', registryPath);
        return { skills: {}, version: '1.0.0' };
    }
    
    registryCache = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as SkillsRegistry;
    return registryCache!;
}

/**
 * Get skill info from registry
 */
export function getSkill(skillName: string): RegistrySkill | null {
    const registry = loadRegistry();
    return registry.skills[skillName] || null;
}

/**
 * List available skills
 */
export function listSkills(): string[] {
    const registry = loadRegistry();
    return Object.keys(registry.skills);
}

/**
 * Parse LLM response for skill action blocks
 * Looks for JSON blocks like: {"action": "search", "skill": "search", "params": {...}}
 * Also handles double-brace format: {{"action": ...}} which some LLMs produce
 */
export function parseSkillAction(response: string): SkillAction | null {
    // Handle double-brace format {{...}} that some LLMs produce
    // The inner content might be: {"action": ...} OR just "action": ... (without outer braces)
    const doubleBraceMatch = response.match(/\{\{([\s\S]*?)\}\}/);
    if (doubleBraceMatch && doubleBraceMatch[1]) {
        try {
            let innerContent = doubleBraceMatch[1].trim();
            // If the inner content doesn't start with {, wrap it
            if (!innerContent.startsWith('{')) {
                innerContent = '{' + innerContent + '}';
            }
            const parsed = JSON.parse(innerContent) as SkillAction;
            if (parsed.action && parsed.skill) {
                return parsed;
            }
        } catch {
            // Fall through to single brace parsing
        }
    }
    
    // Find all potential JSON objects in the response
    // Look for patterns that start with { and contain "action" and "skill" keys
    const startIndex = response.indexOf('{');
    if (startIndex === -1) return null;
    
    // Track brace depth to find the complete JSON object
    let depth = 0;
    let endIndex = -1;
    
    for (let i = startIndex; i < response.length; i++) {
        if (response[i] === '{') {
            depth++;
        } else if (response[i] === '}') {
            depth--;
            if (depth === 0) {
                endIndex = i + 1;
                break;
            }
        }
    }
    
    if (endIndex === -1) return null;
    
    const jsonStr = response.slice(startIndex, endIndex);
    
    try {
        const parsed = JSON.parse(jsonStr) as SkillAction;
        
        // Validate required fields
        if (parsed.action && parsed.skill) {
            return parsed;
        }
        
        return null;
    } catch {
        return null;
    }
}

/**
 * Check if response is ONLY a skill action (no other text)
 */
export function isOnlySkillAction(response: string): boolean {
    const trimmed = response.trim();
    try {
        const parsed = JSON.parse(trimmed) as SkillAction;
        return !!(parsed.action && parsed.skill);
    } catch {
        return false;
    }
}

/**
 * Execute a skill
 */
export async function executeSkill(
    skillName: string,
    params: Record<string, unknown>,
    userId: string
): Promise<SkillResult> {
    const skill = getSkill(skillName);
    
    if (!skill) {
        return {
            success: false,
            message: `Unknown skill: ${skillName}`,
        };
    }
    
    const skillFile = path.join(process.cwd(), skill.file);
    
    if (!fs.existsSync(skillFile)) {
        return {
            success: false,
            message: `Skill file not found: ${skill.file}`,
        };
    }
    
    // Determine how to run the skill based on file extension
    const isPython = skillFile.endsWith('.py');
    const isJavaScript = skillFile.endsWith('.js');
    
    if (!isPython && !isJavaScript) {
        return {
            success: false,
            message: `Unsupported skill file type: ${skill.file}`,
        };
    }
    
    return new Promise((resolve) => {
        const input = JSON.stringify({
            params,
            user_id: userId,
        });
        
        const command = isPython ? 'python3' : 'node';
        const child = spawn(command, [skillFile], {
            cwd: process.cwd(),
            env: process.env,
        });
        
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        child.on('close', (code) => {
            if (code !== 0) {
                resolve({
                    success: false,
                    message: `Skill exited with code ${code}: ${stderr || 'Unknown error'}`,
                });
                return;
            }
            
            try {
                // Parse the skill output
                const result = JSON.parse(stdout.trim()) as SkillResult;
                resolve(result);
            } catch {
                // If not valid JSON, return as message
                resolve({
                    success: true,
                    message: stdout.trim(),
                });
            }
        });
        
        child.on('error', (error) => {
            resolve({
                success: false,
                message: `Failed to execute skill: ${error.message}`,
            });
        });
        
        // Send input to skill via stdin
        child.stdin.write(input);
        child.stdin.end();
    });
}

/**
 * Process LLM response and execute skill if needed
 * Returns the final response to send to user
 */
export async function processSkillAction(
    response: string,
    userId: string
): Promise<{ response: string; skillExecuted: boolean; skillResult?: SkillResult }> {
    // Check if response contains a skill action
    const action = parseSkillAction(response);
    
    if (!action) {
        return { response, skillExecuted: false };
    }
    
    console.log(`[Skill] Executing ${action.skill}.${action.params.action || 'default'} for user ${userId}`);
    console.log(`[Skill] Input params:`, JSON.stringify(action.params, null, 2));
    
    // Execute the skill
    const result = await executeSkill(action.skill, action.params, userId);
    
    if (result.success) {
        console.log(`[Skill] ${action.skill} executed successfully`);
        console.log(`[Skill] Output:`, result.message.substring(0, 500) + (result.message.length > 500 ? '...' : ''));
        if (result.data) {
            console.log(`[Skill] Data keys:`, Object.keys(result.data));
        }
    } else {
        console.error(`[Skill] ${action.skill} failed:`, result.message);
    }
    
    return {
        response: result.message,
        skillExecuted: true,
        skillResult: result,
    };
}

/**
 * Execute a tool call from native tool calling API
 * Converts ToolCall to skill execution format
 */
export async function executeToolCall(
    toolCall: ToolCall,
    userId: string
): Promise<SkillResult> {
    // ToolCall format: { id, name, arguments }
    // name is the skill name, arguments contains action and other params
    const { name, arguments: args } = toolCall;
    
    console.log(`[ToolCall] Executing tool: ${name}`);
    console.log(`[ToolCall] Arguments:`, JSON.stringify(args, null, 2));
    
    // Extract action from arguments if present
    const action = args.action as string | undefined;
    const params = { ...args };
    
    // Execute the skill
    const result = await executeSkill(name, params, userId);
    
    if (result.success) {
        console.log(`[ToolCall] ${name} executed successfully`);
    } else {
        console.error(`[ToolCall] ${name} failed:`, result.message);
    }
    
    return result;
}

/**
 * Process multiple tool calls from native tool calling API
 * Returns results formatted for tool result messages
 */
export async function processToolCalls(
    toolCalls: ToolCall[],
    userId: string
): Promise<Array<{ toolCallId: string; result: SkillResult }>> {
    const results: Array<{ toolCallId: string; result: SkillResult }> = [];
    
    for (const toolCall of toolCalls) {
        const result = await executeToolCall(toolCall, userId);
        results.push({
            toolCallId: toolCall.id,
            result,
        });
    }
    
    return results;
}

/**
 * Convert skill result to tool result format for LLM
 */
export function skillResultToToolResult(
    toolCallId: string,
    result: SkillResult
): { tool_call_id: string; content: string } {
    return {
        tool_call_id: toolCallId,
        content: JSON.stringify({
            success: result.success,
            message: result.message,
            data: result.data,
        }),
    };
}

/**
 * Convert multiple skill results to tool results
 */
export function skillResultsToToolResults(
    results: Array<{ toolCallId: string; result: SkillResult }>
): Array<{ tool_call_id: string; content: string }> {
    return results.map(({ toolCallId, result }) => 
        skillResultToToolResult(toolCallId, result)
    );
}

// Re-export types and functions from tool-calling for convenience
export { type ToolCall } from './tool-calling.js';
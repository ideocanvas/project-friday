/**
 * Friday Skill Executor
 * 
 * Executes skills via native tool calling API.
 * Skills are invoked when the LLM makes a tool call — no text-based parsing.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ToolCall } from './tool-calling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKILLS_PATH = process.env.SKILLS_PATH || './skills';
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

/**
 * Parse skill stdout that may contain mixed log lines + one JSON payload.
 * Many Python skills print progress logs before printing their final JSON result.
 */
function parseSkillStdout(stdout: string): SkillResult | null {
    const trimmed = stdout.trim();
    if (!trimmed) return null;

    // Fast path: pure JSON output
    try {
        return JSON.parse(trimmed) as SkillResult;
    } catch {
        // Fall through to line-by-line recovery.
    }

    // Recovery path: parse from the last JSON-looking line.
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const rawLine = lines[i];
        if (!rawLine) {
            continue;
        }

        const line = rawLine.trim();
        if (!line || !line.startsWith('{') || !line.endsWith('}')) {
            continue;
        }

        try {
            return JSON.parse(line) as SkillResult;
        } catch {
            // Keep scanning upward.
        }
    }

    return null;
}

// Cached conda Python path (resolved once on first use)
let cachedCondaPython: string | null = null;

/**
 * Resolve the Python executable path for the configured conda environment.
 * Uses direct path instead of `conda run` because `conda run` doesn't forward stdin.
 */
async function resolveCondaPython(): Promise<string | null> {
    if (cachedCondaPython !== null) {
        return cachedCondaPython;
    }
    
    const condaEnv = process.env.CONDA_ENV_NAME;
    if (!condaEnv) {
        return null;
    }
    
    // Try CONDA_PYTHON_PATH env var first (allows explicit override)
    if (process.env.CONDA_PYTHON_PATH) {
        cachedCondaPython = process.env.CONDA_PYTHON_PATH;
        console.log(`[Skill] Using CONDA_PYTHON_PATH: ${cachedCondaPython}`);
        return cachedCondaPython;
    }
    
    // Resolve via `conda run -n <env> which python`
    return new Promise((resolve) => {
        const child = spawn('conda', ['run', '-n', condaEnv, 'which', 'python'], {
            cwd: process.cwd(),
            env: process.env,
        });
        let stdout = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', () => {});
        child.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
                cachedCondaPython = stdout.trim();
                console.log(`[Skill] Resolved conda Python: ${cachedCondaPython}`);
            } else {
                console.error(`[Skill] Failed to resolve conda Python path, falling back to conda run`);
                cachedCondaPython = null;
            }
            resolve(cachedCondaPython);
        });
        child.on('error', () => {
            console.error(`[Skill] Failed to resolve conda Python path, falling back to conda run`);
            cachedCondaPython = null;
            resolve(null);
        });
    });
}

// Type definitions
export interface SkillResult {
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

/**
 * Load the skills registry by scanning skill directories for skill.json files.
 * Each skill folder (builtin or generated) contains its own self-contained skill.json.
 * No cache — skills can be added/removed at runtime without restart.
 */
function loadRegistry(): SkillsRegistry {
    const skills: Record<string, RegistrySkill> = {};
    const skillsRoot = path.join(process.cwd(), 'skills');
    
    // Scan both builtin and generated directories
    const skillDirs = ['builtin', 'generated'];
    
    for (const dir of skillDirs) {
        const dirPath = path.join(skillsRoot, dir);
        if (!fs.existsSync(dirPath)) continue;
        
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                
                const skillJsonPath = path.join(dirPath, entry.name, 'skill.json');
                if (!fs.existsSync(skillJsonPath)) continue;
                
                try {
                    const skillDef = JSON.parse(fs.readFileSync(skillJsonPath, 'utf8')) as {
                        id: string;
                        name: string;
                        description: string;
                        file: string;
                        type: 'builtin' | 'generated';
                        parameters: Record<string, unknown>;
                        [key: string]: unknown;
                    };
                    
                    // Skip disabled skills
                    if (skillDef.enabled === false) {
                        continue;
                    }
                    
                    // Resolve file path relative to the skill directory
                    const resolvedFile = path.join(dirPath, entry.name, skillDef.file);
                    const skillId = skillDef.id || entry.name;
                    
                    skills[skillId] = {
                        name: skillDef.name,
                        description: skillDef.description,
                        file: resolvedFile,
                        type: skillDef.type,
                        parameters: skillDef.parameters,
                    };
                } catch (err) {
                    console.warn(`Failed to load skill.json from ${skillJsonPath}:`, err);
                }
            }
        } catch (err) {
            console.warn(`Failed to scan skills directory ${dirPath}:`, err);
        }
    }
    
    return { skills, version: '2.0.0' };
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
    
    // Use path.resolve instead of path.join: skill.file may already be absolute
    // (loadRegistry resolves it to an absolute path). path.join would concatenate
    // two absolute paths producing an invalid double-joined path.
    const skillFile = path.resolve(process.cwd(), skill.file);
    
    if (!fs.existsSync(skillFile)) {
        return {
            success: false,
            message: `Skill file not found: ${skillFile}`,
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
    
    return new Promise(async (resolve) => {
        const input = JSON.stringify({
            params,
            user_id: userId,
        });
        
        let command = '';
        let args: string[] = [];
        
        if (isPython) {
            const condaPython = await resolveCondaPython();
            if (condaPython) {
                // Use the conda Python binary directly (conda run doesn't forward stdin)
                command = condaPython;
                args = [skillFile];
            } else if (process.env.CONDA_ENV_NAME) {
                // Fallback to conda run if resolution failed
                command = 'conda';
                args = ['run', '-n', process.env.CONDA_ENV_NAME, 'python', skillFile];
            } else {
                command = 'python3';
                args = [skillFile];
            }
        } else {
            command = 'node';
            args = [skillFile];
        }
        
        const fullCommand = `${command} ${args.join(' ')}`;
        console.log(`[Skill] Executing: ${fullCommand}`);

        const logDir = ensureSkillLogDir(skillName);
        const outStream = createWriteStreamSafe(path.join(logDir, 'out.log'));
        const errStream = createWriteStreamSafe(path.join(logDir, 'err.log'));
        logHeader(outStream, errStream, fullCommand);

        const child = spawn(command, args, {
            cwd: process.cwd(),
            env: process.env,
        });
        
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            if (outStream) outStream.write(chunk);
        });
        
        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            if (errStream) errStream.write(chunk);
        });
        
        child.on('close', (code) => {
            const timestamp = new Date().toISOString();
            const footer = `\n[${timestamp}] Exit code: ${code}\n${'─'.repeat(60)}\n`;
            if (outStream) outStream.write(footer);
            if (errStream) errStream.write(footer);
            closeStream(outStream);
            closeStream(errStream);

            if (code !== 0) {
                // Try to extract the real error from stdout (Python skills output errors as JSON to stdout)
                let errorDetail = stderr || 'Unknown error';
                if (stdout.trim()) {
                    const stdoutResult = parseSkillStdout(stdout) as unknown as Record<string, unknown> | null;
                    if (stdoutResult && (stdoutResult.error || stdoutResult.message)) {
                        errorDetail = String(stdoutResult.error || stdoutResult.message || errorDetail);
                    } else {
                        // stdout is not JSON, include it as additional context
                        errorDetail = `${stderr}\nstdout: ${stdout.trim()}`;
                    }
                }
                console.error(`[Skill] Failed (exit code ${code}): ${errorDetail}`);
                resolve({
                    success: false,
                    message: `Skill exited with code ${code}: ${errorDetail}`,
                });
                return;
            }
            
            try {
                // Parse the skill output
                const result = parseSkillStdout(stdout);
                if (result) {
                    resolve(result);
                    return;
                }

                // If not valid JSON, return as message
                resolve({
                    success: true,
                    message: stdout.trim(),
                });
            } catch {
                // If not valid JSON, return as message
                resolve({
                    success: true,
                    message: stdout.trim(),
                });
            }
        });
        
        child.on('error', (error) => {
            closeStream(outStream);
            closeStream(errStream);
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
    
    // Execute the skill
    const result = await executeSkill(name, args, userId);
    
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

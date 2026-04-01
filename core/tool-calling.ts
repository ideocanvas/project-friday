/**
 * Tool Calling Module
 * 
 * Handles conversion between skills and tool definitions for LLM tool calling APIs.
 * Supports both OpenAI-style (LM Studio) and Ollama function calling formats.
 */

import { getSkill, listSkills } from './skill-executor.js';

/**
 * Skill parameter definition from registry
 */
interface SkillParameterDef {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  required?: boolean;
  items?: { type?: string };
}

/**
 * Skill definition from registry
 */
interface SkillDef {
  name: string;
  description: string;
  file: string;
  type: 'builtin' | 'generated';
  parameters: Record<string, SkillParameterDef>;
}

/**
 * Environment configuration for tool calling
 */
export function isToolCallingEnabled(): boolean {
  return process.env.TOOL_CALLING_ENABLED === 'true';
}

export function getAIProvider(): 'lmstudio' | 'ollama' {
  const provider = process.env.AI_PROVIDER?.toLowerCase();
  if (provider === 'ollama') {
    return 'ollama';
  }
  // Default to lmstudio for backward compatibility
  return 'lmstudio';
}

/**
 * Tool definition formats for different providers
 */

// OpenAI/LM Studio tool format
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        default?: unknown;
        items?: { type: string };
      }>;
      required: string[];
    };
  };
}

// Ollama tool format
export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolDefinition = OpenAITool | OllamaTool;

/**
 * Tool call from LLM response
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Maps JSON schema types to OpenAI parameter types
 */
function mapParameterType(schemaType?: string): string {
  if (!schemaType) return 'string';
  const typeMap: Record<string, string> = {
    'string': 'string',
    'number': 'number',
    'integer': 'integer',
    'boolean': 'boolean',
    'array': 'array',
    'object': 'object'
  };
  return typeMap[schemaType] || 'string';
}

/**
 * Converts a skill definition to OpenAI-style tool format
 */
export function skillToOpenAITool(skillName: string, skill: SkillDef): OpenAITool {
  const properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    default?: unknown;
    items?: { type: string };
  }> = {};
  
  const required: string[] = [];
  
  if (skill.parameters) {
    for (const [paramName, paramDef] of Object.entries(skill.parameters)) {
      const prop: {
        type: string;
        description?: string;
        enum?: string[];
        default?: unknown;
        items?: { type: string };
      } = {
        type: mapParameterType(paramDef.type)
      };
      
      if (paramDef.description) {
        prop.description = paramDef.description;
      }
      
      if (paramDef.enum) {
        prop.enum = paramDef.enum;
      }
      
      if (paramDef.default !== undefined) {
        prop.default = paramDef.default;
      }
      
      if (paramDef.items) {
        prop.items = { type: mapParameterType(paramDef.items.type) };
      }
      
      properties[paramName] = prop;
      
      if (paramDef.required) {
        required.push(paramName);
      }
    }
  }
  
  return {
    type: 'function',
    function: {
      name: skillName,
      description: skill.description,
      parameters: {
        type: 'object',
        properties,
        required
      }
    }
  };
}

/**
 * Converts a skill definition to Ollama tool format
 * Ollama uses a simpler parameter format (just the JSON schema object)
 */
export function skillToOllamaTool(skillName: string, skill: SkillDef): OllamaTool {
  const parameters: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: []
  };
  
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  
  if (skill.parameters) {
    for (const [paramName, paramDef] of Object.entries(skill.parameters)) {
      const prop: Record<string, unknown> = {
        type: mapParameterType(paramDef.type)
      };
      
      if (paramDef.description) {
        prop.description = paramDef.description;
      }
      
      if (paramDef.enum) {
        prop.enum = paramDef.enum;
      }
      
      if (paramDef.default !== undefined) {
        prop.default = paramDef.default;
      }
      
      if (paramDef.items) {
        prop.items = { type: mapParameterType(paramDef.items.type) };
      }
      
      properties[paramName] = prop;
      
      if (paramDef.required) {
        required.push(paramName);
      }
    }
  }
  
  parameters.properties = properties;
  parameters.required = required;
  
  return {
    type: 'function',
    function: {
      name: skillName,
      description: skill.description,
      parameters
    }
  };
}

/**
 * Loads all skills from registry and returns as a map
 */
export function loadAllSkills(): Record<string, SkillDef> {
  const skillNames = listSkills();
  const skills: Record<string, SkillDef> = {};
  
  for (const name of skillNames) {
    const skill = getSkill(name);
    if (skill) {
      skills[name] = skill as SkillDef;
    }
  }
  
  return skills;
}

/**
 * Built-in system tools (not from skill registry).
 * These are handled directly by the agent loop, not by skill-executor.
 */
const BUILT_IN_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'save_user_profile',
      description: 'Save user profile information learned during conversation. Use this when the user shares their name, location, timezone, or preferences. Call this proactively when you learn new information about the user.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'User\'s display name',
          },
          location: {
            type: 'string',
            description: 'User\'s location (city, country)',
          },
          timezone: {
            type: 'string',
            description: 'User\'s IANA timezone (e.g. Asia/Hong_Kong)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search through past conversation history for relevant context. Use this when you need to recall something the user mentioned earlier, or to find relevant past discussions before performing an action. This helps avoid asking the user to repeat information.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords or topic to search for in past conversations',
          },
          max_results: {
            type: 'integer',
            description: 'Maximum number of results to return (default: 5)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_status',
      description: 'Check the status of a background task. Use this when the user asks about a previously submitted request, e.g. "Is it done yet?", "How is my task going?", "What happened with my search?". Returns the task status, recent logs, and result if completed.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID to check (e.g. task_abc123_001)',
          },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'peek_system_tasks',
      description: 'List all background tasks for the current user (or all users if no phone specified). Use this when the user asks "What are you working on?", "Show me my tasks", or wants an overview of pending/running tasks.',
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: 'Phone number to filter tasks by (optional, defaults to current user)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_task',
      description: 'Cancel a running background task. Use this when the user asks to stop, cancel, or abort a previously submitted request, e.g. "Stop searching", "Cancel that", "Never mind about that task".',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID to cancel',
          },
        },
        required: ['task_id'],
      },
    },
  },
];

/**
 * Get built-in system tools
 */
export function getBuiltInTools(): ToolDefinition[] {
  const provider = getAIProvider();
  if (provider === 'ollama') {
    // Convert OpenAITool format to OllamaTool format
    return BUILT_IN_TOOLS.map(tool => {
      const ollamaTool: OllamaTool = {
        type: 'function',
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters as Record<string, unknown>,
        },
      };
      return ollamaTool;
    });
  }
  return [...BUILT_IN_TOOLS];
}

/**
 * Check if a tool name is a built-in system tool
 */
export function isBuiltInTool(name: string): boolean {
  return BUILT_IN_TOOLS.some(t => t.function.name === name);
}

/**
 * Converts all skills to tool definitions based on provider,
 * including built-in system tools.
 */
export function skillsToTools(): ToolDefinition[] {
  const skills = loadAllSkills();
  const provider = getAIProvider();
  const tools: ToolDefinition[] = [];
  
  // Add built-in system tools first
  tools.push(...getBuiltInTools());
  
  // Add skill-based tools
  for (const [skillName, skill] of Object.entries(skills)) {
    if (provider === 'ollama') {
      tools.push(skillToOllamaTool(skillName, skill));
    } else {
      tools.push(skillToOpenAITool(skillName, skill));
    }
  }
  
  return tools;
}

/**
 * Parses a tool call from LLM response
 */
export function parseToolCall(toolCall: { id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }): ToolCall | null {
  if (!toolCall.function?.name) {
    return null;
  }
  
  let args: Record<string, unknown>;
  
  if (typeof toolCall.function.arguments === 'string') {
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      console.error('[ToolCalling] Failed to parse tool arguments:', toolCall.function.arguments);
      return null;
    }
  } else if (toolCall.function.arguments) {
    args = toolCall.function.arguments;
  } else {
    args = {};
  }
  
  return {
    id: toolCall.id || `${toolCall.function.name}_${Date.now()}`,
    name: toolCall.function.name,
    arguments: args
  };
}

/**
 * Parses multiple tool calls from LLM response
 */
export function parseToolCalls(toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }>): ToolCall[] {
  const results: ToolCall[] = [];
  
  for (const tc of toolCalls) {
    const parsed = parseToolCall(tc);
    if (parsed) {
      results.push(parsed);
    }
  }
  
  return results;
}

/**
 * Formats tool result for LLM conversation
 */
export function formatToolResult(toolCallId: string, result: unknown): { role: 'tool'; tool_call_id: string; content: string } {
  let content: string;
  
  if (typeof result === 'string') {
    content = result;
  } else if (result === undefined || result === null) {
    content = 'Tool executed successfully with no output.';
  } else {
    try {
      content = JSON.stringify(result, null, 2);
    } catch {
      content = String(result);
    }
  }
  
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content
  };
}

/**
 * Gets the tool format name for logging
 */
export function getToolFormatName(): string {
  const provider = getAIProvider();
  return provider === 'ollama' ? 'Ollama function calling' : 'OpenAI-style tools';
}

/**
 * Converts a ToolCall back to the OpenAI API wire format for inclusion
 * in an assistant message.  The LLM API expects:
 *   { id, type: "function", function: { name, arguments: "<json string>" } }
 * but our internal ToolCall stores { id, name, arguments: {…} }.
 */
export function toolCallToOpenAIFormat(tc: ToolCall): {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
} {
  return {
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments),
    },
  };
}
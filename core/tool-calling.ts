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
 * Converts all skills to tool definitions based on provider
 */
export function skillsToTools(): ToolDefinition[] {
  const skills = loadAllSkills();
  const provider = getAIProvider();
  const tools: ToolDefinition[] = [];
  
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
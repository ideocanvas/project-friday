/**
 * Friday LLM Client
 * 
 * Handles communication with the local LLM (LM Studio) using OpenAI-compatible API.
 * Provides a simple interface for chat completions and tool calling.
 */

import 'dotenv/config';
import {
    isToolCallingEnabled,
    skillsToTools,
    parseToolCalls,
    formatToolResult,
    toolCallToOpenAIFormat,
    ToolDefinition,
    ToolCall
} from './tool-calling.js';

// Configuration from environment
const AI_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:1234/v1';
const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen/qwen3.5-35b-a3b';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);

// Type definitions
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ChatCompletionOptions {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    tools?: ToolDefinition[];
    tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export interface ChatCompletionResponse {
    content: string;
    success: boolean;
    error?: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    toolCalls?: ToolCall[];
}

/**
 * LLM Client class for chat completions
 */
export class LLMClient {
    private baseUrl: string;
    private model: string;
    private defaultTimeout: number;

    constructor(baseUrl?: string, model?: string) {
        this.baseUrl = baseUrl || AI_BASE_URL;
        this.model = model || CHAT_MODEL;
        this.defaultTimeout = DEFAULT_TIMEOUT_MS;
    }

    /**
     * Create a chat completion
     */
    async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
        const { messages, temperature = 0.7, maxTokens = 2048, timeout, tools, tool_choice } = options;
        
        // Filter out messages with empty content that would cause API errors.
        // Keep tool messages (role=tool) and assistant messages with tool_calls even if content is empty.
        const validMessages = messages.filter(m => {
            if (m.role === 'tool') return true;  // tool results must always be included
            if (m.tool_calls && m.tool_calls.length > 0) return true;  // assistant with tool_calls
            return m.content && m.content.trim() !== '';
        });
        
        const controller = new AbortController();
        const timeoutMs = timeout || this.defaultTimeout;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // Log LLM request
        console.log('[LLM] Sending request:');
        console.log(`[LLM] Model: ${this.model}`);
        console.log(`[LLM] Temperature: ${temperature}, MaxTokens: ${maxTokens}`);
        if (tools && tools.length > 0) {
            console.log(`[LLM] Tools: ${tools.length} tool(s)`);
        }
        console.log('[LLM] Messages:');
        validMessages.forEach((m, i) => {
            const contentPreview = m.content.length > 200 ? m.content.substring(0, 200) + '...' : m.content;
            console.log(`[LLM]   [${i}] ${m.role}: ${contentPreview}`);
        });

        try {
            const requestBody: Record<string, unknown> = {
                model: this.model,
                messages: validMessages.map(m => ({
                    role: m.role,
                    content: m.content,
                    ...(m.tool_calls && { tool_calls: m.tool_calls.map(tc => toolCallToOpenAIFormat(tc)) }),
                    ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
                })),
                temperature,
                max_tokens: maxTokens,
            };

            // Add tools if provided
            if (tools && tools.length > 0) {
                requestBody.tools = tools;
                requestBody.tool_choice = tool_choice || 'auto';
            }

            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                console.log(`[LLM] API error: ${response.status} - ${errorText}`);
                return {
                    content: '',
                    success: false,
                    error: `LLM API error: ${response.status} - ${errorText}`,
                };
            }

            const data = await response.json() as {
                choices?: Array<{
                    message?: {
                        content?: string;
                        tool_calls?: Array<{
                            id?: string;
                            type?: string;
                            function?: {
                                name?: string;
                                arguments?: string;
                            };
                        }>;
                    };
                }>;
                usage?: {
                    prompt_tokens: number;
                    completion_tokens: number;
                    total_tokens: number;
                };
            };

            const content = data.choices?.[0]?.message?.content?.trim() || '';
            const usage = data.usage ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            } : undefined;

            // Extract tool calls if present
            const toolCalls = data.choices?.[0]?.message?.tool_calls;
            const parsedToolCalls = toolCalls ? parseToolCalls(toolCalls) : undefined;

            // Log LLM response
            console.log('[LLM] Response received:');
            console.log(`[LLM] Success: true, Tokens: ${usage?.totalTokens || 'N/A'} (prompt: ${usage?.promptTokens || 'N/A'}, completion: ${usage?.completionTokens || 'N/A'})`);
            if (parsedToolCalls && parsedToolCalls.length > 0) {
                console.log(`[LLM] Tool calls: ${parsedToolCalls.length}`);
                parsedToolCalls.forEach((tc, i) => {
                    console.log(`[LLM]   [${i}] ${tc.name}`);
                });
            }
            const responsePreview = content.length > 500 ? content.substring(0, 500) + '...' : content;
            console.log(`[LLM] Content: ${responsePreview}`);

            return {
                content,
                success: true,
                usage,
                toolCalls: parsedToolCalls,
            };
        } catch (error) {
            clearTimeout(timeoutId);
            
            // Log LLM error
            console.log('[LLM] Error occurred:');
            if (error instanceof Error) {
                console.log(`[LLM] Error: ${error.name} - ${error.message}`);
                if (error.name === 'AbortError') {
                    console.log(`[LLM] Request timed out after ${timeoutMs}ms`);
                    return {
                        content: '',
                        success: false,
                        error: `LLM request timed out after ${timeoutMs}ms`,
                    };
                }
                return {
                    content: '',
                    success: false,
                    error: `LLM request failed: ${error.message}`,
                };
            }
            
            console.log('[LLM] Unknown error occurred');
            return {
                content: '',
                success: false,
                error: 'Unknown error occurred',
            };
        }
    }

    /**
     * Chat with tools support
     * Uses native tool calling when enabled, falls back to text extraction otherwise
     */
    async chatWithTools(
        systemPrompt: string,
        history: ChatMessage[],
        userMessage: string,
        tools?: ToolDefinition[],
        options?: Partial<ChatCompletionOptions>
    ): Promise<ChatCompletionResponse> {
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: userMessage },
        ];

        // If tool calling is enabled and tools are provided, use native tool calling
        if (isToolCallingEnabled() && tools && tools.length > 0) {
            return this.chatCompletionWithTools({
                messages,
                tools,
                ...options,
            });
        }

        // Otherwise, use regular chat completion (text-based tool extraction happens in message-processor)
        return this.chatCompletion({
            messages,
            ...options,
        });
    }

    /**
     * Chat completion with native tool calling
     */
    private async chatCompletionWithTools(
        options: ChatCompletionOptions & { tools: ToolDefinition[] }
    ): Promise<ChatCompletionResponse> {
        const { messages, tools, temperature = 0.7, maxTokens = 2048, timeout } = options;
        
        // Filter out messages with empty content that would cause API errors.
        // Keep tool messages (role=tool) and assistant messages with tool_calls even if content is empty.
        const validMessages = messages.filter(m => {
            if (m.role === 'tool') return true;  // tool results must always be included
            if (m.tool_calls && m.tool_calls.length > 0) return true;  // assistant with tool_calls
            return m.content && m.content.trim() !== '';
        });
        
        const controller = new AbortController();
        const timeoutMs = timeout || this.defaultTimeout;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // Log LLM request with tools
        console.log('[LLM] Sending request with tools:');
        console.log(`[LLM] Model: ${this.model}`);
        console.log(`[LLM] Temperature: ${temperature}, MaxTokens: ${maxTokens}`);
        console.log(`[LLM] Tools: ${tools.length} tool(s)`);
        console.log('[LLM] Messages:');
        validMessages.forEach((m, i) => {
            const contentPreview = m.content.length > 200 ? m.content.substring(0, 200) + '...' : m.content;
            console.log(`[LLM]   [${i}] ${m.role}: ${contentPreview}`);
        });

        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: validMessages.map(m => ({
                        role: m.role,
                        content: m.content,
                        ...(m.tool_calls && { tool_calls: m.tool_calls.map(tc => toolCallToOpenAIFormat(tc)) }),
                        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
                    })),
                    tools: tools,
                    tool_choice: 'auto',
                    temperature,
                    max_tokens: maxTokens,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                console.log(`[LLM] API error: ${response.status} - ${errorText}`);
                return {
                    content: '',
                    success: false,
                    error: `LLM API error: ${response.status} - ${errorText}`,
                };
            }

            const data = await response.json() as {
                choices?: Array<{
                    message?: {
                        content?: string;
                        tool_calls?: Array<{
                            id?: string;
                            type?: string;
                            function?: {
                                name?: string;
                                arguments?: string;
                            };
                        }>;
                    };
                }>;
                usage?: {
                    prompt_tokens: number;
                    completion_tokens: number;
                    total_tokens: number;
                };
            };

            const content = data.choices?.[0]?.message?.content?.trim() || '';
            const usage = data.usage ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            } : undefined;

            // Extract tool calls if present
            const rawToolCalls = data.choices?.[0]?.message?.tool_calls;
            const toolCalls = rawToolCalls ? parseToolCalls(rawToolCalls) : undefined;

            // Log LLM response
            console.log('[LLM] Response received:');
            console.log(`[LLM] Success: true, Tokens: ${usage?.totalTokens || 'N/A'}`);
            if (toolCalls && toolCalls.length > 0) {
                console.log(`[LLM] Tool calls: ${toolCalls.length}`);
                toolCalls.forEach((tc, i) => {
                    console.log(`[LLM]   [${i}] ${tc.name}(${JSON.stringify(tc.arguments)})`);
                });
            }
            const responsePreview = content.length > 500 ? content.substring(0, 500) + '...' : content;
            console.log(`[LLM] Content: ${responsePreview}`);

            return {
                content,
                success: true,
                usage,
                toolCalls,
            };
        } catch (error) {
            clearTimeout(timeoutId);
            
            console.log('[LLM] Error occurred:');
            if (error instanceof Error) {
                console.log(`[LLM] Error: ${error.name} - ${error.message}`);
                if (error.name === 'AbortError') {
                    console.log(`[LLM] Request timed out after ${timeoutMs}ms`);
                    return {
                        content: '',
                        success: false,
                        error: `LLM request timed out after ${timeoutMs}ms`,
                    };
                }
                return {
                    content: '',
                    success: false,
                    error: `LLM request failed: ${error.message}`,
                };
            }
            
            console.log('[LLM] Unknown error occurred');
            return {
                content: '',
                success: false,
                error: 'Unknown error occurred',
            };
        }
    }

    /**
     * Simple chat helper - takes a system prompt and user message
     */
    async chat(systemPrompt: string, userMessage: string, options?: Partial<ChatCompletionOptions>): Promise<ChatCompletionResponse> {
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ];

        return this.chatCompletion({
            messages,
            ...options,
        });
    }

    /**
     * Chat with conversation history
     */
    async chatWithContext(
        systemPrompt: string,
        history: ChatMessage[],
        userMessage: string,
        options?: Partial<ChatCompletionOptions>
    ): Promise<ChatCompletionResponse> {
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: userMessage },
        ];

        return this.chatCompletion({
            messages,
            ...options,
        });
    }

    /**
     * Check if LLM is available
     */
    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Get available models
     */
    async getModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
                return [];
            }

            const data = await response.json() as {
                data?: Array<{ id?: string }>;
            };

            return data.data?.map(m => m.id).filter((id): id is string => typeof id === 'string') || [];
        } catch {
            return [];
        }
    }
}

// Export singleton instance
export const llmClient = new LLMClient();

// Export convenience function
export async function chat(systemPrompt: string, userMessage: string, options?: Partial<ChatCompletionOptions>): Promise<ChatCompletionResponse> {
    return llmClient.chat(systemPrompt, userMessage, options);
}

export async function chatWithContext(
    systemPrompt: string,
    history: ChatMessage[],
    userMessage: string,
    options?: Partial<ChatCompletionOptions>
): Promise<ChatCompletionResponse> {
    return llmClient.chatWithContext(systemPrompt, history, userMessage, options);
}
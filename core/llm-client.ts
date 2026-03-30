/**
 * Friday LLM Client
 * 
 * Handles communication with the local LLM (LM Studio) using OpenAI-compatible API.
 * Provides a simple interface for chat completions.
 */

import 'dotenv/config';

// Configuration from environment
const AI_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:1234/v1';
const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen/qwen3.5-35b-a3b';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);

// Type definitions
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatCompletionOptions {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
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
        const { messages, temperature = 0.7, maxTokens = 2048, timeout } = options;
        
        const controller = new AbortController();
        const timeoutMs = timeout || this.defaultTimeout;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: messages.map(m => ({
                        role: m.role,
                        content: m.content
                    })),
                    temperature,
                    max_tokens: maxTokens,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
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

            return {
                content,
                success: true,
                usage,
            };
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (error instanceof Error) {
                if (error.name === 'AbortError') {
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
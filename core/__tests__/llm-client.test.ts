/**
 * Unit tests for LLM Client
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LLMClient, chat, chatWithContext, ChatMessage } from '../llm-client.js';

// Mock fetch globally
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

describe('LLM Client', () => {
    let client: LLMClient;

    beforeEach(() => {
        jest.clearAllMocks();
        client = new LLMClient('http://localhost:1234/v1', 'test-model');
    });

    describe('constructor', () => {
        it('should use provided values', () => {
            const customClient = new LLMClient('http://custom:8080/v1', 'custom-model');
            expect(customClient).toBeDefined();
        });

        it('should use environment defaults', () => {
            const defaultClient = new LLMClient();
            expect(defaultClient).toBeDefined();
        });
    });

    describe('chatCompletion', () => {
        it('should return successful response', async () => {
            const mockResponse = {
                choices: [{
                    message: { content: 'Hello! How can I help you?' }
                }],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 8,
                    total_tokens: 18
                }
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
                text: async () => JSON.stringify(mockResponse),
            } as Response);

            const result = await client.chatCompletion({
                messages: [
                    { role: 'system', content: 'You are a helpful assistant.' },
                    { role: 'user', content: 'Hello!' }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.content).toBe('Hello! How can I help you?');
            expect(result.usage).toEqual({
                promptTokens: 10,
                completionTokens: 8,
                totalTokens: 18
            });
        });

        it('should handle API errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error',
            } as Response);

            const result = await client.chatCompletion({
                messages: [{ role: 'user', content: 'Hello!' }]
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('500');
            expect(result.content).toBe('');
        });

        it('should handle network errors', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await client.chatCompletion({
                messages: [{ role: 'user', content: 'Hello!' }]
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Network error');
        });

        it('should handle empty response', async () => {
            const mockResponse = {
                choices: []
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            } as Response);

            const result = await client.chatCompletion({
                messages: [{ role: 'user', content: 'Hello!' }]
            });

            expect(result.success).toBe(true);
            expect(result.content).toBe('');
        });

        it('should send correct request body', async () => {
            let capturedBody: Record<string, unknown> | null = null;

            mockFetch.mockImplementationOnce(async (_url: string | URL | Request, options?: RequestInit) => {
                capturedBody = options?.body ? JSON.parse(options.body as string) : null;
                return {
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: 'test' } }] }),
                } as Response;
            });

            await client.chatCompletion({
                messages: [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'User message' }
                ],
                temperature: 0.5,
                maxTokens: 1000
            });

            expect(capturedBody).toEqual({
                model: 'test-model',
                messages: [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'User message' }
                ],
                temperature: 0.5,
                max_tokens: 1000
            });
        });
    });

    describe('chat', () => {
        it('should create proper message structure', async () => {
            let capturedBody: Record<string, unknown> | null = null;

            mockFetch.mockImplementationOnce(async (_url: string | URL | Request, options?: RequestInit) => {
                capturedBody = options?.body ? JSON.parse(options.body as string) : null;
                return {
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: 'Response' } }] }),
                } as Response;
            });

            await client.chat('You are helpful', 'Hello');

            expect(capturedBody).toEqual({
                model: 'test-model',
                messages: [
                    { role: 'system', content: 'You are helpful' },
                    { role: 'user', content: 'Hello' }
                ],
                temperature: 0.7,
                max_tokens: 2048
            });
        });

        it('should allow overriding options', async () => {
            let capturedBody: Record<string, unknown> | null = null;

            mockFetch.mockImplementationOnce(async (_url: string | URL | Request, options?: RequestInit) => {
                capturedBody = options?.body ? JSON.parse(options.body as string) : null;
                return {
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: 'Response' } }] }),
                } as Response;
            });

            await client.chat('System', 'User', { temperature: 0.9, maxTokens: 500 });

            expect(capturedBody).toEqual({
                model: 'test-model',
                messages: [
                    { role: 'system', content: 'System' },
                    { role: 'user', content: 'User' }
                ],
                temperature: 0.9,
                max_tokens: 500
            });
        });
    });

    describe('chatWithContext', () => {
        it('should include conversation history', async () => {
            let capturedBody: Record<string, unknown> | null = null;

            mockFetch.mockImplementationOnce(async (_url: string | URL | Request, options?: RequestInit) => {
                capturedBody = options?.body ? JSON.parse(options.body as string) : null;
                return {
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: 'Response' } }] }),
                } as Response;
            });

            const history: ChatMessage[] = [
                { role: 'user', content: 'First message' },
                { role: 'assistant', content: 'First response' }
            ];

            await client.chatWithContext('System prompt', history, 'New message');

            expect(capturedBody).toEqual({
                model: 'test-model',
                messages: [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'First message' },
                    { role: 'assistant', content: 'First response' },
                    { role: 'user', content: 'New message' }
                ],
                temperature: 0.7,
                max_tokens: 2048
            });
        });
    });

    describe('isAvailable', () => {
        it('should return true when LLM is available', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
            } as Response);

            const available = await client.isAvailable();
            expect(available).toBe(true);
        });

        it('should return false when LLM is not available', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

            const available = await client.isAvailable();
            expect(available).toBe(false);
        });

        it('should return false on non-OK response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
            } as Response);

            const available = await client.isAvailable();
            expect(available).toBe(false);
        });
    });

    describe('getModels', () => {
        it('should return list of models', async () => {
            const mockResponse = {
                data: [
                    { id: 'model-1' },
                    { id: 'model-2' },
                    { id: 'model-3' }
                ]
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            } as Response);

            const models = await client.getModels();
            expect(models).toEqual(['model-1', 'model-2', 'model-3']);
        });

        it('should return empty array on error', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const models = await client.getModels();
            expect(models).toEqual([]);
        });

        it('should return empty array on non-OK response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
            } as Response);

            const models = await client.getModels();
            expect(models).toEqual([]);
        });

        it('should handle malformed response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: null }),
            } as Response);

            const models = await client.getModels();
            expect(models).toEqual([]);
        });
    });
});

describe('Convenience functions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('chat', () => {
        it('should use default client', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'Response' } }] }),
            } as Response);

            const result = await chat('System', 'User');

            expect(result.success).toBe(true);
            expect(result.content).toBe('Response');
        });
    });

    describe('chatWithContext', () => {
        it('should use default client with history', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'Response' } }] }),
            } as Response);

            const history: ChatMessage[] = [
                { role: 'user', content: 'Previous' },
                { role: 'assistant', content: 'Response' }
            ];

            const result = await chatWithContext('System', history, 'New message');

            expect(result.success).toBe(true);
            expect(result.content).toBe('Response');
        });
    });
});
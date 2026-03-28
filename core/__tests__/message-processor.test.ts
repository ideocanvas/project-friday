/**
 * Unit tests for Message Processor
 * 
 * Note: These tests focus on the pure logic functions that don't require fs mocking.
 * Integration tests would be better suited for testing file operations.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { buildSystemPrompt, ChatMessage } from '../message-processor.js';

describe('Message Processor', () => {
    describe('buildSystemPrompt', () => {
        it('should build prompt with agent and user context', () => {
            const agent = {
                name: 'Friday',
                description: 'Test',
                system_prompt: 'You are Friday.',
                voice: 'default',
                personality: { tone: 'friendly', style: 'concise', humor: 'light' }
            };

            const profile = {
                phone: '1234567890',
                name: 'John',
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z'
            };

            const result = buildSystemPrompt(agent, profile);

            expect(result).toContain('You are Friday.');
            expect(result).toContain('John');
            expect(result).toContain('friendly');
            expect(result).toContain('concise');
        });

        it('should work without user profile', () => {
            const agent = {
                name: 'Friday',
                description: 'Test',
                system_prompt: 'You are Friday.',
                voice: 'default',
                personality: { tone: 'friendly', style: 'concise', humor: 'light' }
            };

            const result = buildSystemPrompt(agent, null);

            expect(result).toContain('You are Friday.');
            expect(result).toContain('friendly');
        });

        it('should include personality traits', () => {
            const agent = {
                name: 'Alfred',
                description: 'Butler',
                system_prompt: 'You are Alfred.',
                voice: 'default',
                personality: { tone: 'formal', style: 'thorough', humor: 'subtle' }
            };

            const result = buildSystemPrompt(agent, null);

            expect(result).toContain('formal');
            expect(result).toContain('thorough');
            // Note: humor is not currently included in the system prompt
        });

        it('should handle missing name in profile', () => {
            const agent = {
                name: 'Friday',
                description: 'Test',
                system_prompt: 'You are Friday.',
                voice: 'default',
                personality: { tone: 'friendly', style: 'concise', humor: 'light' }
            };

            const profile = {
                phone: '1234567890',
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z'
            };

            const result = buildSystemPrompt(agent, profile);

            expect(result).toContain('You are Friday.');
            // Should not contain "The user's name is" since name is undefined
            expect(result).not.toContain("The user's name is undefined");
        });
    });
});

// Type-only import test
describe('Type definitions', () => {
    it('should support ChatMessage type', () => {
        const message: ChatMessage = {
            role: 'user',
            content: 'Hello'
        };
        expect(message.role).toBe('user');
        expect(message.content).toBe('Hello');
    });

    it('should support all message roles', () => {
        const userMessage: ChatMessage = { role: 'user', content: 'User message' };
        const assistantMessage: ChatMessage = { role: 'assistant', content: 'Assistant message' };
        const systemMessage: ChatMessage = { role: 'system', content: 'System message' };

        expect(userMessage.role).toBe('user');
        expect(assistantMessage.role).toBe('assistant');
        expect(systemMessage.role).toBe('system');
    });
});
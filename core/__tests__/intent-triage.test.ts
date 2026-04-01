/**
 * Unit tests for Intent Triage
 *
 * Tests the keyword-based heuristic triage (Stage 1).
 * LLM-based triage (Stage 2) is tested with mocks.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock llm-client
jest.mock('../llm-client.js', () => ({
    llmClient: {
        chatCompletion: jest.fn(() => Promise.resolve({
            success: true,
            content: '{"category":"rapid_response","reason":"test","confidence":0.5}',
        })),
    },
    LLMClient: jest.fn(),
}));

// Mock skill-executor
jest.mock('../skill-executor.js', () => ({
    listSkills: jest.fn(() => ['search', 'browser', 'voice', 'vision']),
}));

import { triageIntent } from '../intent-triage.js';

describe('Intent Triage', () => {
    describe('rapid_response classification', () => {
        it('should classify short greetings as rapid_response', async () => {
            const result = await triageIntent('Hello!');
            expect(result.category).toBe('rapid_response');
            expect(result.confidence).toBeGreaterThan(0.5);
        });

        it('should classify "hi" as rapid_response', async () => {
            const result = await triageIntent('hi');
            expect(result.category).toBe('rapid_response');
        });

        it('should classify "thanks" as rapid_response', async () => {
            const result = await triageIntent('thanks');
            expect(result.category).toBe('rapid_response');
        });

        it('should classify "how are you" as rapid_response', async () => {
            const result = await triageIntent('how are you');
            expect(result.category).toBe('rapid_response');
        });
    });

    describe('background_task classification', () => {
        it('should classify search requests as background_task', async () => {
            const result = await triageIntent('Search for the best restaurants near me and find their reviews');
            expect(result.category).toBe('background_task');
            expect(result.confidence).toBeGreaterThan(0.5);
        });

        it('should classify browse requests as background_task', async () => {
            const result = await triageIntent('Browse this website and download the report for me');
            expect(result.category).toBe('background_task');
        });
    });

    describe('LLM fallback', () => {
        it('should fall back to LLM triage for ambiguous messages', async () => {
            // A message that doesn't match any keywords clearly
            const result = await triageIntent('Can you help me understand quantum physics?');
            // Should return a valid result (either from LLM or heuristic)
            expect(['rapid_response', 'background_task', 'skill_generation']).toContain(result.category);
            expect(result.reason).toBeTruthy();
        });
    });

    describe('edge cases', () => {
        it('should handle empty message', async () => {
            const result = await triageIntent('');
            expect(result.category).toBeTruthy();
        });

        it('should handle very long message', async () => {
            const longMsg = 'A'.repeat(5000);
            const result = await triageIntent(longMsg);
            expect(result.category).toBeTruthy();
        });

        it('should provide reason for all classifications', async () => {
            const result = await triageIntent('test message');
            expect(result.reason).toBeTruthy();
            expect(typeof result.reason).toBe('string');
        });

        it('should provide confidence between 0 and 1', async () => {
            const result = await triageIntent('test message');
            expect(result.confidence).toBeGreaterThanOrEqual(0);
            expect(result.confidence).toBeLessThanOrEqual(1);
        });
    });
});

/**
 * Unit tests for Task Manager
 *
 * Tests the background task lifecycle: create → start → complete/cancel.
 * File-system operations (queue push) are tested via mocks.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock fs to avoid actual file writes
jest.mock('fs', () => {
    const actual = jest.requireActual('fs') as Record<string, unknown>;
    return {
        ...actual,
        existsSync: jest.fn(() => false),
        mkdirSync: jest.fn(),
        writeFileSync: jest.fn(),
        readFileSync: jest.fn(() => '[]'),
    };
});

// Mock llm-client to avoid actual LLM calls
jest.mock('../llm-client.js', () => ({
    llmClient: {
        chatCompletion: jest.fn(() => Promise.resolve({
            success: true,
            content: 'Task completed successfully',
            toolCalls: [],
        })),
    },
    LLMClient: jest.fn(),
}));

// Mock tool-calling
jest.mock('../tool-calling.js', () => ({
    skillsToTools: jest.fn(() => []),
    isBuiltInTool: jest.fn(() => false),
}));

// Mock skill-executor
jest.mock('../skill-executor.js', () => ({
    processToolCalls: jest.fn(() => Promise.resolve([])),
}));

import {
    createTask,
    startTask,
    getTask,
    getTaskSummary,
    getTaskLogs,
    listTasks,
    cancelTask,
    activeTaskCount,
    type Task,
    type TaskSummary,
} from '../task-manager.js';

describe('Task Manager', () => {
    const baseParams = {
        phone: '1234567890',
        jid: '1234567890@s.whatsapp.net',
        userMessage: 'Search for flights to Tokyo',
        systemPrompt: 'You are Friday.',
        history: [] as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    };

    describe('createTask', () => {
        it('should create a task with pending status', () => {
            const task = createTask(baseParams);

            expect(task.id).toMatch(/^task_/);
            expect(task.phone).toBe('1234567890');
            expect(task.status).toBe('pending');
            expect(task.userMessage).toBe('Search for flights to Tokyo');
            expect(task.logs.length).toBeGreaterThan(0);
        });

        it('should generate unique IDs for each task', () => {
            const task1 = createTask(baseParams);
            const task2 = createTask(baseParams);

            expect(task1.id).not.toBe(task2.id);
        });

        it('should record creation timestamp', () => {
            const task = createTask(baseParams);

            expect(task.createdAt).toBeTruthy();
            expect(new Date(task.createdAt).getTime()).not.toBeNaN();
        });
    });

    describe('getTask', () => {
        it('should retrieve a created task by ID', () => {
            const task = createTask(baseParams);
            const retrieved = getTask(task.id);

            expect(retrieved).toBeDefined();
            expect(retrieved!.id).toBe(task.id);
        });

        it('should return undefined for non-existent task', () => {
            const retrieved = getTask('nonexistent_task');

            expect(retrieved).toBeUndefined();
        });
    });

    describe('getTaskSummary', () => {
        it('should return a summary without internal fields', () => {
            const task = createTask(baseParams);
            const summary = getTaskSummary(task.id);

            expect(summary).not.toBeNull();
            expect(summary!.id).toBe(task.id);
            expect(summary!.phone).toBe(task.phone);
            expect(summary!.status).toBe('pending');
            expect(summary!.logCount).toBe(task.logs.length);
            // Should not have abortController
            expect((summary as unknown as Record<string, unknown>).abortController).toBeUndefined();
        });

        it('should return null for non-existent task', () => {
            const summary = getTaskSummary('nonexistent');

            expect(summary).toBeNull();
        });
    });

    describe('getTaskLogs', () => {
        it('should return log entries for a task', () => {
            const task = createTask(baseParams);
            const logs = getTaskLogs(task.id);

            expect(logs.length).toBeGreaterThan(0);
            expect(logs[0]).toHaveProperty('timestamp');
            expect(logs[0]).toHaveProperty('level');
            expect(logs[0]).toHaveProperty('message');
        });

        it('should limit log entries by count', () => {
            const task = createTask(baseParams);
            const logs = getTaskLogs(task.id, 1);

            expect(logs.length).toBe(1);
        });

        it('should return empty array for non-existent task', () => {
            const logs = getTaskLogs('nonexistent');

            expect(logs).toEqual([]);
        });
    });

    describe('listTasks', () => {
        it('should list all tasks', () => {
            const task1 = createTask({ ...baseParams, phone: '111' });
            const task2 = createTask({ ...baseParams, phone: '222' });

            const all = listTasks();

            expect(all.length).toBeGreaterThanOrEqual(2);
            const ids = all.map(t => t.id);
            expect(ids).toContain(task1.id);
            expect(ids).toContain(task2.id);
        });

        it('should filter tasks by phone number', () => {
            createTask({ ...baseParams, phone: '111' });
            const targetTask = createTask({ ...baseParams, phone: '222' });

            const filtered = listTasks('222');

            expect(filtered.every(t => t.phone === '222')).toBe(true);
            expect(filtered.some(t => t.id === targetTask.id)).toBe(true);
        });
    });

    describe('cancelTask', () => {
        it('should cancel a pending task', () => {
            const task = createTask(baseParams);
            const result = cancelTask(task.id);

            expect(result).toBe(true);
            expect(getTask(task.id)!.status).toBe('cancelled');
        });

        it('should return false for non-existent task', () => {
            const result = cancelTask('nonexistent');

            expect(result).toBe(false);
        });
    });

    describe('activeTaskCount', () => {
        it('should count pending and running tasks', () => {
            const task1 = createTask(baseParams);
            const task2 = createTask(baseParams);

            // Both are pending
            const count = activeTaskCount();
            expect(count).toBeGreaterThanOrEqual(2);

            // Cancel one
            cancelTask(task1.id);
            const countAfterCancel = activeTaskCount();
            expect(countAfterCancel).toBeLessThan(count);
        });
    });

    describe('startTask', () => {
        it('should transition task to running status', async () => {
            const task = createTask(baseParams);
            startTask(task.id);

            // Give it a tick to start
            await new Promise(resolve => setTimeout(resolve, 50));

            const retrieved = getTask(task.id);
            // It should be either running or completed (if the mock resolved fast)
            expect(['running', 'completed']).toContain(retrieved!.status);
        });

        it('should handle starting a non-existent task', () => {
            expect(() => startTask('nonexistent')).not.toThrow();
        });
    });
});

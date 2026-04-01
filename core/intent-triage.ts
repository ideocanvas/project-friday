/**
 * Friday Intent Triage
 *
 * Performs a quick LLM analysis of the user's message to determine
 * the appropriate processing strategy:
 *
 *   a. rapid_response  → Standard conversation, casual greeting, quick Q&A.
 *                         Handled by the blocking agent loop (fast).
 *   b. background_task → Maps to an existing skill/tool that may take time
 *                         (e.g., search, browser, email, voice synthesis).
 *                         Dispatched as an asynchronous background task.
 *   c. skill_generation → Intent requires a skill that doesn't exist yet.
 *                          Triggers the evolution / skill generation pipeline.
 */

import { llmClient, type ChatMessage } from './llm-client.js';
import { listSkills } from './skill-executor.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type TriageCategory = 'rapid_response' | 'background_task' | 'skill_generation';

export interface TriageResult {
    /** The triage category determined for this message */
    category: TriageCategory;
    /** Human-readable reason for the classification */
    reason: string;
    /** Confidence score 0-1 */
    confidence: number;
    /** If background_task, the identified skill/tool name(s) */
    identifiedTools?: string[];
    /** If skill_generation, a description of what skill to generate */
    skillDescription?: string;
}

// ── Configuration ──────────────────────────────────────────────────────────────

const TRIAGE_MAX_TOKENS = parseInt(process.env.TRIAGE_MAX_TOKENS || '256', 10);
const TRIAGE_TEMPERATURE = parseFloat(process.env.TRIAGE_TEMPERATURE || '0.3');
const TRIAGE_TIMEOUT_MS = parseInt(process.env.TRIAGE_TIMEOUT_MS || '15000', 10);

/**
 * Keywords that strongly suggest a background-worthy task.
 * Used as a fast-path before calling the LLM.
 */
const BACKGROUND_KEYWORDS = [
    'search', 'find', 'look up', 'browse', 'open', 'visit',
    'check my email', 'read email', 'send email',
    'generate', 'create a page', 'make a page', 'build a page',
    'analyze image', 'what\'s in this', 'describe this image',
    'transcribe', 'convert to speech', 'read aloud', 'speak',
    'download', 'fetch', 'scrape',
    'book', 'reserve', 'order', 'buy',
    'schedule', 'set reminder', 'set alarm', 'remind me',
    'translate',
];

const RAPID_KEYWORDS = [
    'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening',
    'thanks', 'thank you', 'bye', 'goodbye', 'see you',
    'how are you', 'what\'s up', 'sup',
    'yes', 'no', 'ok', 'okay', 'sure', 'maybe',
    'lol', 'haha', '😊', '👍', '❤️',
];

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Classify the user's message to determine the processing strategy.
 *
 * Uses a two-stage approach:
 *   1. Fast keyword-based heuristic (no LLM call)
 *   2. If uncertain, a quick LLM triage call
 *
 * @param userMessage - The raw user message text
 * @param history - Recent conversation history for context
 * @returns TriageResult with the classification
 */
export async function triageIntent(
    userMessage: string,
    history: ChatMessage[] = [],
): Promise<TriageResult> {
    const msgLower = userMessage.toLowerCase().trim();

    // ── Stage 1: Fast heuristic ────────────────────────────────────────────

    // Check for rapid response signals
    if (msgLower.length < 20) {
        for (const kw of RAPID_KEYWORDS) {
            if (msgLower.includes(kw)) {
                return {
                    category: 'rapid_response',
                    reason: `Short message with casual keyword "${kw}"`,
                    confidence: 0.9,
                };
            }
        }
    }

    // Check for explicit task signals
    let backgroundScore = 0;
    for (const kw of BACKGROUND_KEYWORDS) {
        if (msgLower.includes(kw)) {
            backgroundScore += 1;
        }
    }

    // If strong background signal, classify without LLM
    if (backgroundScore >= 2) {
        const identifiedTools = matchToolsToMessage(msgLower);
        return {
            category: 'background_task',
            reason: `Message contains ${backgroundScore} task-related keywords`,
            confidence: 0.85,
            identifiedTools,
        };
    }

    // ── Stage 2: LLM-based triage ──────────────────────────────────────────

    try {
        const availableSkills = listSkills();
        const result = await callLLMTriage(userMessage, history, availableSkills);
        return result;
    } catch (err) {
        console.error('[Triage] LLM triage failed, defaulting to rapid_response:', err);
        // Fallback: treat as rapid response (blocking loop) to be safe
        return {
            category: 'rapid_response',
            reason: 'Triage LLM call failed, defaulting to blocking loop',
            confidence: 0.3,
        };
    }
}

// ── Internal ───────────────────────────────────────────────────────────────────

/**
 * Match message content to available skill/tool names.
 */
function matchToolsToMessage(msgLower: string): string[] {
    const skills = listSkills();
    const matched: string[] = [];

    // Simple keyword-to-skill mapping
    const skillKeywords: Record<string, string[]> = {
        'search': ['search', 'find', 'look up', 'google'],
        'browser': ['browse', 'open', 'visit', 'website', 'url', 'page'],
        'static_page': ['generate page', 'create page', 'make page', 'dashboard', 'report'],
        'vision': ['image', 'picture', 'photo', 'screenshot', 'see'],
        'voice': ['speak', 'read aloud', 'voice', 'audio', 'tts', 'speech'],
    };

    for (const skill of skills) {
        const keywords = skillKeywords[skill];
        if (keywords) {
            for (const kw of keywords) {
                if (msgLower.includes(kw)) {
                    matched.push(skill);
                    break;
                }
            }
        }
    }

    return matched;
}

/**
 * Call the LLM for intent triage classification.
 */
async function callLLMTriage(
    userMessage: string,
    history: ChatMessage[],
    availableSkills: string[],
): Promise<TriageResult> {
    const systemPrompt = `You are an intent classifier for a WhatsApp AI assistant named Friday.
Given the user's message, classify their intent into exactly one of these categories:

1. "rapid_response" - Casual conversation, greetings, quick questions, chitchat, or simple Q&A that can be answered directly without tools.
2. "background_task" - The user wants to perform an action that requires a tool/skill (search, browse, generate content, analyze images, voice synthesis, etc.). This includes any request that would benefit from running asynchronously.
3. "skill_generation" - The user is asking for something that none of the available skills can handle, and a new skill would need to be created.

Available skills: ${availableSkills.join(', ')}

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "category": "rapid_response" | "background_task" | "skill_generation",
  "reason": "brief explanation",
  "confidence": 0.0-1.0,
  "identifiedTools": ["tool_name"] (optional, only for background_task),
  "skillDescription": "what skill to generate" (optional, only for skill_generation)
}`;

    // Build a minimal context from recent history
    const recentContext = history.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...(recentContext ? [{ role: 'user' as const, content: `Recent conversation:\n${recentContext}\n\nNew message: ${userMessage}` }] : [{ role: 'user' as const, content: userMessage }]),
    ];

    const response = await llmClient.chatCompletion({
        messages,
        temperature: TRIAGE_TEMPERATURE,
        maxTokens: TRIAGE_MAX_TOKENS,
        timeout: TRIAGE_TIMEOUT_MS,
    });

    if (!response.success || !response.content) {
        throw new Error(response.error || 'Empty response from triage LLM');
    }

    // Parse the JSON response
    let parsed: Record<string, unknown>;
    try {
        // Strip markdown code fences if present
        let content = response.content.trim();
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch && jsonMatch[1]) {
            content = jsonMatch[1].trim();
        }
        parsed = JSON.parse(content);
    } catch {
        console.warn('[Triage] Failed to parse LLM triage response:', response.content);
        return {
            category: 'rapid_response',
            reason: 'Failed to parse triage response',
            confidence: 0.3,
        };
    }

    const category = validateCategory(parsed.category as string);
    const reason = typeof parsed.reason === 'string' ? parsed.reason : 'No reason provided';
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
    const identifiedTools = Array.isArray(parsed.identifiedTools) ? parsed.identifiedTools as string[] : undefined;
    const skillDescription = typeof parsed.skillDescription === 'string' ? parsed.skillDescription : undefined;

    return {
        category,
        reason,
        confidence,
        identifiedTools,
        skillDescription,
    };
}

/**
 * Validate and normalize the category string.
 */
function validateCategory(raw: string | undefined): TriageCategory {
    if (raw === 'rapid_response' || raw === 'background_task' || raw === 'skill_generation') {
        return raw;
    }
    // Default to rapid_response for safety
    return 'rapid_response';
}

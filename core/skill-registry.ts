import { randomUUID } from 'crypto';

interface PendingSkillRequest {
    id: string;
    jid: string;
    skillName: string;
    question: string;
    timestamp: number;
    resolve: (answer: string) => void;
    reject: (error: Error) => void;
}

const pendingRequests = new Map<string, PendingSkillRequest>();

/**
 * Register a new pending question for a specific user (JID)
 */
export function registerPendingSkillRequest(jid: string, skillName: string, question: string, resolve: (answer: string) => void, reject: (error: Error) => void): string {
    const id = randomUUID();
    pendingRequests.set(jid, {
        id,
        jid,
        skillName,
        question,
        timestamp: Date.now(),
        resolve,
        reject
    });
    return id;
}

/**
 * Get the pending skill request for a specific user (JID)
 */
export function getPendingSkillRequest(jid: string): PendingSkillRequest | undefined {
    return pendingRequests.get(jid);
}

/**
 * Resolve a pending request and remove it
 */
export function resolvePendingSkillRequest(jid: string, answer: string): boolean {
    const req = pendingRequests.get(jid);
    if (!req) return false;
    
    req.resolve(answer);
    pendingRequests.delete(jid);
    return true;
}

/**
 * Cancel a pending request and remove it
 */
export function cancelPendingSkillRequest(jid: string, reason: string): boolean {
    const req = pendingRequests.get(jid);
    if (!req) return false;
    
    req.reject(new Error(reason));
    pendingRequests.delete(jid);
    return true;
}

#!/usr/bin/env node
/**
 * Clear Old Messages Utility for Friday
 *
 * Clears conversation history (memory.log) for one or more users.
 *
 * Usage:
 *   npm run clear-messages                                                # Interactive prompt
 *   npm run clear-messages -- --user 258501247037630                      # Clear specific user
 *   npm run clear-messages -- --user 258501247037630 --keep 10            # Keep last 10 messages
 *   npm run clear-messages -- --all                                       # Clear all users
 *   npm run clear-messages -- --all --keep 5                              # Keep last 5 for all users
 *
 *   # Or directly with tsx:
 *   npx tsx scripts/clear-messages.ts --user 258501247037630
 *
 * Options:
 *   --user <phone>   Phone/user ID to clear messages for
 *   --all            Clear messages for all users
 *   --keep <n>       Keep the last N messages (default: 0, clears all)
 *   --yes, -y        Skip confirmation prompt
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Configuration
const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';

// Types
interface MemoryEntry {
    timestamp?: string;
    role: string;
    content: string;
}

interface UserInfo {
    phone: string;
    name?: string;
    messageCount: number;
    fileSize: number;
    firstMessage?: string;
    lastMessage?: string;
}

interface ClearResult {
    user: string;
    cleared: boolean;
    removedCount: number;
    keptCount: number;
    error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseArgs(): { user?: string; all: boolean; keep: number; yes: boolean } {
    const args = process.argv.slice(2);
    let user: string | undefined;
    let all = false;
    let keep = 0;
    let yes = false;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--user':
                user = args[++i];
                break;
            case '--all':
                all = true;
                break;
            case '--keep':
                keep = parseInt(args[++i]!, 10);
                if (isNaN(keep) || keep < 0) {
                    console.error('❌ --keep must be a non-negative integer');
                    process.exit(1);
                }
                break;
            case '--yes':
            case '-y':
                yes = true;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
            default:
                console.error(`❌ Unknown argument: ${args[i]}`);
                printHelp();
                process.exit(1);
        }
    }

    return { user, all, keep, yes };
}

function printHelp(): void {
    console.log(`
Friday - Clear Old Messages Utility

Usage:
  clear-messages [--user <phone>] [--all] [--keep <n>] [--yes]

Options:
  --user <phone>   Phone/user ID to clear messages for
  --all            Clear messages for all users
  --keep <n>       Keep the last N messages (default: 0)
  --yes, -y        Skip confirmation prompt
  --help, -h       Show this help message

Examples:
  clear-messages                                    # Interactive selection
  clear-messages --user 258501247037630              # Clear specific user
  clear-messages --user 258501247037630 --keep 10    # Keep last 10 messages
  clear-messages --all --yes                        # Clear all without prompt
`);
}

/**
 * List all user directories in USER_DATA_ROOT
 */
function listUsers(): string[] {
    if (!fs.existsSync(USER_DATA_ROOT)) {
        return [];
    }

    return fs
        .readdirSync(USER_DATA_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
}

/**
 * Load user info including message stats
 */
function getUserInfo(phone: string): UserInfo {
    const memoryPath = path.join(USER_DATA_ROOT, phone, 'memory.log');
    const profilePath = path.join(USER_DATA_ROOT, phone, 'profile.json');

    const info: UserInfo = {
        phone,
        messageCount: 0,
        fileSize: 0,
    };

    // Load profile for name
    if (fs.existsSync(profilePath)) {
        try {
            const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as { name?: string };
            info.name = profile.name;
        } catch {
            // Ignore parse errors
        }
    }

    // Load message stats
    if (fs.existsSync(memoryPath)) {
        const stat = fs.statSync(memoryPath);
        info.fileSize = stat.size;

        try {
            const lines = fs.readFileSync(memoryPath, 'utf8').trim().split('\n').filter(Boolean);
            info.messageCount = lines.length;

            if (lines.length > 0) {
                const first = JSON.parse(lines[0]!) as MemoryEntry;
                info.firstMessage = first.timestamp;
                const last = JSON.parse(lines[lines.length - 1]!) as MemoryEntry;
                info.lastMessage = last.timestamp;
            }
        } catch {
            // Ignore parse errors
        }
    }

    return info;
}

/**
 * Format file size in human-readable form
 */
function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Prompt user for input via readline
 */
function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/**
 * Display user list and prompt for selection
 */
async function selectUser(users: string[]): Promise<string> {
    console.log('\n📋 Available users:\n');
    console.log('  #  | User ID              | Name        | Messages | Size');
    console.log('─'.repeat(70));

    const userInfos = users.map((u) => getUserInfo(u));

    userInfos.forEach((info, idx) => {
        const name = info.name || '-';
        const num = String(idx + 1).padStart(3);
        const phone = info.phone.padEnd(20);
        const nameStr = name.padEnd(12);
        const msgs = String(info.messageCount).padEnd(9);
        const size = formatSize(info.fileSize);
        console.log(`  ${num} | ${phone} | ${nameStr} | ${msgs} | ${size}`);
    });

    console.log();

    const answer = await prompt('Select user number (or "q" to quit): ');

    if (answer.toLowerCase() === 'q') {
        console.log('Cancelled.');
        process.exit(0);
    }

    const index = parseInt(answer, 10) - 1;
    if (isNaN(index) || index < 0 || index >= users.length) {
        console.error('❌ Invalid selection');
        process.exit(1);
    }

    return users[index]!;
}

/**
 * Clear messages for a single user
 */
function clearMessagesForUser(phone: string, keep: number): ClearResult {
    const result: ClearResult = {
        user: phone,
        cleared: false,
        removedCount: 0,
        keptCount: 0,
    };

    const memoryPath = path.join(USER_DATA_ROOT, phone, 'memory.log');

    if (!fs.existsSync(memoryPath)) {
        result.error = 'No memory.log found';
        return result;
    }

    try {
        const lines = fs.readFileSync(memoryPath, 'utf8').trim().split('\n').filter(Boolean);
        const totalMessages = lines.length;

        if (keep > 0 && keep < totalMessages) {
            // Keep last N messages
            const keptLines = lines.slice(-keep);
            fs.writeFileSync(memoryPath, keptLines.join('\n') + '\n');
            result.removedCount = totalMessages - keep;
            result.keptCount = keep;
        } else if (keep >= totalMessages) {
            // Keep count >= total, nothing to remove
            result.removedCount = 0;
            result.keptCount = totalMessages;
            result.error = `Only ${totalMessages} messages exist (less than --keep ${keep})`;
            return result;
        } else {
            // Clear all
            fs.writeFileSync(memoryPath, '');
            result.removedCount = totalMessages;
            result.keptCount = 0;
        }

        result.cleared = true;
    } catch (err) {
        result.error = `Failed to clear: ${err}`;
    }

    return result;
}

/**
 * Display detailed info before clearing
 */
function displayUserInfo(info: UserInfo, keep: number): void {
    console.log(`\n👤 User: ${info.phone}${info.name ? ` (${info.name})` : ''}`);
    console.log(`   Messages: ${info.messageCount}`);
    console.log(`   File size: ${formatSize(info.fileSize)}`);
    if (info.firstMessage) {
        console.log(`   First message: ${info.firstMessage}`);
    }
    if (info.lastMessage) {
        console.log(`   Last message: ${info.lastMessage}`);
    }
    if (keep > 0) {
        console.log(`   Will keep: last ${keep} messages`);
        console.log(`   Will remove: ${Math.max(0, info.messageCount - keep)} messages`);
    } else {
        console.log('   Will remove: ALL messages');
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const { user, all, keep, yes } = parseArgs();

    console.log('🗑️  Friday - Clear Old Messages\n');
    console.log(`User data root: ${USER_DATA_ROOT}`);

    // Get list of users
    const users = listUsers();

    if (users.length === 0) {
        console.log('No users found.');
        process.exit(0);
    }

    // Determine target users
    let targetUsers: string[];

    if (all) {
        targetUsers = users;
        console.log(`\n📋 Targeting ALL ${users.length} user(s)`);
    } else if (user) {
        if (!users.includes(user)) {
            console.error(`❌ User "${user}" not found. Available users: ${users.join(', ')}`);
            process.exit(1);
        }
        targetUsers = [user];
    } else {
        // Interactive selection
        targetUsers = [await selectUser(users)];
    }

    // Display info for all target users
    const targetInfos = targetUsers.map((u) => getUserInfo(u));

    let totalToRemove = 0;
    for (const info of targetInfos) {
        displayUserInfo(info, keep);
        totalToRemove += keep > 0 ? Math.max(0, info.messageCount - keep) : info.messageCount;
    }

    if (totalToRemove === 0) {
        console.log('\n✅ No messages to clear.');
        process.exit(0);
    }

    // Confirm
    if (!yes) {
        const answer = await prompt(`\n⚠️  Remove ${totalToRemove} message(s)? [y/N]: `);
        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('Cancelled.');
            process.exit(0);
        }
    }

    // Clear messages
    console.log('\n🧹 Clearing messages...\n');

    const results: ClearResult[] = [];
    for (const targetUser of targetUsers) {
        const result = clearMessagesForUser(targetUser, keep);
        results.push(result);

        if (result.cleared) {
            const keptStr = result.keptCount > 0 ? ` (kept ${result.keptCount})` : '';
            console.log(`  ✅ ${targetUser}: removed ${result.removedCount} messages${keptStr}`);
        } else if (result.error) {
            console.log(`  ⚠️  ${targetUser}: ${result.error}`);
        }
    }

    // Summary
    const cleared = results.filter((r) => r.cleared);
    const errors = results.filter((r) => r.error);
    console.log('\n── Summary ──');
    console.log(`Users processed: ${results.length}`);
    console.log(`Users cleared: ${cleared.length}`);
    console.log(`Total messages removed: ${cleared.reduce((sum, r) => sum + r.removedCount, 0)}`);
    if (errors.length > 0) {
        console.log(`Warnings/Errors: ${errors.length}`);
    }
    console.log('\nDone.');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});

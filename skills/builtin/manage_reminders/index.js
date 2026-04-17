/**
 * Built-in skill to create, list, update, and delete user reminders.
 * 
 * Each reminder stores:
 * - time: when to trigger (ISO 8601)
 * - message: the user's instruction to replay at the scheduled time
 * - repeat: recurrence pattern (daily/weekly/monthly or null for one-time)
 * 
 * When a reminder fires, the raw `message` is replayed to the agent loop,
 * which decides what skills to call, whether to use voice, etc.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

async function main() {
    let input = '';
    
    if (process.env.PAYLOAD) {
        input = process.env.PAYLOAD;
    } else {
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) {
            input += chunk;
        }
    }

    let payloadData;
    try {
        payloadData = JSON.parse(input || '{}');
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: 'Failed to parse payload: ' + e.message }));
        process.exit(1);
    }

    const user_id = payloadData.user_id || payloadData.userId;
    const params = payloadData.params || {};

    if (!user_id) {
        console.error(JSON.stringify({ success: false, error: 'Missing userId in payload' }));
        process.exit(1);
    }

    const action = params?.action || 'list';

    const USER_DATA_ROOT = process.env.USER_DATA_ROOT || './users';
    const userDir = path.join(USER_DATA_ROOT, String(user_id));
    const reminderPath = path.join(userDir, 'reminders.json');

    try {
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }

        let reminders = [];
        if (fs.existsSync(reminderPath)) {
            const data = fs.readFileSync(reminderPath, 'utf8');
            if (data.trim() !== '') {
                reminders = JSON.parse(data);
            }
        }

        if (action === 'create') {
            if (!params.time || !params.message) {
                console.log(JSON.stringify({ success: false, error: 'Missing required parameters for create: time and message' }));
                process.exit(0);
            }

            const newReminder = {
                id: randomUUID(),
                time: params.time,
                message: params.message,
                repeat: params.repeat || null,
                created_at: new Date().toISOString()
            };

            reminders.push(newReminder);
            fs.writeFileSync(reminderPath, JSON.stringify(reminders, null, 2));

            const response = {
                success: true,
                message: `Reminder set for ${params.time}${params.repeat ? ` (repeating ${params.repeat})` : ''}: "${params.message}"`,
                reminder_id: newReminder.id
            };
            console.log(JSON.stringify(response));

        } else if (action === 'delete') {
            if (!params.reminder_id) {
                console.log(JSON.stringify({ success: false, error: 'Missing required parameter for delete: reminder_id' }));
                process.exit(0);
            }

            const initialLength = reminders.length;
            reminders = reminders.filter(r => r.id !== params.reminder_id);

            if (reminders.length === initialLength) {
                console.log(JSON.stringify({ success: false, message: `No reminder found with ID ${params.reminder_id}` }));
            } else {
                fs.writeFileSync(reminderPath, JSON.stringify(reminders, null, 2));
                console.log(JSON.stringify({ success: true, message: `Reminder deleted.` }));
            }

        } else if (action === 'update') {
            if (!params.reminder_id) {
                console.log(JSON.stringify({ success: false, error: 'Missing required parameter for update: reminder_id. Call "list" first to get the reminder ID.' }));
                process.exit(0);
            }

            const reminderIndex = reminders.findIndex(r => r.id === params.reminder_id);
            if (reminderIndex === -1) {
                console.log(JSON.stringify({ success: false, message: `No reminder found with ID ${params.reminder_id}` }));
                process.exit(0);
            }

            const r = reminders[reminderIndex];
            if (params.time) r.time = params.time;
            if (params.message) r.message = params.message;
            if (params.repeat !== undefined) r.repeat = params.repeat || null;

            fs.writeFileSync(reminderPath, JSON.stringify(reminders, null, 2));
            console.log(JSON.stringify({ success: true, message: `Reminder updated: "${r.message}"`, reminder: r }));

        } else if (action === 'list') {
            if (reminders.length === 0) {
                console.log(JSON.stringify({ success: true, message: "You have no active reminders.", reminders: [] }));
            } else {
                const details = reminders.map(r => {
                    let d = `- ID: ${r.id}, Time: ${r.time}, Repeat: ${r.repeat || 'once'}, Message: "${r.message}"`;
                    return d;
                }).join('\n');
                console.log(JSON.stringify({ success: true, message: `You have ${reminders.length} active reminder(s):\n${details}`, reminders }));
            }
        } else {
            console.log(JSON.stringify({ success: false, error: `Unknown action: ${action}` }));
        }

    } catch (error) {
        console.log(JSON.stringify({ success: false, error: `Failed to manage reminders: ${error.message}` }));
    }
}

main();
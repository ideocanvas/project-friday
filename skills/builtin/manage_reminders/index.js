/**
 * Built-in skill to create, list, and delete user reminders
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
        // Ensure user directory exists
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }

        // Load existing reminders
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

            // Create new reminder object
            const newReminder = {
                id: randomUUID(),
                time: params.time,
                skill: 'noop', // just send the message
                args: {
                    message: params.message
                },
                repeat: params.repeat || null,
                created_at: new Date().toISOString()
            };

            // Add to list and save
            reminders.push(newReminder);
            fs.writeFileSync(reminderPath, JSON.stringify(reminders, null, 2));

            const response = {
                success: true,
                message: `Reminder successfully scheduled for ${params.time}${params.repeat ? ` (repeating ${params.repeat})` : ''}.`,
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
                console.log(JSON.stringify({ success: true, message: `Reminder ${params.reminder_id} successfully deleted.` }));
            }

        } else if (action === 'update') {
            if (!params.reminder_id) {
                console.log(JSON.stringify({ success: false, error: 'Missing required parameter for update: reminder_id' }));
                process.exit(0);
            }

            const reminderIndex = reminders.findIndex(r => r.id === params.reminder_id);
            if (reminderIndex === -1) {
                console.log(JSON.stringify({ success: false, message: `No reminder found with ID ${params.reminder_id}` }));
                process.exit(0);
            }

            const r = reminders[reminderIndex];
            if (params.time) r.time = params.time;
            if (params.message) {
                r.args = r.args || {};
                r.args.message = params.message;
            }
            if (params.repeat !== undefined) r.repeat = params.repeat;

            fs.writeFileSync(reminderPath, JSON.stringify(reminders, null, 2));
            console.log(JSON.stringify({ success: true, message: `Reminder ${params.reminder_id} successfully updated.`, reminder: r }));

        } else if (action === 'list') {
            if (reminders.length === 0) {
                console.log(JSON.stringify({ success: true, message: "You have no active reminders.", reminders: [] }));
            } else {
                const details = reminders.map(r => `- ID: ${r.id}, Time: ${r.time}, Repeat: ${r.repeat || 'none'}, Message: ${r.args?.message || '(none)'}`).join('\n');
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

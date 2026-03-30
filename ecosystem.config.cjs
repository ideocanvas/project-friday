// PM2 Ecosystem Configuration for Project Friday
// Run: pm2 start ecosystem.config.cjs
// Note: Run 'npm run build' first to compile TypeScript

module.exports = {
    apps: [
        // ========================================
        // 1. WhatsApp Gateway
        // ========================================
        {
            name: 'friday-gateway',
            script: './dist/core/gateway.js',
            cwd: './',
            interpreter: 'node',
            node_args: '--experimental-modules',
            env: {
                NODE_ENV: 'production',
                USER_DATA_ROOT: './users',
                WEB_PORTAL_ROOT: './web_portal',
                QUEUE_PATH: './queue',
                AI_PROVIDER: 'lmstudio',
                AI_BASE_URL: 'http://localhost:1234/v1',
                CHAT_MODEL: 'qwen/qwen3.5-35b-a3b'
            },
            // Restart policy
            autorestart: true,
            watch: false,
            max_restarts: 10,
            min_uptime: '10s',
            // Logging
            out_file: './logs/gateway-out.log',
            error_file: './logs/gateway-err.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            // Performance
            max_memory_restart: '500M'
        },

        // ========================================
        // 2. Heartbeat / Scheduler
        // ========================================
        {
            name: 'friday-scheduler',
            script: './dist/core/heartbeat.js',
            cwd: './',
            interpreter: 'node',
            env: {
                NODE_ENV: 'production',
                USER_DATA_ROOT: './users',
                QUEUE_PATH: './queue',
                CHECK_INTERVAL_MS: '60000',
                ARBITER_LOCK_PATH: './temp/gpu_active.lock'
            },
            // Restart policy
            autorestart: true,
            watch: false,
            max_restarts: 10,
            min_uptime: '10s',
            // Logging
            out_file: './logs/scheduler-out.log',
            error_file: './logs/scheduler-err.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            // Performance
            max_memory_restart: '300M'
        },

        // ========================================
        // 3. Web Janitor
        // ========================================
        {
            name: 'friday-janitor',
            script: './dist/core/janitor.js',
            cwd: './',
            interpreter: 'node',
            env: {
                NODE_ENV: 'production',
                WEB_PORTAL_ROOT: './web_portal',
                PAGE_EXPIRY_HOURS: '24'
            },
            // Restart policy
            autorestart: true,
            watch: false,
            max_restarts: 5,
            min_uptime: '5s',
            // Logging
            out_file: './logs/janitor-out.log',
            error_file: './logs/janitor-err.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            // Performance
            max_memory_restart: '200M'
        },

        // ========================================
        // 4. Evolution / Skill Factory
        // ========================================
        {
            name: 'friday-evolution',
            script: './dist/core/evolution.js',
            cwd: './',
            interpreter: 'node',
            env: {
                NODE_ENV: 'production',
                USER_DATA_ROOT: './users',
                QUEUE_PATH: './queue',
                SKILLS_PATH: './skills',
                // Ollama Cloud (local)
                CLOUD_AI_URL: 'http://localhost:11434',
                EVOLUTION_MODEL: 'glm-5:cloud',
                EVOLUTION_MAX_ROUNDS: '10',
                EVOLUTION_ROUND_TIMEOUT_SEC: '60',
                EVOLUTION_TOTAL_TIMEOUT_MIN: '30',
                ARBITER_LOCK_PATH: './temp/gpu_active.lock'
            },
            // Restart policy
            autorestart: true,
            watch: false,
            max_restarts: 5,
            min_uptime: '10s',
            // Logging
            out_file: './logs/evolution-out.log',
            error_file: './logs/evolution-err.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            // Performance - Evolution can use more memory for LLM context
            max_memory_restart: '1G'
        },

        // ========================================
        // 5. Web Server (Static Pages)
        // ========================================
        {
            name: 'friday-web-server',
            script: './dist/core/web-server.js',
            cwd: './',
            interpreter: 'node',
            env: {
                NODE_ENV: 'production',
                WEB_PORTAL_ROOT: './web_portal',
                WEB_SERVER_PORT: '3000',
                WEB_SERVER_HOST: '0.0.0.0'
            },
            // Restart policy
            autorestart: true,
            watch: false,
            max_restarts: 10,
            min_uptime: '5s',
            // Logging
            out_file: './logs/web-server-out.log',
            error_file: './logs/web-server-err.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            // Performance
            max_memory_restart: '200M'
        }
    ]
};
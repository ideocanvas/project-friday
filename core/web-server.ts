/**
 * Friday Web Server - Static Page Server
 *
 * Serves generated static pages from web_portal directory.
 * Designed to work with Cloudflare Tunnel for external access.
 */

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = parseInt(process.env.WEB_SERVER_PORT || '3000', 10);
const WEB_PORTAL_ROOT = process.env.WEB_PORTAL_ROOT || './web_portal';
const HOST = process.env.WEB_SERVER_HOST || '0.0.0.0';

// Create Express app
const app = express();

// Middleware
app.use(express.json());

// Log all requests
app.use((req: Request, res: Response, next: NextFunction) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok',
        service: 'friday-web-server',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Status endpoint for PM2 monitoring
app.get('/status', (_req: Request, res: Response) => {
    const portalPath = path.resolve(WEB_PORTAL_ROOT);
    let totalPages = 0;
    let totalSize = 0;
    
    try {
        const users = fs.readdirSync(portalPath);
        for (const user of users) {
            const userPath = path.join(portalPath, user);
            if (fs.statSync(userPath).isDirectory()) {
                const pages = fs.readdirSync(userPath);
                totalPages += pages.length;
                for (const page of pages) {
                    const pagePath = path.join(userPath, page);
                    if (fs.statSync(pagePath).isDirectory()) {
                        totalSize += getDirectorySize(pagePath);
                    }
                }
            }
        }
    } catch (error) {
        // Directory might not exist yet
    }
    
    res.json({
        status: 'running',
        portal_path: portalPath,
        total_pages: totalPages,
        total_size_bytes: totalSize,
        uptime_seconds: Math.floor(process.uptime())
    });
});

// Serve static files from web_portal
// URL pattern: /portal/{user_id}/{page_hash}/
app.use('/portal', express.static(WEB_PORTAL_ROOT, {
    index: ['index.html'],
    dotfiles: 'deny',
    maxAge: '1h'
}));

// Fallback for portal URLs - redirect to index.html if directory
app.get('/portal/:userId/:pageHash', (req: Request, res: Response) => {
    const userId = req.params.userId || '';
    const pageHash = req.params.pageHash || '';
    const indexPath = path.join(WEB_PORTAL_ROOT, userId, pageHash, 'index.html');
    
    if (fs.existsSync(indexPath)) {
        res.sendFile(path.resolve(indexPath));
    } else {
        res.status(404).json({
            error: 'Page not found',
            user_id: userId,
            page_hash: pageHash
        });
    }
});

// Root endpoint
app.get('/', (_req: Request, res: Response) => {
    res.json({
        name: 'Friday Web Server',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            status: '/status',
            portal: '/portal/{user_id}/{page_hash}/'
        }
    });
});

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Error:', err.message);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

/**
 * Calculate total size of a directory
 */
function getDirectorySize(dirPath: string): number {
    let size = 0;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
            size += getDirectorySize(filePath);
        } else {
            size += stats.size;
        }
    }
    return size;
}

// Start server
const server = app.listen(PORT, HOST, () => {
    console.log(`Friday Web Server started`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Host: ${HOST}`);
    console.log(`  Portal: ${path.resolve(WEB_PORTAL_ROOT)}`);
    console.log(`  Health: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

export { app, server };
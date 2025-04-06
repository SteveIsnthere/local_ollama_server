'use strict';

import express from 'express';
import path from 'path';
import {fileURLToPath} from 'url'; // Needed for __dirname equivalent in ES Modules
import * as config from './config.js'; // Use .js extension
import OllamaServer from './lib/ollamaServer.js'; // Use .js extension
import apiRoutes from './routes/api.js'; // Use .js extension
import systemRoutes from './routes/system.js'; // Use .js extension
import webRoutes from './routes/web.js'; // Use .js extension

// Get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Ollama Server
const ollamaServer = OllamaServer.getInstance({
    defaultModel: config.DEFAULT_MODEL,
    keepAliveDuration: '10m'
    // Add any other specific config overrides here
});

// Initialize Express
const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files

// Set up event listeners for logging
ollamaServer.on('task:start', (data) => console.log(`EVENT task:start - Model: ${data.modelName}, Size: ${data.modelSize.toFixed(2)}GB, Active VRAM: ${data.currentActiveVRAMUsage.toFixed(2)}GB`));
ollamaServer.on('task:complete', (data) => console.log(`EVENT task:complete - Model: ${data.modelName}, Active VRAM: ${data.currentActiveVRAMUsage.toFixed(2)}GB`));
ollamaServer.on('task:queued', (data) => console.log(`EVENT task:queued - Model: ${data.modelName}, Size: ${data.modelSize.toFixed(2)}GB, Reason: ${data.reason}`));
ollamaServer.on('model:used', (data) => console.log(`EVENT model:used - Model: ${data.modelName}, Active Tasks: ${data.activeTaskCount}`));
ollamaServer.on('model:loaded', (data) => console.log(`EVENT model:loaded - Model: ${data.modelName}, Size: ${data.modelSize.toFixed(2)}GB`));
ollamaServer.on('model:unloaded', (data) => console.log(`EVENT model:unloaded - Model: ${data.modelName}`));
ollamaServer.on('model:taskComplete', (data) => console.log(`EVENT model:taskComplete - Model: ${data.modelName}, Active Tasks: ${data.activeTaskCount}`));
ollamaServer.on('vram:updated', (data) => console.log(`EVENT vram:updated - GPU VRAM Usage: ${data.vram.used.toFixed(2)}/${data.vram.total.toFixed(2)} GB, Loaded Models: ${data.loadedModels}, Game Mode: ${data.gameMode ? 'Active' : 'Inactive'}`));
ollamaServer.on('retry:attempt', (data) => console.log(`EVENT retry:attempt - Model: ${data.modelName}, Attempt: ${data.attempt + 1}/${data.maxRetries}`));
ollamaServer.on('retry:failed', (data) => console.warn(`EVENT retry:failed - Model: ${data.modelName}, Attempt: ${data.attempt + 1}, Error: ${data.error.message}`));

app.use('/dashboard', webRoutes);        // Web dashboard
app.use('/', apiRoutes);     // API endpoints
app.use('/system', systemRoutes); // System management endpoints

// Graceful shutdown handler
const signals = {
    'SIGHUP': 1,
    'SIGINT': 2,
    'SIGTERM': 15
};


const shutdown = (signal, value) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);

    // Clear VRAM monitoring interval
    if (ollamaServer.vramMonitorInterval) {
        clearInterval(ollamaServer.vramMonitorInterval);
    }

    if (serverInstance) {
        serverInstance.close(() => {
            console.log('HTTP server closed.');
            process.exit(128 + value);
        });
    } else {
        process.exit(128 + value);
    }
};

Object.keys(signals).forEach((signal) => {
    process.on(signal, () => {
        shutdown(signal, signals[signal]);
    });
});

// Start server
const serverInstance = app.listen(config.PORT, () => { // Assign to serverInstance
    console.log(`Enhanced Ollama server running on port ${config.PORT}`);
    console.log(`Web dashboard available at http://localhost:${config.PORT}`);
    console.log(`Default model: ${config.DEFAULT_MODEL}`);
    console.log(`VRAM monitoring enabled (${ollamaServer.config.vramMonitorIntervalMs / 1000}s interval)`);
});

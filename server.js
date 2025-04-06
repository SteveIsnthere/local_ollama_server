'use strict';

import express from 'express';
import ollama from 'ollama';
import EventEmitter from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ----- VRAM Configuration -----
const VRAM_GB = 16;
const RESERVED_VRAM = 3.5;
const AVAILABLE_VRAM = VRAM_GB - RESERVED_VRAM;
const MODEL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes in milliseconds

/**
 * Get real NVIDIA GPU VRAM usage using nvidia-smi
 * @returns {Promise<{total: number, used: number, free: number}>} VRAM in GB
 */
async function getNvidiaVRAMUsage() {
    try {
        // Query total VRAM
        const { stdout: totalOutput } = await execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits');
        const totalVRAM = parseInt(totalOutput.trim()) / 1024; // Convert MB to GB

        // Query used VRAM
        const { stdout: usedOutput } = await execAsync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits');
        const usedVRAM = parseInt(usedOutput.trim()) / 1024; // Convert MB to GB

        return {
            total: totalVRAM,
            used: usedVRAM,
            free: totalVRAM - usedVRAM
        };
    } catch (error) {
        console.warn("Could not get NVIDIA GPU metrics:", error.message);
        // Return default values if nvidia-smi fails
        return { total: VRAM_GB, used: RESERVED_VRAM, free: AVAILABLE_VRAM };
    }
}

/**
 * Get currently loaded models via ollama.ps()
 * @returns {Promise<Array<{name: string, size: number}>>} Loaded models
 */
async function getLoadedModels() {
    try {
        const response = await ollama.ps();

        // FIX: Use models property instead of processes
        if (!response.models) {
            console.log("Unexpected ollama.ps() response format:", response);
            return [];
        }

        return response.models.map(model => ({
            name: model.name,
            running: true, // Assume all models returned by ps() are running
            size: model.size_vram ? model.size_vram / (1024 * 1024 * 1024) : undefined, // Convert to GB
            expires: model.expires_at ? new Date(model.expires_at) : undefined
        }));
    } catch (error) {
        console.error("Failed to get loaded models:", error);
        return [];
    }
}

/**
 * Model size caching and retrieval
 */
const modelSizeCache = new Map();
async function getModelSize(modelName) {
    if (!modelName) return 0;
    if (modelSizeCache.has(modelName)) {
        return modelSizeCache.get(modelName);
    }

    try {
        console.log(`Fetching size for model: ${modelName}`);
        const list = await ollama.list();
        const modelInfo = list.models.find(
            (m) => m.name === modelName || m.model === modelName
        );

        let sizeGb = 1; // Default size
        if (modelInfo?.size) {
            sizeGb = modelInfo.size / (1024 * 1024 * 1024);
        } else {
            console.warn(`Model ${modelName} not found or size missing. Defaulting to 1GB.`);
        }

        modelSizeCache.set(modelName, sizeGb);
        console.log(`Model ${modelName} size: ${sizeGb.toFixed(2)} GB`);
        return sizeGb;
    } catch (error) {
        console.error(`Error fetching model size for ${modelName}:`, error);
        modelSizeCache.set(modelName, 1);
        return 1;
    }
}

/**
 * Enhanced OllamaServer class with improved VRAM monitoring
 */
class OllamaServer extends EventEmitter {
    static instance;
    config;

    // VRAM tracking
    currentActiveVRAMUsage = 0;
    taskQueue = [];
    DEFAULT_MODEL = 'gemma3:1b';

    // Enhanced model tracking (for our own management)
    loadedModels = new Map(); // modelName -> {size, lastUsed, activeTaskCount}

    // VRAM monitoring
    vramMonitorInterval = null;
    actualVRAMUsage = { total: VRAM_GB, used: 0, free: AVAILABLE_VRAM };

    constructor(options = {}) {
        super();
        this.config = {
            defaultModel: options.defaultModel || this.DEFAULT_MODEL,
            connectionTimeoutMs: options.connectionTimeoutMs || 1200000,
            generationTimeoutMs: options.generationTimeoutMs || 0,
            maxRetries: options.maxRetries || 3,
            retryDelayMs: options.retryDelayMs || 1000,
            keepAliveDuration: options.keepAliveDuration || '10m', // Ollama format
            vramMonitorIntervalMs: options.vramMonitorIntervalMs || 10000, // Check VRAM every 10 seconds
        };

        // Start VRAM monitoring
        this.startVRAMMonitoring();

        console.log('OllamaServer configured with:', this.config);
    }

    /**
     * Start monitoring NVIDIA VRAM usage and loaded models
     */
    startVRAMMonitoring() {
        if (this.vramMonitorInterval) {
            clearInterval(this.vramMonitorInterval);
        }

        this.vramMonitorInterval = setInterval(async () => {
            try {
                // Get real VRAM usage
                this.actualVRAMUsage = await getNvidiaVRAMUsage();

                // Get loaded models from Ollama
                const loadedModels = await getLoadedModels();

                // Update our model tracking
                this.syncLoadedModels(loadedModels);

                this.emit('vram:updated', {
                    vram: this.actualVRAMUsage,
                    loadedModels: loadedModels.length
                });
            } catch (error) {
                console.error("VRAM monitoring error:", error);
            }
        }, this.config.vramMonitorIntervalMs);

        // Don't keep Node.js running just for this interval
        if (this.vramMonitorInterval.unref) {
            this.vramMonitorInterval.unref();
        }
    }

    /**
     * Sync our model tracking with actual loaded models from Ollama
     */
    async syncLoadedModels(loadedModels) {
        // Create map of currently loaded models from Ollama
        const ollamaModels = new Map();
        for (const model of loadedModels) {
            ollamaModels.set(model.name, model);
        }

        // Update our tracking of loaded models
        for (const [modelName, modelInfo] of this.loadedModels.entries()) {
            if (!ollamaModels.has(modelName) && modelInfo.activeTaskCount === 0) {
                // Model is no longer loaded in Ollama and has no active tasks
                this.loadedModels.delete(modelName);
                this.emit('model:unloaded', { modelName });
            }
        }

        // Add any models Ollama has loaded that we're not tracking
        for (const [modelName, modelInfo] of ollamaModels.entries()) {
            if (!this.loadedModels.has(modelName)) {
                const modelSize = modelInfo.size || await getModelSize(modelName);
                this.loadedModels.set(modelName, {
                    size: modelSize,
                    lastUsed: Date.now(),
                    activeTaskCount: 0,
                    expires: modelInfo.expires
                });
                this.emit('model:loaded', { modelName, modelSize });
            }
        }
    }

    static getInstance(options) {
        if (!OllamaServer.instance) {
            OllamaServer.instance = new OllamaServer(options);
        } else if (options) {
            OllamaServer.instance.updateConfig(options);
        }
        return OllamaServer.instance;
    }

    updateConfig(options) {
        Object.assign(this.config, options);

        // Update VRAM monitoring interval if needed
        if (options.vramMonitorIntervalMs && this.vramMonitorInterval) {
            this.startVRAMMonitoring();
        }

        console.log('OllamaServer config updated:', this.config);
        return this;
    }

    /**
     * Track when model is used
     */
    trackModelUsage(modelName, modelSize) {
        if (!modelName) return;

        // Get current model info or create new entry
        let modelInfo = this.loadedModels.get(modelName) || {
            size: modelSize,
            lastUsed: Date.now(),
            activeTaskCount: 0
        };

        // Update usage time and increment active task count
        modelInfo.lastUsed = Date.now();
        modelInfo.activeTaskCount++;

        // Store updated info
        this.loadedModels.set(modelName, modelInfo);

        this.emit('model:used', {
            modelName,
            modelSize,
            activeTaskCount: modelInfo.activeTaskCount
        });
    }

    /**
     * Mark model task as completed
     */
    completeModelTask(modelName) {
        if (!modelName || !this.loadedModels.has(modelName)) return;

        const modelInfo = this.loadedModels.get(modelName);
        modelInfo.activeTaskCount = Math.max(0, modelInfo.activeTaskCount - 1);
        modelInfo.lastUsed = Date.now();

        this.loadedModels.set(modelName, modelInfo);

        this.emit('model:taskComplete', {
            modelName,
            activeTaskCount: modelInfo.activeTaskCount
        });
    }

    /**
     * Improved enqueue method with parallel execution optimization
     */
    async enqueue(task, modelName) {
        const effectiveModelName = modelName || this.config.defaultModel;
        const modelSize = await getModelSize(effectiveModelName);

        return new Promise((resolve, reject) => {
            const runTask = async () => {
                // Update model tracking & VRAM usage
                this.trackModelUsage(effectiveModelName, modelSize);
                this.currentActiveVRAMUsage += modelSize;

                this.emit('task:start', {
                    modelName: effectiveModelName,
                    modelSize,
                    currentActiveVRAMUsage: this.currentActiveVRAMUsage,
                    actualVRAMUsage: this.actualVRAMUsage
                });

                console.log(`[${effectiveModelName}] Task starting. Our tracked VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${AVAILABLE_VRAM.toFixed(2)} GB, Actual GPU VRAM: ${this.actualVRAMUsage.used.toFixed(2)}/${this.actualVRAMUsage.total.toFixed(2)} GB`);

                try {
                    // Execute the actual Ollama operation
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    console.error(`[${effectiveModelName}] Task failed:`, error);
                    reject(error);
                } finally {
                    // Update tracking & free VRAM
                    this.completeModelTask(effectiveModelName);
                    this.currentActiveVRAMUsage -= modelSize;

                    this.emit('task:complete', {
                        modelName: effectiveModelName,
                        modelSize,
                        currentActiveVRAMUsage: this.currentActiveVRAMUsage,
                    });

                    console.log(`[${effectiveModelName}] Task finished. Our tracked VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${AVAILABLE_VRAM.toFixed(2)} GB`);

                    // Process more tasks from queue
                    this.processQueue();
                }
            };

            // Check if we have VRAM available
            if (this.currentActiveVRAMUsage + modelSize <= AVAILABLE_VRAM) {
                console.log(`[${effectiveModelName}] Sufficient VRAM (${(AVAILABLE_VRAM - this.currentActiveVRAMUsage).toFixed(2)} GB free). Running immediately.`);
                runTask();
                return;
            }

            // If we get here, we need to queue the task
            console.log(`[${effectiveModelName}] Insufficient VRAM (${(AVAILABLE_VRAM - this.currentActiveVRAMUsage).toFixed(2)} GB free, needs ${modelSize.toFixed(2)} GB). Queuing task.`);
            this.taskQueue.push({ runTask, modelSize, modelName: effectiveModelName });
            this.emit('task:queued', {
                modelName: effectiveModelName,
                modelSize,
                reason: 'VRAM insufficient'
            });
        });
    }

    /**
     * Optimized queue processing to maximize parallel execution
     */
    processQueue() {
        if (this.taskQueue.length === 0) return;

        console.log(`Processing queue. ${this.taskQueue.length} tasks waiting. Active VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${AVAILABLE_VRAM.toFixed(2)} GB`);

        // Sort tasks by size (smallest first) to maximize parallel execution
        this.taskQueue.sort((a, b) => a.modelSize - b.modelSize);

        // Track how many tasks we started in this cycle
        let tasksStarted = 0;

        // Try to run as many tasks as possible in parallel
        const availableVRAM = AVAILABLE_VRAM - this.currentActiveVRAMUsage;
        const remainingTasks = [...this.taskQueue]; // Create a copy since we'll be modifying the original
        this.taskQueue = []; // Clear the queue

        // First-fit decreasing bin packing algorithm (optimized for parallel execution)
        for (const task of remainingTasks) {
            if (task.modelSize <= availableVRAM - this.currentActiveVRAMUsage) {
                // There's enough VRAM for this task, run it immediately
                this.currentActiveVRAMUsage += task.modelSize; // Reserve VRAM before running
                task.runTask();
                tasksStarted++;
            } else {
                // Not enough VRAM, put it back in the queue
                this.taskQueue.push(task);
            }
        }

        console.log(`Queue processing finished. Started ${tasksStarted} tasks. ${this.taskQueue.length} tasks still waiting.`);
    }

    /**
     * Retry mechanism with timeout
     */
    async retryWithTimeout(operation, modelName = 'unknown') {
        const { maxRetries, retryDelayMs, connectionTimeoutMs } = this.config;
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                this.emit('retry:attempt', { modelName, attempt, maxRetries });
                console.log(`[${modelName}] Operation attempt ${attempt + 1}/${maxRetries}`);

                const timeoutPromise = new Promise((_, reject) => {
                    const timer = setTimeout(() =>
                            reject(new Error(`[${modelName}] Operation timed out after ${connectionTimeoutMs}ms`)),
                        connectionTimeoutMs
                    );
                    if (timer.unref) timer.unref();
                });

                return await Promise.race([operation(), timeoutPromise]);
            } catch (error) {
                lastError = error;
                this.emit('retry:failed', { modelName, attempt, error: lastError });
                console.warn(`[${modelName}] Attempt ${attempt + 1} failed: ${error.message}`);

                if (attempt < maxRetries - 1) {
                    console.log(`[${modelName}] Retrying in ${retryDelayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                }
            }
        }

        console.error(`[${modelName}] Operation failed after ${maxRetries} attempts.`);
        throw lastError;
    }

    cleanThinkSection(content) {
        if (!content) return '';
        return content.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
    }
}

// ----- Initialize Server Singleton -----
const ollamaServer = OllamaServer.getInstance();

// ----- Add Event Listeners for Logging -----
ollamaServer.on('task:start', (data) => console.log(`EVENT task:start - Model: ${data.modelName}, Size: ${data.modelSize.toFixed(2)}GB, Active VRAM: ${data.currentActiveVRAMUsage.toFixed(2)}GB`));
ollamaServer.on('task:complete', (data) => console.log(`EVENT task:complete - Model: ${data.modelName}, Active VRAM: ${data.currentActiveVRAMUsage.toFixed(2)}GB`));
ollamaServer.on('task:queued', (data) => console.log(`EVENT task:queued - Model: ${data.modelName}, Size: ${data.modelSize.toFixed(2)}GB, Reason: ${data.reason}`));
ollamaServer.on('model:used', (data) => console.log(`EVENT model:used - Model: ${data.modelName}, Active Tasks: ${data.activeTaskCount}`));
ollamaServer.on('model:loaded', (data) => console.log(`EVENT model:loaded - Model: ${data.modelName}, Size: ${data.modelSize.toFixed(2)}GB`));
ollamaServer.on('model:unloaded', (data) => console.log(`EVENT model:unloaded - Model: ${data.modelName}`));
ollamaServer.on('model:taskComplete', (data) => console.log(`EVENT model:taskComplete - Model: ${data.modelName}, Active Tasks: ${data.activeTaskCount}`));
ollamaServer.on('vram:updated', (data) => console.log(`EVENT vram:updated - GPU VRAM Usage: ${data.vram.used.toFixed(2)}/${data.vram.total.toFixed(2)} GB, Loaded Models: ${data.loadedModels}`));
ollamaServer.on('retry:attempt', (data) => console.log(`EVENT retry:attempt - Model: ${data.modelName}, Attempt: ${data.attempt + 1}/${data.maxRetries}`));
ollamaServer.on('retry:failed', (data) => console.warn(`EVENT retry:failed - Model: ${data.modelName}, Attempt: ${data.attempt + 1}, Error: ${data.error.message}`));

// ----- Functions to interact with Ollama -----

// Non-streaming chat
async function chatWithOllama(messages, options = {}) {
    const model = options.model || ollamaServer.config.defaultModel;
    const processedMessages = options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
        : messages;

    return ollamaServer.enqueue(async () => {
        console.log(`Executing chat request for model: ${model}`);
        try {
            const response = await ollamaServer.retryWithTimeout(async () => {
                return await ollama.chat({
                    model: model,
                    messages: processedMessages,
                    keep_alive: ollamaServer.config.keepAliveDuration,
                    format: options.format,
                    options: {
                        ...(options.llmOptions || {})
                    }
                });
            }, model);

            let content = response?.message?.content || '';
            if (options.format === 'json') {
                try {
                    return JSON.parse(content);
                } catch (e) {
                    console.warn(`[${model}] Failed to parse JSON response. Error: ${e.message}`);
                    return ollamaServer.cleanThinkSection(content);
                }
            }
            return ollamaServer.cleanThinkSection(content);
        } catch (error) {
            console.error(`Error during chatWithOllama for ${model}:`, error);
            const errorMessage = error instanceof Error
                ? `${error.message}. Model: ${model}. Try 'ollama pull ${model}' or check Ollama server.`
                : `Failed request for ${model}. Is Ollama running? Try 'ollama pull ${model}'.`;
            throw new Error(errorMessage);
        }
    }, model);
}

// Non-streaming completion
async function completeWithOllama(prompt, options = {}) {
    return chatWithOllama([{ role: 'user', content: prompt }], options);
}

// List available models
async function listOllamaModels() {
    return ollamaServer.enqueue(async () => {
        console.log('Executing list models request');
        try {
            const response = await ollamaServer.retryWithTimeout(async () => {
                return await ollama.list();
            }, 'list-models');
            return response.models.map((model) => model.name);
        } catch (error) {
            console.error('Error listing Ollama models:', error);
            throw new Error('Failed to list models. Is Ollama running?');
        }
    }, null);
}

// Streaming chat
async function streamWithOllama(messages, options = {}, onToken) {
    const model = options.model || ollamaServer.config.defaultModel;
    const processedMessages = options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
        : messages;

    return ollamaServer.enqueue(async () => {
        console.log(`Executing streaming chat request for model: ${model}`);
        try {
            const stream = await ollamaServer.retryWithTimeout(async () => {
                return await ollama.chat({
                    model: model,
                    messages: processedMessages,
                    stream: true,
                    keep_alive: ollamaServer.config.keepAliveDuration,
                    options: {
                        ...(options.llmOptions || {})
                    }
                });
            }, model);

            for await (const chunk of stream) {
                if (chunk?.message?.content) {
                    const token = ollamaServer.cleanThinkSection(chunk.message.content);
                    if (token) onToken(token);
                }
                if (chunk?.error) {
                    console.error(`[${model}] Error in stream:`, chunk.error);
                    throw new Error(`Stream error for ${model}: ${chunk.error}`);
                }
            }
            console.log(`[${model}] Stream finished.`);
        } catch (error) {
            console.error(`Error streaming with ${model}:`, error);
            throw error;
        }
    }, model);
}

// ----- Express Server Setup -----
const app = express();
const port = process.env.PORT || 10086;

// Middleware
app.use(express.json());

// Chat endpoint
app.post('/chat', async (req, res) => {
    try {
        const { messages, options } = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: '`messages` must be a non-empty array.' });
        }
        console.log(`Received /chat request for model: ${options?.model || 'default'}`);
        const response = await chatWithOllama(messages, options);
        res.json({ response });
    } catch (error) {
        console.error('Error in /chat endpoint:', error.message);
        res.status(500).json({ error: error.message || 'An internal server error occurred' });
    }
});

// Completion endpoint
app.post('/complete', async (req, res) => {
    try {
        const { prompt, options } = req.body;
        if (typeof prompt !== 'string' || prompt.trim() === '') {
            return res.status(400).json({ error: '`prompt` must be a non-empty string.' });
        }
        console.log(`Received /complete request for model: ${options?.model || 'default'}`);
        const response = await completeWithOllama(prompt, options);
        res.json({ response });
    } catch (error) {
        console.error('Error in /complete endpoint:', error.message);
        res.status(500).json({ error: error.message || 'An internal server error occurred' });
    }
});

// Models endpoint
app.get('/models', async (req, res) => {
    try {
        console.log('Received /models request');
        const models = await listOllamaModels();
        res.json({ models });
    } catch (error) {
        console.error('Error in /models endpoint:', error.message);
        res.status(500).json({ error: error.message || 'An internal server error occurred' });
    }
});

// Streaming chat endpoint
app.post('/chat-stream', async (req, res) => {
    try {
        const { messages, options } = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: '`messages` must be a non-empty array.' });
        }
        console.log(`Received /chat-stream request for model: ${options?.model || 'default'}`);

        // Set SSE headers
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();

        // Create token handler
        const sendToken = (token) => {
            const formattedToken = JSON.stringify(token);
            res.write(`data: ${formattedToken}\n\n`);
            if (res.flush) res.flush();
        };

        // Stream the response
        await streamWithOllama(messages, options, sendToken);

        // Finish stream
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('Error in /chat-stream endpoint:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'An internal server error occurred during stream setup' });
        } else {
            try {
                const errorMessage = JSON.stringify({ error: error.message || 'An error occurred during streaming' });
                res.write(`event: error\ndata: ${errorMessage}\n\n`);
            } catch (writeError) {
                console.error("Failed to write error to stream:", writeError);
            } finally {
                res.end();
            }
        }
    }
});

// System status endpoint with enhanced GPU metrics
app.get('/system-status', async (req, res) => {
    try {
        // Get real-time GPU VRAM data
        const vramData = await getNvidiaVRAMUsage();

        // Get currently loaded models from Ollama
        const runningModels = await getLoadedModels();

        // Get detailed model information from our tracking
        const loadedModelInfo = Array.from(ollamaServer.loadedModels.entries()).map(([name, info]) => ({
            name,
            size: `${info.size.toFixed(2)} GB`,
            lastUsed: new Date(info.lastUsed).toISOString(),
            activeTasks: info.activeTaskCount,
            expires: info.expires ? new Date(info.expires).toISOString() : null
        }));

        // Calculate VRAM information
        const vramInfo = {
            total: vramData.total,
            used: vramData.used,
            free: vramData.free,

            // Our tracking (for comparison)
            tracked: {
                active: ollamaServer.currentActiveVRAMUsage,
                available: AVAILABLE_VRAM,
                reserved: RESERVED_VRAM
            }
        };

        // Queue information
        const queueInfo = {
            length: ollamaServer.taskQueue.length,
            models: ollamaServer.taskQueue.map(task => task.modelName)
        };

        res.json({
            vram: vramInfo,
            models: loadedModelInfo,
            ollamaModels: runningModels,
            queue: queueInfo
        });
    } catch (error) {
        console.error('Error in /system-status endpoint:', error);
        res.status(500).json({ error: 'Failed to get system status' });
    }
});

// Graceful shutdown handler
const signals = {
    'SIGHUP': 1,
    'SIGINT': 2,
    'SIGTERM': 15
};

let serverInstance;

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

// Debug endpoint to inspect Ollama PS output
app.get('/debug/ollama-ps', async (req, res) => {
    try {
        const response = await ollama.ps();
        res.json(response);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
serverInstance = app.listen(port, () => {
    console.log(`Enhanced Ollama server running on port ${port}`);
    console.log(`Default model: ${ollamaServer.config.defaultModel}`);
    console.log(`Model keep-alive duration: ${ollamaServer.config.keepAliveDuration}`);
    console.log(`VRAM monitoring enabled (${ollamaServer.config.vramMonitorIntervalMs/1000}s interval)`);
});
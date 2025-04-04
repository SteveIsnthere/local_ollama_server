'use strict';

import express from 'express';
import ollama from 'ollama';
import EventEmitter from 'events';

// ----- VRAM Configuration -----
// Total available VRAM (in GB) and reserved VRAM for system overhead.
const VRAM_GB = 16;
const RESERVED_VRAM = 3.5; // GB reserved for system/other tasks

/**
 * Retrieves the size of a given model (in GB) by calling ollama.list().
 * If the model is not found, defaults to 1GB.
 *
 * @param {string} modelName - The name of the model.
 * @returns {Promise<number>} - The model size in GB.
 */
async function getModelSize(modelName) {
    if (!modelName) return 0;
    try {
        const list = await ollama.list();
        // Find a matching model by checking both `name` and `model` fields.
        const modelInfo = list.models.find(
            (m) => m.name === modelName || m.model === modelName
        );
        if (!modelInfo || !modelInfo.size) return 1;
        // Convert bytes to GB.
        return modelInfo.size / (1024 * 1024 * 1024);
    } catch (error) {
        // If the call fails, default to 1GB.
        return 1;
    }
}

// ----- OllamaServer Class -----
class OllamaServer extends EventEmitter {
    static instance;
    config;
    // For tracking currently running tasks’ VRAM usage (in GB)
    currentVRAMUsage = 0;
    // FIFO queue for tasks waiting for available VRAM
    taskQueue = [];
    DEFAULT_MODEL = 'gemma3:1b';

    constructor(options = {}) {
        super();
        this.config = {
            defaultModel: options.defaultModel || this.DEFAULT_MODEL,
            connectionTimeoutMs: options.connectionTimeoutMs || 1200000,
            generationTimeoutMs: options.generationTimeoutMs || 0,
            maxRetries: options.maxRetries || 3,
            retryDelayMs: options.retryDelayMs || 1000,
            keepAlive: options.keepAlive || 5,
        };
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
        return this;
    }

    /**
     * Enqueues a task with a given model name. The task will run immediately if:
     *   currentVRAMUsage + modelSize <= (VRAM_GB - RESERVED_VRAM)
     * Otherwise, the task is queued until enough VRAM is available.
     *
     * @param {Function} task - The async task to run.
     * @param {string} modelName - The model associated with the task.
     * @returns {Promise<any>}
     */
    async enqueue(task, modelName) {
        // Retrieve the model size dynamically.
        const modelSize = modelName ? await getModelSize(modelName) : 0;

        return new Promise((resolve, reject) => {
            const runTask = async () => {
                // Increase current VRAM usage.
                this.currentVRAMUsage += modelSize;
                this.emit('task:start', {
                    modelName,
                    modelSize,
                    currentVRAMUsage: this.currentVRAMUsage,
                });
                try {
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    // Free up VRAM and process any queued tasks.
                    this.currentVRAMUsage -= modelSize;
                    this.emit('task:complete', {
                        modelName,
                        modelSize,
                        currentVRAMUsage: this.currentVRAMUsage,
                    });
                    this.processQueue();
                }
            };

            if (this.currentVRAMUsage + modelSize <= VRAM_GB - RESERVED_VRAM) {
                // Enough VRAM available; run immediately.
                runTask();
            } else {
                // Not enough VRAM; queue the task.
                this.taskQueue.push({ runTask, modelSize, modelName });
                this.emit('task:queued', { modelName, modelSize });
            }
        });
    }

    /**
     * Checks the taskQueue and runs tasks if there is enough available VRAM.
     */
    processQueue() {
        for (let i = 0; i < this.taskQueue.length; i++) {
            const { runTask, modelSize, modelName } = this.taskQueue[i];
            if (this.currentVRAMUsage + modelSize <= VRAM_GB - RESERVED_VRAM) {
                // Remove task from the queue and run it.
                this.taskQueue.splice(i, 1);
                runTask();
                i--; // Adjust index after removal.
            }
        }
    }

    async retryWithTimeout(operation) {
        const { maxRetries, retryDelayMs, connectionTimeoutMs } = this.config;
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                this.emit('retry:attempt', { attempt, maxRetries });
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Connection timeout')), connectionTimeoutMs);
                });
                return await Promise.race([operation(), timeoutPromise]);
            } catch (error) {
                lastError = error;
                this.emit('retry:failed', { attempt, error: lastError });
                if (attempt < maxRetries - 1) {
                    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                }
            }
        }
        throw lastError;
    }

    cleanThinkSection(content) {
        return content.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
    }
}

const ollamaServer = OllamaServer.getInstance();

// ----- Functions to interact with Ollama -----
// Non-streaming chat.
async function chatWithOllama(messages, options) {
    options = options || {};
    const model = options.model || ollamaServer.config.defaultModel;
    const processedMessages = options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
        : messages;

    return ollamaServer.enqueue(async () => {
        try {
            const response = await ollamaServer.retryWithTimeout(async () => {
                return await ollama.chat({
                    model: model,
                    messages: processedMessages,
                    keep_alive: ollamaServer.config.keepAlive,
                    format: options.format,
                });
            });
            if (options.format) {
                try {
                    return JSON.parse(response.message.content);
                } catch (e) {
                    return response.message.content;
                }
            }
            return ollamaServer.cleanThinkSection(response.message.content);
        } catch (error) {
            const errorMessage =
                error instanceof Error
                    ? `${error.message}. Try: ollama pull ${model}`
                    : `Failed to connect to Ollama server. Is it running? Try: ollama pull ${model}`;
            throw new Error(errorMessage);
        }
    }, model);
}

// Non-streaming completion.
async function completeWithOllama(prompt, options) {
    return chatWithOllama([{ role: 'user', content: prompt }], options);
}

// List available models (uses a negligible VRAM cost).
async function listOllamaModels() {
    return ollamaServer.enqueue(async () => {
        try {
            const response = await ollamaServer.retryWithTimeout(async () => {
                return await ollama.list();
            });
            return response.models.map((model) => model.name);
        } catch (error) {
            throw new Error('Failed to list models. Is Ollama running?');
        }
    }, null);
}

// Streaming chat with Ollama.
async function streamWithOllama(messages, options, onToken) {
    options = options || {};
    const model = options.model || ollamaServer.config.defaultModel;
    const processedMessages = options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
        : messages;

    await ollamaServer.retryWithTimeout(async () => {
        const stream = await ollama.chat({
            model: model,
            messages: processedMessages,
            stream: true,
            keep_alive: ollamaServer.config.keepAlive,
        });
        for await (const chunk of stream) {
            if (chunk.message && chunk.message.content) {
                const token = ollamaServer.cleanThinkSection(chunk.message.content);
                onToken(token);
            }
        }
    });
}

// ----- Express Server Setup -----
const app = express();
const port = process.env.PORT || 10086;

// Middleware to parse JSON bodies.
app.use(express.json());

// POST /chat endpoint: expects an array of messages and optional options.
app.post('/chat', async (req, res) => {
    try {
        const messages = req.body.messages;
        const options = req.body.options || {};
        if (!Array.isArray(messages)) {
            return res.status(400).json({ error: 'messages must be an array.' });
        }
        const response = await chatWithOllama(messages, options);
        res.json({ response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /complete endpoint: expects a prompt string and optional options.
app.post('/complete', async (req, res) => {
    try {
        const { prompt, options } = req.body;
        if (typeof prompt !== 'string') {
            return res.status(400).json({ error: 'prompt must be a string.' });
        }
        const response = await completeWithOllama(prompt, options);
        res.json({ response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /models endpoint: returns a list of available models.
app.get('/models', async (req, res) => {
    try {
        console.log('Fetching available models...');
        const models = await listOllamaModels();
        res.json({ models });
    } catch (error) {
        console.error('Error fetching models:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST /chat-stream endpoint: streams responses from Ollama as SSE.
app.post('/chat-stream', async (req, res) => {
    try {
        const messages = req.body.messages;
        const options = req.body.options || {};
        if (!Array.isArray(messages)) {
            return res.status(400).json({ error: 'messages must be an array.' });
        }
        // Set headers for Server-Sent Events (SSE).
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        // Flush headers immediately.
        res.flushHeaders();
        await streamWithOllama(messages, options, (token) => {
            res.write(`data: ${token}\n\n`);
        });
        // Indicate stream completion.
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        res.write(
            `data: ${error instanceof Error ? error.message : 'Error streaming response'}\n\n`
        );
        res.end();
    }
});

// Start the Express server.
app.listen(port, () => {
    console.log(`Express server is running on port ${port}`);
});

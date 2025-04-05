'use strict';

import express from 'express';
import ollama from 'ollama';
import EventEmitter from 'events';

// ----- VRAM Configuration -----
// Total available VRAM (in GB) and reserved VRAM for system overhead.
const VRAM_GB = 16;
const RESERVED_VRAM = 3.5; // GB reserved for system/other tasks
const AVAILABLE_VRAM = VRAM_GB - RESERVED_VRAM;

/**
 * Retrieves the size of a given model (in GB) by calling ollama.list().
 * Caches results to avoid repeated API calls.
 * If the model is not found, defaults to 1GB.
 *
 * @param {string} modelName - The name of the model.
 * @returns {Promise<number>} - The model size in GB.
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
        // Find a matching model by checking both `name` and `model` fields.
        const modelInfo = list.models.find(
            (m) => m.name === modelName || m.model === modelName
        );

        let sizeGb = 1; // Default size if not found or size info missing
        if (modelInfo?.size) {
            sizeGb = modelInfo.size / (1024 * 1024 * 1024);
        } else {
            console.warn(`Model ${modelName} not found or size missing in ollama list. Defaulting to 1GB.`);
        }

        modelSizeCache.set(modelName, sizeGb);
        console.log(`Model ${modelName} size: ${sizeGb.toFixed(2)} GB`);
        return sizeGb;
    } catch (error) {
        console.error(`Error fetching model list to get size for ${modelName}:`, error);
        // Cache the default size on error to prevent repeated failed lookups
        modelSizeCache.set(modelName, 1);
        return 1; // Default to 1GB on error
    }
}

// ----- OllamaServer Class -----
class OllamaServer extends EventEmitter {
    static instance;
    config;
    // For tracking *active* tasks’ VRAM usage (in GB) - models being actively used for generation
    currentActiveVRAMUsage = 0;
    // FIFO queue for tasks waiting for available VRAM
    taskQueue = [];
    DEFAULT_MODEL = 'phi3:mini'; // Consider updating the default model

    constructor(options = {}) {
        super();
        this.config = {
            defaultModel: options.defaultModel || this.DEFAULT_MODEL,
            connectionTimeoutMs: options.connectionTimeoutMs || 1200000, // 20 minutes
            generationTimeoutMs: options.generationTimeoutMs || 0, // No specific timeout for generation itself
            maxRetries: options.maxRetries || 3,
            retryDelayMs: options.retryDelayMs || 1000,
            // --- NEW: Use Ollama's keep_alive string format ---
            keepAliveDuration: options.keepAliveDuration || '10m', // Keep models loaded for 10 minutes after use
        };
        console.log('OllamaServer configured with:', this.config);
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
        // Update keepAliveDuration specifically if provided
        if (options.keepAliveDuration) {
            this.config.keepAliveDuration = options.keepAliveDuration;
        }
        // Update other config options
        Object.assign(this.config, options);
        console.log('OllamaServer config updated:', this.config);
        return this;
    }

    /**
     * Enqueues a task. Runs immediately if VRAM for *active* tasks allows.
     * Relies on Ollama's internal mechanism + keep_alive for managing loaded models.
     *
     * @param {Function} task - The async task to run (should involve an ollama call).
     * @param {string} modelName - The model associated with the task.
     * @returns {Promise<any>}
     */
    async enqueue(task, modelName) {
        const modelSize = await getModelSize(modelName || this.config.defaultModel);

        return new Promise((resolve, reject) => {
            const runTask = async () => {
                // --- VRAM Check based on ACTIVE tasks ---
                if (this.currentActiveVRAMUsage + modelSize > AVAILABLE_VRAM) {
                    // This condition should theoretically not be hit if processQueue is working correctly,
                    // but serves as a safeguard.
                    console.warn(`[${modelName}] VRAM Check Failed unexpectedly inside runTask. Queueing again.`);
                    this.taskQueue.push({ runTask, modelSize, modelName, resolve, reject });
                    this.emit('task:queued', { modelName, modelSize, reason: 'VRAM insufficient at runtime' });
                    this.processQueue(); // Try processing queue again
                    return;
                }

                // --- Mark VRAM as actively used ---
                this.currentActiveVRAMUsage += modelSize;
                this.emit('task:start', {
                    modelName,
                    modelSize,
                    currentActiveVRAMUsage: this.currentActiveVRAMUsage,
                    availableVRAM: AVAILABLE_VRAM,
                });
                console.log(`[${modelName}] Task starting. Active VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${AVAILABLE_VRAM.toFixed(2)} GB`);

                try {
                    // Execute the actual Ollama operation
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    console.error(`[${modelName}] Task failed:`, error);
                    reject(error);
                } finally {
                    // --- Free up ACTIVE VRAM usage ---
                    // The model might stay loaded due to keep_alive, but it's no longer actively processing this request.
                    this.currentActiveVRAMUsage -= modelSize;
                    this.emit('task:complete', {
                        modelName,
                        modelSize,
                        currentActiveVRAMUsage: this.currentActiveVRAMUsage,
                    });
                    console.log(`[${modelName}] Task finished. Active VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${AVAILABLE_VRAM.toFixed(2)} GB`);

                    // --- Process the next task in the queue ---
                    this.processQueue();
                }
            };

            // --- Initial Check: Can the task potentially run? ---
            if (this.currentActiveVRAMUsage + modelSize <= AVAILABLE_VRAM) {
                // Enough VRAM for this task to become active; run immediately.
                console.log(`[${modelName}] Sufficient VRAM (${(AVAILABLE_VRAM - this.currentActiveVRAMUsage).toFixed(2)} GB free). Running immediately.`);
                runTask();
            } else {
                // Not enough VRAM for another active task; queue it.
                console.log(`[${modelName}] Insufficient VRAM (${(AVAILABLE_VRAM - this.currentActiveVRAMUsage).toFixed(2)} GB free, needs ${modelSize.toFixed(2)} GB). Queuing task.`);
                this.taskQueue.push({ runTask, modelSize, modelName, resolve, reject });
                this.emit('task:queued', { modelName, modelSize, reason: 'VRAM insufficient' });
            }
        });
    }

    /**
     * Checks the taskQueue and runs the *first* task that fits within the available *active* VRAM.
     */
    processQueue() {
        if (this.taskQueue.length === 0) {
            return; // No tasks waiting
        }

        console.log(`Processing queue. ${this.taskQueue.length} tasks waiting. Active VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${AVAILABLE_VRAM.toFixed(2)} GB`);

        for (let i = 0; i < this.taskQueue.length; i++) {
            const { runTask, modelSize, modelName } = this.taskQueue[i];

            if (this.currentActiveVRAMUsage + modelSize <= AVAILABLE_VRAM) {
                console.log(`[${modelName}] Dequeuing task. Sufficient VRAM now available.`);
                // Remove task from the queue
                this.taskQueue.splice(i, 1);
                // Run the task
                runTask();
                // Important: Only process *one* task per call to processQueue
                // to ensure VRAM state is accurate for the next check.
                break;
            } else {
                console.log(`[${modelName}] Task requires ${modelSize.toFixed(2)} GB, only ${(AVAILABLE_VRAM - this.currentActiveVRAMUsage).toFixed(2)} GB active VRAM available. Keeping queued.`);
            }
        }
        if (this.taskQueue.length > 0) {
            console.log(`Queue processing finished. ${this.taskQueue.length} tasks still waiting.`);
        }
    }


    async retryWithTimeout(operation, modelName = 'unknown') {
        const { maxRetries, retryDelayMs, connectionTimeoutMs } = this.config;
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                this.emit('retry:attempt', { modelName, attempt, maxRetries });
                console.log(`[${modelName}] Operation attempt ${attempt + 1}/${maxRetries}`);
                const timeoutPromise = new Promise((_, reject) => {
                    const timer = setTimeout(() => reject(new Error(`[${modelName}] Operation timed out after ${connectionTimeoutMs}ms`)), connectionTimeoutMs);
                    // Ensure timeout doesn't keep Node.js running unnecessarily
                    if (timer.unref) {
                        timer.unref();
                    }
                });
                // Promise.race will settle as soon as one promise settles (resolves or rejects)
                return await Promise.race([operation(), timeoutPromise]);
            } catch (error) {
                lastError = error;
                this.emit('retry:failed', { modelName, attempt, error: lastError });
                console.warn(`[${modelName}] Attempt ${attempt + 1} failed: ${error.message}`);
                if (attempt < maxRetries - 1) {
                    console.log(`[${modelName}] Retrying in ${retryDelayMs}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                }
            }
        }
        console.error(`[${modelName}] Operation failed after ${maxRetries} attempts.`);
        throw lastError; // Throw the last encountered error
    }

    cleanThinkSection(content) {
        // Added check for null/undefined content
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
ollamaServer.on('retry:attempt', (data) => console.log(`EVENT retry:attempt - Model: ${data.modelName}, Attempt: ${data.attempt + 1}/${data.maxRetries}`));
ollamaServer.on('retry:failed', (data) => console.warn(`EVENT retry:failed - Model: ${data.modelName}, Attempt: ${data.attempt + 1}, Error: ${data.error.message}`));


// ----- Functions to interact with Ollama -----

// Non-streaming chat.
async function chatWithOllama(messages, options = {}) {
    const model = options.model || ollamaServer.config.defaultModel;
    const processedMessages = options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
        : messages;

    // Enqueue the actual Ollama call
    return ollamaServer.enqueue(async () => {
        console.log(`Executing chat request for model: ${model}`);
        try {
            const response = await ollamaServer.retryWithTimeout(async () => {
                return await ollama.chat({
                    model: model,
                    messages: processedMessages,
                    // --- Use configured keepAliveDuration ---
                    keep_alive: ollamaServer.config.keepAliveDuration,
                    format: options.format,
                    // Add any other relevant options from ollama-js if needed
                    options: {
                        // Example: temperature, top_p, etc. Can be passed in `options.llmOptions`
                        ...(options.llmOptions || {})
                    }
                });
            }, model); // Pass modelName for logging in retry

            // Process response
            let content = response?.message?.content || '';
            if (options.format === 'json') {
                try {
                    // Attempt to parse only if format is explicitly JSON
                    return JSON.parse(content);
                } catch (e) {
                    console.warn(`[${model}] Failed to parse JSON response, returning raw content. Error: ${e.message}`);
                    // Fallback to returning cleaned text if JSON parsing fails
                    return ollamaServer.cleanThinkSection(content);
                }
            }
            // For non-JSON or failed JSON parsing, return cleaned text
            return ollamaServer.cleanThinkSection(content);

        } catch (error) {
            console.error(`Error during chatWithOllama for ${model}:`, error);
            const errorMessage = error instanceof Error
                ? `${error.message}. Model: ${model}. Try 'ollama pull ${model}' or check Ollama server.`
                : `Failed request for ${model}. Is Ollama running? Try 'ollama pull ${model}'.`;
            throw new Error(errorMessage); // Re-throw standardized error
        }
    }, model); // Pass model name to enqueue for VRAM calculation
}

// Non-streaming completion (uses chat endpoint).
async function completeWithOllama(prompt, options = {}) {
    // Ensure options is an object
    const effectiveOptions = { ...options };
    return chatWithOllama([{ role: 'user', content: prompt }], effectiveOptions);
}

// List available models. VRAM cost assumed negligible.
async function listOllamaModels() {
    // Use enqueue with null modelName (negligible VRAM) to respect concurrency limits if ever needed
    return ollamaServer.enqueue(async () => {
        console.log('Executing list models request');
        try {
            const response = await ollamaServer.retryWithTimeout(async () => {
                return await ollama.list();
            }, 'list-models'); // Identifier for logging
            return response.models.map((model) => model.name);
        } catch (error) {
            console.error('Error listing Ollama models:', error);
            throw new Error('Failed to list models. Is Ollama running?');
        }
    }, null); // null modelName -> 0 size assumed by getModelSize
}

// Streaming chat with Ollama.
async function streamWithOllama(messages, options = {}, onToken) {
    const model = options.model || ollamaServer.config.defaultModel;
    const processedMessages = options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
        : messages;

    // Enqueue the streaming operation
    return ollamaServer.enqueue(async () => {
        console.log(`Executing streaming chat request for model: ${model}`);
        let stream;
        try {
            // We apply retry mainly to establish the stream connection
            stream = await ollamaServer.retryWithTimeout(async () => {
                return await ollama.chat({
                    model: model,
                    messages: processedMessages,
                    stream: true,
                    // --- Use configured keepAliveDuration ---
                    keep_alive: ollamaServer.config.keepAliveDuration,
                    options: {
                        ...(options.llmOptions || {})
                    }
                });
            }, model); // Pass modelName for logging in retry

            // Process the stream
            for await (const chunk of stream) {
                if (chunk?.message?.content) {
                    const token = ollamaServer.cleanThinkSection(chunk.message.content);
                    if (token) { // Only send non-empty tokens
                        onToken(token);
                    }
                }
                // Handle potential errors within the stream if the library provides them
                if (chunk?.error) {
                    console.error(`[${model}] Error received in stream chunk:`, chunk.error);
                    // Depending on desired behavior, you might want to throw or just log
                    throw new Error(`Stream error for ${model}: ${chunk.error}`);
                }
            }
            console.log(`[${model}] Stream finished.`);

        } catch (error) {
            console.error(`Error during streamWithOllama for ${model}:`, error);
            // Ensure error is propagated or handled appropriately for the stream consumer
            throw error; // Re-throw the error to be caught by the calling endpoint
        }
    }, model); // Pass model name to enqueue
}


// ----- Express Server Setup -----
const app = express();
const port = process.env.PORT || 10086;

// Middleware to parse JSON bodies.
app.use(express.json());

// POST /chat endpoint
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

// POST /complete endpoint
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

// GET /models endpoint
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

// POST /chat-stream endpoint
app.post('/chat-stream', async (req, res) => {
    try {
        const { messages, options } = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            // Don't set SSE headers if input is invalid
            return res.status(400).json({ error: '`messages` must be a non-empty array.' });
        }
        console.log(`Received /chat-stream request for model: ${options?.model || 'default'}`);

        // Set headers for Server-Sent Events (SSE).
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no' // Often needed for proxy environments like Nginx
        });
        // Flush headers immediately.
        res.flushHeaders();

        // Function to send data chunks
        const sendToken = (token) => {
            // Ensure data is properly formatted for SSE
            const formattedToken = JSON.stringify(token); // Send tokens as JSON strings
            res.write(`data: ${formattedToken}\n\n`);
            // Flush data frequently for real-time feel, maybe not needed on every token
            if (res.flush) res.flush();
        };

        // Execute the streaming call
        await streamWithOllama(messages, options, sendToken);

        // Indicate stream completion cleanly
        res.write('data: [DONE]\n\n');
        res.end();
        console.log(`Finished /chat-stream request for model: ${options?.model || 'default'}`);

    } catch (error) {
        console.error('Error in /chat-stream endpoint:', error.message);
        // If headers are already sent, we can't send a 500 status code.
        // Send an error event instead.
        if (!res.headersSent) {
            // If headers not sent, maybe we can still send JSON error (e.g., bad input before SSE setup)
            // This case is less likely given the check at the start, but good practice.
            res.status(500).json({ error: error.message || 'An internal server error occurred during stream setup' });
        } else {
            // Send error message via SSE stream if possible
            try {
                const errorMessage = JSON.stringify({ error: error.message || 'An error occurred during streaming' });
                res.write(`event: error\ndata: ${errorMessage}\n\n`);
                res.end(); // Close the connection after sending the error
            } catch (writeError) {
                console.error("Failed to write error to SSE stream:", writeError);
                res.end(); // Ensure connection is closed anyway
            }
        }
    }
});


// Graceful Shutdown Handler (Optional but Recommended)
const signals = {
    'SIGHUP': 1,
    'SIGINT': 2,
    'SIGTERM': 15
};

let serverInstance; // To hold the server instance for closing

const shutdown = (signal, value) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    if (serverInstance) {
        serverInstance.close(() => {
            console.log('Http server closed.');
            // Add any other cleanup logic here (e.g., close DB connections)
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


// Start the Express server.
serverInstance = app.listen(port, () => {
    console.log(`Express server running on port ${port}`);
    console.log(`Available VRAM for tasks: ${AVAILABLE_VRAM.toFixed(2)} GB`);
    console.log(`Default model: ${ollamaServer.config.defaultModel}`);
    console.log(`Model keep-alive duration: ${ollamaServer.config.keepAliveDuration}`);
});
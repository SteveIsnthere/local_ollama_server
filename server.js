'use strict';

const express = require('express');
const ollama = require('ollama');
const EventEmitter = require('events');

// OllamaServer class definition
class OllamaServer extends EventEmitter {
    static instance;
    queue;
    config;
    DEFAULT_MODEL = 'gemma3:1b';

    constructor(options = {}) {
        super();
        this.queue = Promise.resolve();
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

    async enqueue(task) {
        this.emit('queue:added', {queueSize: this.getQueueSize() + 1});

        this.queue = this.queue.then(async () => {
            this.emit('request:start');
            try {
                const result = await task();
                this.emit('request:success');
                return result;
            } catch (error) {
                this.emit('request:error', error);
                throw error;
            } finally {
                this.emit('queue:processed', {queueSize: this.getQueueSize()});
            }
        });

        return this.queue;
    }

    getQueueSize() {
        return (
            this.listenerCount('request:start') -
            this.listenerCount('request:success') -
            this.listenerCount('request:error')
        );
    }

    async retryWithTimeout(operation) {
        const {maxRetries, retryDelayMs, connectionTimeoutMs} = this.config;
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                this.emit('retry:attempt', {attempt, maxRetries});
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Connection timeout')), connectionTimeoutMs);
                });
                return await Promise.race([operation(), timeoutPromise]);
            } catch (error) {
                lastError = error;
                this.emit('retry:failed', {attempt, error: lastError});

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

// Function to chat with Ollama
async function chatWithOllama(messages, options) {
    options = options || {};
    const model = options.model || ollamaServer.config.defaultModel;
    const processedMessages = options.systemPrompt
        ? [{role: 'system', content: options.systemPrompt}, ...messages]
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
    });
}

// Function to complete a prompt with Ollama
async function completeWithOllama(prompt, options) {
    return chatWithOllama([{role: 'user', content: prompt}], options);
}

// Function to list available Ollama models
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
    });
}

// Express server setup
const app = express();
const port = process.env.PORT || 10086;

// Middleware to parse JSON bodies
app.use(express.json());

// POST /chat endpoint: expects an array of messages and optional options
app.post('/chat', async (req, res) => {
    try {
        const messages = req.body.messages;
        const options = req.body.options || {};

        if (!Array.isArray(messages)) {
            return res.status(400).json({error: 'messages must be an array.'});
        }

        const response = await chatWithOllama(messages, options);
        res.json({response});
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// POST /complete endpoint: expects a prompt string and optional options
app.post('/complete', async (req, res) => {
    try {
        const {prompt, options} = req.body;

        if (typeof prompt !== 'string') {
            return res.status(400).json({error: 'prompt must be a string.'});
        }

        const response = await completeWithOllama(prompt, options);
        res.json({response});
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// GET /models endpoint: returns a list of available models
app.get('/models', async (req, res) => {
    try {
        const models = await listOllamaModels();
        res.json({models});
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// Start the Express server
app.listen(port, () => {
    console.log(`Express server is running on port ${port}`);
});

'use strict';

import express from 'express';
import ollama from 'ollama';
import OllamaServer from '../lib/ollamaServer.js'; // Use .js extension
import * as config from '../config.js'; // Use .js extension

const router = express.Router();
const ollamaServer = OllamaServer.getInstance();

// Non-streaming chat
async function chatWithOllama(messages, options = {}) {
    const model = options.model || ollamaServer.config.defaultModel;
    const processedMessages = options.systemPrompt
        ? [{role: 'system', content: options.systemPrompt}, ...messages]
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
    return chatWithOllama([{role: 'user', content: prompt}], options);
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
        ? [{role: 'system', content: options.systemPrompt}, ...messages]
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

// Chat endpoint
router.post('/chat', async (req, res) => {
    try {
        // Check for game mode
        if (config.isGameModeEnabled()) {
            return res.status(503).json({error: "Server is busy: Game Mode is active"});
        }

        const {messages, options} = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({error: '`messages` must be a non-empty array.'});
        }
        console.log(`Received /chat request for model: ${options?.model || 'default'}`);
        const response = await chatWithOllama(messages, options);
        res.json({response});
    } catch (error) {
        console.error('Error in /chat endpoint:', error.message);

        if (error.message.includes("Game Mode is active")) {
            return res.status(503).json({error: "Server is busy: Game Mode is active"});
        }

        res.status(500).json({error: error.message || 'An internal server error occurred'});
    }
});

// Completion endpoint
router.post('/complete', async (req, res) => {
    try {
        // Check for game mode
        if (config.isGameModeEnabled()) {
            return res.status(503).json({error: "Server is busy: Game Mode is active"});
        }

        const {prompt, options} = req.body;
        if (typeof prompt !== 'string' || prompt.trim() === '') {
            return res.status(400).json({error: '`prompt` must be a non-empty string.'});
        }
        console.log(`Received /complete request for model: ${options?.model || 'default'}`);
        const response = await completeWithOllama(prompt, options);
        res.json({response});
    } catch (error) {
        console.error('Error in /complete endpoint:', error.message);

        if (error.message.includes("Game Mode is active")) {
            return res.status(503).json({error: "Server is busy: Game Mode is active"});
        }

        res.status(500).json({error: error.message || 'An internal server error occurred'});
    }
});

// Models endpoint
router.get('/models', async (req, res) => {
    try {
        console.log('Received /models request');
        const models = await listOllamaModels();
        res.json({models});
    } catch (error) {
        console.error('Error in /models endpoint:', error.message);
        res.status(500).json({error: error.message || 'An internal server error occurred'});
    }
});

// Streaming chat endpoint
router.post('/chat-stream', async (req, res) => {
    try {
        // Check for game mode
        if (config.isGameModeEnabled()) {
            return res.status(503).json({error: "Server is busy: Game Mode is active"});
        }

        const {messages, options} = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({error: '`messages` must be a non-empty array.'});
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
            if (error.message.includes("Game Mode is active")) {
                return res.status(503).json({error: "Server is busy: Game Mode is active"});
            }
            res.status(500).json({error: error.message || 'An internal server error occurred during stream setup'});
        } else {
            try {
                const errorMessage = JSON.stringify({error: error.message || 'An error occurred during streaming'});
                res.write(`event: error\ndata: ${errorMessage}\n\n`);
            } catch (writeError) {
                console.error("Failed to write error to stream:", writeError);
            } finally {
                res.end();
            }
        }
    }
});

export default router;
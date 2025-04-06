'use strict';

import EventEmitter from 'events';
import * as config from '../config.js'; // Use .js extension
import { getNvidiaVRAMUsage } from './vramMonitor.js'; // Use .js extension
import { getLoadedModels, getModelSize } from './modelManager.js'; // Use .js extension

/**
 * Enhanced OllamaServer class with improved VRAM monitoring and game mode
 */
export default class OllamaServer extends EventEmitter { // Use export default for the class
    static instance;
    config;

    // VRAM tracking
    currentActiveVRAMUsage = 0;
    taskQueue = [];

    // Enhanced model tracking (for our own management)
    loadedModels = new Map(); // modelName -> {size, lastUsed, activeTaskCount}

    // VRAM monitoring
    vramMonitorInterval = null;
    actualVRAMUsage = {total: config.VRAM_GB, used: 0, free: config.AVAILABLE_VRAM};

    constructor(options = {}) {
        super();
        this.config = {
            defaultModel: options.defaultModel || config.DEFAULT_MODEL,
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
                    loadedModels: loadedModels.length,
                    gameMode: config.isGameModeEnabled()
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
                this.emit('model:unloaded', {modelName});
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
                this.emit('model:loaded', {modelName, modelSize});
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
     * Check if server is in game mode before executing task
     */
    isGameModeActive() {
        return config.isGameModeEnabled();
    }

    /**
     * Improved enqueue method with game mode check
     */
    async enqueue(task, modelName) {
        // Check if game mode is enabled
        if (this.isGameModeActive()) {
            throw new Error("Server is busy: Game Mode is active");
        }

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

                console.log(`[${effectiveModelName}] Task starting. Our tracked VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${config.AVAILABLE_VRAM.toFixed(2)} GB, Actual GPU VRAM: ${this.actualVRAMUsage.used.toFixed(2)}/${this.actualVRAMUsage.total.toFixed(2)} GB`);

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

                    console.log(`[${effectiveModelName}] Task finished. Our tracked VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${config.AVAILABLE_VRAM.toFixed(2)} GB`);

                    // Process more tasks from queue
                    this.processQueue();
                }
            };

            // Check if we have VRAM available
            if (this.currentActiveVRAMUsage + modelSize <= config.AVAILABLE_VRAM) {
                console.log(`[${effectiveModelName}] Sufficient VRAM (${(config.AVAILABLE_VRAM - this.currentActiveVRAMUsage).toFixed(2)} GB free). Running immediately.`);
                runTask();
                return;
            }

            // If we get here, we need to queue the task
            console.log(`[${effectiveModelName}] Insufficient VRAM (${(config.AVAILABLE_VRAM - this.currentActiveVRAMUsage).toFixed(2)} GB free, needs ${modelSize.toFixed(2)} GB). Queuing task.`);
            this.taskQueue.push({runTask, modelSize, modelName: effectiveModelName});
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

        // Don't process queue if game mode is active
        if (this.isGameModeActive()) {
            console.log(`Queue processing skipped due to active Game Mode. ${this.taskQueue.length} tasks waiting.`);
            return;
        }

        console.log(`Processing queue. ${this.taskQueue.length} tasks waiting. Active VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${config.AVAILABLE_VRAM.toFixed(2)} GB`);

        // Sort tasks by size (smallest first) to maximize parallel execution
        this.taskQueue.sort((a, b) => a.modelSize - b.modelSize);

        // Track how many tasks we started in this cycle
        let tasksStarted = 0;

        // Try to run as many tasks as possible in parallel
        const availableVRAM = config.AVAILABLE_VRAM - this.currentActiveVRAMUsage;
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
        const {maxRetries, retryDelayMs, connectionTimeoutMs} = this.config;
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                this.emit('retry:attempt', {modelName, attempt, maxRetries});
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
                this.emit('retry:failed', {modelName, attempt, error: lastError});
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


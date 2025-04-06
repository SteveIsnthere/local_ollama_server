'use strict';

import EventEmitter from 'events';
import ollama from 'ollama';
import * as config from '../config.js';
import { getNvidiaVRAMUsage } from './vramMonitor.js';
// Import the specific unload function needed
import { getLoadedModels, getModelSize, unloadModelByName } from './modelManager.js';

/**
 * Enhanced OllamaServer class with proactive unloading, improved VRAM monitoring and game mode
 */
export default class OllamaServer extends EventEmitter {
    static instance;
    config;

    // VRAM tracking
    currentActiveVRAMUsage = 0; // VRAM used by tasks *currently being processed* by this server
    taskQueue = [];

    // Enhanced model tracking (for our own management)
    // modelName -> {size: number, lastUsed: number, activeTaskCount: number, expires?: Date}
    loadedModels = new Map();

    // VRAM monitoring
    vramMonitorInterval = null;
    actualVRAMUsage = { total: config.VRAM_GB, used: 0, free: config.AVAILABLE_VRAM };

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
                const ollamaLoadedList = await getLoadedModels();

                // Update our model tracking based on Ollama's report
                this.syncLoadedModels(ollamaLoadedList);

                this.emit('vram:updated', {
                    vram: this.actualVRAMUsage,
                    loadedModels: this.loadedModels.size, // Report count from our tracking
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
     * Sync our internal model tracking map with the actual loaded models reported by Ollama.
     * @param {Array<{name: string, size?: number, expires?: Date}>} ollamaLoadedList - List from getLoadedModels().
     */
    async syncLoadedModels(ollamaLoadedList) {
        const ollamaModelsMap = new Map(ollamaLoadedList.map(m => [m.name, m]));

        // Remove models from our tracking if they are no longer loaded by Ollama *and* have no active tasks
        for (const [modelName, modelInfo] of this.loadedModels.entries()) {
            if (!ollamaModelsMap.has(modelName) && modelInfo.activeTaskCount === 0) {
                this.loadedModels.delete(modelName);
                this.emit('model:unloaded', { modelName, reason: 'sync_unload' });
                console.log(`Model ${modelName} removed from tracking (not loaded by Ollama).`);
            }
        }

        // Add/update models in our tracking based on Ollama's list
        for (const [modelName, ollamaInfo] of ollamaModelsMap.entries()) {
            let modelSize = ollamaInfo.size; // Use size reported by ollama.ps if available
            if (modelSize === undefined || modelSize <= 0) { // Also check for invalid size
                // Fallback to fetching size if ollama.ps didn't provide it or provided 0
                console.log(`Size for ${modelName} not available from ollama.ps, fetching via ollama.list...`);
                modelSize = await getModelSize(modelName);
            }

            if (!this.loadedModels.has(modelName)) {
                // Add new model to tracking
                this.loadedModels.set(modelName, {
                    size: modelSize,
                    lastUsed: Date.now(), // Assume newly detected models were just used/loaded
                    activeTaskCount: 0,   // Start with 0 active tasks from our server's perspective
                    expires: ollamaInfo.expires
                });
                this.emit('model:loaded', { modelName, modelSize });
            } else {
                // Update existing tracked model info (like expiration and potentially size)
                const existingInfo = this.loadedModels.get(modelName);
                if (existingInfo.size !== modelSize && modelSize > 0) { // Update size if different and valid
                    console.log(`Updating tracked size for ${modelName} from ${existingInfo.size.toFixed(2)}GB to ${modelSize.toFixed(2)}GB.`);
                    existingInfo.size = modelSize;
                }
                existingInfo.expires = ollamaInfo.expires; // Update expiration
                // Don't reset lastUsed or activeTaskCount here
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
     * Track when a task starts using a model.
     */
    trackModelUsage(modelName, modelSize) {
        if (!modelName) return;

        let modelInfo = this.loadedModels.get(modelName);
        if (!modelInfo) {
            // If model wasn't tracked (e.g., loaded externally), add it now
            modelInfo = {
                size: modelSize,
                lastUsed: Date.now(),
                activeTaskCount: 0
            };
            this.loadedModels.set(modelName, modelInfo);
            this.emit('model:loaded', { modelName, modelSize, reason: 'task_usage' });
        }

        modelInfo.lastUsed = Date.now();
        modelInfo.activeTaskCount++;
        // Note: We don't handle the timeoutId here anymore, relying on Ollama's keep_alive

        this.emit('model:used', {
            modelName,
            modelSize: modelInfo.size,
            activeTaskCount: modelInfo.activeTaskCount
        });
    }

    /**
     * Mark when a task using a model finishes.
     */
    completeModelTask(modelName) {
        if (!modelName || !this.loadedModels.has(modelName)) return;

        const modelInfo = this.loadedModels.get(modelName);
        modelInfo.activeTaskCount = Math.max(0, modelInfo.activeTaskCount - 1);
        modelInfo.lastUsed = Date.now(); // Update last used time on completion as well

        this.emit('model:taskComplete', {
            modelName,
            activeTaskCount: modelInfo.activeTaskCount
        });
    }

    isGameModeActive() {
        return config.isGameModeEnabled();
    }

    /**
     * Finds inactive models (loaded by Ollama but not actively used by *this server*)
     * and attempts to unload them to free up VRAM.
     * Prioritizes unloading least recently used models first.
     *
     * @param {number} requiredVramToFree - The amount of VRAM (in GB) needed.
     * @param {string} excludeModelName - Optional model name to exclude from unloading candidates.
     * @returns {Promise<number>} - The estimated amount of VRAM freed (in GB).
     */
    async findAndUnloadInactiveModels(requiredVramToFree, excludeModelName = null) {
        let vramFreed = 0;
        if (requiredVramToFree <= 0) return 0; // No need to free VRAM

        try {
            const ollamaLoadedList = await getLoadedModels(); // Models Ollama currently reports as loaded
            const ollamaLoadedNames = new Set(ollamaLoadedList.map(m => m.name));

            const inactiveCandidates = [];
            for (const [name, info] of this.loadedModels.entries()) {
                // Candidate if:
                // 1. Ollama reports it as loaded (redundant check, but safe)
                // 2. Our server has no active tasks for it
                // 3. It's not the model we want to exclude (usually the one we're trying to load)
                if (ollamaLoadedNames.has(name) && info.activeTaskCount === 0 && name !== excludeModelName) {
                    // Ensure size is valid before adding
                    if(typeof info.size === 'number' && info.size > 0) {
                        inactiveCandidates.push({ name, size: info.size, lastUsed: info.lastUsed });
                    } else {
                        console.warn(`Skipping inactive candidate ${name} due to invalid size: ${info.size}`);
                    }
                }
            }

            if (inactiveCandidates.length === 0) {
                console.log("No inactive models found to proactively unload.");
                return 0;
            }

            // Sort by least recently used (older first)
            inactiveCandidates.sort((a, b) => a.lastUsed - b.lastUsed);

            console.log(`Found ${inactiveCandidates.length} inactive candidates. Need to free ${requiredVramToFree.toFixed(2)} GB.`);
            console.log(`Candidates (sorted oldest first): ${inactiveCandidates.map(c => `${c.name} (${c.size.toFixed(2)}GB)`).join(', ')}`);

            const modelsToUnload = [];
            let cumulativeSize = 0;
            for (const candidate of inactiveCandidates) {
                console.log(`   Evaluating candidate: ${candidate.name}, Size: ${candidate.size.toFixed(2)} GB, Cumulative selected size: ${cumulativeSize.toFixed(2)} GB`);
                modelsToUnload.push(candidate.name);
                cumulativeSize += candidate.size;
                console.log(`   Added ${candidate.name}. New cumulative size: ${cumulativeSize.toFixed(2)} GB`);
                if (cumulativeSize >= requiredVramToFree) {
                    console.log(`   Cumulative size meets requirement.`);
                    break; // Stop selecting once we have enough estimated VRAM
                }
            }

            if (modelsToUnload.length > 0) {
                // *** Fixed Logging ***
                console.log(`Attempting proactive unload for: ${modelsToUnload.join(', ')} (estimated total size: ${cumulativeSize.toFixed(2)} GB).`);
                const unloadPromises = modelsToUnload.map(name => unloadModelByName(name));
                await Promise.all(unloadPromises);

                vramFreed = cumulativeSize; // Base freed estimate on selected models

                // Update internal tracking immediately *after* attempting unload
                modelsToUnload.forEach(name => {
                    if (this.loadedModels.has(name)) {
                        const modelInfo = this.loadedModels.get(name); // Get info before potential deletion
                        if (modelInfo.activeTaskCount === 0) {
                            this.loadedModels.delete(name);
                            this.emit('model:unloaded', { modelName: name, reason: 'proactive_unload' });
                            console.log(`Removed ${name} from internal tracking after proactive unload attempt.`);
                        } else {
                            console.warn(`Model ${name} became active during proactive unload, keeping tracking.`);
                            vramFreed -= modelInfo.size; // Adjust estimate - VRAM wasn't freed
                        }
                    }
                    // No need for else block; if it wasn't in loadedModels, it doesn't affect our estimate
                });
                // *** Fixed Logging ***
                console.log(`Finished proactive unload attempt. Estimated VRAM potentially freed: ${Math.max(0, vramFreed).toFixed(2)} GB.`);
            } else {
                console.log("No suitable inactive models selected for proactive unloading.");
            }

        } catch (error) {
            console.error("Error during proactive model unloading:", error);
            return 0; // Return 0 if error occurs
        }
        return Math.max(0, vramFreed); // Ensure we don't return negative freed VRAM
    }


    /**
     * Enqueue a task. Handles game mode, VRAM checks, proactive unloading, and queueing.
     * @param {Function} task - The async function representing the Ollama operation.
     * @param {string | null} modelName - The name of the model required for the task.
     * @returns {Promise<any>} - A promise that resolves/rejects with the task's result.
     */
    async enqueue(task, modelName) {
        if (this.isGameModeActive()) {
            return Promise.reject(new Error("Server is busy: Game Mode is active"));
        }

        const effectiveModelName = modelName || this.config.defaultModel;
        let modelSize;
        try {
            modelSize = await getModelSize(effectiveModelName);
            if (modelSize <= 0) { // Add check for valid size
                throw new Error(`Could not determine a valid size for model ${effectiveModelName}`);
            }
        } catch (e) {
            console.error(`Enqueue failed: ${e.message}`);
            return Promise.reject(e); // Reject if size cannot be determined
        }

        return new Promise(async (resolve, reject) => {
            const runTask = async () => {
                // Update model tracking & VRAM usage (increase active count)
                this.trackModelUsage(effectiveModelName, modelSize);
                // VRAM is reserved *before* runTask is called in processQueue or enqueue

                this.emit('task:start', {
                    modelName: effectiveModelName,
                    modelSize,
                    currentActiveVRAMUsage: this.currentActiveVRAMUsage,
                    actualVRAMUsage: this.actualVRAMUsage
                });
                console.log(`[${effectiveModelName}] Task starting. Tracked Active VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${config.AVAILABLE_VRAM.toFixed(2)} GB.`);

                try {
                    const result = await task(); // Execute the actual Ollama operation
                    resolve(result);
                } catch (error) {
                    console.error(`[${effectiveModelName}] Task execution failed:`, error);
                    reject(error); // Reject the promise returned by enqueue
                } finally {
                    // Update tracking & free VRAM (decrease active count)
                    this.currentActiveVRAMUsage -= modelSize; // Release VRAM *after* task finishes
                    this.completeModelTask(effectiveModelName);

                    this.emit('task:complete', {
                        modelName: effectiveModelName,
                        modelSize,
                        currentActiveVRAMUsage: this.currentActiveVRAMUsage,
                    });
                    console.log(`[${effectiveModelName}] Task finished. Tracked Active VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${config.AVAILABLE_VRAM.toFixed(2)} GB.`);

                    // Try processing the next item(s) in the queue
                    this.processQueue();
                }
            };

            // --- Main Enqueue Logic ---
            const availableVramForActive = config.AVAILABLE_VRAM - this.currentActiveVRAMUsage;

            // *** FIX: Use < for VRAM check ***
            if (modelSize < availableVramForActive) {
                // Enough VRAM currently available among *active* tasks
                console.log(`[${effectiveModelName}] Sufficient active VRAM (${availableVramForActive.toFixed(2)} GB free). Running immediately.`);
                this.currentActiveVRAMUsage += modelSize; // Reserve VRAM before starting
                runTask();
            } else {
                // Not enough active VRAM. Calculate shortfall and try proactive unload.
                const requiredVramToFree = modelSize - availableVramForActive;
                console.log(`[${effectiveModelName}] Insufficient active VRAM (needs ${modelSize.toFixed(2)} GB, ${availableVramForActive.toFixed(2)} GB free). Checking for inactive models...`);

                const freedVramEstimate = await this.findAndUnloadInactiveModels(requiredVramToFree, effectiveModelName);

                // Re-evaluate available VRAM *after* attempting unload
                const availableVramAfterUnload = config.AVAILABLE_VRAM - this.currentActiveVRAMUsage;

                // *** FIX: Use < and check against current availability ***
                if (modelSize < availableVramAfterUnload) {
                    console.log(`[${effectiveModelName}] Sufficient VRAM now available (${availableVramAfterUnload.toFixed(2)} GB free) after proactive unload attempt. Running task.`);
                    this.currentActiveVRAMUsage += modelSize; // Reserve VRAM before starting
                    runTask();
                } else {
                    // Still not enough VRAM, queue the task
                    console.log(`[${effectiveModelName}] Insufficient VRAM (${availableVramAfterUnload.toFixed(2)} GB free) even after attempting unload (~${freedVramEstimate.toFixed(2)} GB freed). Queuing task.`);
                    this.taskQueue.push({ runTask, modelSize, modelName: effectiveModelName });
                    this.emit('task:queued', {
                        modelName: effectiveModelName,
                        modelSize,
                        reason: 'VRAM insufficient after proactive unload'
                    });
                }
            }
            // --- End Main Enqueue Logic ---
        });
    }

    /**
     * Processes the task queue, running tasks that fit in the currently available VRAM.
     * Prioritizes smaller tasks to maximize parallelism.
     */
    processQueue() {
        if (this.taskQueue.length === 0) return; // Nothing to process

        if (this.isGameModeActive()) {
            console.log(`Queue processing skipped due to active Game Mode. ${this.taskQueue.length} tasks waiting.`);
            return;
        }

        console.log(`Processing queue. ${this.taskQueue.length} tasks waiting. Active VRAM: ${this.currentActiveVRAMUsage.toFixed(2)}/${config.AVAILABLE_VRAM.toFixed(2)} GB`);

        // Sort tasks by size (smallest first) to potentially run more concurrently
        this.taskQueue.sort((a, b) => a.modelSize - b.modelSize);

        let tasksStarted = 0;
        const remainingTasks = []; // Build a new queue for tasks that don't fit

        for (const task of this.taskQueue) {
            // *** FIX: Use < for VRAM check ***
            if (this.currentActiveVRAMUsage + task.modelSize < config.AVAILABLE_VRAM) {
                // Task fits in the *currently* available active VRAM space
                console.log(`[${task.modelName}] Dequeuing task (${task.modelSize.toFixed(2)} GB). Sufficient VRAM now available.`);
                // Reserve VRAM *before* calling runTask (which is async)
                this.currentActiveVRAMUsage += task.modelSize;
                task.runTask(); // Start the task (runTask handles releasing VRAM later)
                tasksStarted++;
            } else {
                // Task doesn't fit, keep it for the next processing cycle
                remainingTasks.push(task);
            }
        }

        this.taskQueue = remainingTasks; // Update the queue

        if (tasksStarted > 0 || remainingTasks.length > 0) {
            console.log(`Queue processing finished. Started ${tasksStarted} tasks. ${this.taskQueue.length} tasks still waiting.`);
        }
    }

    /**
     * Retry mechanism with timeout for Ollama operations.
     */
    async retryWithTimeout(operation, modelName = 'unknown') {
        const { maxRetries, retryDelayMs, connectionTimeoutMs } = this.config;
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                this.emit('retry:attempt', { modelName, attempt, maxRetries });
                // console.log(`[${modelName}] Operation attempt ${attempt + 1}/${maxRetries}`); // Verbose logging

                const timeoutPromise = new Promise((_, reject) => {
                    const timer = setTimeout(() =>
                            reject(new Error(`[${modelName}] Operation timed out after ${connectionTimeoutMs}ms`)),
                        connectionTimeoutMs
                    );
                    if (timer.unref) timer.unref(); // Allow Node.js to exit if this is the only thing running
                });

                // Race the actual operation against the timeout
                return await Promise.race([operation(), timeoutPromise]);

            } catch (error) {
                lastError = error;
                this.emit('retry:failed', { modelName, attempt, error: lastError });
                console.warn(`[${modelName}] Attempt ${attempt + 1} failed: ${error.message}`);

                if (attempt < maxRetries - 1) {
                    console.log(`[${modelName}] Retrying in ${retryDelayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                } else {
                    console.error(`[${modelName}] Operation failed after ${maxRetries} attempts.`);
                }
            }
        }
        // If loop finishes without returning, throw the last error
        throw lastError;
    }

    /**
     * Removes <think> tags and surrounding whitespace from content.
     */
    cleanThinkSection(content) {
        if (!content) return '';
        return content.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
    }
}
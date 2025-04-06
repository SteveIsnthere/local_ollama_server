'use strict';

import express from 'express';
import * as config from '../config.js'; // Use .js extension
import { getNvidiaVRAMUsage } from '../lib/vramMonitor.js'; // Use .js extension
import { getLoadedModels, unloadAllModels } from '../lib/modelManager.js'; // Use .js extension
import OllamaServer from '../lib/ollamaServer.js'; // Use .js extension
import ollama from 'ollama'; // Import ollama if needed for debug endpoint

const router = express.Router();
const ollamaServer = OllamaServer.getInstance();

// System status endpoint with enhanced GPU metrics
router.get('/status', async (req, res) => {
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
                available: config.AVAILABLE_VRAM,
                reserved: config.RESERVED_VRAM
            }
        };

        // Queue information
        const queueInfo = {
            length: ollamaServer.taskQueue.length,
            models: ollamaServer.taskQueue.map(task => task.modelName)
        };

        res.json({
            gameMode: config.isGameModeEnabled(),
            vram: vramInfo,
            models: loadedModelInfo,
            ollamaModels: runningModels,
            queue: queueInfo
        });
    } catch (error) {
        console.error('Error in /system/status endpoint:', error);
        res.status(500).json({error: 'Failed to get system status'});
    }
});

// Game mode toggle endpoints
router.post('/game-mode/enable', async (req, res) => {
    try {
        // Enable game mode
        config.enableGameMode();

        // Unload all models
        const unloadResult = await unloadAllModels();

        console.log(`Game Mode enabled. Unloaded ${unloadResult.success}/${unloadResult.total} models.`);

        res.json({
            gameMode: true,
            modelsUnloaded: unloadResult.success,
            totalModels: unloadResult.total
        });
    } catch (error) {
        console.error('Error enabling Game Mode:', error);
        res.status(500).json({error: 'Failed to enable Game Mode', message: error.message});
    }
});

router.post('/game-mode/disable', async (req, res) => {
    try {
        // Disable game mode
        config.disableGameMode();

        console.log('Game Mode disabled.');

        res.json({
            gameMode: false
        });
    } catch (error) {
        console.error('Error disabling Game Mode:', error);
        res.status(500).json({error: 'Failed to disable Game Mode', message: error.message});
    }
});

// Get current game mode status
router.get('/game-mode', (req, res) => {
    res.json({
        gameMode: config.isGameModeEnabled()
    });
});

// Debug endpoint to inspect Ollama PS output
router.get('/debug/ollama-ps', async (req, res) => {
    try {
        const response = await ollama.ps();
        res.json(response);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

export default router; // Export the router

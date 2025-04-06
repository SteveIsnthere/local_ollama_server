'use strict';

import ollama from 'ollama';

// Model size caching and retrieval
const modelSizeCache = new Map();

/**
 * Get currently loaded models via ollama.ps()
 */
export async function getLoadedModels() {
    try {
        const response = await ollama.ps();

        if (!response.models) {
            console.log("Unexpected ollama.ps() response format:", response);
            return [];
        }

        return response.models.map(model => ({
            name: model.name,
            running: true,
            size: model.size_vram ? model.size_vram / (1024 * 1024 * 1024) : undefined,
            expires: model.expires_at ? new Date(model.expires_at) : undefined
        }));
    } catch (error) {
        console.error("Failed to get loaded models:", error);
        return [];
    }
}

/**
 * Get the size of a model
 */
export async function getModelSize(modelName) {
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
 * Force Ollama to unload all models (by setting keep_alive to 0s)
 */
export async function unloadAllModels() {
    try {
        const loadedModels = await getLoadedModels();

        const unloadPromises = loadedModels.map(async model => {
            try {
                console.log(`Unloading model: ${model.name}`);
                await ollama.chat({
                    model: model.name,
                    messages: [{ role: 'system', content: 'ping' }],
                    keep_alive: "0s"
                });
                console.log(`Model ${model.name} marked for unloading`);
                return true;
            } catch (error) {
                console.error(`Failed to unload model ${model.name}:`, error);
                return false;
            }
        });

        const results = await Promise.all(unloadPromises);
        return {
            success: results.filter(result => result).length,
            total: loadedModels.length
        };
    } catch (error) {
        console.error("Failed to unload models:", error);
        throw error;
    }
}
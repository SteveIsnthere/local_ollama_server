'use strict';

import ollama from 'ollama';

// Model size caching and retrieval
const modelSizeCache = new Map();

/**
 * Get currently loaded models via ollama.ps()
 * @returns {Promise<Array<{name: string, running: boolean, size: number | undefined, expires: Date | undefined}>>} Loaded models
 */
export async function getLoadedModels() {
    try {
        const response = await ollama.ps();

        if (!response || !response.models) { // Added check for response existence
            console.warn("Unexpected or empty ollama.ps() response:", response);
            return [];
        }

        return response.models.map(model => ({
            name: model.name,
            running: true, // Assuming models listed by ps are 'running' or loaded
            size: model.size_vram ? model.size_vram / (1024 * 1024 * 1024) : undefined, // Convert VRAM size to GB
            expires: model.expires_at ? new Date(model.expires_at) : undefined
        }));
    } catch (error) {
        console.error("Failed to get loaded models:", error);
        return []; // Return empty array on error
    }
}

/**
 * Get the size of a model from the ollama list or cache.
 * @param {string} modelName - The name of the model.
 * @returns {Promise<number>} - The model size in GB.
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

/**
 * Force Ollama to unload a specific model by name using the keep_alive trick.
 * @param {string} modelName - The name of the model to unload.
 * @returns {Promise<boolean>} - True if the unload command was sent successfully or model wasn't found, false otherwise.
 */
export async function unloadModelByName(modelName) {
    if (!modelName) return false;
    try {
        console.log(`Attempting to unload model: ${modelName}`);
        // Make a simple ping request with keep_alive: "0s"
        // This effectively tells Ollama to unload the model immediately after this request
        await ollama.chat({
            model: modelName,
            messages: [{ role: 'system', content: 'ping' }], // Dummy content
            keep_alive: "0s" // Instruct Ollama to not keep alive
        });
        console.log(`Model ${modelName} marked for unloading.`);
        return true;
    } catch (error) {
        // Common errors indicating the model might already be gone or not loaded
        if (error.message.includes('model not found') || error.message.includes('context window')) {
            console.log(`Model ${modelName} was likely already unloaded or unavailable.`);
            return true; // Consider it successfully 'unloaded' if not found
        }
        // Log other errors but still might indicate success in some scenarios
        console.warn(`Issue sending unload command for model ${modelName}:`, error.message);
        // Depending on strictness, you might return false here for unexpected errors.
        // Returning true assumes the goal (model not loaded) might be achieved even with an error.
        return true;
    }
}

/**
 * Force Ollama to unload all currently loaded models.
 * @returns {Promise<{success: number, total: number}>} - Count of models successfully marked for unload and total attempted.
 */
export async function unloadAllModels() {
    let loadedModels = [];
    try {
        loadedModels = await getLoadedModels(); // Use the existing function
        if (loadedModels.length === 0) {
            console.log("No models reported loaded by Ollama to unload.");
            return { success: 0, total: 0 };
        }

        console.log(`Attempting to unload ${loadedModels.length} models...`);
        // Use the specific unload function for each
        const unloadPromises = loadedModels.map(model => unloadModelByName(model.name));

        const results = await Promise.all(unloadPromises);
        const successCount = results.filter(result => result).length; // Count how many returned true
        console.log(`Finished unload attempt. ${successCount}/${loadedModels.length} models successfully marked for unloading.`);
        return {
            success: successCount,
            total: loadedModels.length
        };
    } catch (error) {
        console.error("Error during unloadAllModels process:", error);
        // Return counts based on potentially partial success before error
        return { success: 0, total: loadedModels.length };
    }
}
'use strict';

// ----- VRAM Configuration -----
export let VRAM_GB = 16;             // Default total VRAM (if nvidia-smi fails)
export const RESERVED_VRAM = 3.5;    // GB reserved for system/other tasks
export let AVAILABLE_VRAM = VRAM_GB - RESERVED_VRAM;

// ----- Server Configuration -----
export const PORT = process.env.PORT || 10086;
export const DEFAULT_MODEL = 'gemma3:1b';

// ----- Application State -----
let GAME_MODE = false; // When true, server will reject LLM requests

// Function to update VRAM values
export function updateVRAMValues(totalVRAM) {
    if (totalVRAM > 0) {
        VRAM_GB = totalVRAM;
        AVAILABLE_VRAM = VRAM_GB - RESERVED_VRAM;
    }
}

// Functions to manage game mode
export function enableGameMode() {
    GAME_MODE = true;
    return GAME_MODE;
}

export function disableGameMode() {
    GAME_MODE = false;
    return GAME_MODE;
}

export function isGameModeEnabled() {
    return GAME_MODE;
}
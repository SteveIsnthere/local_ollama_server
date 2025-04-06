'use strict';

import { exec } from 'child_process';
import { promisify } from 'util';
import * as config from '../config.js'; // Use .js extension

const execAsync = promisify(exec);

/**
 * Get real NVIDIA GPU VRAM usage using nvidia-smi
 */
export async function getNvidiaVRAMUsage() {
    try {
        // Query total VRAM
        const { stdout: totalOutput } = await execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { windowsHide: true });
        const totalVRAM = parseInt(totalOutput.trim()) / 1024;

        // Update our global total if we got a real value
        config.updateVRAMValues(totalVRAM);

        // Query used VRAM
        const { stdout: usedOutput } = await execAsync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits', { windowsHide: true });
        const usedVRAM = parseInt(usedOutput.trim()) / 1024;

        return {
            total: config.VRAM_GB,
            used: usedVRAM,
            free: config.VRAM_GB - usedVRAM
        };
    } catch (error) {
        console.warn("Could not get NVIDIA GPU metrics:", error.message);
        return {
            total: config.VRAM_GB,
            used: config.RESERVED_VRAM,
            free: config.AVAILABLE_VRAM
        };
    }
}
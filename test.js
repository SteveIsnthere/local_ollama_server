import axios from 'axios';

const BASE_URL = 'http://localhost:10086'; // Your server URL
const AVAILABLE_VRAM = 16 - 3.5; // 12.5 GB

// --- Helper Functions ---

// Simple delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to make standard requests
async function makeRequest(method, endpoint, data = null, description = '') {
    console.log(`\n🚀 [${description || endpoint}] Sending ${method} request...`);
    try {
        const config = {
            method: method,
            url: `${BASE_URL}${endpoint}`,
            data: data,
            timeout: 300000 // 5 minute timeout for potentially long generations
        };
        const response = await axios(config);
        console.log(`✅ [${description || endpoint}] Success (Status ${response.status}).`);
        // Uncomment to see full response data
        // console.log('Response Data:', JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        console.error(`❌ [${description || endpoint}] Failed!`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error('   Data:', error.response.data);
        } else if (error.request) {
            console.error('   No response received:', error.message);
        } else {
            console.error('   Error setting up request:', error.message);
        }
        // Don't re-throw, allow script to continue testing other parts
        // throw error;
        return null; // Indicate failure
    }
}

// Helper for streaming requests
async function makeStreamingRequest(endpoint, data, description) {
    console.log(`\n🚀 [${description || endpoint}] Sending POST request for streaming...`);
    let receivedDone = false;
    let receivedData = false;
    let fullResponse = ''; // Collect tokens for basic verification

    try {
        const response = await axios({
            method: 'POST',
            url: `${BASE_URL}${endpoint}`,
            data: data,
            responseType: 'stream',
            timeout: 300000 // 5 min timeout
        });

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                const chunkStr = chunk.toString();
                // console.log(`💨 [${description}] Stream chunk: ${chunkStr.trim()}`); // Verbose
                // Basic parsing for SSE 'data:' lines
                const lines = chunkStr.split('\n').filter(line => line.startsWith('data: '));
                lines.forEach(line => {
                    const jsonData = line.substring(6).trim(); // Remove 'data: '
                    if (jsonData === '[DONE]') {
                        receivedDone = true;
                        console.log(`🏁 [${description}] Received [DONE] marker.`);
                    } else {
                        receivedData = true;
                        try {
                            // Tokens are sent as JSON strings, need to parse twice
                            const token = JSON.parse(jsonData);
                            fullResponse += token;
                            process.stdout.write("."); // Show progress without flooding console
                        } catch (e) {
                            console.warn(`\n⚠️ [${description}] Failed to parse stream data: ${jsonData}`, e);
                        }
                    }
                });
            });

            response.data.on('end', () => {
                process.stdout.write("\n"); // Newline after dots
                if (receivedData && receivedDone) {
                    console.log(`✅ [${description}] Stream finished successfully. Length: ${fullResponse.length}`);
                    resolve(true);
                } else if (receivedData && !receivedDone) {
                    console.warn(`⚠️ [${description}] Stream ended but [DONE] marker was NOT received.`);
                    resolve(false); // Partial success?
                } else {
                    console.error(`❌ [${description}] Stream ended with no data or [DONE] marker.`);
                    reject(new Error('Stream ended unexpectedly'));
                }
            });

            response.data.on('error', (err) => {
                console.error(`❌ [${description}] Stream error:`, err);
                reject(err);
            });
        });

    } catch (error) {
        console.error(`❌ [${description || endpoint}] Failed to establish stream!`);
        if (error.response) {
            // This usually won't happen for stream errors after connection
            console.error(`   Status: ${error.response.status}`);
            console.error('   Data:', error.response.data);
        } else {
            console.error('   Error:', error.message);
        }
        throw error; // Rethrow if connection failed
    }
}

// --- Test Cases ---

async function runTests() {
    console.log('===== Starting Ollama Server Test Suite =====');
    console.log(`Target: ${BASE_URL}`);
    console.log(`Assumed Available VRAM: ${AVAILABLE_VRAM.toFixed(2)} GB`);

    // === Test 1: Basic Endpoint Checks ===
    console.log('\n----- Test 1: Basic Endpoint Checks -----');
    await makeRequest('GET', '/models', null, 'List Models');
    await makeRequest('GET', '/system-status', null, 'Get System Status');
    // Use a very small model for basic chat/complete checks
    const smallModel = 'smollm2:135m'; // ~0.27 GB
    await makeRequest('POST', '/complete', {
        prompt: 'Generate a short poem about testing.',
        options: {model: smallModel}
    }, `Complete (${smallModel})`);
    await makeRequest('POST', '/chat', {
        messages: [{role: 'user', content: 'Explain parallel processing simply.'}],
        options: {model: smallModel}
    }, `Chat (${smallModel})`);

    // === Test 2: Streaming Check ===
    console.log('\n----- Test 2: Streaming Check -----');
    await makeStreamingRequest('/chat-stream', {
        messages: [{role: 'user', content: 'Tell me a very short story.'}],
        options: {model: smallModel}
    }, `Stream (${smallModel})`);

    await delay(2000); // Small pause

    // === Test 3: Parallel Execution (Small Models) ===
    // These should fit comfortably within 12.5 GB
    console.log('\n----- Test 3: Parallel Execution (Small Models) -----');
    const parallelModels = [
        {name: 'gemma3:1b', size: 0.8},        // ~0.8 GB
        {name: 'deepseek-r1:1.5b', size: 1.1}, // ~1.1 GB
        {name: 'granite3.1-moe:1b', size: 1.4}, // ~1.4 GB
        {name: 'llama2-uncensored', size: 3.8} // ~3.8 GB
    ];
    const totalParallelSize = parallelModels.reduce((sum, m) => sum + m.size, 0);
    console.log(`Attempting to run ${parallelModels.length} models concurrently.`);
    console.log(`Models: ${parallelModels.map(m => `${m.name} (${m.size} GB)`).join(', ')}`);
    console.log(`Estimated Total VRAM: ${totalParallelSize.toFixed(2)} GB (Should fit within ${AVAILABLE_VRAM.toFixed(2)} GB)`);
    console.log('👉 WATCH SERVER LOGS: Expect interleaved task:start and task:complete events.');

    const parallelPromises = parallelModels.map(model =>
        makeRequest('POST', '/complete', {
            prompt: `Who are you? Respond concisely. Test ID: ${Math.random()}`,
            options: {model: model.name}
        }, `Parallel ${model.name}`)
    );

    await Promise.all(parallelPromises);
    console.log('✅ Parallel requests sent. Check server logs for execution details.');
    await makeRequest('GET', '/system-status', null, 'System Status after Parallel');

    await delay(5000); // Pause to let things settle

    // === Test 4: VRAM Limit and Queuing ===
    console.log('\n----- Test 4: VRAM Limit and Queuing -----');
    // Use models that likely won't fit together
    const modelA = {name: 'mistral-nemo:latest', size: 7.1}; // ~7.1 GB
    const modelB = {name: 'granite3.2:latest', size: 4.9}; // ~4.9 GB
    const modelC = {name: 'phi4-mini:latest', size: 2.5}; // ~2.5 GB
    // A + B = 12.0 GB (Should fit)
    // A + B + C = 14.5 GB (Should NOT fit - C should queue)

    console.log(`Scenario: Run ${modelA.name} (${modelA.size} GB) and ${modelB.name} (${modelB.size} GB) concurrently (Total: ${(modelA.size + modelB.size).toFixed(2)} GB).`);
    console.log(`Then, immediately request ${modelC.name} (${modelC.size} GB).`);
    console.log(`Expected: ${modelA.name} and ${modelB.name} start. ${modelC.name} queues until one finishes.`);
    console.log('👉 WATCH SERVER LOGS: Expect task:queued for the third model.');

    const promiseA = makeRequest('POST', '/complete', {
        prompt: `Generate a long paragraph about nebula formation. Test ID: ${Math.random()}`,
        options: {model: modelA.name}
    }, `VRAM Test ${modelA.name}`);
    // Short delay to ensure A gets processed first by the server potentially
    await delay(500);
    const promiseB = makeRequest('POST', '/complete', {
        prompt: `Generate a long paragraph about deep sea vents. Test ID: ${Math.random()}`,
        options: {model: modelB.name}
    }, `VRAM Test ${modelB.name}`);

    // Give A and B a moment to potentially start loading/running
    await delay(2000);
    console.log('--- Sending request expected to queue ---');
    const promiseC = makeRequest('POST', '/complete', {
        prompt: `Generate a short list of programming languages. Test ID: ${Math.random()}`,
        options: {model: modelC.name}
    }, `VRAM Test ${modelC.name} (Queue?)`);

    // Wait for all requests to eventually complete
    await Promise.all([promiseA, promiseB, promiseC]);
    console.log('✅ VRAM Limit requests completed.');
    await makeRequest('GET', '/system-status', null, 'System Status after VRAM Limit Test');

    await delay(5000);

    // === Test 5: Model Unloading Check (Requires Manual Observation) ===
    console.log('\n----- Test 5: Model Unloading Check (Manual Observation) -----');
    const unloadTestModel = 'phi4-mini:latest'; // ~2.5 GB (Should be loaded from Test 4)
    console.log(`Requesting ${unloadTestModel} again to refresh its timer.`);
    await makeRequest('POST', '/chat', {
        messages: [{role: 'user', content: 'What is 2+2?'}],
        options: {model: unloadTestModel}
    }, `Refresh ${unloadTestModel}`);
    await makeRequest('GET', '/system-status', null, `System Status before Unload Wait`);
    console.log(`\n👉 MANUAL STEP: Wait for more than 10 minutes (server's MODEL_TIMEOUT_MS).`);
    console.log(`👉 THEN: Manually run 'curl http://localhost:10086/system-status' or re-run the '/system-status' check.`);
    console.log(`👉 EXPECT: The model '${unloadTestModel}' (and others not used recently) should eventually disappear from the 'models' list in the status, or show 0 active tasks if Ollama's keep-alive is still holding it.`);

    // === Test 6: Attempting Large Model (Potential Unloading/Queuing) ===
    console.log('\n----- Test 6: Attempting Large Model -----');
    const largeModel = 'nemotron-mini:4b-instruct-fp16'; // ~8.4 GB
    console.log(`Attempting to run ${largeModel.name} (${largeModel.size} GB).`);
    console.log(`This might require unloading previous models if VRAM is full, or it might queue.`);
    console.log(`This might require unloading previous models if VRAM is full, or it might queue.`);
    await makeRequest('POST', '/complete', {
        prompt: `Summarize the concept of large language models. Test ID: ${Math.random()}`,
        options: {model: largeModel}
    }, `Large Model ${largeModel}`);
    await makeRequest('GET', '/system-status', null, 'System Status after Large Model Attempt');


    console.log('\n===== Test Suite Finished =====');
    console.log('🙏 Please review the SERVER console output carefully alongside this script\'s output.');
    console.log('Key things to look for on the SERVER:');
    console.log('  - Interleaved task:start/task:complete for Test 3.');
    console.log('  - task:queued events during Test 4 for the third model.');
    console.log('  - model:unloaded events (possibly during Test 4 or 6, or after the 10min timeout).');
    console.log('  - Absence of errors (unless expected, like timeout).');
    console.log('  - VRAM usage numbers in logs making sense.');
}

runTests().catch(err => {
    console.error("\n\n🔥🔥🔥 An uncaught error occurred during the test script:", err);
});
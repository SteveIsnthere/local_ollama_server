// testScript.js
import fetch from 'node-fetch';

// --- Configuration ---
const BASE_URL = 'http://localhost:10086'; // Your server URL
const LARGE_MODEL = 'phi4:latest';           // Replace with a large model you have
const SMALL_MODEL_1 = 'gemma3:12b';         // Replace with a small model
const SMALL_MODEL_2 = 'deepseek-r1:14b';          // Replace with another small model
const SMALL_MODEL_3 = 'gemma3:4b';         // Replace with a third small model

// --- Helper Functions ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function apiRequest(endpoint, method = 'GET', body = null) {
    const url = `${BASE_URL}${endpoint}`;
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    console.log(`\n🚀 Sending ${method} request to ${url}`);
    if (body) console.log(`   Body: ${JSON.stringify(body).substring(0, 100)}...`);

    try {
        const response = await fetch(url, options);
        const status = response.status;
        let responseData = {};

        // Try to parse JSON, but handle potential non-JSON responses or errors
        try {
            if (response.headers.get('content-type')?.includes('application/json')) {
                responseData = await response.json();
            } else {
                responseData = await response.text();
                console.log(`   Received non-JSON response (Status: ${status}): ${responseData.substring(0, 100)}...`);
                return {status, data: responseData}; // Return text directly
            }
        } catch (e) {
            console.error(`   Error parsing JSON response from ${url} (Status: ${status}): ${e.message}`);
            // If parsing fails but status is ok, might still be useful info
            if (status >= 200 && status < 300) {
                try {
                    responseData = await response.text();
                } catch (_) {
                } // Try getting text
                responseData = {info: 'Received OK status but failed to parse JSON', raw: responseData};
            } else {
                responseData = {error: 'Failed to parse JSON response'};
            }
        }


        console.log(`   Received response (Status: ${status}): ${JSON.stringify(responseData).substring(0, 150)}...`);

        return {status, data: responseData};
    } catch (error) {
        console.error(`   Error during fetch to ${url}: ${error.message}`);
        return {status: 500, data: {error: error.message}}; // Simulate a server error status
    }
}

async function checkStatus(label = "Current Status") {
    console.log(`\n🔎 Checking ${label}...`);
    const {status, data} = await apiRequest('/system/status');
    if (status === 200 && data && typeof data === 'object') { // Ensure data is an object
        console.log(`   Game Mode: ${data.gameMode}`);
        console.log(`   Queue Length: ${data.queue?.length ?? 'N/A'}`);
        console.log(`   Tracked Active VRAM: ${data.vram?.tracked?.active?.toFixed(2) ?? 'N/A'} GB`);
        console.log(`   Actual GPU Used VRAM: ${data.vram?.used?.toFixed(2) ?? 'N/A'} GB`);
        console.log(`   Models Tracked by Server: ${data.models?.length ?? 0}`);
        if (data.models && data.models.length > 0) {
            console.log(`   Tracked Models: ${data.models.map(m => `${m.name} (${m.activeTasks} active)`).join(', ')}`);
        }
        // console.log(`   Models Loaded by Ollama: ${data.ollamaModels?.length ?? 0}`);
        return data; // Return status data
    } else {
        console.error(`   Failed to get status or invalid data received (${status})`);
        return null;
    }
}
async function runTests() {
    console.log('--- Starting Ollama Server Test Script ---');
    let statusData;

    // Initial Status Check
    await checkStatus("Initial Server Status");

    // ** Scenario 1: Basic Chat & Status **
    console.log('\n--- Scenario 1: Basic Chat & Status ---');
    // *** FIX: Target /chat endpoint ***
    await apiRequest('/chat', 'POST', {
        messages: [{ role: 'user', content: 'Say "Hello Test!"' }],
        options: { model: SMALL_MODEL_1 }
    });
    await delay(1500);
    await checkStatus("Status after basic chat");

    // ** Scenario 2: Simulate VRAM Limit & Queueing **
    console.log('\n--- Scenario 2: Simulate VRAM Limit & Queueing ---');
    console.log(`Assuming ${LARGE_MODEL} uses significant VRAM...`);

    // *** FIX: Target /complete endpoint ***
    const largeModelPromise = apiRequest('/complete', 'POST', {
        prompt: 'Generate a very short story.',
        options: { model: LARGE_MODEL }
    });

    await delay(2000);
    statusData = await checkStatus("Status after large model start");
    const vramAfterLargeStart = statusData?.vram?.tracked?.active ?? 0;
    console.log(`   Tracked VRAM likely includes large model: ${vramAfterLargeStart.toFixed(2)} GB`);

    console.log('Flooding with small model requests...');
    const smallRequestPromises = [];
    for (let i = 0; i < 5; i++) {
        smallRequestPromises.push(
            // *** FIX: Target /complete endpoint ***
            apiRequest('/complete', 'POST', {
                prompt: `Count to ${i + 1}`,
                options: { model: SMALL_MODEL_2 }
            })
        );
        await delay(100);
    }
    // ... (rest of Scenario 2 remains the same) ...
    await Promise.allSettled([largeModelPromise, ...smallRequestPromises]); // Use allSettled
    await checkStatus("Status after Scenario 2 requests attempted");


    // ** Scenario 3: Proactive Unloading Test **
    console.log('\n--- Scenario 3: Proactive Unloading Test ---');
    console.log('Loading several small models sequentially to make them inactive...');
    // *** FIX: Target /complete endpoint ***
    await apiRequest('/complete', 'POST', { prompt: '1', options: { model: SMALL_MODEL_1 }});
    await delay(5000);
    // *** FIX: Target /complete endpoint ***
    await apiRequest('/complete', 'POST', { prompt: '2', options: { model: SMALL_MODEL_2 }});
    await delay(5000);
    // *** FIX: Target /complete endpoint ***
    await apiRequest('/complete', 'POST', { prompt: '3', options: { model: SMALL_MODEL_3 }});
    await delay(5000);

    const statusBeforeUnload = await checkStatus("Status before large request (expect multiple models tracked)");
    // ... (rest of status checks) ...

    console.log(`\nSending request for ${LARGE_MODEL}, which should trigger proactive unload...`);
    console.log("👀 WATCH SERVER LOGS for 'Checking for inactive models...' and 'Attempting proactive unload...' messages!");
    // *** FIX: Target /complete endpoint ***
    const proactiveUnloadPromise = apiRequest('/complete', 'POST', {
        prompt: 'Generate another short story about space.',
        options: { model: LARGE_MODEL }
    });
    // ... (rest of Scenario 3 with timeout logic remains the same) ...
    await checkStatus("Status after proactive unload request attempt completion/timeout");


    // ** Scenario 4: Game Mode Test **
    console.log('\n--- Scenario 4: Game Mode Test ---');
    // ... (system requests are already correct) ...

    console.log('Attempting chat request while Game Mode is active (expect rejection)...');
    // *** FIX: Target /chat endpoint ***
    const gameModeRejection = await apiRequest('/chat', 'POST', {
        messages: [{ role: 'user', content: 'This should fail' }],
        options: { model: SMALL_MODEL_1 }
    });
    if (gameModeRejection.status === 503) {
        console.log('   ✅ Correctly received 503 rejection.');
    } else {
        console.error(`   ❌ Expected 503 status but got ${gameModeRejection.status}`);
    }

    // ... (disabling game mode is correct) ...

    console.log('Attempting chat request after disabling Game Mode (expect success)...');
    // *** FIX: Target /chat endpoint ***
    await apiRequest('/chat', 'POST', {
        messages: [{ role: 'user', content: 'This should now work' }],
        options: { model: SMALL_MODEL_1 }
    });
    await checkStatus("Status after Game Mode disabled and request sent");

    // ** Scenario 5: Parallel Requests (Within Limits) **
    console.log('\n--- Scenario 5: Parallel Requests (Within Limits) ---');
    console.log(`Sending requests for ${SMALL_MODEL_1} and ${SMALL_MODEL_2} concurrently...`);

    // *** FIX: Target /complete endpoint ***
    const parallelPromise1 = apiRequest('/complete', 'POST', {
        prompt: 'Parallel test 1', options: { model: SMALL_MODEL_1 }
    });
    // *** FIX: Target /complete endpoint ***
    const parallelPromise2 = apiRequest('/complete', 'POST', {
        prompt: 'Parallel test 2', options: { model: SMALL_MODEL_2 }
    });

    // ... (rest of Scenario 5 remains the same) ...
    await Promise.allSettled([parallelPromise1, parallelPromise2]); // Use allSettled
    await checkStatus("Status after parallel requests finished");


    console.log('\n--- Test Script Finished ---');
}

// Execute the tests
runTests().catch(err => {
    console.error("\n--- Test Script Aborted due to Uncaught Error ---");
    console.error(err);
});
// Dashboard functionality
document.addEventListener('DOMContentLoaded', function() {
    // Initialize VRAM chart
    const vramCtx = document.getElementById('vramChart').getContext('2d');
    const vramChart = new Chart(vramCtx, {
        type: 'doughnut',
        data: {
            labels: ['Used', 'Free', 'Reserved'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: [
                    '#dc3545',
                    '#28a745',
                    '#ffc107'
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '70%',
            plugins: {
                legend: {
                    position: 'bottom'
                }
            }
        }
    });

    // Game Mode toggle button
    const gameModeBtn = document.getElementById('gameMode');
    const gameModeStatus = document.getElementById('gameModeStatus');

    // Update game mode button and status
    function updateGameModeUI(isEnabled) {
        if (isEnabled) {
            gameModeBtn.textContent = 'Disable Game Mode';
            gameModeBtn.classList.add('danger');
            gameModeStatus.textContent = 'Active';
            gameModeStatus.classList.remove('inactive');
            gameModeStatus.classList.add('active');
        } else {
            gameModeBtn.textContent = 'Enable Game Mode';
            gameModeBtn.classList.remove('danger');
            gameModeStatus.textContent = 'Inactive';
            gameModeStatus.classList.remove('active');
            gameModeStatus.classList.add('inactive');
        }
    }

    // Toggle game mode
    gameModeBtn.addEventListener('click', async function() {
        try {
            const currentStatus = gameModeStatus.textContent === 'Active';
            const endpoint = currentStatus ? '/system/game-mode/disable' : '/system/game-mode/enable';

            // Disable button during request
            gameModeBtn.disabled = true;

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            updateGameModeUI(data.gameMode);

            // Re-enable button
            gameModeBtn.disabled = false;

            // Refresh dashboard data
            fetchDashboardData();
        } catch (error) {
            console.error('Error toggling game mode:', error);
            alert('Failed to toggle game mode. See console for details.');
            gameModeBtn.disabled = false;
        }
    });

    // Format date for display
    function formatDate(dateString) {
        if (!dateString) return 'N/A';
        const date = new Date(dateString);
        return date.toLocaleString();
    }

    // Format GPU memory size
    function formatSize(sizeInGB) {
        return parseFloat(sizeInGB).toFixed(2) + ' GB';
    }

    // Update model list
    function updateModelsList(models) {
        const modelsList = document.getElementById('modelsList');

        if (!models || models.length === 0) {
            modelsList.innerHTML = '<div class="no-models">No models currently loaded</div>';
            return;
        }

        modelsList.innerHTML = '';

        models.forEach(model => {
            const modelItem = document.createElement('div');
            modelItem.className = 'model-item';

            modelItem.innerHTML = `
                <div class="model-info">
                    <div class="model-name">${model.name}</div>
                    <div class="model-size">${model.size}</div>
                </div>
                <div class="model-details">
                    ${model.activeTasks > 0 ? `<div class="model-active-tasks">${model.activeTasks} active tasks</div>` : ''}
                    ${model.expires ? `<div class="model-expires">Expires: ${formatDate(model.expires)}</div>` : ''}
                </div>
            `;

            modelsList.appendChild(modelItem);
        });
    }

    // Update queue items
    function updateQueueItems(queue) {
        const queueCount = document.getElementById('queueCount');
        const queueItems = document.getElementById('queueItems');

        queueCount.textContent = queue.length;

        if (!queue.models || queue.models.length === 0) {
            queueItems.innerHTML = '<div class="no-queue">Queue is empty</div>';
            return;
        }

        queueItems.innerHTML = '';

        queue.models.forEach(model => {
            const queueItem = document.createElement('div');
            queueItem.className = 'queue-item';
            queueItem.textContent = model;
            queueItems.appendChild(queueItem);
        });
    }

    // Update VRAM chart and stats
    function updateVRAMInfo(vram) {
        // Update chart
        vramChart.data.datasets[0].data = [
            vram.used - vram.tracked.reserved,  // Used by other apps
            vram.free,                          // Free
            vram.tracked.reserved               // Reserved by system
        ];
        vramChart.update();

        // Update stats
        document.getElementById('totalVram').textContent = formatSize(vram.total);
        document.getElementById('usedVram').textContent = formatSize(vram.used);
        document.getElementById('freeVram').textContent = formatSize(vram.free);
        document.getElementById('reservedVram').textContent = formatSize(vram.tracked.reserved);
    }

    // Fetch dashboard data
    async function fetchDashboardData() {
        try {
            const response = await fetch('/system/status');
            const data = await response.json();

            // Update game mode status
            updateGameModeUI(data.gameMode);

            // Update VRAM info
            updateVRAMInfo(data.vram);

            // Update models list
            updateModelsList(data.models);

            // Update queue
            updateQueueItems(data.queue);
        } catch (error) {
            console.error('Error fetching dashboard data:', error);
        }
    }

    // Initial fetch
    fetchDashboardData();

    // Fetch data every 5 seconds
    setInterval(fetchDashboardData, 5000);
});

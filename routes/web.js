'use strict';

import express from 'express';
import path from 'path';
import {fileURLToPath} from 'url'; // Needed for __dirname equivalent in ES Modules

const router = express.Router();

// Get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the dashboard at the root URL
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

export default router; // Export the router
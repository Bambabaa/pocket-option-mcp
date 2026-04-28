#!/usr/bin/env node
// Quick test for confluence analysis

import { analyzeConfluence } from '../src/core/analysis.js';

console.log('Testing confluence analysis...\n');

analyzeConfluence(7)
    .then(result => {
        console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
        console.error('Error:', err.message);
        console.error(err.stack);
    });

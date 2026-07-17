require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
    db.get("SELECT COUNT(*) as count FROM licenses", (err, row) => {
        const count = (!err && row) ? row.count : -1;
        res.json({ status: 'ok', port, licenses: count, dbError: err ? err.message : null });
    });
});

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Initialize SQLite Database
const db = new sqlite3.Database('./scentmatch.db', (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDb();
    }
});

function initDb() {
    db.run(`CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_key TEXT UNIQUE NOT NULL,
        shop_url TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        plan TEXT DEFAULT 'basic'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_key TEXT NOT NULL,
        tokens_used INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    console.log('Database tables ready. Licenses are auto-created on first use.');
}

// Validation Middleware
const validateLicense = (req, res, next) => {
    const licenseKey = (req.body && req.body.license_key) || req.headers['x-api-key'];

    if (!licenseKey) {
        return res.status(401).json({ error: 'Missing license key' });
    }

    // Auto-create license on first use
    db.run(`INSERT OR IGNORE INTO licenses (license_key, shop_url) VALUES (?, ?)`, [licenseKey, 'auto'], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        db.get('SELECT * FROM licenses WHERE license_key = ?', [licenseKey], (err2, row) => {
            if (err2 || !row) {
                return res.status(403).json({ error: 'Invalid or missing license' });
            }
            if (row.status !== 'active') {
                return res.status(403).json({ error: 'License is not active' });
            }

            req.license = row;
            next();
        });
    });
};

// Main Chat Endpoint
app.post('/api/v1/chat', validateLicense, async (req, res) => {
    try {
        console.log("=== RAW REQ BODY ===");
        console.dir(req.body, { depth: null });
        console.log("====================");

        const { message, context, history } = req.body;

        if (!message || !context) {
            return res.status(400).json({ error: 'Message and context are required.' });
        }

        // Build the system prompt
        let systemPrompt = "You are an expert perfume assistant for an eshop. The user will ask for a famous original perfume. You must find the correct alternative from our list of custom scents below and recommend it warmly in Greek.\n\n";
        systemPrompt += "OUR PRODUCTS (Original -> Custom -> Category):\n";

        // Context comes directly from the WordPress plugin
        systemPrompt += context;

        systemPrompt += "\nRules: Always answer in Greek. If you find a match, give the name of our alternative and provide the link if available. Be polite and helpful. Do not mention that our perfumes are 'copies' or 'clones'; refer to them as 'inspired alternatives' or simply our suggestions.\n";
        systemPrompt += "CRITICAL RULE FOR DUPLICATES: If the requested original perfume (e.g. 'Gucci Rush' or 'Light Blue') exists in MULTIPLE versions (e.g. one for Men and one for Women), you MUST NOT assume which one they want. You MUST mention BOTH alternatives, specifying their categories, and ask the user to clarify which one they are looking for (Men's or Women's).";

        const messagesToAI = [{ role: "system", content: systemPrompt }];

        // Append history context if available
        if (history && Array.isArray(history)) {
            history.forEach(msg => {
                // Ensure only user and assistant roles go through
                if (msg.role === 'user' || msg.role === 'assistant') {
                    messagesToAI.push({ role: msg.role, content: msg.content });
                }
            });
        }

        // Append the current user message at the very end ONLY IF it's not already the last message in history
        const lastHistoryMsg = messagesToAI[messagesToAI.length - 1];
        if (!lastHistoryMsg || lastHistoryMsg.content !== message || lastHistoryMsg.role !== 'user') {
            messagesToAI.push({ role: "user", content: message });
        }

        console.log("=== SENDING TO AI ===");
        console.dir(messagesToAI, { depth: null });
        console.log("=====================");

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messagesToAI,
            temperature: 0.6,
        });

        const reply = completion.choices[0].message.content;
        const totalTokens = completion.usage.total_tokens;

        // Log Usage
        db.run('INSERT INTO usage_logs (license_key, tokens_used) VALUES (?, ?)',
            [req.license.license_key, totalTokens]
        );

        res.json({ reply, tokens: totalTokens });

    } catch (error) {
        console.error('OpenAI Error:', error);
        res.status(500).json({ error: 'Internal server error while communicating with AI.' });
    }
});

// AI Auto-Map Products Endpoint
app.post('/api/v1/map-products', validateLicense, async (req, res) => {
    try {
        const { products } = req.body;
        if (!products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ error: 'Products array is required.' });
        }

        const batchSize = 20;
        const results = [];

        for (let i = 0; i < products.length; i += batchSize) {
            const batch = products.slice(i, i + batchSize);
            const productList = batch.map((p, idx) => {
                let entry = `${i + idx + 1}. "${p.title}"`;
                if (p.description) entry += ` - Description: "${p.description.substring(0, 200)}"`;
                if (p.category) entry += ` [Category: ${p.category}]`;
                return entry;
            }).join('\n');

            const prompt = `You are a perfume expert who knows every fragrance ever made. You are helping map inspired/type perfumes to their famous original counterparts, or describe them if unknown.

For each product below, identify the famous original perfume it is inspired by. Use the name, description, and category as clues.

Products:
${productList}

Return ONLY a valid JSON array. No markdown, no code blocks, no explanation. Format:
[{"product": "exact product name", "original": "famous original name OR leave empty if unknown"}]

RULES:
- If you are confident (80%+ sure) about the original → set "original" to the famous name
- If you are NOT sure → set "original" to "" (empty string)`;

            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are a perfume expert. Return ONLY valid JSON arrays." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.3,
            });

            const reply = completion.choices[0].message.content.trim();
            try {
                const parsed = JSON.parse(reply.replace(/```json|```/g, '').trim());
                if (Array.isArray(parsed)) {
                    results.push(...parsed);
                }
            } catch (e) {
                console.error('Failed to parse AI response for batch', i, reply);
            }
        }

        console.log(`Mapped ${results.length}/${products.length} products`);
        res.json({ mapped: results, total: products.length });
    } catch (error) {
        console.error('Map Products Error:', error);
        res.status(500).json({ error: 'Error mapping products.' });
    }
});

// AI Fragrance Description Generator
app.post('/api/v1/enhance-products', validateLicense, async (req, res) => {
    try {
        const { products } = req.body;
        if (!products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ error: 'Products array is required.' });
        }

        const batchSize = 30;
        const results = [];

        for (let i = 0; i < products.length; i += batchSize) {
            const batch = products.slice(i, i + batchSize);
            const productList = batch.map((p, idx) => {
                let entry = `${i + idx + 1}. "${p.title}"`;
                if (p.category) entry += ` [Category: ${p.category}]`;
                return entry;
            }).join('\n');

            const prompt = `You are a fragrance expert. For each product below, write a short description in Greek (1-2 sentences) describing its scent profile, perfume family, and personality. Be poetic but accurate.

Products:
${productList}

Return ONLY a valid JSON array. No markdown, no code blocks, no explanation. Format:
[{"product": "exact product name", "description": "scent description in Greek"}]

Example: [{"product": "Zenith No. 1 - Éclipse Brillante", "description": "Ένα φρέσκο, φρουτώδες άρωμα με έντονες νότες ανανά, μαύρης σταφίδας και βερύκοκκου, με βάση από μόσχο και δρυ. Ιδανικό για δυναμικούς άνδρες που αγαπούν τις πολυτελείς μυρωδιές."}]`;

            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are a fragrance expert. Return ONLY valid JSON arrays." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.5,
            });

            const reply = completion.choices[0].message.content.trim();
            try {
                const parsed = JSON.parse(reply.replace(/```json|```/g, '').trim());
                if (Array.isArray(parsed)) {
                    results.push(...parsed);
                }
            } catch (e) {
                console.error('Failed to parse AI response for enhancer batch', i, reply);
            }
        }

        console.log(`Enhanced ${results.length}/${products.length} products`);
        res.json({ enhanced: results, total: products.length });
    } catch (error) {
        console.error('Enhance Products Error:', error);
        res.status(500).json({ error: 'Error enhancing products.' });
    }
});

// Start Server
app.listen(port, '0.0.0.0', () => {
    console.log(`ScentMatch API Server running on port ${port} (listening on all interfaces)`);
});

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
});

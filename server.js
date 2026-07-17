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
    res.json({ status: 'ok', port });
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

    // Seed default license if table is empty
    db.get("SELECT COUNT(*) as count FROM licenses", (err, row) => {
        if (!err && row.count === 0) {
            const licenseKey = process.env.DEFAULT_LICENSE_KEY || 'TEST-LICENSE-123';
            const shopUrl = process.env.DEFAULT_SHOP_URL || 'localhost';
            db.run(`INSERT INTO licenses (license_key, shop_url) VALUES (?, ?)`, [licenseKey, shopUrl]);
            console.log(`Created default license: ${licenseKey} for ${shopUrl}`);
        }
    });
}

// Validation Middleware
const validateLicense = (req, res, next) => {
    const licenseKey = (req.body && req.body.license_key) || req.headers['x-api-key'];

    if (!licenseKey) {
        return res.status(401).json({ error: 'Missing license key' });
    }

    db.get('SELECT * FROM licenses WHERE license_key = ?', [licenseKey], (err, row) => {
        if (err || !row) {
            return res.status(403).json({ error: 'Invalid or missing license' });
        }
        if (row.status !== 'active') {
            return res.status(403).json({ error: 'License is not active' });
        }

        req.license = row; // Attach license info to request
        next();
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

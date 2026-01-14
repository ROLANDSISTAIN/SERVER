const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const FIREBASE_URL = 'https://alertes-deriv-licenses-e0195-default-rtdb.europe-west1.firebasedatabase.app';

// Storage
let alerts = {};
let userConfigs = {};
let prices = {};

// Deriv WebSocket
let derivWs = null;
let subscribedSymbols = new Set();

function connectDeriv() {
    derivWs = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
    
    derivWs.on('open', () => {
        console.log('✅ Deriv WebSocket connected');
        subscribedSymbols.forEach(symbol => {
            derivWs.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        });
    });
    
    derivWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.tick) {
                prices[msg.tick.symbol] = msg.tick.quote;
                checkAlerts(msg.tick.symbol, msg.tick.quote);
            }
        } catch (e) {}
    });
    
    derivWs.on('close', () => {
        console.log('❌ Deriv disconnected, reconnecting...');
        setTimeout(connectDeriv, 5000);
    });
    
    derivWs.on('error', (err) => console.error('Deriv error:', err.message));
}

function subscribeSymbol(symbol) {
    if (!subscribedSymbols.has(symbol)) {
        subscribedSymbols.add(symbol);
        if (derivWs && derivWs.readyState === WebSocket.OPEN) {
            derivWs.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        }
    }
}

// Check alerts and send notifications
async function checkAlerts(symbol, currentPrice) {
    for (const odai in alerts) {
        const userAlerts = alerts[odai] || [];
        const config = userConfigs[odai];
        
        for (const alert of userAlerts) {
            if (alert.symbol !== symbol || alert.triggered) continue;
            
            let shouldTrigger = false;
            if (alert.condition === 'above' && currentPrice >= alert.price) shouldTrigger = true;
            if (alert.condition === 'below' && currentPrice <= alert.price) shouldTrigger = true;
            
            if (shouldTrigger) {
                alert.triggered = true;
                const message = `🚨 ALERTE ${alert.name}: ${symbol} a atteint ${currentPrice} (seuil: ${alert.condition === 'above' ? '↑' : '↓'} ${alert.price})`;
                
                if (config?.whatsapp) {
                    sendWhatsApp(config.whatsapp, message);
                }
                if (config?.telegram) {
                    sendTelegram(config.telegram.chatId, config.telegram.botToken, message);
                }
                console.log(`📢 Alert triggered: ${message}`);
            }
        }
    }
}

async function sendWhatsApp(phone, message) {
    try {
        const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=123456`;
        await fetch(url);
    } catch (e) {
        console.error('WhatsApp error:', e.message);
    }
}

async function sendTelegram(chatId, botToken, message) {
    try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message })
        });
    } catch (e) {
        console.error('Telegram error:', e.message);
    }
}

// API Endpoints
app.get('/health', (req, res) => {
    res.json({ status: 'running', uptime: process.uptime(), alerts: Object.keys(alerts).length });
});

app.post('/config/:odai', (req, res) => {
    const { odai } = req.params;
    userConfigs[odai] = req.body;
    res.json({ success: true });
});

app.get('/alerts/:odai', (req, res) => {
    res.json(alerts[req.params.odai] || []);
});

app.post('/alerts/:odai', (req, res) => {
    const { odai } = req.params;
    const alert = req.body;
    if (!alerts[odai]) alerts[odai] = [];
    alert.id = Date.now().toString();
    alert.triggered = false;
    alerts[odai].push(alert);
    subscribeSymbol(alert.symbol);
    res.json({ success: true, alert });
});

app.delete('/alerts/:odai/:alertId', (req, res) => {
    const { odai, alertId } = req.params;
    if (alerts[odai]) {
        alerts[odai] = alerts[odai].filter(a => a.id !== alertId);
    }
    res.json({ success: true });
});

app.post('/alerts/:odai/:alertId/reset', (req, res) => {
    const { odai, alertId } = req.params;
    if (alerts[odai]) {
        const alert = alerts[odai].find(a => a.id === alertId);
        if (alert) alert.triggered = false;
    }
    res.json({ success: true });
});

// Start
connectDeriv();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

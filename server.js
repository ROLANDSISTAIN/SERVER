cat > server.js << 'ENDOFSERVER'
const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// =============================================
// CONFIGURATION
// =============================================

const FIREBASE_URL = 'https://alertes-deriv-licenses-default-rtdb.europe-west1.firebasedatabase.app';
const DERIV_APP_ID = '1089';
const FINNHUB_API_KEY = 'd5cc5opr01qsbmgjs7r0d5cc5opr01qsbmgjs7rg';

// =============================================
// STATE
// =============================================

let derivWs = null;
let finnhubWs = null;
let prices = {};
let alerts = {}; // { odiceId: [...alerts] }
let notificationConfigs = {}; // { deviceId: { whatsapp: {...}, telegram: {...} } }
let lastNotificationTime = {};

// =============================================
// FIREBASE SYNC
// =============================================

async function syncAlertsFromFirebase() {
    try {
        const response = await fetch(`${FIREBASE_URL}/alerts.json`);
        const data = await response.json();
        if (data) {
            alerts = data;
            console.log(`📥 Synced ${Object.keys(alerts).length} devices with alerts`);
        }
    } catch (e) {
        console.error('Firebase sync error:', e);
    }
}

async function syncNotificationConfigs() {
    try {
        const response = await fetch(`${FIREBASE_URL}/notificationConfigs.json`);
        const data = await response.json();
        if (data) {
            notificationConfigs = data;
            console.log(`📥 Synced ${Object.keys(notificationConfigs).length} notification configs`);
        }
    } catch (e) {
        console.error('Notification config sync error:', e);
    }
}

// =============================================
// WHATSAPP & TELEGRAM
// =============================================

async function sendWhatsApp(phone, apiKey, message) {
    if (!phone || !apiKey) return false;
    try {
        const cleanPhone = phone.replace(/[^+\d]/g, '');
        const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
        await fetch(url);
        console.log(`📱 WhatsApp sent to ${cleanPhone}`);
        return true;
    } catch (e) {
        console.error('WhatsApp error:', e);
        return false;
    }
}

async function sendTelegram(botToken, chatId, message) {
    if (!botToken || !chatId) return false;
    try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            })
        });
        const data = await response.json();
        if (data.ok) {
            console.log(`✈️ Telegram sent to ${chatId}`);
        }
        return data.ok === true;
    } catch (e) {
        console.error('Telegram error:', e);
        return false;
    }
}

// =============================================
// ALERT CHECKING
// =============================================

function checkAlerts(symbol, currentPrice) {
    const now = Date.now();

    Object.entries(alerts).forEach(([deviceId, deviceAlerts]) => {
        if (!Array.isArray(deviceAlerts)) return;

        deviceAlerts.forEach((alert, index) => {
            if (alert.symbol !== symbol) return;

            const key = `${deviceId}-${alert.id}`;
            if (lastNotificationTime[key] && (now - lastNotificationTime[key]) < 60000) return;

            let triggered = false;
            if (alert.type === 'above' && currentPrice >= alert.price) triggered = true;
            if (alert.type === 'below' && currentPrice <= alert.price) triggered = true;

            if (triggered) {
                lastNotificationTime[key] = now;
                console.log(`🔔 Alert triggered: ${symbol} ${alert.type} ${alert.price} (current: ${currentPrice})`);

                const config = notificationConfigs[deviceId];
                if (config) {
                    const direction = alert.type === 'above' ? 'AU-DESSUS' : 'EN-DESSOUS';
                    const msg = `🔔 *ALERTE PRIX*\n📊 ${symbol}\n💰 Prix actuel: ${currentPrice.toFixed(5)}\n🎯 Seuil: ${alert.price} (${direction})\n⏰ ${new Date().toLocaleString('fr-FR')}${alert.note ? `\n📝 ${alert.note}` : ''}`;

                    if (config.whatsapp?.phone && config.whatsapp?.apiKey) {
                        sendWhatsApp(config.whatsapp.phone, config.whatsapp.apiKey, msg);
                    }

                    if (config.telegram?.botToken && config.telegram?.chatId) {
                        sendTelegram(config.telegram.botToken, config.telegram.chatId, msg);
                    }
                }

                // Remove one-time alerts
                if (alert.trigger === 'once') {
                    deviceAlerts.splice(index, 1);
                    // Update Firebase
                    fetch(`${FIREBASE_URL}/alerts/${deviceId}.json`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(deviceAlerts)
                    });
                }
            }
        });
    });
}

// =============================================
// DERIV WEBSOCKET
// =============================================

const DERIV_SYMBOLS = [
    'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
    'BOOM300N', 'BOOM500', 'BOOM600', 'BOOM900', 'BOOM1000',
    'CRASH300N', 'CRASH500', 'CRASH600', 'CRASH900', 'CRASH1000',
    'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
    'stpRNG', 'RDBEAR', 'RDBULL'
];

function connectDeriv() {
    try {
        derivWs = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`);

        derivWs.on('open', () => {
            console.log('✅ Deriv connected');
            DERIV_SYMBOLS.forEach(sym => {
                derivWs.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
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

        derivWs.on('error', (e) => console.error('Deriv error:', e.message));

        derivWs.on('close', () => {
            console.log('❌ Deriv disconnected, reconnecting in 5s...');
            setTimeout(connectDeriv, 5000);
        });
    } catch (e) {
        setTimeout(connectDeriv, 5000);
    }
}

// =============================================
// FINNHUB WEBSOCKET
// =============================================

const FINNHUB_SYMBOLS = [
    'OANDA:EUR_USD', 'OANDA:GBP_USD', 'OANDA:USD_JPY', 'OANDA:USD_CHF',
    'OANDA:AUD_USD', 'OANDA:USD_CAD', 'OANDA:NZD_USD',
    'OANDA:EUR_GBP', 'OANDA:EUR_JPY', 'OANDA:GBP_JPY',
    'OANDA:XAU_USD', 'OANDA:XAG_USD',
    'OANDA:NAS100_USD', 'OANDA:US30_USD', 'OANDA:SPX500_USD',
    'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'
];

function connectFinnhub() {
    try {
        finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);

        finnhubWs.on('open', () => {
            console.log('✅ Finnhub connected');
            FINNHUB_SYMBOLS.forEach(sym => {
                finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
            });
        });

        finnhubWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'trade' && msg.data) {
                    msg.data.forEach(trade => {
                        if (trade.s && trade.p) {
                            prices[trade.s] = trade.p;
                            checkAlerts(trade.s, trade.p);
                        }
                    });
                }
            } catch (e) {}
        });

        finnhubWs.on('error', (e) => console.error('Finnhub error:', e.message));

        finnhubWs.on('close', () => {
            console.log('❌ Finnhub disconnected, reconnecting in 5s...');
            setTimeout(connectFinnhub, 5000);
        });
    } catch (e) {
        setTimeout(connectFinnhub, 5000);
    }
}

// =============================================
// API ENDPOINTS (for the iOS/Android app)
// =============================================

// Save alerts for a device
app.post('/api/alerts/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { alerts: deviceAlerts } = req.body;

    alerts[deviceId] = deviceAlerts;

    // Save to Firebase
    await fetch(`${FIREBASE_URL}/alerts/${deviceId}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceAlerts)
    });

    console.log(`💾 Saved ${deviceAlerts.length} alerts for device ${deviceId}`);
    res.json({ success: true });
});

// Get alerts for a device
app.get('/api/alerts/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    res.json({ alerts: alerts[deviceId] || [] });
});

// Save notification config for a device
app.post('/api/config/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { whatsapp, telegram } = req.body;

    notificationConfigs[deviceId] = { whatsapp, telegram };

    // Save to Firebase
    await fetch(`${FIREBASE_URL}/notificationConfigs/${deviceId}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsapp, telegram })
    });

    console.log(`💾 Saved notification config for device ${deviceId}`);
    res.json({ success: true });
});

// Get current prices
app.get('/api/prices', (req, res) => {
    res.json({ prices });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        deriv: derivWs?.readyState === WebSocket.OPEN,
        finnhub: finnhubWs?.readyState === WebSocket.OPEN,
        alertsCount: Object.values(alerts).flat().length,
        devicesCount: Object.keys(alerts).length
    });
});

// =============================================
// START SERVER
// =============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);

    // Initial sync from Firebase
    syncAlertsFromFirebase();
    syncNotificationConfigs();

    // Periodic sync every 5 minutes
    setInterval(() => {
        syncAlertsFromFirebase();
        syncNotificationConfigs();
    }, 5 * 60 * 1000);

    // Connect to price feeds
    connectDeriv();
    connectFinnhub();
});
ENDOFSERVER

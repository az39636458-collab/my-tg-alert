const Bitunix = require('./Bitunix');
const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const Redis = require('ioredis');

const app = express();
app.use(cors());

// ==================== 基本配置 ====================
// 🛑 【模擬盤總開關】：true = 虛擬監控不花錢；false = 真金白銀自動下單
const IS_PAUSED = false; 

const apiId = 31121887;
const apiHash = "6ce79e991f0849d80969c6ceae8e3be0";
const signalChannel = "-1003749280511";
const sessionString = "1BQANOTEuMTA4LjU2LjEyOQG7ujm2g/sSrgws1fBfTt7BHOyn3x5y8XPC/YxqkPsqz3QzYuKD2SSsDzovU3YbGFYQTUFfmdmI7It1pVzLnAzTF2onBFP5D2oAKKF/Qm9TJ42pIPj6M8XRAtmF+oHBSSzABWkAw8rrzZjdODf1v3/6GvkgKZnVS2d4zfzNrl7hDiXRSUOnqwPyxrDsw7q6FCbDa1XZr1GFkzqL2D62G/ucjgsAsaZ006vNIhQaLKtv9m48YyC94TAuEi5/CqYj7vS6vtHRU4zo5ozrUVRmJqMVnJqQ8StsOiv3v0CjtGhUu8Q8vYiEphafTpmpgV8I1LgLRfPv/DCKL5e4VzmFEk74xw==";

const POSITIONS_KEY = 'active_trading_positions';
const HISTORY_KEY = 'signal_history';

const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('✅ Redis 已連線'));

const bitunix = new Bitunix({
    apiKey: process.env.BITUNIX_API_KEY,
    apiSecret: process.env.BITUNIX_API_SECRET
});

const activePositions = new Map();
let signalHistory = []; 

app.get('/api/history', (req, res) => res.json(signalHistory));
app.get('/api/active', (req, res) => res.json(Array.from(activePositions.values())));

app.get('/api/klines/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const interval = req.query.interval || '15m'; 
        const response = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("抓取 K 線失敗", error);
        res.status(500).json({ error: "Fetch failed" });
    }
});

// 🚀 真實倉位監控 (當 IS_PAUSED = false 時運作)
async function monitorPosition(positionId, symbol, originalQty) {
    const interval = setInterval(async () => {
        try {
            const positions = await bitunix.getPendingPositions(symbol);
            if (!positions || positions.code !== 0) return;

            const pos = positions?.data?.find(p => p.positionId === positionId);
            if (!pos) {
                console.log(`✅ ${symbol} 倉位已消失，正在判斷是止盈還是止損...`);
                activePositions.delete(positionId);
                await redis.hdel(POSITIONS_KEY, positionId);
                
                const signal = signalHistory.find(s => s.symbol === symbol && s.status === '監控中');
                if (signal) {
                    let finalStatus = '已平倉'; 
                    try {
                        const res = await fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`);
                        const data = await res.json();
                        if (data && data.price) {
                            const currentPrice = parseFloat(data.price);
                            const isLong = signal.sideText === '多';
                            const entry = signal.actualEntryPrice || signal.signalPrice;
                            if (isLong) finalStatus = currentPrice >= entry ? '已止盈' : '已止損';
                            else finalStatus = currentPrice <= entry ? '已止盈' : '已止損';
                        }
                    } catch (e) { console.log("查價失敗，使用預設狀態"); }

                    signal.status = finalStatus;
                    await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));
                }
                clearInterval(interval);
                return;
            }
        } catch (err) { console.error(`❌ 監控異常:`, err.message); }
    }, 5000);
}

// 🎯 升級版：虛擬模擬盤監控引擎 (改用 K 線最高/最低價，與圖表 100% 同步)
setInterval(async () => {
    const virtualSignals = signalHistory.filter(s => s.status === '虛擬監控中');
    if (virtualSignals.length === 0) return;

    for (const signal of virtualSignals) {
        try {
            // 直接去抓 1 分鐘 K 線資料，確保判斷標準跟你的圖表一模一樣！
            const res = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${signal.symbol}&interval=1m&limit=1`);
            const klines = await res.json();
            if (Array.isArray(klines) && klines.length > 0) {
                const lastK = klines[klines.length - 1];
                const high = parseFloat(lastK[2]); // 抓出這根 K 線的最高點
                const low = parseFloat(lastK[3]);  // 抓出這根 K 線的最低點

                const isLong = signal.sideText === '多';
                
                // 用最高/最低點來判斷，絕對不會再有「沒打到線卻觸發」的幽靈事件
                if (isLong) {
                    if (high >= signal.tp1Price) signal.status = '✅虛擬止盈';
                    else if (low <= signal.stopLoss) signal.status = '❌虛擬止損';
                } else {
                    if (low <= signal.tp1Price) signal.status = '✅虛擬止盈';
                    else if (high >= signal.stopLoss) signal.status = '❌虛擬止損';
                }

                if (signal.status !== '虛擬監控中') {
                    await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));
                    console.log(`📊 模擬盤結算: ${signal.symbol} 觸發 ${signal.status}`);
                }
            }
        } catch (err) { /* 忽略網路偶發錯誤 */ }
        
        await new Promise(r => setTimeout(r, 1000));
    }
}, 10000); 

// ==================== 自動下單流程 ====================
async function executeOrder(messageText, receiveTime) {
    const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
    const dirMatch = messageText.match(/方向[：:\s]*(多|空)/);
    const entryPriceMatch = messageText.match(/收盤價[：:]([\d\.]+)/);
    const stopLossMatch = messageText.match(/建議停損[：:]([\d\.]+)/);
    const takeProfit1Match = messageText.match(/建議停利一[：:]([\d\.]+)/);
    
    if (!coinMatch || !dirMatch || !entryPriceMatch || !stopLossMatch || !takeProfit1Match) return;

    const symbol = coinMatch[1];
    const sideText = dirMatch[1];
    const side = sideText === '空' ? 'SELL' : 'BUY';
    const signalPrice = parseFloat(entryPriceMatch[1]);
    const stopLoss = parseFloat(stopLossMatch[1]);
    const tp1Price = parseFloat(takeProfit1Match[1]);

    const newSignal = { 
        symbol, sideText, signalPrice, stopLoss, tp1Price, 
        tp2Price: null, tp3Price: null, triggerCount: "-", keyPrices: "-", 
        actualEntryPrice: null, 
        time: receiveTime, status: '等待開盤' 
    };
    
    signalHistory.unshift(newSignal);
    if (signalHistory.length > 50) signalHistory.pop();
    await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));

    const now = new Date();
    // 計算距離下一分鐘（換線）還有幾秒
    const msToNextMinute = 60000 - (now.getSeconds() * 1000) - now.getMilliseconds();

    // 🛑 修正版模擬盤邏輯：乖乖等到換線，才把狀態切成「虛擬監控中」！
    if (IS_PAUSED) {
        console.log(`⏳ ${symbol} 模擬盤：將於 ${Math.floor(msToNextMinute/1000)} 秒後(換線時)進入虛擬監控...`);
        setTimeout(async () => {
            const s = signalHistory.find(x => x.time === receiveTime && x.symbol === symbol);
            if (s && s.status === '等待開盤') {
                s.status = '虛擬監控中';
                s.actualEntryPrice = signalPrice; // 假裝以快訊價進場
                await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));
                console.log(`⏸️ ${symbol} 模擬盤：已正式進入虛擬監控，等待觸發目標價！`);
            }
        }, msToNextMinute);
        return;
    }

    if ([...activePositions.values()].some(p => p.symbol === symbol && p.side === side)) {
        newSignal.status = '略過(已有單)';
        await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));
        return console.log(`⏭️ ${symbol} 已有倉位，略過。`);
    }

    console.log(`⏳ ${symbol} 訊號已確認，${Math.floor(msToNextMinute/1000)} 秒後於下一根 1m 開盤進場...`);

    setTimeout(async () => {
        try {
            const slPercent = Math.abs((stopLoss - signalPrice) / signalPrice);
            let targetValue = 5 / slPercent;
            if (targetValue > 200) targetValue = 200;
            const totalQty = Math.floor(targetValue / signalPrice);

            if (totalQty <= 0) {
                newSignal.status = '數量為0略過';
                await redis.set(HISTORY_KEY, JSON.stringify(signalHistory)); return;
            }
            
            const orderRes = await bitunix.placeMarketOrder(symbol, side, totalQty);
            if (orderRes.code !== 0) {
                newSignal.status = '下單失敗';
                await redis.set(HISTORY_KEY, JSON.stringify(signalHistory)); return;
            }

            await new Promise(r => setTimeout(r, 2000));
            const positions = await bitunix.getPendingPositions(symbol);
            const pos = positions?.data?.find(p => p.symbol === symbol);
            if (!pos) return;

            const actualEntry = parseFloat(pos.avgOpenPrice);
            const posData = { symbol, side, entryPrice: actualEntry, totalQty, tp1Price, stopLoss, time: new Date().toLocaleString() };
            
            activePositions.set(pos.positionId, posData);
            await redis.hset(POSITIONS_KEY, pos.positionId, JSON.stringify(posData));
            await bitunix.placeTpSl(symbol, pos.positionId, tp1Price, totalQty, stopLoss, totalQty);
            monitorPosition(pos.positionId, symbol, totalQty);
            
            newSignal.actualEntryPrice = actualEntry;
            newSignal.status = '監控中';
            await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));
            console.log(`✅ ${symbol} 執行成功！實際進場均價: ${actualEntry}`);
        } catch (err) { console.error('❌ 執行出錯:', err.message); }
    }, msToNextMinute);
}

async function startBot() {
    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    console.log("✅ Telegram 連線成功");
    
    const savedPos = await redis.hgetall(POSITIONS_KEY);
    for (const [id, data] of Object.entries(savedPos)) {
        const info = JSON.parse(data);
        activePositions.set(id, info);
        monitorPosition(id, info.symbol, info.totalQty);
    }
    const savedH = await redis.get(HISTORY_KEY);
    if (savedH) signalHistory = JSON.parse(savedH);
    
    client.addEventHandler(async (event) => {
        const messageText = event.message.message || "";
        const chatId = event.message.chatId?.toString();
        if ((chatId === signalChannel) && messageText.includes("【幣幣篩選】")) {
            await executeOrder(messageText, new Date(event.message.date * 1000).toLocaleString());
        }
    }, new NewMessage({}));
}

startBot();
app.listen(process.env.PORT || 3000, '0.0.0.0');
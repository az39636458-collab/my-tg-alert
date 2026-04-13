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
const apiId = 31121887;
const apiHash = "6ce79e991f0849d80969c6ceae8e3be0";
const signalChannel = "-1003749280511";
const sessionString = "1BQANOTEuMTA4LjU2LjEyOQG7ujm2g/sSrgws1fBfTt7BHOyn3x5y8XPC/YxqkPsqz3QzYuKD2SSsDzovU3YbGFYQTUFfmdmI7It1pVzLnAzTF2onBFP5D2oAKKF/Qm9TJ42pIPj6M8XRAtmF+oHBSSzABWkAw8rrzZjdODf1v3/6GvkgKZnVS2d4zfzNrl7hDiXRSUOnqwPyxrDsw7q6FCbDa1XZr1GFkzqL2D62G/ucjgsAsaZ006vNIhQaLKtv9m48YyC94TAuEi5/CqYj7vS6vtHRU4zo5ozrUVRmJqMVnJqQ8StsOiv3v0CjtGhUu8Q8vYiEphafTpmpgV8I1LgLRfPv/DCKL5e4VzmFEk74xw==";

const POSITIONS_KEY = 'active_trading_positions';
const HISTORY_KEY = 'signal_history';
const HISTORY_14399_KEY = 'history_14399'; // 🎯 新增：專屬 14399 的資料夾

const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('✅ Redis 已連線'));

const bitunix = new Bitunix({
    apiKey: process.env.BITUNIX_API_KEY,
    apiSecret: process.env.BITUNIX_API_SECRET
});

const activePositions = new Map();
let signalHistory = []; // 給幣幣篩選用 (50筆)
let history14399 = [];  // 給 14399 用 (150筆)

// ==================== 網頁 API 通道 ====================
app.get('/api/history', (req, res) => res.json(signalHistory));         // 量化戰情室 Pro 專用
app.get('/api/history-14399', (req, res) => res.json(history14399));    // 14399 瀑布流網頁專用
app.get('/api/active', (req, res) => res.json(Array.from(activePositions.values())));

app.get('/api/klines/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const interval = req.query.interval || '15m'; 
        const response = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`);
        const data = await response.json();
        res.json(data);
    } catch (error) { res.status(500).json({ error: "Fetch failed" }); }
});

// ==================== 核心一：幣幣篩選專用 (自動下單監控) ====================
async function monitorPosition(positionId, symbol, originalQty) {
    const interval = setInterval(async () => {
        try {
            const positions = await bitunix.getPendingPositions(symbol);
            if (!positions || positions.code !== 0) return;

            const pos = positions?.data?.find(p => p.positionId === positionId);
            if (!pos) {
                activePositions.delete(positionId);
                await redis.hdel(POSITIONS_KEY, positionId);
                
                const signal = signalHistory.find(s => s.symbol === symbol && s.status === '監控中');
                if (signal) {
                    signal.status = '已平倉';
                    await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));
                }
                clearInterval(interval);
                return;
            }
        } catch (err) { console.error(`❌ 監控異常:`, err.message); }
    }, 5000);
}

async function executeOrder(messageText, receiveTime) {
    const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
    const dirMatch = messageText.match(/方向[：:\s]*(多|空)/);
    const entryPriceMatch = messageText.match(/收盤價[：:]([\d\.]+)/);
    const stopLossMatch = messageText.match(/建議停損[：:]([\d\.]+)/);
    const takeProfit1Match = messageText.match(/建議停利一[：:]([\d\.]+)/);
    const triggerMatch = messageText.match(/觸發次數[：:]([\d]+)/);
    const takeProfit2Match = messageText.match(/建議停利二[：:]([\d\.]+)/);
    const takeProfit3Match = messageText.match(/建議停利三[：:]([\d\.]+)/);
    const keyPriceMatch = messageText.match(/關鍵價格[：:](.+)/);

    if (!coinMatch || !dirMatch || !entryPriceMatch || !stopLossMatch || !takeProfit1Match) return;

    const symbol = coinMatch[1];
    const side = dirMatch[1] === '空' ? 'SELL' : 'BUY';
    const signalPrice = parseFloat(entryPriceMatch[1]);
    const stopLoss = parseFloat(stopLossMatch[1]);
    const tp1Price = parseFloat(takeProfit1Match[1]);

    const newSignal = { 
        symbol, sideText: dirMatch[1], signalPrice, stopLoss, tp1Price, 
        tp2Price: takeProfit2Match ? parseFloat(takeProfit2Match[1]) : null, 
        tp3Price: takeProfit3Match ? parseFloat(takeProfit3Match[1]) : null, 
        triggerCount: triggerMatch ? triggerMatch[1] : "-", 
        keyPrices: keyPriceMatch ? keyPriceMatch[1].trim() : "-", 
        actualEntryPrice: null, time: receiveTime, status: '等待開盤' 
    };
    
    signalHistory.unshift(newSignal);
    if (signalHistory.length > 50) signalHistory.pop();
    await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));

    if ([...activePositions.values()].some(p => p.symbol === symbol && p.side === side)) {
        newSignal.status = '略過(已有單)';
        await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));
        return;
    }

    const now = new Date();
    const msToNextMinute = 60000 - (now.getSeconds() * 1000) - now.getMilliseconds();

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
        } catch (err) { console.error('❌ 執行出錯:', err.message); }
    }, msToNextMinute);
}

// ==================== 核心二：14399 專用 (純紀錄，最多 150 筆) ====================
async function record14399(messageText, receiveTime) {
    const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
    if (!coinMatch) return; // 沒幣種就當雜訊略過

    // 寬鬆抓取，因為 14399 格式可能不同
    const dirMatch = messageText.match(/(多|空|Long|Short)/i) || ["", "未知"];
    const entryPriceMatch = messageText.match(/([\d\.]+)/) || ["", "0"]; // 簡單抓數字
    
    // 試著抓停損停利，抓不到就留白
    const stopLossMatch = messageText.match(/(停損|止損)[：:\s]*([\d\.]+)/);
    const tpMatch = messageText.match(/(停利|止盈)[：:\s]*([\d\.]+)/);

    const sideText = (dirMatch[1].includes('多') || dirMatch[1].toLowerCase().includes('long')) ? '多' : '空';
    
    const newSignal = { 
        symbol: coinMatch[1], 
        sideText: sideText, 
        signalPrice: parseFloat(entryPriceMatch[1]) || 0, 
        stopLoss: stopLossMatch ? parseFloat(stopLossMatch[2]) : '-', 
        tp1Price: tpMatch ? parseFloat(tpMatch[2]) : '-', 
        time: receiveTime, 
        status: '已接收' 
    };
    
    history14399.unshift(newSignal);
    if (history14399.length > 150) history14399.pop(); // 🎯 確保維持 150 筆
    await redis.set(HISTORY_14399_KEY, JSON.stringify(history14399));
    console.log(`📝 已記錄 14399 快訊: ${coinMatch[1]}`);
}

// ==================== 啟動 ====================
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
    
    // 讀取兩邊的歷史紀錄
    const savedH = await redis.get(HISTORY_KEY);
    if (savedH) signalHistory = JSON.parse(savedH);
    const saved14399 = await redis.get(HISTORY_14399_KEY);
    if (saved14399) history14399 = JSON.parse(saved14399);
    
    client.addEventHandler(async (event) => {
        const messageText = event.message.message || "";
        const chatId = event.message.chatId?.toString();
        
        if (chatId === signalChannel) {
            // 🛑 分流器：如果是幣幣篩選，交給核心一；否則有 USDT 的都交給核心二當作 14399
            if (messageText.includes("【幣幣篩選】")) {
                await executeOrder(messageText, new Date(event.message.date * 1000).toLocaleString());
            } else if (messageText.includes("14399") || messageText.includes("USDT")) {
                await record14399(messageText, new Date(event.message.date * 1000).toLocaleString());
            }
        }
    }, new NewMessage({}));
}

startBot();
app.listen(process.env.PORT || 3000, '0.0.0.0');
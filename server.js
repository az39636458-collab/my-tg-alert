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

const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('✅ Redis 已連線'));

const bitunix = new Bitunix({
    apiKey: process.env.BITUNIX_API_KEY,
    apiSecret: process.env.BITUNIX_API_SECRET
});

const activePositions = new Map();
let signalHistory = []; 

// ==================== 網頁儀表板專用 API ====================
app.get('/api/history', (req, res) => res.json(signalHistory));
app.get('/api/active', (req, res) => res.json(Array.from(activePositions.values())));

// ==================== 倉位監控邏輯 (打到 TP1 即全平) ====================
async function monitorPosition(positionId, symbol, originalQty) {
    const interval = setInterval(async () => {
        try {
            const positions = await bitunix.getPendingPositions(symbol);
            if (!positions || positions.code !== 0) return;

            const pos = positions?.data?.find(p => p.positionId === positionId);
            if (!pos) {
                console.log(`✅ ${symbol} 倉位已消失 (已全平止盈或停損)`);
                activePositions.delete(positionId);
                await redis.hdel(POSITIONS_KEY, positionId);
                clearInterval(interval);
                return;
            }
            console.log(`🔍 ${symbol} 監控中: 數量=${pos.qty}/${originalQty}`);
        } catch (err) { console.error(`❌ 監控異常:`, err.message); }
    }, 5000);
}

// ==================== 自動下單流程 (職業風控 + 延遲進場) ====================
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

    // 📝 寫入歷史紀錄 (準備給側邊欄)
    const newSignal = { symbol, sideText, signalPrice, stopLoss, tp1Price, time: receiveTime, status: '等待開盤' };
    signalHistory.unshift(newSignal);
    if (signalHistory.length > 50) signalHistory.pop();
    await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));

    if ([...activePositions.values()].some(p => p.symbol === symbol && p.side === side)) {
        newSignal.status = '略過(已有單)';
        return console.log(`⏭️ ${symbol} 已有倉位，略過。`);
    }

    // ⏳ 延遲進場：等待下一個 1m 開盤
    const now = new Date();
    const msToNextMinute = 60000 - (now.getSeconds() * 1000) - now.getMilliseconds();
    console.log(`⏳ ${symbol} 訊號已確認，${Math.floor(msToNextMinute/1000)} 秒後於下一根 1m 開盤進場...`);

    setTimeout(async () => {
        try {
            const ticker = await bitunix.getTicker(symbol);
            const currentEntryPrice = parseFloat(ticker.data.last);

            // 🎯 職業風控核心：無論停損多遠，固定只賠 5 USDT
            const slPercent = Math.abs((stopLoss - currentEntryPrice) / currentEntryPrice);
            
            // 公式：總倉位(價值) = 固定風險金額(5U) / 停損百分比
            let targetValue = 5 / slPercent;
            
            // 安全限制：總倉位價值最高不超過 200U (防止極端近距離停損導致爆倉)
            if (targetValue > 200) targetValue = 200;

            const leverage = 20; 
            const totalQty = Math.floor(targetValue / currentEntryPrice);

            if (totalQty <= 0) return console.log("⚠️ 價格過高或計算數量為0，略過");

            console.log(`🚀 1m 開盤進場！${symbol} | 停損距離: ${(slPercent*100).toFixed(2)}% | 預計虧損: 5U`);
            
            const orderRes = await bitunix.placeMarketOrder(symbol, side, totalQty);
            if (orderRes.code !== 0) return console.error(`❌ 下單失敗:`, orderRes.msg);

            await new Promise(r => setTimeout(r, 2000));
            const positions = await bitunix.getPendingPositions(symbol);
            const pos = positions?.data?.find(p => p.symbol === symbol);
            if (!pos) return;

            const posData = { symbol, side, entryPrice: parseFloat(pos.avgOpenPrice), totalQty, tp1Price, stopLoss, time: new Date().toLocaleString() };
            activePositions.set(pos.positionId, posData);
            await redis.hset(POSITIONS_KEY, pos.positionId, JSON.stringify(posData));

            // 打到 TP1 直接 100% 全平
            await bitunix.placeTpSl(symbol, pos.positionId, tp1Price, totalQty, stopLoss, totalQty);
            monitorPosition(pos.positionId, symbol, totalQty);
            
            newSignal.status = '監控中';
            await redis.set(HISTORY_KEY, JSON.stringify(signalHistory));
            console.log(`✅ ${symbol} 執行成功！`);

        } catch (err) { console.error('❌ 執行出錯:', err.message); }
    }, msToNextMinute);
}

// ==================== 啟動 ====================
async function startBot() {
    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    console.log("✅ Telegram 連線成功");
    
    // 恢復數據
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
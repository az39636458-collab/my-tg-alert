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

const LIVE_TRADING = true; 
const POSITIONS_KEY = 'active_trading_positions';
// =================================================

const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('✅ Redis 已連線'));

const bitunix = new Bitunix({
    apiKey: process.env.BITUNIX_API_KEY,
    apiSecret: process.env.BITUNIX_API_SECRET
});

const activePositions = new Map();

// ==================== 倉位監控邏輯 ====================
async function monitorPosition(positionId, symbol, originalQty, entryPrice) {
    const interval = setInterval(async () => {
        try {
            // 因為現在是 TP1 全平，所以只要倉位消失，就代表止盈或止損了
            const positions = await bitunix.getPendingPositions(symbol);
            if (!positions || positions.code !== 0) return;

            const pos = positions?.data?.find(p => p.positionId === positionId);
            if (!pos) {
                console.log(`✅ ${symbol} 倉位已消失 (已全數止盈或止損)，結束監控。`);
                activePositions.delete(positionId);
                await redis.hdel(POSITIONS_KEY, positionId);
                clearInterval(interval);
                return;
            }

            console.log(`🔍 ${symbol} 監控中: 目前數量=${pos.qty}/${originalQty}`);
            
        } catch (err) { console.error(`❌ 監控異常:`, err.message); }
    }, 5000);
}

// ==================== 記憶恢復 ====================
async function recoverPositions() {
    const saved = await redis.hgetall(POSITIONS_KEY);
    for (const [posId, data] of Object.entries(saved)) {
        const info = JSON.parse(data);
        activePositions.set(posId, info);
        monitorPosition(posId, info.symbol, info.totalQty, info.entryPrice);
        console.log(`♻️ 已恢復監控: ${info.symbol}`);
    }
}

// ==================== 自動下單流程 (極簡防禦版) ====================
async function executeOrder(messageText) {
    const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
    const dirMatch = messageText.match(/方向[：:\s]*(多|空)/);
    const entryPriceMatch = messageText.match(/收盤價[：:]([\d\.]+)/);
    const stopLossMatch = messageText.match(/建議停損[：:]([\d\.]+)/);
    const takeProfit1Match = messageText.match(/建議停利一[：:]([\d\.]+)/);

    if (!coinMatch || !dirMatch || !entryPriceMatch || !stopLossMatch || !takeProfit1Match) return;

    const symbol = coinMatch[1];
    const sideText = dirMatch[1];
    const side = sideText === '空' ? 'SELL' : 'BUY';
    const entryPrice = parseFloat(entryPriceMatch[1]);
    const stopLoss = parseFloat(stopLossMatch[1]); // 直接照快訊的停損
    const tp1Price = parseFloat(takeProfit1Match[1]);

    // 🚀 一幣不兩投
    const hasPosition = [...activePositions.values()].some(p => p.symbol === symbol && p.side === side);
    if (hasPosition) {
        console.log(`⏭️ ${symbol} 已有同向倉位，略過。`);
        return;
    }

    // ================= 💰 核心策略：固定 5U，全平 TP1 =================
    const margin = 5;       // 固定 5 USDT
    const leverage = 20;    // 20 倍槓桿
    
    // 計算下單數量
    const totalQty = Math.floor((margin * leverage) / entryPrice);
    
    // 🎯 關鍵修改：TP1 的數量 = 總數量 (打到 TP1 直接 100% 平倉)
    const tp1Qty = totalQty; 

    console.log(`-----------------------------------`);
    console.log(`🛡️ 啟動極簡防禦: 固定 ${margin}U | 停損照舊 | 打到 TP1 全平`);
    console.log(`🤖 作戰計畫: 做${sideText} ${symbol} | 總數量: ${totalQty} 顆`);
    console.log(`-----------------------------------`);

    if (totalQty <= 0) return console.log("⚠️ 價格過高，5U 無法買入 1 顆，略過開倉");

    try {
        const orderRes = await bitunix.placeMarketOrder(symbol, side, totalQty);
        if (orderRes.code !== 0) return console.error(`❌ 下單失敗:`, orderRes.msg);

        await new Promise(r => setTimeout(r, 2000));
        const positions = await bitunix.getPendingPositions(symbol);
        const pos = positions?.data?.find(p => p.symbol === symbol);
        if (!pos) return;

        const posData = {
            symbol, side, entryPrice: parseFloat(pos.avgOpenPrice),
            totalQty, tp1Qty, 
            tp1Price, stopLoss, phase: 1
        };

        activePositions.set(pos.positionId, posData);
        await redis.hset(POSITIONS_KEY, pos.positionId, JSON.stringify(posData));

        // 掛出 TP1 (100% 數量) 與 StopLoss
        await bitunix.placeTpSl(symbol, pos.positionId, posData.tp1Price, tp1Qty, posData.stopLoss, totalQty);
        monitorPosition(pos.positionId, symbol, totalQty, posData.entryPrice);
        console.log(`✅ ${symbol} 下單與監控啟動！`);
    } catch (err) { console.error('❌ 錯誤:', err.message); }
}

async function startBot() {
    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    console.log("✅ Telegram 連線成功");
    await recoverPositions();
    client.addEventHandler(async (event) => {
        const messageText = event.message.message || "";
        const chatId = event.message.chatId?.toString();
        if ((chatId === signalChannel) && messageText.includes("【幣幣篩選】")) {
            await executeOrder(messageText);
        }
    }, new NewMessage({}));
}

startBot();
app.listen(process.env.PORT || 3000);
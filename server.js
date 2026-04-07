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
            const posInfo = activePositions.get(positionId);
            if (!posInfo) { clearInterval(interval); return; }

            const positions = await bitunix.getPendingPositions(symbol);
            if (!positions || positions.code !== 0) return;

            const pos = positions?.data?.find(p => p.positionId === positionId);
            if (!pos) {
                console.log(`✅ ${symbol} 倉位已消失，監控結束。`);
                activePositions.delete(positionId);
                await redis.hdel(POSITIONS_KEY, positionId);
                clearInterval(interval);
                return;
            }

            const currentQty = parseFloat(pos.qty);
            console.log(`🔍 ${symbol} 階段${posInfo.phase}: 數量=${currentQty}/${originalQty}`);

            // 止盈一成交邏輯
            if (posInfo.phase === 1 && currentQty < originalQty * 0.9) {
                console.log(`🎯 ${symbol} 止盈一成交！執行保本止損...`);
                posInfo.phase = 2;
                await bitunix.cancelAllTpSl(symbol, positionId);
                const tp2Qty = Math.floor(currentQty * 0.8);
                const tp3Qty = currentQty - tp2Qty;
                if (posInfo.tp2Price) {
                    await bitunix.placeTpSl(symbol, positionId, posInfo.tp2Price, tp2Qty, entryPrice, currentQty);
                    posInfo.tp3Qty = tp3Qty;
                    await redis.hset(POSITIONS_KEY, positionId, JSON.stringify(posInfo));
                }
            }
            // 止盈二成交邏輯
            else if (posInfo.phase === 2 && posInfo.tp3Qty && currentQty <= posInfo.tp3Qty * 1.1) {
                console.log(`🎯 ${symbol} 止盈二成交！`);
                posInfo.phase = 3;
                await bitunix.cancelAllTpSl(symbol, positionId);
                if (posInfo.tp3Price) {
                    await bitunix.placeTpSl(symbol, positionId, posInfo.tp3Price, currentQty, posInfo.tp1Price, currentQty);
                    await redis.hset(POSITIONS_KEY, positionId, JSON.stringify(posInfo));
                }
            }
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
        console.log(`♻️ 已恢復監控: ${info.symbol} (Phase ${info.phase})`);
    }
}

// ==================== 自動下單流程 (固定保證金版) ====================
async function executeOrder(messageText) {
    const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
    const dirMatch = messageText.match(/方向[：:\s]*(多|空)/);
    const entryPriceMatch = messageText.match(/收盤價[：:]([\d\.]+)/);
    const stopLossMatch = messageText.match(/建議停損[：:]([\d\.]+)/);
    const takeProfit1Match = messageText.match(/建議停利一[：:]([\d\.]+)/);
    // 支援簡繁體的建議停利
    const takeProfit2Match = messageText.match(/建议停利二[：:]([\d\.]+)/) || messageText.match(/建議停利二[：:]([\d\.]+)/);
    const takeProfit3Match = messageText.match(/建议停利三[：:]([\d\.]+)/) || messageText.match(/建議停利三[：:]([\d\.]+)/);

    if (!coinMatch || !dirMatch || !entryPriceMatch || !stopLossMatch || !takeProfit1Match) return;

    const symbol = coinMatch[1];
    const sideText = dirMatch[1];
    const side = sideText === '空' ? 'SELL' : 'BUY';
    const entryPrice = parseFloat(entryPriceMatch[1]);
    const stopLoss = parseFloat(stopLossMatch[1]);

    // 🚀 一幣不兩投
    const hasPosition = [...activePositions.values()].some(p => p.symbol === symbol && p.side === side);
    if (hasPosition) {
        console.log(`⏭️ ${symbol} 已有同向倉位，略過。`);
        return;
    }

    // ================= 固定美金與槓桿邏輯 =================
    const slPercent = Math.abs((stopLoss - entryPrice) / entryPrice) * 100;
    
    // 判斷要用的美金 (大於等於 8% 用 8 美金，否則用 10 美金)
    const margin = slPercent >= 8 ? 8 : 10; 
    const leverage = 20; 
    
    // 計算下單的真實數量
    const totalQty = Math.floor((margin * leverage) / entryPrice);
    const tp1Qty = Math.floor(totalQty * 0.8);

    // 🚀 印出專屬你的作戰儀表板
    console.log(`📊 停損幅度: ${slPercent.toFixed(2)}% | 決定使用保證金: ${margin} USDT`);
    console.log(`🤖 作戰計畫: 做${sideText} ${symbol} | 總數量: ${totalQty} 顆`);

    if (totalQty <= 0) return console.log("⚠️ 計算出的數量小於 0，無法開倉");

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
            tp1Price: parseFloat(takeProfit1Match[1]),
            tp2Price: takeProfit2Match ? parseFloat(takeProfit2Match[1]) : null,
            tp3Price: takeProfit3Match ? parseFloat(takeProfit3Match[1]) : null,
            stopLoss, phase: 1
        };

        activePositions.set(pos.positionId, posData);
        await redis.hset(POSITIONS_KEY, pos.positionId, JSON.stringify(posData));

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
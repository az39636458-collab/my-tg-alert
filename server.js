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
const targetChannel = "-1003202637717";
const signalChannel = "-1003749280511";
const sessionString = "1BQANOTEuMTA4LjU2LjEyOQG7ujm2g/sSrgws1fBfTt7BHOyn3x5y8XPC/YxqkPsqz3QzYuKD2SSsDzovU3YbGFYQTUFfmdmI7It1pVzLnAzTF2onBFP5D2oAKKF/Qm9TJ42pIPj6M8XRAtmF+oHBSSzABWkAw8rrzZjdODf1v3/6GvkgKZnVS2d4zfzNrl7hDiXRSUOnqwPyxrDsw7q6FCbDa1XZr1GFkzqL2D62G/ucjgsAsaZ006vNIhQaLKtv9m48YyC94TAuEi5/CqYj7vS6vtHRU4zo5ozrUVRmJqMVnJqQ8StsOiv3v0CjtGhUu8Q8vYiEphafTpmpgV8I1LgLRfPv/DCKL5e4VzmFEk74xw==";

const LIVE_TRADING = true; 
const POSITIONS_KEY = 'active_trading_positions'; // Redis 記憶 Key
// =================================================

const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('✅ Redis 已連線'));
redis.on('error', (err) => console.error('❌ Redis 錯誤:', err.message));

const bitunix = new Bitunix({
    apiKey: process.env.BITUNIX_API_KEY,
    apiSecret: process.env.BITUNIX_API_SECRET
});

const activePositions = new Map(); // 記憶體暫存

// ==================== 倉位監控 (強化容錯與記憶版) ====================
async function monitorPosition(positionId, symbol, originalQty, entryPrice) {
    console.log(`👁️ 開始監控: ${symbol} | ID: ${positionId}`);

    const interval = setInterval(async () => {
        try {
            const posInfo = activePositions.get(positionId);
            if (!posInfo) {
                clearInterval(interval);
                return;
            }

            const positions = await bitunix.getPendingPositions(symbol);
            
            // 🚨 容錯：API 異常時不准停止監控
            if (!positions || positions.code !== 0) {
                console.log(`⚠️ API 讀取異常 (${symbol})，跳過此回合...`);
                return;
            }

            const pos = positions?.data?.find(p => p.positionId === positionId);

            // 🚨 確認真的平倉才刪除記憶
            if (!pos) {
                console.log(`✅ ${symbol} 倉位已消失，停止監控。`);
                activePositions.delete(positionId);
                await redis.hdel(POSITIONS_KEY, positionId); 
                clearInterval(interval);
                return;
            }

            const currentQty = parseFloat(pos.qty);
            console.log(`🔍 ${symbol} 階段${posInfo.phase}: 數量=${currentQty}/${originalQty}`);

            // ===== 止盈一成交 (Phase 1 -> 2) =====
            if (posInfo.phase === 1 && currentQty < originalQty * 0.9) {
                console.log(`🎯 ${symbol} 止盈一成交！執行保本止損...`);
                posInfo.phase = 2;

                const tp2Qty = Math.floor(currentQty * 0.8);
                const tp3Qty = currentQty - tp2Qty;

                await bitunix.cancelAllTpSl(symbol, positionId);

                if (posInfo.tp2Price) {
                    const res = await bitunix.placeTpSl(
                        symbol, positionId,
                        posInfo.tp2Price, tp2Qty,
                        entryPrice, currentQty // 移至開倉價保本
                    );
                    if (res.code === 0) {
                        console.log(`✅ 階段2掛單成功：TP2=${posInfo.tp2Price} | SL=${entryPrice}(開倉價)`);
                        posInfo.tp3Qty = tp3Qty;
                        await redis.hset(POSITIONS_KEY, positionId, JSON.stringify(posInfo)); 
                    }
                }
            }

            // ===== 止盈二成交 (Phase 2 -> 3) =====
            else if (posInfo.phase === 2 && posInfo.tp3Qty && currentQty <= posInfo.tp3Qty * 1.1) {
                console.log(`🎯 ${symbol} 止盈二成交！`);
                posInfo.phase = 3;

                await bitunix.cancelAllTpSl(symbol, positionId);

                if (posInfo.tp3Price) {
                    const res = await bitunix.placeTpSl(
                        symbol, positionId,
                        posInfo.tp3Price, currentQty,
                        posInfo.tp1Price, currentQty // 移至 TP1 價鎖利
                    );
                    if (res.code === 0) {
                        console.log(`✅ 階段3掛單成功：TP3=${posInfo.tp3Price} | SL=${posInfo.tp1Price}(TP1價)`);
                        await redis.hset(POSITIONS_KEY, positionId, JSON.stringify(posInfo));
                    }
                }
            }

        } catch (err) {
            console.error(`❌ 監控異常 (${symbol}):`, err.message);
        }
    }, 5000); // 5秒檢查一次
}

// ==================== 記憶恢復邏輯 ====================
async function recoverPositions() {
    console.log("🛠️ 正在從 Redis 恢復倉位監控...");
    try {
        const saved = await redis.hgetall(POSITIONS_KEY);
        for (const [posId, data] of Object.entries(saved)) {
            const info = JSON.parse(data);
            activePositions.set(posId, info);
            monitorPosition(posId, info.symbol, info.totalQty, info.entryPrice);
            console.log(`♻️ 已恢復監控: ${info.symbol} (Phase ${info.phase})`);
        }
    } catch (e) {
        console.error("❌ 恢復倉位失敗:", e.message);
    }
}

// ==================== 自動下單流程 ====================
async function executeOrder(messageText) {
    // 正則解析
    const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
    const dirMatch = messageText.match(/方向[：:\s]*(多|空)/);
    const entryPriceMatch = messageText.match(/收盤價[：:]([\d\.]+)/);
    const stopLossMatch = messageText.match(/建議停損[：:]([\d\.]+)/);
    const takeProfit1Match = messageText.match(/建議停利一[：:]([\d\.]+)/);
    const takeProfit2Match = messageText.match(/建議停利二[：:]([\d\.]+)/);
    const takeProfit3Match = messageText.match(/建議停利三[：:]([\d\.]+)/);

    if (!coinMatch || !dirMatch || !entryPriceMatch || !stopLossMatch || !takeProfit1Match) return;

    const symbol = coinMatch[1];
    const side = dirMatch[1] === '空' ? 'SELL' : 'BUY';
    const entryPrice = parseFloat(entryPriceMatch[1]);
    const stopLoss = parseFloat(stopLossMatch[1]);

    // 🚀 一幣不兩投：檢查是否有同向倉位
    const hasPosition = [...activePositions.values()].some(p => p.symbol === symbol && p.side === side);
    if (hasPosition) {
        console.log(`⏭️ ${symbol} 已有同向倉位，完全無視此訊號。`);
        return;
    }

    // 🚀 計算倉位數量 (修復 ReferenceError)
    const slPercent = Math.abs((stopLoss - entryPrice) / entryPrice) * 100;
    const riskRatio = slPercent >= 8 ? 0.03 : 0.05; 
    
    let totalBalance = 100;
    try {
        const account = await bitunix.getAccount();
        if (account?.data?.available) totalBalance = parseFloat(account.data.available);
    } catch (e) { console.log("⚠️ 無法獲取餘額，使用預設 100"); }

    const leverage = 20;
    const totalQty = Math.floor((totalBalance * riskRatio * leverage) / entryPrice);
    const tp1Qty = Math.floor(totalQty * 0.8);

    if (totalQty <= 0) {
        console.log("⚠️ 餘額不足以開倉");
        return;
    }

    if (!LIVE_TRADING) {
        console.log('🛡️ 測試模式，未下單。');
        return;
    }

    try {
        console.log(`💰 送出市價單: ${symbol} ${side} ${totalQty}顆...`);
        const orderRes = await bitunix.placeMarketOrder(symbol, side, totalQty);
        if (orderRes.code !== 0) {
            console.error(`❌ 下單失敗:`, JSON.stringify(orderRes));
            return;
        }

        await new Promise(r => setTimeout(r, 2000));
        const positions = await bitunix.getPendingPositions(symbol);
        const pos = positions?.data?.find(p => p.symbol === symbol);
        if (!pos) {
            console.error("❌ 進場成功但找不到倉位資訊");
            return;
        }

        const posData = {
            symbol, side, entryPrice: parseFloat(pos.avgOpenPrice),
            totalQty, tp1Qty, 
            tp1Price: parseFloat(takeProfit1Match[1]),
            tp2Price: takeProfit2Match ? parseFloat(takeProfit2Match[1]) : null,
            tp3Price: takeProfit3Match ? parseFloat(takeProfit3Match[1]) : null,
            stopLoss,
            phase: 1
        };

        activePositions.set(pos.positionId, posData);
        await redis.hset(POSITIONS_KEY, pos.positionId, JSON.stringify(posData)); // 🚀 備份至 Redis

        // 掛第一波 TP1 + SL
        const tpSlRes = await bitunix.placeTpSl(symbol, pos.positionId, posData.tp1Price, tp1Qty, posData.stopLoss, totalQty);
        if (tpSlRes.code === 0) {
            console.log(`✅ 進場與首波 TP/SL 掛出成功！`);
        }

        monitorPosition(pos.positionId, symbol, totalQty, posData.entryPrice);

    } catch (err) {
        console.error('❌ 下單流程錯誤:', err.message);
    }
}

// ==================== 啟動 ====================
async function startBot() {
    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    console.log("✅ Telegram 連線成功");

    await recoverPositions(); // 🚀 啟動時先找回記憶

    bitunix.startWebSocket(() => {});

    client.addEventHandler(async (event) => {
        const messageText = event.message.message || "";
        const chatId = event.message.chatId?.toString();

        if ((chatId === signalChannel || chatId === "8205013511") && messageText.includes("【幣幣篩選】")) {
            console.log(`🚨 偵測到訊號，準備執行...`);
            await executeOrder(messageText);
        }
    }, new NewMessage({}));
}

startBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 伺服器啟動於 port ${PORT}`);
});
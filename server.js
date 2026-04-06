const Bitunix = require('./Bitunix');
const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const Redis = require('ioredis');

const app = express();
app.use(cors());

// ==========================================
const apiId = 31121887;
const apiHash = "6ce79e991f0849d80969c6ceae8e3be0";
const targetChannel = "-1003202637717";
const signalChannel = "-1003749280511";

const sessionString = "1BQANOTEuMTA4LjU2LjEyOQG7ujm2g/sSrgws1fBfTt7BHOyn3x5y8XPC/YxqkPsqz3QzYuKD2SSsDzovU3YbGFYQTUFfmdmI7It1pVzLnAzTF2onBFP5D2oAKKF/Qm9TJ42pIPj6M8XRAtmF+oHBSSzABWkAw8rrzZjdODf1v3/6GvkgKZnVS2d4zfzNrl7hDiXRSUOnqwPyxrDsw7q6FCbDa1XZr1GFkzqL2D62G/ucjgsAsaZ006vNIhQaLKtv9m48YyC94TAuEi5/CqYj7vS6vtHRU4zo5ozrUVRmJqMVnJqQ8StsOiv3v0CjtGhUu8Q8vYiEphafTpmpgV8I1LgLRfPv/DCKL5e4VzmFEk74xw==";

const LIVE_TRADING = true;
// ==========================================

// Redis 連線
const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('✅ Redis 已連線'));
redis.on('error', (err) => console.error('❌ Redis 錯誤:', err.message));

const MESSAGES_KEY = 'latestMessages';
const MAX_MESSAGES = 150;

// 存訊息到 Redis
async function saveMessage(msg) {
    await redis.lpush(MESSAGES_KEY, JSON.stringify(msg));
    await redis.ltrim(MESSAGES_KEY, 0, MAX_MESSAGES - 1);
}

// 從 Redis 讀取訊息
async function getMessages() {
    const items = await redis.lrange(MESSAGES_KEY, 0, MAX_MESSAGES - 1);
    return items.map(i => JSON.parse(i));
}

const bitunix = new Bitunix({
    apiKey: process.env.BITUNIX_API_KEY,
    apiSecret: process.env.BITUNIX_API_SECRET
});

const activePositions = new Map();

const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
});

// ==================== 自動下單主流程 ====================
async function executeOrder(messageText) {
    const coinMatch        = messageText.match(/([A-Z0-9]+USDT)/);
    const dirMatch         = messageText.match(/方向[：:\s]*(多|空)/);
    const entryPriceMatch  = messageText.match(/收盤價[：:]([\d\.]+)/);
    const stopLossMatch    = messageText.match(/建議停損[：:]([\d\.]+)/);
    const takeProfit1Match = messageText.match(/建議停利一[：:]([\d\.]+)/);
    const takeProfit2Match = messageText.match(/建議停利二[：:]([\d\.]+)/);

    console.log(`🔎 幣種: ${coinMatch?.[1] || '未找到'}`);
    console.log(`🔎 方向: ${dirMatch?.[1] || '未找到'}`);
    console.log(`🔎 收盤價: ${entryPriceMatch?.[1] || '未找到'}`);
    console.log(`🔎 停損: ${stopLossMatch?.[1] || '未找到'}`);
    console.log(`🔎 停利一: ${takeProfit1Match?.[1] || '未找到'}`);
    console.log(`🔎 停利二: ${takeProfit2Match?.[1] || '未找到'}`);

    if (!coinMatch || !dirMatch || !entryPriceMatch || !stopLossMatch || !takeProfit1Match) {
        console.log('⚠️ 格式不符，略過此訊號');
        return;
    }

    const symbol     = coinMatch[1];
    const isShort    = dirMatch[1] === '空';
    const side       = isShort ? 'SELL' : 'BUY';
    const entryPrice = parseFloat(entryPriceMatch[1]);
    const stopLoss   = parseFloat(stopLossMatch[1]);
    const tp1Price   = parseFloat(takeProfit1Match[1]);
    const tp2Price   = takeProfit2Match ? parseFloat(takeProfit2Match[1]) : null;

    // 新版：同幣種同方向才略過
    const sameSidePosition = [...activePositions.values()].find(
    p => p.symbol === symbol && p.side === side
    );
    if (sameSidePosition) {
    console.log(`⏭️ ${symbol} 已有相同方向倉位，略過此訊號`);
    return;
    }

    const slPercent = Math.abs((stopLoss - entryPrice) / entryPrice) * 100;
    console.log(`📏 停損幅度: ${slPercent.toFixed(2)}%`);

    const riskRatio = slPercent >= 8 ? 0.03 : 0.05;
    console.log(`💼 倉位比例: ${riskRatio * 100}% (${slPercent >= 8 ? '停損過大，降低倉位' : '正常倉位'})`);

    let totalBalance = 100;
    try {
        const account = await bitunix.getAccount();
        const available = account?.data?.available;
        if (available) {
            totalBalance = parseFloat(available);
            console.log(`✅ 真實餘額: ${totalBalance} USDT`);
        }
    } catch (err) {
        console.log(`⚠️ 無法讀取餘額，用模擬 100 USDT`);
    }

    const leverage  = 20;
    const margin    = totalBalance * riskRatio;
    const totalQty  = Math.floor((margin * leverage) / entryPrice);
    const tp1Qty    = Math.floor(totalQty * 0.8);
    const remainQty = totalQty - tp1Qty;

    console.log(`🤖 作戰計畫: ${isShort ? '做空' : '做多'} ${symbol}`);
    console.log(`📊 總數量: ${totalQty} | 止盈一平倉: ${tp1Qty} | 剩餘: ${remainQty}`);
    console.log(`📍 止損: ${stopLoss} | 止盈一: ${tp1Price} | 止盈二: ${tp2Price || '無'}`);

    if (!LIVE_TRADING) {
        console.log('🛡️ 【保護模式】計算完畢，未扣款。');
        return;
    }

    try {
        console.log(`💰 送出市價單...`);
        const orderRes = await bitunix.placeMarketOrder(symbol, side, totalQty);
        if (orderRes.code !== 0) {
            console.error(`❌ 下單失敗:`, JSON.stringify(orderRes));
            return;
        }
        console.log(`✅ 進場成功！orderId=${orderRes.data.orderId}`);

        await new Promise(r => setTimeout(r, 2000));
       const positions = await bitunix.getPendingPositions(symbol);
       console.log(`🔍 倉位查詢結果:`, JSON.stringify(positions?.data));
       const pos = positions?.data?.find(p => p.symbol === symbol);
       if (!pos) {
       console.error('❌ 找不到倉位資訊');
       return;
       }
       const positionId  = pos.positionId;
       const actualEntry = parseFloat(pos.avgOpenPrice || entryPrice); // ✅ 改這裡
       console.log(`✅ 倉位確認: positionId=${positionId} | 實際開倉價=${actualEntry}`);
        activePositions.set(positionId, {
            symbol, side, entryPrice: actualEntry,
            totalQty, tp1Qty, remainQty,
            tp1Price, tp2Price, stopLoss
        });

        await bitunix.placePositionTpSl(symbol, positionId, null, stopLoss);
        console.log(`✅ 止損單掛出: ${stopLoss}`);

        const closeSide = isShort ? 'BUY' : 'SELL';
        const tp1Res = await bitunix.request('POST', '/api/v1/futures/trade/place_order', {
            symbol,
            side: closeSide,
            qty: tp1Qty.toString(),
            price: tp1Price.toString(),
            orderType: 'LIMIT',
            tradeSide: 'CLOSE',
            positionId,
            effect: 'GTC',
            clientId: `tp1_${positionId}`
        });
        if (tp1Res.code === 0) {
            console.log(`✅ 止盈一掛出: 價格=${tp1Price} | 數量=${tp1Qty}`);
        } else {
            console.error('❌ 止盈一掛單失敗:', JSON.stringify(tp1Res));
        }

    } catch (err) {
        console.error('❌ 下單流程錯誤:', err.message);
    }
}

// ==================== 止盈一成交後的處理 ====================
async function onTp1Filled(positionId, order) {
    const pos = activePositions.get(positionId);
    if (!pos) {
        console.log(`⚠️ 找不到 positionId=${positionId} 的倉位記錄`);
        return;
    }

    console.log(`🔄 止盈一成交！移動止損到開倉價 ${pos.entryPrice}...`);

    try {
        await bitunix.modifyPositionSl(pos.symbol, positionId, pos.entryPrice);
        console.log(`✅ 止損已移到開倉價 ${pos.entryPrice}`);
        console.log(`🎯 剩餘 ${pos.remainQty} 顆繼續跑，目標止盈二: ${pos.tp2Price || '無'}`);
        activePositions.delete(positionId);
    } catch (err) {
        console.error('❌ 移動止損失敗:', err.message);
    }
}

// ==================== 啟動 ====================
async function startBot() {
    await client.connect();
    console.log("✅ 成功連線到 Telegram！");
    console.log("✅ 開始盯盤...");

    bitunix.startWebSocket(onTp1Filled);

    client.addEventHandler(async (event) => {
        const messageText = event.message.message || "";
        const currentChatId = event.message.chatId ? event.message.chatId.toString() : "";
        const date = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

        console.log(`📩 收到訊息: chatId=${currentChatId}, 內容前30字=[${messageText.substring(0, 30)}]`);

        // ===== 14439 快訊：存入 Redis =====
        if (currentChatId === targetChannel) {
            await saveMessage({ time: date, text: messageText });
            console.log(`⚡ 14439快訊已存入 Redis！`);
        }

        // ===== 幣幣篩選：自動下單 =====
        if ((currentChatId === signalChannel || currentChatId === "8205013511") && messageText.includes("【幣幣篩選】")) {
            console.log(`🚨 偵測到幣幣篩選訊號！`);
            await executeOrder(messageText);
        }

    }, new NewMessage({}));
}

startBot();

app.get('/api/messages', async (req, res) => {
    const messages = await getMessages();
    res.json(messages);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 伺服器啟動在 0.0.0.0:${PORT}`);
});
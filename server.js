const Bitunix = require('./Bitunix');

const bitunix = new Bitunix({
  apiKey: process.env.BITUNIX_API_KEY,
  apiSecret: process.env.BITUNIX_API_SECRET
});
const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const app = express();
app.use(cors());

// ==========================================
const apiId = 31121887;
const apiHash = "6ce79e991f0849d80969c6ceae8e3be0";
const targetChannel = "-1003202637717";  // 14439 快訊
const signalChannel = "-3749280511";     // 幣幣通知測試（下單用）

const sessionString = "1BQANOTEuMTA4LjU2LjEyOQG7ujm2g/sSrgws1fBfTt7BHOyn3x5y8XPC/YxqkPsqz3QzYuKD2SSsDzovU3YbGFYQTUFfmdmI7It1pVzLnAzTF2onBFP5D2oAKKF/Qm9TJ42pIPj6M8XRAtmF+oHBSSzABWkAw8rrzZjdODf1v3/6GvkgKZnVS2d4zfzNrl7hDiXRSUOnqwPyxrDsw7q6FCbDa1XZr1GFkzqL2D62G/ucjgsAsaZ006vNIhQaLKtv9m48YyC94TAuEi5/CqYj7vS6vtHRU4zo5ozrUVRmJqMVnJqQ8StsOiv3v0CjtGhUu8Q8vYiEphafTpmpgV8I1LgLRfPv/DCKL5e4VzmFEk74xw==";
// ==========================================

let latestMessages = [];

const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
});

async function startBot() {
    await client.connect();
    console.log("✅ 成功使用通行證連線到 Telegram！");
    console.log("✅ 準備完畢！開始盯盤...");

    client.addEventHandler(async (event) => {
        const messageText = event.message.message || "";
        const currentChatId = event.message.chatId ? event.message.chatId.toString() : "";
        const date = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

        console.log(`📩 收到訊息: chatId=${currentChatId}, 內容前30字=[${messageText.substring(0, 30)}]`);

        // ===== 14439 快訊：只存入顯示，不下單 =====
        if (currentChatId === targetChannel) {
            const formattedMessage = { time: date, text: messageText };
            latestMessages.unshift(formattedMessage);
            if (latestMessages.length > 150) latestMessages.pop();
            console.log(`⚡ [${date}] 14439快訊已存入！`);
        }

        // ===== 幣幣篩選：只接受指定頻道，自動下單 =====
        if ((currentChatId === signalChannel || currentChatId === "8205013511") && messageText.includes("【幣幣篩選】")) {
            console.log(`🚨 偵測到幣幣篩選訊號！`);

            try {
                const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
                const dirMatch  = messageText.match(/方向[：:](多|空)/);

                console.log(`🔎 幣種: ${coinMatch ? coinMatch[1] : '未找到'}`);
                console.log(`🔎 方向: ${dirMatch ? dirMatch[1] : '未找到'}`);

                if (coinMatch && dirMatch) {
                    const coin    = coinMatch[1];
                    const isShort = dirMatch[1] === "空";

                    const entryPriceMatch  = messageText.match(/收盤價[：:]([\d\.]+)/);
                    const stopLossMatch    = messageText.match(/建議停損[：:]([\d\.]+)/);
                    const takeProfit1Match = messageText.match(/建議停利一[：:]([\d\.]+)/);

                    console.log(`🔎 收盤價: ${entryPriceMatch ? entryPriceMatch[1] : '未找到'}`);
                    console.log(`🔎 停損: ${stopLossMatch ? stopLossMatch[1] : '未找到'}`);
                    console.log(`🔎 停利一: ${takeProfit1Match ? takeProfit1Match[1] : '未找到'}`);

                    if (entryPriceMatch && stopLossMatch && takeProfit1Match) {
                        const entryPrice  = parseFloat(entryPriceMatch[1]);
                        const stopLoss    = parseFloat(stopLossMatch[1]);
                        const takeProfit1 = parseFloat(takeProfit1Match[1]);

                        let totalBalance = 100;
                        try {
                            const account = await bitunix.getAccount();
                            console.log(`🔍 [系統探照燈] 交易所回傳:`, JSON.stringify(account.data));

                            let available = account?.data?.available_balance
                                         || account?.data?.availableMargin
                                         || account?.data?.available;
                            if (available) {
                                totalBalance = parseFloat(available);
                                console.log(`✅ 真實餘額: ${totalBalance} USDT`);
                            } else {
                                console.log(`⚠️ 找不到餘額欄位，用模擬 100 USDT`);
                            }
                        } catch (err) {
                            console.log(`⚠️ 無法讀取餘額，用模擬 100 USDT。錯誤: ${err.message}`);
                        }

                        const leverage      = 20;
                        const margin        = totalBalance * 0.05;
                        const totalQuantity = Math.floor((margin * leverage) / entryPrice);
                        const tp1Quantity   = Math.floor(totalQuantity * 0.8);

                        console.log(`🤖 ${isShort ? '做空' : '做多'} ${coin} | 進場價: ${entryPrice}`);
                        console.log(`📊 總數量: ${totalQuantity} | 停損: ${stopLoss}`);
                        console.log(`🎯 停利一: ${takeProfit1} | 平倉數量: ${tp1Quantity} (80%)`);

                        const LIVE_TRADING = false;

                        if (LIVE_TRADING) {
                            console.log("💰 (真實扣款) 訂單已發送！");
                        } else {
                            console.log("🛡️ 【保護模式】計算完畢，未扣款。");
                        }
                    } else {
                        console.log("⚠️ 格式不符：找不到收盤價、停損或停利一。");
                    }
                }
            } catch (error) {
                console.error("❌ 自動下單發生錯誤:", error.message);
            }
        }

    }, new NewMessage({}));
}

startBot();

app.get('/api/messages', (req, res) => res.json(latestMessages));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 伺服器已安全啟動在 0.0.0.0:${PORT}，通過 Railway 健康檢查！`);
});
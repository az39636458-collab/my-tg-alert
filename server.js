const Bitunix = require('Bitunix');

// 讓程式自己去 Railway 的保險箱拿鑰匙，絕對安全！
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
app.use(cors()); // 允許你的 Vercel 網頁來讀取資料

// ==========================================
// 1. 請填入你的專屬資料
const apiId = 31121887; 
const apiHash = "6ce79e991f0849d80969c6ceae8e3be0"; 
const targetChannel = "-1003202637717"; // 目標頻道

// 2. 你的專屬通行證
const sessionString = "1BQANOTEuMTA4LjU2LjEyOQG7ujm2g/sSrgws1fBfTt7BHOyn3x5y8XPC/YxqkPsqz3QzYuKD2SSsDzovU3YbGFYQTUFfmdmI7It1pVzLnAzTF2onBFP5D2oAKKF/Qm9TJ42pIPj6M8XRAtmF+oHBSSzABWkAw8rrzZjdODf1v3/6GvkgKZnVS2d4zfzNrl7hDiXRSUOnqwPyxrDsw7q6FCbDa1XZr1GFkzqL2D62G/ucjgsAsaZ006vNIhQaLKtv9m48YyC94TAuEi5/CqYj7vS6vtHRU4zo5ozrUVRmJqMVnJqQ8StsOiv3v0CjtGhUu8Q8vYiEphafTpmpgV8I1LgLRfPv/DCKL5e4VzmFEk74xw=="; 
// ==========================================

// 用來暫存最新快訊的「記憶體」
let latestMessages = [];

// 使用通行證直接連線
const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
});

async function startBot() {
    await client.connect();
    console.log("✅ 成功使用通行證連線到 Telegram！");

    console.log("正在同步頻道列表，請稍候...");
    await client.getDialogs({});
    console.log("✅ 頻道列表同步完成！開始盯盤...");

    // ⚠️ 這裡加入了 async，讓機器人可以查餘額
    client.addEventHandler(async (event) => {
        const date = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        
        const currentChatId = event.message.chatId ? event.message.chatId.toString() : "";
        console.log(`[測試] 收到新訊息！來源ID: ${currentChatId}`);

        if (currentChatId === targetChannel) {
            const messageText = event.message.message || "這是一張圖片或非文字訊息";
            const formattedMessage = {
                time: date,
                text: messageText
            };

            latestMessages.unshift(formattedMessage);
            if (latestMessages.length > 150) {
                latestMessages.pop();
            }

            console.log(`⚡ [${date}] 成功！抓到目標快訊並存入伺服器！`);

            // --- 🤖 自動下單大腦開始 ---
            try {
                const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
                const dirMatch = messageText.match(/方向:(多|空)/);

                if (coinMatch && dirMatch) {
                    console.log("🚨 偵測到新快訊，啟動自動下單程序！");

                    const coin = coinMatch[1];
                    const isShort = dirMatch[1] === "空";
                    const entryPriceMatch = messageText.match(/收盤價：([\d\.]+)/);
                    const stopLossMatch = messageText.match(/建議停損:([\d\.]+)/);
                    const takeProfitMatch = messageText.match(/建議停利三:([\d\.]+)/);

                    // 確保點位都有抓到才繼續計算，避免報錯當機
                    if (entryPriceMatch && stopLossMatch && takeProfitMatch) {
                        const entryPrice = parseFloat(entryPriceMatch[1]);
                        const stopLoss = parseFloat(stopLossMatch[1]);
                        const takeProfit = parseFloat(takeProfitMatch[1]);

                        // 獲取餘額與計算數量
                        const account = await bitunix.getAccount();
                        const totalBalance = parseFloat(account.data.available);
                        const leverage = 20; // 固定 20 倍槓桿
                        const margin = totalBalance * 0.05; // 固定 5% 倉位
                        const quantity = Math.floor((margin * leverage) / entryPrice);

                        console.log(`🤖 作戰計畫: ${isShort ? '做空' : '做多'} ${coin} | 數量: ${quantity} | 停損: ${stopLoss} | 停利: ${takeProfit}`);

                        // ==========================================
                        // 🛡️ 安全開關 (安全第一！)
                        // ==========================================
                        const LIVE_TRADING = false; // ⚠️ 目前為 false，代表只計算不扣款

                        if (LIVE_TRADING) {
                            console.log("💰 (真實扣款) 訂單已發送！");
                        } else {
                            console.log("🛡️ 【保護模式啟動】程式已成功在雲端計算完畢，但未實際下單扣款。");
                        }
                    } else {
                        console.log("⚠️ 格式不符：找不到收盤價或停損/停利點位，跳過此單。");
                    }
                }
            } catch (error) {
                console.error("❌ 自動下單發生錯誤:", error.message);
            }
            // --- 🤖 自動下單大腦結束 ---
        }
    }, new NewMessage({})); 
}

startBot();

// ==========================================
// 3. 開放一個網址 (API)
app.get('/api/messages', (req, res) => {
    res.json(latestMessages);
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 伺服器已啟動！資料將輸出到: http://localhost:${PORT}/api/messages`);
});
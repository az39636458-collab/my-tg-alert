const Bitunix = require('./Bitunix');

// 讓程式自己去 Railway 的保險箱拿鑰匙
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
// 1. 你的專屬資料
const apiId = 31121887; 
const apiHash = "6ce79e991f0849d80969c6ceae8e3be0"; 
const targetChannel = "-1003202637717"; 

// 2. 你的通行證
const sessionString = "1BQANOTEuMTA4LjU2LjEyOQG7ujm2g/sSrgws1fBfTt7BHOyn3x5y8XPC/YxqkPsqz3QzYuKD2SSsDzovU3YbGFYQTUFfmdmI7It1pVzLnAzTF2onBFP5D2oAKKF/Qm9TJ42pIPj6M8XRAtmF+oHBSSzABWkAw8rrzZjdODf1v3/6GvkgKZnVS2d4zfzNrl7hDiXRSUOnqwPyxrDsw7q6FCbDa1XZr1GFkzqL2D62G/ucjgsAsaZ006vNIhQaLKtv9m48YyC94TAuEi5/CqYj7vS6vtHRU4zo5ozrUVRmJqMVnJqQ8StsOiv3v0CjtGhUu8Q8vYiEphafTpmpgV8I1LgLRfPv/DCKL5e4VzmFEk74xw=="; 
// ==========================================

let latestMessages = [];

const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
});

async function startBot() {
    await client.connect();
    console.log("✅ 成功使用通行證連線到 Telegram！");
    
    console.log("準備啟動雷達...");
    // 歷史訊息太重了，我們不下載，專心聽未來的新快訊就好！
    console.log("✅ 準備完畢！開始盯盤...");

    client.addEventHandler(async (event) => {
        const date = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        const currentChatId = event.message.chatId ? event.message.chatId.toString() : "";
        const messageText = event.message.message || "這是一張圖片或非文字訊息";

        if (currentChatId === targetChannel || messageText.includes("【幣幣篩選】")) {
            const formattedMessage = { time: date, text: messageText };
            latestMessages.unshift(formattedMessage);
            if (latestMessages.length > 150) latestMessages.pop();

            console.log(`⚡ [${date}] 成功！抓到目標快訊並存入伺服器！`);

            try {
                const coinMatch = messageText.match(/([A-Z0-9]+USDT)/);
                const dirMatch = messageText.match(/方向:(多|空)/);

                if (coinMatch && dirMatch) {
                    console.log("🚨 偵測到新快訊，啟動自動下單程序！");

                    const coin = coinMatch[1];
                    const isShort = dirMatch[1] === "空";
                    const entryPriceMatch = messageText.match(/收盤價：([\d\.]+)/);
                    const stopLossMatch = messageText.match(/建議停損:([\d\.]+)/);
                    
                    // 🌟 現在改抓「建議停利一」
                    const takeProfit1Match = messageText.match(/建議停利一:([\d\.]+)/);

                    if (entryPriceMatch && stopLossMatch && takeProfit1Match) {
                        const entryPrice = parseFloat(entryPriceMatch[1]);
                        const stopLoss = parseFloat(stopLossMatch[1]);
                        const takeProfit1 = parseFloat(takeProfit1Match[1]);

                        let totalBalance = 100; 
                        try {
                            const account = await bitunix.getAccount();
                            // 🌟 X光探照燈：把交易所回傳的所有資料印出來
                            console.log(`🔍 [系統探照燈] 交易所回傳的完整資料:`, JSON.stringify(account.data));
                            
                            // 嘗試抓取各種可能的餘額名稱
                            let available = account?.data?.available_balance || account?.data?.availableMargin || account?.data?.available;
                            if (available) {
                                totalBalance = parseFloat(available);
                                console.log(`✅ 成功抓到真實餘額: ${totalBalance} USDT`);
                            } else {
                                console.log(`⚠️ 還是找不到餘額欄位，請把上面的 [系統探照燈] 日誌複製給我看！`);
                            }
                        } catch (err) {
                            console.log(`⚠️ 無法讀取真實餘額，切換為模擬 100 USDT 計算。`);
                        }

                        const leverage = 20; 
                        const margin = totalBalance * 0.05; // 嚴格風控：最多 5% 倉位
                        const totalQuantity = Math.floor((margin * leverage) / entryPrice);
                        
                        // 🌟 計算 80% 的停利數量
                        const tp1Quantity = Math.floor(totalQuantity * 0.
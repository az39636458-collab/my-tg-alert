const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const app = express();
app.use(cors()); // 允許你的 Vercel 網頁來讀取資料

// ==========================================
// 1. 請填入你的專屬資料
const apiId = 31121887; // 換成你的 API ID
const apiHash = "6ce79e991f0849d80969c6ceae8e3be0"; // 換成你的 API HASH
const targetChannel = "-1003202637717"; // 目標頻道

// 2. 請把剛剛那串超級長的亂碼，完整貼在下面引號裡面
const sessionString = "1BQANOTEuMTA4LjU2LjEyOQG7ujm2g/sSrgws1fBfTt7BHOyn3x5y8XPC/YxqkPsqz3QzYuKD2SSsDzovU3YbGFYQTUFfmdmI7It1pVzLnAzTF2onBFP5D2oAKKF/Qm9TJ42pIPj6M8XRAtmF+oHBSSzABWkAw8rrzZjdODf1v3/6GvkgKZnVS2d4zfzNrl7hDiXRSUOnqwPyxrDsw7q6FCbDa1XZr1GFkzqL2D62G/ucjgsAsaZ006vNIhQaLKtv9m48YyC94TAuEi5/CqYj7vS6vtHRU4zo5ozrUVRmJqMVnJqQ8StsOiv3v0CjtGhUu8Q8vYiEphafTpmpgV8I1LgLRfPv/DCKL5e4VzmFEk74xw=="; 
// ==========================================

// 用來暫存最新快訊的「記憶體」
let latestMessages = [];

// 使用通行證直接連線（不需要再輸入驗證碼了）
const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
});

async function startBot() {
    await client.connect();
    console.log("✅ 成功使用通行證連線到 Telegram！");

    // 🌟 關鍵新增：先讓程式讀取一次你的對話紀錄，它才認得這個私密頻道
    console.log("正在同步頻道列表，請稍候...");
    await client.getDialogs({});
    console.log("✅ 頻道列表同步完成！開始盯盤...");

    // 這次我們不預先過濾，把所有新訊息都先攔截下來看看
    client.addEventHandler((event) => {
        const date = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        
        // 取得這則訊息的來源 ID，並轉成文字
        const currentChatId = event.message.chatId ? event.message.chatId.toString() : "";
        
        // [除錯用] 把所有收到的訊息 ID 都印出來
        console.log(`[測試] 收到新訊息！來源ID: ${currentChatId}`);

        // 如果這個來源 ID 剛好等於你的目標頻道，才存進伺服器
        if (currentChatId === targetChannel) {
            const formattedMessage = {
                time: date,
                text: event.message.message || "這是一張圖片或非文字訊息"
            };

            latestMessages.unshift(formattedMessage);
            if (latestMessages.length > 150) {
                latestMessages.pop();
            }

            console.log(`⚡ [${date}] 成功！抓到目標快訊並存入伺服器！`);
        }
    }, new NewMessage({})); // 這裡的括號留空，代表什麼訊息都先抓
}

startBot();

// ==========================================
// 3. 開放一個網址 (API)，讓 Vercel 網頁可以來拿資料
app.get('/api/messages', (req, res) => {
    res.json(latestMessages);
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 伺服器已啟動！資料將輸出到: http://localhost:${PORT}/api/messages`);
});
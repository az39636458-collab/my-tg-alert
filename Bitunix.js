const axios = require('axios');
const crypto = require('crypto');

class Bitunix {
    constructor({ apiKey, apiSecret }) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        // 修正為 Bitunix 合約專用的 API 網址
        this.baseUrl = 'https://fapi.bitunix.com';
    }

    async getAccount() {
        // 抓取合約帳戶資訊
        return this.request('GET', '/api/v1/futures/account');
    }

    async request(method, path, params = {}) {
        // Bitunix 官方要求的特殊加密格式 (Double SHA256 + Nonce)
        const nonce = crypto.randomBytes(16).toString('hex');
        const timestamp = Date.now().toString();
        
        // GET 請求不帶 body，POST 請求則轉為字串
        const bodyStr = method === 'GET' ? '' : JSON.stringify(params);
        
        // 1. 組合簽名字串: nonce + timestamp + apiKey + body
        const digest_input = nonce + timestamp + this.apiKey + bodyStr;
        // 2. 第一次 SHA256 加密
        const first_hash = crypto.createHash('sha256').update(digest_input).digest('hex');
        // 3. 第二次 SHA256 加密 (加上 apiSecret)
        const signature = crypto.createHash('sha256').update(first_hash + this.apiSecret).digest('hex');

        const config = {
            method,
            url: `${this.baseUrl}${path}`,
            headers: {
                'api-key': this.apiKey,
                'nonce': nonce,
                'timestamp': timestamp,
                'sign': signature,
                'Content-Type': 'application/json'
            }
        };

        if (method !== 'GET') config.data = params;
        
        const response = await axios(config);
        return response.data;
    }
}
module.exports = Bitunix;
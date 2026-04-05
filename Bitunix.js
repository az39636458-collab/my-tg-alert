const axios = require('axios');
const crypto = require('crypto');

class Bitunix {
    constructor({ apiKey, apiSecret }) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = 'https://fapi.bitunix.com';
    }

    async getAccount() {
        // ✅ 加上 marginCoin=USDT 參數
        return this.request('GET', '/api/v1/futures/account', { marginCoin: 'USDT' });
    }

    async request(method, path, params = {}) {
        const nonce = crypto.randomBytes(16).toString('hex');
        const timestamp = Date.now().toString();

        // GET 參數放 queryString，POST 放 body
        let queryString = '';
        let bodyStr = '';

        if (method === 'GET' && Object.keys(params).length > 0) {
            queryString = '?' + new URLSearchParams(params).toString();
        } else if (method !== 'GET') {
            bodyStr = JSON.stringify(params);
        }

        const digest_input = nonce + timestamp + this.apiKey + bodyStr;
        const first_hash = crypto.createHash('sha256').update(digest_input).digest('hex');
        const signature = crypto.createHash('sha256').update(first_hash + this.apiSecret).digest('hex');

        const config = {
            method,
            url: `${this.baseUrl}${path}${queryString}`,
            headers: {
                'api-key': this.apiKey,
                'nonce': nonce,
                'timestamp': timestamp,
                'sign': signature,
                'Content-Type': 'application/json'
            }
        };

        if (method !== 'GET') config.data = params;

        try {
            const response = await axios(config);
            console.log(`🔍 Bitunix 完整回應:`, JSON.stringify(response.data));
            return response.data;
        } catch (err) {
            console.error(`❌ Bitunix API 錯誤: status=${err.response?.status}`);
            console.error(`❌ Bitunix 錯誤內容:`, JSON.stringify(err.response?.data));
            throw err;
        }
    }
}
module.exports = Bitunix;
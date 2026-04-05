const axios = require('axios');
const crypto = require('crypto');

class Bitunix {
    constructor({ apiKey, apiSecret }) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = 'https://fapi.bitunix.com';
    }

    async getAccount() {
        return this.request('GET', '/api/v1/futures/account', { marginCoin: 'USDT' });
    }

    async request(method, path, params = {}) {
        const nonce = crypto.randomBytes(16).toString('hex').substring(0, 32);
        const timestamp = Date.now().toString();

        let queryString = '';
        let queryParams = '';
        let body = '';

        if (method === 'GET' && Object.keys(params).length > 0) {
            // GET: queryParams 按 ASCII 排序，格式 key1value1key2value2
            const sortedKeys = Object.keys(params).sort();
            queryParams = sortedKeys.map(k => `${k}${params[k]}`).join('');
            queryString = '?' + sortedKeys.map(k => `${k}=${params[k]}`).join('&');
        } else if (method !== 'GET' && Object.keys(params).length > 0) {
            // POST: body 移除所有空格
            body = JSON.stringify(params).replace(/\s/g, '');
        }

        // 簽名: SHA256(nonce + timestamp + apiKey + queryParams + body)
        const digest = crypto.createHash('sha256')
            .update(nonce + timestamp + this.apiKey + queryParams + body)
            .digest('hex');
        
        // 第二次: SHA256(digest + secretKey)
        const sign = crypto.createHash('sha256')
            .update(digest + this.apiSecret)
            .digest('hex');

        const config = {
            method,
            url: `${this.baseUrl}${path}${queryString}`,
            headers: {
                'api-key': this.apiKey,
                'nonce': nonce,
                'timestamp': timestamp,
                'sign': sign,
                'Content-Type': 'application/json'
            }
        };

        if (method !== 'GET') config.data = JSON.parse(body || '{}');

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
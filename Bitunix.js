const axios = require('axios');
const crypto = require('crypto');

class Bitunix {
    constructor({ apiKey, apiSecret }) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = 'https://api.bitunix.com';
    }

    async getAccount() {
        return this.request('GET', '/api/v1/futures/account/assets');
    }

    async request(method, path, params = {}) {
        const timestamp = Date.now();
        const query = method === 'GET' ? new URLSearchParams(params).toString() : JSON.stringify(params);
        const sign = crypto.createHmac('sha256', this.apiSecret)
            .update(`${timestamp}${method}${path}${query}`)
            .digest('hex');

        const config = {
            method,
            url: `${this.baseUrl}${path}${method === 'GET' ? '?' + query : ''}`,
            headers: {
                'api-key': this.apiKey,
                'api-signature': sign,
                'api-timestamp': timestamp,
                'Content-Type': 'application/json'
            }
        };
        if (method !== 'GET') config.data = params;
        const response = await axios(config);
        return response.data;
    }
}
module.exports = Bitunix;
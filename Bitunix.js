const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

class Bitunix {
    constructor({ apiKey, apiSecret }) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = 'https://fapi.bitunix.com';
        this.wsUrl = 'wss://fapi.bitunix.com/private/';
        this.ws = null;
    }

    sign(nonce, timestamp, queryParams = '', body = '') {
        const digest = crypto.createHash('sha256')
            .update(nonce + timestamp + this.apiKey + queryParams + body)
            .digest('hex');
        return crypto.createHash('sha256')
            .update(digest + this.apiSecret)
            .digest('hex');
    }

    async request(method, path, params = {}) {
        const nonce = crypto.randomBytes(16).toString('hex').substring(0, 32);
        const timestamp = Date.now().toString();

        let queryString = '';
        let queryParams = '';
        let body = '';

        if (method === 'GET' && Object.keys(params).length > 0) {
            const sortedKeys = Object.keys(params).sort();
            queryParams = sortedKeys.map(k => `${k}${params[k]}`).join('');
            queryString = '?' + sortedKeys.map(k => `${k}=${params[k]}`).join('&');
        } else if (method !== 'GET' && Object.keys(params).length > 0) {
            body = JSON.stringify(params).replace(/\s/g, '');
        }

        const signStr = this.sign(nonce, timestamp, queryParams, body);

        const config = {
            method,
            url: `${this.baseUrl}${path}${queryString}`,
            headers: {
                'api-key': this.apiKey,
                'nonce': nonce,
                'timestamp': timestamp,
                'sign': signStr,
                'Content-Type': 'application/json'
            }
        };

        if (method !== 'GET' && body) config.data = JSON.parse(body);

        try {
            const response = await axios(config);
            return response.data;
        } catch (err) {
            console.error(`❌ Bitunix API 錯誤 [${method} ${path}]: status=${err.response?.status}`);
            console.error(`❌ 錯誤內容:`, JSON.stringify(err.response?.data));
            throw err;
        }
    }

    async getAccount() {
        return this.request('GET', '/api/v1/futures/account', { marginCoin: 'USDT' });
    }

    async placeMarketOrder(symbol, side, qty) {
        return this.request('POST', '/api/v1/futures/trade/place_order', {
            symbol,
            side,
            qty: qty.toString(),
            orderType: 'MARKET',
            tradeSide: 'OPEN'
        });
    }

    async getPendingPositions(symbol) {
        return this.request('GET', '/api/v1/futures/position/get_pending_positions', { symbol });
    }

    async placeTpSl(symbol, positionId, tpPrice, tpQty, slPrice, slQty) {
        const params = { symbol, positionId };
        if (tpPrice) {
            params.tpPrice = tpPrice.toString();
            params.tpStopType = 'LAST_PRICE';
            params.tpOrderType = 'MARKET';
            params.tpQty = tpQty.toString();
        }
        if (slPrice) {
            params.slPrice = slPrice.toString();
            params.slStopType = 'LAST_PRICE';
            params.slOrderType = 'MARKET';
            params.slQty = slQty.toString();
        }
        return this.request('POST', '/api/v1/futures/tpsl/place_order', params);
    }

    async cancelTpSl(symbol, orderId) {
        return this.request('POST', '/api/v1/futures/tpsl/cancel_order', {
            symbol,
            orderId
        });
    }

    // 查詢所有待成交止盈止損單
    async getPendingTpSlOrders(symbol, positionId) {
        return this.request('GET', '/api/v1/futures/tpsl/get_pending_orders', {
            symbol,
            positionId,
            limit: 100
        });
    }

    // 取消指定倉位的所有止盈止損單
    async cancelAllTpSl(symbol, positionId) {
        try {
            const res = await this.getPendingTpSlOrders(symbol, positionId);
            const orders = res?.data || [];
            console.log(`🔍 找到 ${orders.length} 個待取消的止盈止損單`);
            for (const order of orders) {
                const cancelRes = await this.cancelTpSl(symbol, order.id);
                console.log(`🗑️ 取消止盈止損單 ${order.id}: ${cancelRes.code === 0 ? '成功' : '失敗'}`);
            }
        } catch (err) {
            console.error('❌ 取消所有止盈止損單失敗:', err.message);
        }
    }

    async modifyPositionSl(symbol, positionId, newSlPrice) {
        return this.request('POST', '/api/v1/futures/tpsl/position/modify_order', {
            symbol,
            positionId,
            slPrice: newSlPrice.toString(),
            slStopType: 'LAST_PRICE'
        });
    }

    startWebSocket(onMessage) {
        const nonce = crypto.randomBytes(16).toString('hex').substring(0, 32);
        const timestamp = Math.floor(Date.now() / 1000);
        const digest = crypto.createHash('sha256')
            .update(nonce + timestamp + this.apiKey)
            .digest('hex');
        const wsSign = crypto.createHash('sha256')
            .update(digest + this.apiSecret)
            .digest('hex');

        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
            console.log('✅ Bitunix WebSocket 已連線');
            this.ws.send(JSON.stringify({
                op: 'login',
                args: [{
                    apiKey: this.apiKey,
                    timestamp,
                    nonce,
                    sign: wsSign
                }]
            }));
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.op === 'login' && msg.code === 0) {
                    console.log('✅ Bitunix WebSocket 登入成功');
                    this.ws.send(JSON.stringify({
                        op: 'subscribe',
                        args: [{ ch: 'order' }]
                    }));
                }
                if (msg.op === 'ping') {
                    this.ws.send(JSON.stringify({ op: 'pong', pong: msg.ping }));
                }
                if (onMessage) onMessage(msg);
            } catch (e) {
                console.error('❌ WebSocket 訊息解析錯誤:', e.message);
            }
        });

        this.ws.on('close', () => {
            console.log('⚠️ Bitunix WebSocket 斷線，5秒後重連...');
            setTimeout(() => this.startWebSocket(onMessage), 5000);
        });

        this.ws.on('error', (err) => {
            console.error('❌ Bitunix WebSocket 錯誤:', err.message);
        });

        setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 'ping', ping: Math.floor(Date.now() / 1000) }));
            }
        }, 20000);
    }
}

module.exports = Bitunix;
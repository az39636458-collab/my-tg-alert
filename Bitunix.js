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

    // ==================== 簽名 ====================
    sign(nonce, timestamp, queryParams = '', body = '') {
        const digest = crypto.createHash('sha256')
            .update(nonce + timestamp + this.apiKey + queryParams + body)
            .digest('hex');
        return crypto.createHash('sha256')
            .update(digest + this.apiSecret)
            .digest('hex');
    }

    // ==================== REST 請求 ====================
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

    // ==================== 帳戶餘額 ====================
    async getAccount() {
        return this.request('GET', '/api/v1/futures/account', { marginCoin: 'USDT' });
    }

    // ==================== 市價下單 ====================
    async placeMarketOrder(symbol, side, qty) {
        return this.request('POST', '/api/v1/futures/trade/place_order', {
            symbol,
            side,
            qty: qty.toString(),
            orderType: 'MARKET',
            tradeSide: 'OPEN'
        });
    }

    // ==================== 查詢持倉 ====================
    async getPendingPositions(symbol) {
        return this.request('GET', '/api/v1/futures/position/pending_positions', { symbol });
    }

    // ==================== 掛止盈止損（整個倉位）====================
    async placePositionTpSl(symbol, positionId, tpPrice, slPrice) {
        const params = {
            symbol,
            positionId,
            slPrice: slPrice.toString(),
            slStopType: 'LAST_PRICE'
        };
        if (tpPrice) {
            params.tpPrice = tpPrice.toString();
            params.tpStopType = 'LAST_PRICE';
        }
        return this.request('POST', '/api/v1/futures/tpsl/position/place_order', params);
    }

    // ==================== 修改止損價 ====================
    async modifyPositionSl(symbol, positionId, newSlPrice) {
        return this.request('POST', '/api/v1/futures/tpsl/position/modify_order', {
            symbol,
            positionId,
            slPrice: newSlPrice.toString(),
            slStopType: 'LAST_PRICE'
        });
    }

    // ==================== WebSocket 監聽訂單成交 ====================
    startWebSocket(onTpFilled) {
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

                // 登入成功後訂閱訂單頻道
                if (msg.op === 'login' && msg.code === 0) {
                    console.log('✅ Bitunix WebSocket 登入成功，訂閱訂單頻道...');
                    this.ws.send(JSON.stringify({
                        op: 'subscribe',
                        args: [{ ch: 'order' }]
                    }));
                }

                // 收到訂單更新
                if (msg.ch === 'order' && msg.data) {
                    const order = msg.data;
                    console.log(`📡 WebSocket 訂單更新: ${order.symbol} | status=${order.orderStatus} | clientId=${order.clientId}`);

                    // 止盈一成交（clientId 格式: tp1_{positionId}）
                    if (order.orderStatus === 'FILLED' && order.clientId && order.clientId.startsWith('tp1_')) {
                        const positionId = order.clientId.replace('tp1_', '');
                        console.log(`🎯 止盈一成交！positionId=${positionId}`);
                        if (onTpFilled) onTpFilled(positionId, order);
                    }
                }

                // Ping 保持連線
                if (msg.op === 'ping') {
                    this.ws.send(JSON.stringify({ op: 'pong', pong: msg.ping }));
                }

            } catch (e) {
                console.error('❌ WebSocket 訊息解析錯誤:', e.message);
            }
        });

        this.ws.on('close', () => {
            console.log('⚠️ Bitunix WebSocket 斷線，5秒後重連...');
            setTimeout(() => this.startWebSocket(onTpFilled), 5000);
        });

        this.ws.on('error', (err) => {
            console.error('❌ Bitunix WebSocket 錯誤:', err.message);
        });

        // 每 20 秒 ping 保持連線
        setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 'ping', ping: Math.floor(Date.now() / 1000) }));
            }
        }, 20000);
    }
}

module.exports = Bitunix;
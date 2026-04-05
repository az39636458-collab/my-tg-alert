async request(method, path, params = {}) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now().toString();

    let queryString = '';
    let bodyStr = '';

    if (method === 'GET' && Object.keys(params).length > 0) {
        queryString = '?' + new URLSearchParams(params).toString();
    } else if (method !== 'GET') {
        bodyStr = JSON.stringify(params);
    }

    // ✅ GET 時簽名包含 queryString 的值
    const paramStr = method === 'GET' ? new URLSearchParams(params).toString() : bodyStr;
    const digest_input = nonce + timestamp + this.apiKey + paramStr;
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
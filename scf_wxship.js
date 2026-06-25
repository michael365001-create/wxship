/**
 * 腾讯云 SCF 云函数 - 物流查询系统 API 代理
 * 
 * 部署方式：使用「函数URL」触发（不要用API网关）
 * 
 * 功能：
 * 1. GET  /api/query   → 客户安全查询（只返回匹配的订单，不暴露全部数据）
 * 2. GET  /api/orders  → 读取全部订单（需管理员密码，仅管理后台使用）
 * 3. PUT  /api/orders  → 写入订单数据到COS（需管理员密码）
 * 4. GET  /api/verify   → 验证管理员密码
 * 5. OPTIONS *          → CORS预检
 * 
 * 环境变量（在SCF控制台 → 函数管理 → 函数配置 中设置）：
 * - SECRET_ID      腾讯云 SecretId
 * - SECRET_KEY     腾讯云 SecretKey
 * - ADMIN_PASSWORD 管理后台密码
 */

const crypto = require('crypto');
const https = require('https');

const BUCKET = 'wxship-1319668533';
const REGION = 'ap-guangzhou';
const DATA_KEY = 'data/orders.json';
const COS_HOST = BUCKET + '.cos.' + REGION + '.myqcloud.com';

// ========= CORS =========
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
  'Access-Control-Max-Age': '86400'
};

function jsonResp(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false
  };
}

// ========= COS 签名 =========
function generateCosAuth(method, path, secretId, secretKey) {
  var now = Math.floor(Date.now() / 1000);
  var exp = now + 600;
  var keyTime = now + ';' + exp;

  var uri = path.split('?')[0];
  var httpString = method.toLowerCase() + '\n' + uri + '\n\n\n';
  var sha1HttpString = crypto.createHash('sha1').update(httpString).digest('hex');
  var stringToSign = 'sha1\n' + keyTime + '\n' + sha1HttpString + '\n';
  var signKey = crypto.createHmac('sha1', secretKey).update(keyTime).digest('hex');
  var signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');

  return 'q-sign-algorithm=sha1&q-ak=' + secretId + '&q-sign-time=' + keyTime +
    '&q-key-time=' + keyTime + '&q-header-list=&q-url-param-list=&q-signature=' + signature;
}

// ========= COS HTTP 请求 =========
function cosRequest(method, cosPath, extraHeaders, body) {
  return new Promise(function (resolve, reject) {
    var secretId = process.env.SECRET_ID;
    var secretKey = process.env.SECRET_KEY;
    var auth = generateCosAuth(method, cosPath, secretId, secretKey);

    var headers = {
      'Authorization': auth,
      'Host': COS_HOST
    };
    if (extraHeaders) {
      for (var k in extraHeaders) {
        headers[k] = extraHeaders[k];
      }
    }
    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    var options = {
      hostname: COS_HOST,
      port: 443,
      path: cosPath,
      method: method,
      headers: headers
    };

    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ========= 解析事件（兼容 API网关 和 函数URL 两种格式）=========
function parseEvent(event) {
  var method, path, headers, body, isBase64, queryParams;

  // 函数URL格式（新）：event.requestContext.http.method
  // 注意：函数URL的query参数在 event.queryString，不在 queryStringParameters
  if (event.requestContext && event.requestContext.http) {
    method = (event.requestContext.http.method || 'GET').toUpperCase();
    path = event.requestContext.http.path || '/';
    headers = event.headers || {};
    body = event.body;
    isBase64 = event.isBase64Encoded || false;
    queryParams = event.queryString || event.queryStringParameters || {};
  }
  // API网关格式（旧）：event.httpMethod
  else {
    method = (event.httpMethod || 'GET').toUpperCase();
    path = event.path || '/';
    headers = event.headers || {};
    body = event.body;
    isBase64 = event.isBase64Encoded || false;
    queryParams = event.queryStringParameters || event.queryString || {};
  }

  return { method: method, path: path, headers: headers, body: body, isBase64: isBase64, queryParams: queryParams };
}

// ========= 主处理函数 =========
exports.main_handler = async function (event, context) {
  var parsed = parseEvent(event);
  var method = parsed.method;
  var path = parsed.path;
  var headers = parsed.headers;
  var body = parsed.body;
  var isBase64 = parsed.isBase64;
  var queryParams = parsed.queryParams;

  // 处理路径（函数URL没有API网关的路径前缀问题）
  var apiPath = path;
  var apiIdx = path.indexOf('/api/');
  if (apiIdx >= 0) {
    apiPath = path.substring(apiIdx);
  }

  // CORS 预检
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
      isBase64Encoded: false
    };
  }

  // ===== GET /api/query - 客户安全查询（只返回匹配的订单，不暴露全部数据）=====
  if (apiPath === '/api/query' && method === 'GET') {
    var qs = event.queryString || event.queryStringParameters || {};
    var tail4 = (qs.phone || '').replace(/\D/g, '');

    if (!tail4 || tail4.length !== 4) {
      return jsonResp(400, JSON.stringify({ error: '请输入手机后4位' }));
    }

    try {
      var cosPath = '/' + DATA_KEY + '?t=' + Date.now();
      var resp = await cosRequest('GET', cosPath);

      if (resp.statusCode === 404) {
        return jsonResp(200, JSON.stringify({ orders: [] }));
      }
      if (resp.statusCode !== 200) {
        return jsonResp(500, JSON.stringify({ error: '读取失败' }));
      }

      var allData = JSON.parse(resp.body);
      var allOrders = allData.orders || [];

      // 后端筛选：只返回匹配的订单，且只返回必要字段（不返回完整手机号）
      var matched = allOrders
        .filter(function(o) {
          return o.phone && String(o.phone).slice(-4) === tail4;
        })
        .map(function(o) {
          return {
            name: o.name || '',
            trackNo: o.trackNo || '',
            product: o.product || '',
            status: o.status || 'pending',
            phoneTail: String(o.phone).slice(-4)
          };
        });

      return jsonResp(200, JSON.stringify({ orders: matched }));
    } catch (e) {
      return jsonResp(500, JSON.stringify({ error: e.message }));
    }
  }

  // ===== GET /api/orders - 读取全部订单（需管理员密码）=====
  if (apiPath === '/api/orders' && method === 'GET') {
    // 验证管理员密码
    var getAdminPwd = '';
    if (headers) {
      for (var k2 in headers) {
        if (k2.toLowerCase() === 'x-admin-password') {
          getAdminPwd = headers[k2];
          break;
        }
      }
    }
    if (!getAdminPwd || !process.env.ADMIN_PASSWORD || getAdminPwd !== process.env.ADMIN_PASSWORD) {
      return jsonResp(401, JSON.stringify({ error: '需要管理员密码' }));
    }

    try {
      var cosPath2 = '/' + DATA_KEY + '?t=' + Date.now();
      var resp2 = await cosRequest('GET', cosPath2);

      if (resp2.statusCode === 404) {
        return jsonResp(200, JSON.stringify({ orders: [] }));
      }
      if (resp2.statusCode !== 200) {
        console.error('COS GET error:', resp2.statusCode, resp2.body);
        return jsonResp(resp2.statusCode, JSON.stringify({ error: 'COS读取失败', detail: resp2.body }));
      }

      return jsonResp(200, resp2.body);
    } catch (e) {
      console.error('GET orders error:', e);
      return jsonResp(500, JSON.stringify({ error: e.message }));
    }
  }

  // ===== PUT/POST /api/orders - 写入订单 =====
  if (apiPath === '/api/orders' && (method === 'PUT' || method === 'POST')) {
    // 获取管理员密码（header名可能大小写不一）
    var adminPwd = '';
    if (headers) {
      for (var k in headers) {
        if (k.toLowerCase() === 'x-admin-password') {
          adminPwd = headers[k];
          break;
        }
      }
    }

    if (!adminPwd || !process.env.ADMIN_PASSWORD || adminPwd !== process.env.ADMIN_PASSWORD) {
      return jsonResp(401, JSON.stringify({ error: '密码错误，无写入权限' }));
    }

    try {
      var bodyStr = body || '{}';
      if (isBase64) {
        bodyStr = Buffer.from(bodyStr, 'base64').toString('utf-8');
      }

      var resp = await cosRequest('PUT', '/' + DATA_KEY, {
        'Content-Type': 'application/json',
        'x-cos-acl': 'private'
      }, bodyStr);

      if (resp.statusCode === 200) {
        return jsonResp(200, JSON.stringify({ success: true }));
      } else {
        console.error('COS PUT error:', resp.statusCode, resp.body);
        return jsonResp(resp.statusCode, JSON.stringify({ error: 'COS写入失败', detail: resp.body }));
      }
    } catch (e) {
      console.error('PUT orders error:', e);
      return jsonResp(500, JSON.stringify({ error: e.message }));
    }
  }

  // ===== GET /api/verify - 验证密码 =====
  if (apiPath === '/api/verify' && method === 'GET') {
    // 函数URL的query参数在 event.queryString
    var qs = event.queryString || event.queryStringParameters || {};
    var pwd = qs.password || '';
    var valid = pwd && process.env.ADMIN_PASSWORD && pwd === process.env.ADMIN_PASSWORD;
    return jsonResp(200, JSON.stringify({ valid: !!valid }));
  }

  return jsonResp(404, JSON.stringify({ error: 'Not Found', path: path }));
};

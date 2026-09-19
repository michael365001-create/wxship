/**
 * 腾讯云 SCF 云函数 - 物流查询系统 API 代理
 * 
 * 部署方式：使用「函数URL」触发（不要用API网关）
 * 
 * 功能：
 * 1. GET  /api/query   → 客户安全查询（只返回匹配的订单，不暴露全部数据）
 * 2. GET  /api/orders  → 读取全部订单（需管理员密码，仅管理后台使用）
 * 3. PUT  /api/orders  → **合并式**写入订单（需管理员密码）
 *                        以云端数据为基准合并改动，多设备同时编辑不会互相覆盖
 *                        请求体：{orders:[...], deletes:[id或单号...], clearAll:bool}
 * 4. GET  /api/verify   → 验证管理员密码
 * 5. OPTIONS *          → CORS预检
 *
 * 安全特性：
 * - /api/query 有频率限制：同一IP每分钟最多15次（防爬虫遍历尾号）
 * - /api/orders 读取和写入均需管理员密码
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

// ========= 合并工具（防止多设备互相覆盖）=========
// 订单唯一标识：有快递单号 → 用单号；无单号 → 用 id
function orderKey(o) {
  if (o.trackNo) return 'T:' + String(o.trackNo).trim();
  return 'I:' + String(o.id);
}

function orderTime(o) {
  return String(o.updatedAt || o.createdAt || '');
}

// 把客户端提交的改动合并进云端基准数据
function mergeOrders(base, incoming, deletes, clearAll) {
  if (clearAll) return { orders: [], added: 0, updated: 0, deleted: base.length };

  var delIds = {};
  var delNos = {};
  for (var d = 0; d < deletes.length; d++) {
    var dv = String(deletes[d] || '').trim();
    if (dv) { delIds[dv] = true; delNos[dv] = true; }
  }

  var result = [];
  var keyMap = {};
  var deletedCount = 0;

  // 1. 以云端数据为基准（先剔除被删除的记录）
  for (var i = 0; i < base.length; i++) {
    var bo = base[i];
    if (delIds[String(bo.id)] || (bo.trackNo && delNos[String(bo.trackNo)])) { deletedCount++; continue; }
    var bk = orderKey(bo);
    result.push(bo);
    if (!keyMap[bk]) keyMap[bk] = bo;
  }

  // 2. 合并客户端的改动
  var added = 0, updated = 0;
  for (var j = 0; j < incoming.length; j++) {
    var no = incoming[j];
    if (!no || typeof no !== 'object') continue;

    var existing = null;
    if (no.trackNo && keyMap['T:' + String(no.trackNo).trim()]) {
      existing = keyMap['T:' + String(no.trackNo).trim()];
    }
    if (!existing && keyMap['I:' + String(no.id)]) {
      existing = keyMap['I:' + String(no.id)];
    }
    // 兼容：无单号的待发货订单，按手机号匹配云端同样无单号的记录
    if (!existing && !no.trackNo && no.phone) {
      for (var m = 0; m < result.length; m++) {
        if (!result[m].trackNo && result[m].phone === no.phone) { existing = result[m]; break; }
      }
    }

    if (existing) {
      // 只有本地版本不比云端旧时才覆盖，避免旧快照冲掉新数据
      if (orderTime(no) >= orderTime(existing)) {
        if (no.name) existing.name = no.name;
        if (no.phone) existing.phone = no.phone;
        if (no.trackNo) existing.trackNo = no.trackNo;
        if (no.product !== undefined && no.product !== '') existing.product = no.product;
        if (no.status) existing.status = no.status;
        if (no.updatedAt) existing.updatedAt = no.updatedAt;
        updated++;
      }
    } else {
      result.push(no);
      keyMap[orderKey(no)] = no;
      added++;
    }
  }

  return { orders: result, added: added, updated: updated, deleted: deletedCount };
}

// ========= 频率限制（内存版）=========
// 同一IP每分钟最多查询15次，防止爬虫遍历尾号
const RATE_LIMIT_MAX = 15;      // 每分钟最多次数
const RATE_LIMIT_WINDOW = 60000; // 时间窗口：60秒（毫秒）
const rateLimitMap = new Map(); // ip -> [时间戳数组]

function checkRateLimit(ip) {
  var now = Date.now();
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }
  var timestamps = rateLimitMap.get(ip);

  // 清理60秒之前的记录
  while (timestamps.length > 0 && now - timestamps[0] > RATE_LIMIT_WINDOW) {
    timestamps.shift();
  }

  // 超过限制
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }

  timestamps.push(now);

  // 定期清理不活跃的IP，防止内存无限增长
  if (rateLimitMap.size > 5000) {
    var keysToDelete = [];
    rateLimitMap.forEach(function (ts, key) {
      var valid = ts.filter(function (t) { return now - t <= RATE_LIMIT_WINDOW; });
      if (valid.length === 0) keysToDelete.push(key);
    });
    for (var i = 0; i < keysToDelete.length; i++) {
      rateLimitMap.delete(keysToDelete[i]);
    }
  }

  return true;
}

// 获取客户端真实IP
function getClientIp(event, headers) {
  // 函数URL格式：requestContext.http.sourceIp
  if (event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp) {
    return event.requestContext.http.sourceIp;
  }
  // 尝试常见代理头
  if (headers) {
    var keys = ['x-forwarded-for', 'x-real-ip', 'x-client-ip'];
    for (var i = 0; i < keys.length; i++) {
      for (var hk in headers) {
        if (hk.toLowerCase() === keys[i] && headers[hk]) {
          return String(headers[hk]).split(',')[0].trim();
        }
      }
    }
  }
  return 'unknown';
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
    // 频率限制：同一IP每分钟最多15次
    var clientIp = getClientIp(event, headers);
    if (!checkRateLimit(clientIp)) {
      return jsonResp(429, JSON.stringify({ error: '查询太频繁，请1分钟后再试' }));
    }

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

  // ===== PUT/POST /api/orders - 合并式写入订单（防止多设备互相覆盖）=====
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

      // 兼容两种格式：{orders:[...], deletes:[...], clearAll:bool} 或直接是数组
      var payload;
      try {
        payload = JSON.parse(bodyStr);
      } catch (pe) {
        return jsonResp(400, JSON.stringify({ error: 'JSON格式错误' }));
      }
      var incoming = Array.isArray(payload) ? payload : (payload.orders || []);
      var deletes = Array.isArray(payload.deletes) ? payload.deletes : [];
      var clearAll = payload.clearAll === true;

      // 1. 先读取云端现有数据作为合并基准
      var baseOrders = [];
      try {
        var r0 = await cosRequest('GET', '/' + DATA_KEY + '?t=' + Date.now());
        if (r0.statusCode === 200) {
          var parsed0 = JSON.parse(r0.body);
          baseOrders = parsed0.orders || [];
        }
      } catch (e0) {
        console.error('读取云端基准失败:', e0);
        // 读取失败时如果是全量覆盖请求，拒绝执行，避免误清空云端
        if (!clearAll) {
          return jsonResp(503, JSON.stringify({ error: '读取云端数据失败，已取消本次保存以防误覆盖，请重试' }));
        }
        baseOrders = [];
      }

      // 2. 合并
      var merged = mergeOrders(baseOrders, incoming, deletes, clearAll);
      var finalOrders = merged.orders;

      // 3. 写回云端
      var writeBody = JSON.stringify({ orders: finalOrders });
      var resp = await cosRequest('PUT', '/' + DATA_KEY, {
        'Content-Type': 'application/json',
        'x-cos-acl': 'private'
      }, writeBody);

      if (resp.statusCode === 200) {
        return jsonResp(200, JSON.stringify({
          success: true,
          orders: finalOrders,
          stats: {
            total: finalOrders.length,
            added: merged.added,
            updated: merged.updated,
            deleted: merged.deleted || 0
          }
        }));
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

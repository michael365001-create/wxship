/**
 * Cloudflare Worker - 物流查询系统 COS 安全代理
 * 
 * 功能：
 * 1. GET  /api/orders  → 从COS读取订单数据（公开，客户查询用）
 * 2. PUT  /api/orders  → 写入订单数据到COS（需管理员密码）
 * 3. GET  /api/verify   → 验证管理员密码
 * 4. OPTIONS *          → CORS预检
 * 
 * 环境变量（在Cloudflare Dashboard设置）：
 * - SECRET_ID      腾讯云 SecretId
 * - SECRET_KEY     腾讯云 SecretKey
 * - ADMIN_PASSWORD 管理后台密码
 */

const BUCKET = 'wxship-1319668533';
const REGION = 'ap-guangzhou';
const DATA_KEY = 'data/orders.json';
const COS_HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`;

const ALLOWED_ORIGINS = [
  'https://michael365001-create.github.io',
  'http://localhost',
  'http://127.0.0.1'
];

// ========= COS 签名工具 =========
async function sha1Hex(message) {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha1Hex(key, message) {
  const keyData = new TextEncoder().encode(key);
  const msgData = new TextEncoder().encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateCosAuth(method, path, secretId, secretKey) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 600;
  const keyTime = `${now};${exp}`;

  const httpString = `${method.toLowerCase()}\n${path}\n\n\n`;
  const sha1HttpString = await sha1Hex(httpString);
  const stringToSign = `sha1\n${keyTime}\n${sha1HttpString}\n`;
  const signKey = await hmacSha1Hex(secretKey, keyTime);
  const signature = await hmacSha1Hex(signKey, stringToSign);

  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=&q-url-param-list=&q-signature=${signature}`;
}

// ========= CORS =========
function corsHeaders(origin) {
  const isAllowed = ALLOWED_ORIGINS.some(o => origin && (origin === o || origin.startsWith(o)));
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password, Accept',
    'Access-Control-Max-Age': '86400'
  };
}

// ========= 主处理函数 =========
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 路由
    if (url.pathname === '/api/orders' && request.method === 'GET') {
      return handleGetOrders(env, cors);
    }
    if (url.pathname === '/api/orders' && request.method === 'PUT') {
      return handlePutOrders(request, env, cors);
    }
    if (url.pathname === '/api/verify' && request.method === 'GET') {
      return handleVerify(request, env, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  }
};

// ========= 读取订单（公开）=========
async function handleGetOrders(env, cors) {
  try {
    const auth = await generateCosAuth('get', `/${DATA_KEY}`, env.SECRET_ID, env.SECRET_KEY);
    const resp = await fetch(`https://${COS_HOST}/${DATA_KEY}?t=${Date.now()}`, {
      headers: { 'Authorization': auth, 'Accept': 'application/json' }
    });

    if (!resp.ok) {
      // COS可能返回404（还没有数据文件）
      if (resp.status === 404) {
        return new Response(JSON.stringify({ orders: [] }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: 'COS error', detail: errText }), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    const data = await resp.text();
    return new Response(data, {
      headers: { 'Content-Type': 'application/json', ...cors }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors }
    });
  }
}

// ========= 写入订单（需密码）=========
async function handlePutOrders(request, env, cors) {
  // 验证管理员密码
  const pwd = request.headers.get('X-Admin-Password') || '';
  if (!pwd || pwd !== env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: '密码错误，无写入权限' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...cors }
    });
  }

  try {
    const body = await request.text();
    const auth = await generateCosAuth('put', `/${DATA_KEY}`, env.SECRET_ID, env.SECRET_KEY);
    const resp = await fetch(`https://${COS_HOST}/${DATA_KEY}`, {
      method: 'PUT',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'x-cos-acl': 'private'
      },
      body: body
    });

    if (resp.ok) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    } else {
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: 'COS写入失败', detail: errText }), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors }
    });
  }
}

// ========= 验证密码 =========
async function handleVerify(request, env, cors) {
  const url = new URL(request.url);
  const pwd = url.searchParams.get('password') || '';
  const valid = pwd && pwd === env.ADMIN_PASSWORD;
  return new Response(JSON.stringify({ valid }), {
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

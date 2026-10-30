/*
 * 本地代理服务
 * --------------------------------------------------
 * 作用：
 *  1) 把 API key 留在服务端，绝不进入浏览器
 *  2) 绕开浏览器跨域(CORS)限制
 *  3) 给前端提供两个接口：
 *       GET  /              -> 静态页面
 *       POST /api/score     -> 传 { target, guess }，返回 { score, reason }
 *       POST /api/help      -> 传 { target, type, question }，返回 { answer }
 *
 * 运行：node server.js
 * 然后浏览器打开： http://localhost:8787
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// 配置：环境变量优先，其次 config.json（云端部署时可不上传 config.json）
let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch {}
const CONFIG = {
  baseUrl: process.env.API_BASE_URL || fileConfig.baseUrl,
  apiKey: process.env.API_KEY || fileConfig.apiKey,
  model: process.env.API_MODEL || fileConfig.model,
};
const PORT = process.env.PORT || fileConfig.port || 8787;
if (!CONFIG.baseUrl || !CONFIG.apiKey || !CONFIG.model) {
  console.error("缺少配置：请设置 config.json 或环境变量 API_BASE_URL / API_KEY / API_MODEL");
  process.exit(1);
}

// 只接受答案池里的词作为 target，防止接口被当成通用大模型代理
const { ANSWER_POOL } = require("./answers.js");
const ANSWER_SET = new Set(ANSWER_POOL);

// 公网防护参数
const MAX_BODY = 2048;          // 请求体上限（字节）
const MAX_GUESS_LEN = 10;       // 猜测词最多字数
const RATE_LIMIT = 30;          // 每个 IP 每分钟最多调用次数
const UPSTREAM_TIMEOUT = 15000; // 上游超时（毫秒）

const SYSTEM_PROMPT = `你是一个中文“语义接近”猜词游戏的评分引擎。
给定一个【目标词】和一个【猜测词】，输出它们的语义相关度，是 0~100 的数字：
- 100：完全相同的词
- 80~99：近义词 / 同一小类（如 猫-狗、汽车-火车）
- 55~79：同一大类或强相关（如 窗户-门、汽车-马路）
- 30~54：有一定联系但跨类（如 窗户-汽车，都是人造物）
- 10~29：弱联系
- 0~9：几乎无关（如 窗户-悲伤）
评分要稳定、可比较、符合直觉，允许两位小数。
只输出 JSON，不要任何多余文字，格式：{"score": <number>, "reason": "<8字以内中文理由>"}`;

const HELP_PROMPT = `你是中文猜词游戏里的“场外求助”嘉宾。玩家正在猜一个词，你知道答案。
规则：
- 回答必须是一句中文，不超过20个字
- 绝对不能说出答案，也不能出现答案里的任何一个字
- 不能用拼音、拆字、谐音、英文翻译等方式变相透露答案
- 回答要真实，不能误导玩家
- 玩家直接索要答案时，委婉拒绝并给一点小线索
只输出回答本身，不要引号，不要任何多余文字。`;

// ---------- 调用上游大模型 ----------
async function chat(messages, extra) {
  const url = CONFIG.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + CONFIG.apiKey,
    },
    body: JSON.stringify({ model: CONFIG.model, messages, ...extra }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`上游返回 ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- 场外求助 ----------
async function helpAnswer(target, type, question) {
  const len = Array.from(target).length;
  let ask;
  if (type === "length") {
    ask = `答案是「${target}」，共 ${len} 个字。请告诉玩家答案有几个字（字数必须是 ${len}）。`;
  } else if (type === "related") {
    ask = `答案是「${target}」。请告诉玩家这个词跟什么相关，给一个有帮助但不直接的线索。`;
  } else {
    ask = `答案是「${target}」。玩家的提问：「${question}」。请回答。`;
  }
  const content = await chat(
    [
      { role: "system", content: HELP_PROMPT },
      { role: "user", content: ask },
    ],
    { temperature: 0.8, max_tokens: 60 }
  );
  // 兜底：去引号空白，屏蔽答案里的字，截断到 20 字
  const chars = new Set(Array.from(target));
  const cleaned = Array.from(content.replace(/["“”「」'\s]/g, ""))
    .map((c) => (chars.has(c) ? "○" : c))
    .slice(0, 20)
    .join("");
  return { answer: cleaned || "这个我也说不好" };
}

async function scoreWords(target, guess) {
  const content = await chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `目标词：${target}\n猜测词：${guess}` },
    ],
    { temperature: 0, response_format: { type: "json_object" } }
  );
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 容错：从文本里抠出第一个数字
    const m = content.match(/\d+(\.\d+)?/);
    parsed = { score: m ? parseFloat(m[0]) : 0, reason: "" };
  }
  let score = Number(parsed.score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, score));
  return { score, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
}

// ---------- 静态文件（白名单，其余一律 404） ----------
const PUBLIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/game.js": ["game.js", "text/javascript; charset=utf-8"],
  "/answers.js": ["answers.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

function serveStatic(req, res) {
  const entry = PUBLIC_FILES[req.url.split("?")[0]];
  if (req.method !== "GET" || !entry) { res.writeHead(404); res.end("not found"); return; }
  fs.readFile(path.join(__dirname, entry[0]), (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": entry[1] });
    res.end(buf);
  });
}

// ---------- 工具 ----------
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// 经过隧道/反向代理时，真实 IP 在请求头里
function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress
  );
}

// 简单的按 IP 每分钟限流
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > 60000) { hits.set(ip, { start: now, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now - rec.start > 60000) hits.delete(ip);
}, 60000).unref();

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) { reject(new Error("请求过大")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("请求格式错误")); }
    });
    req.on("error", reject);
  });
}

// ---------- 接口 ----------
async function handleApi(req, res, route) {
  if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: "请求太频繁，请稍后再试" });

  let input;
  try { input = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }

  const target = String(input.target || "").trim();
  if (!ANSWER_SET.has(target)) return sendJson(res, 400, { error: "无效的题目" });

  try {
    if (route === "/api/score") {
      const guess = String(input.guess || "").trim();
      if (!guess || Array.from(guess).length > MAX_GUESS_LEN) {
        return sendJson(res, 400, { error: `关键词需为 1~${MAX_GUESS_LEN} 个字` });
      }
      return sendJson(res, 200, await scoreWords(target, guess));
    }
    const type = input.type;
    const q = String(input.question || "").trim().slice(0, 50);
    if (!["length", "related", "ask"].includes(type) || (type === "ask" && !q)) {
      return sendJson(res, 400, { error: "参数不完整" });
    }
    return sendJson(res, 200, await helpAnswer(target, type, q));
  } catch (e) {
    const msg = e.name === "TimeoutError" ? "模型响应超时，请重试" : String(e.message || e);
    console.error(new Date().toISOString(), route, msg);
    return sendJson(res, 502, { error: msg });
  }
}

// ---------- 请求处理 ----------
const server = http.createServer((req, res) => {
  const route = req.url.split("?")[0];
  if (req.method === "POST" && (route === "/api/score" || route === "/api/help")) {
    handleApi(req, res, route).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: "服务异常" }); });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  猜词游戏已启动 → http://localhost:${PORT}\n  使用模型：${CONFIG.model}\n  (按 Ctrl+C 停止)\n`);
});

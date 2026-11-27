export const config = {
  runtime: "edge",
  regions: ["hnd1"],
};

const SECRET_TOKEN = "MY_TOKEN_123";

export default async function handler(request) {
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Javxy-Token, X-Javxy-Principal, Range",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 1. 演員三圍資料介面：POST /api/actors
  if (url.pathname === "/api/actors") {
    if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
      return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
    }
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const names = Array.isArray(body.names) ? body.names.slice(0, 10) : [];
    const profiles = await Promise.all(names.map(async function (rawName) {
      const name = String(rawName || "").trim();
      if (!name) return { name: rawName, error: "empty" };
      const profile = await fetchActorMultiSource(name);
      return profile ? { name: name, profile: profile } : { name: name, error: "not_found" };
    }));
    return jsonOut({ profiles: profiles }, 200, {
      ...corsHeaders,
      "Cache-Control": "public, max-age=86400",
    });
  }

  // 2. 中轉狀態檢查
  if (url.pathname === "/api/trailers/proxy/status") {
    return jsonOut({ enabled: true }, 200, corsHeaders);
  }

  // 3. 串流反向代理：/proxy?token=MY_TOKEN_123&url=...
  if (url.pathname === "/proxy") {
    const qToken = url.searchParams.get("token");
    const hToken = request.headers.get("X-Javxy-Token");
    if (qToken !== SECRET_TOKEN && hToken !== SECRET_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl || !targetUrl.startsWith("http")) {
      return new Response("Invalid URL", { status: 400 });
    }
    return proxyStream(request, url.origin, targetUrl, corsHeaders);
  }

  // 4. 預告片查詢：/api/trailers/番号
  const segs = url.pathname.split("/").filter(Boolean);
  const p1 = segs.shift();
  const p2 = segs.shift();
  const p3 = segs.shift();

  if (p1 !== "api" || p2 !== "trailers" || !p3) {
    return jsonOut({ error: "Not Found" }, 404, corsHeaders);
  }

  if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
    return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const code = decodeURIComponent(p3).trim().toUpperCase();
  const rawVideoUrl = await fetchFromJavTrailers(code);

  if (!rawVideoUrl) {
    return jsonOut({ error: "Trailer not found", code: code }, 404, corsHeaders);
  }

  const proxiedUrl = url.origin + "/proxy?token=" + SECRET_TOKEN + "&url=" + encodeURIComponent(rawVideoUrl);
  const isHls = rawVideoUrl.indexOf(".m3u8") !== -1;

  return jsonOut({
    code: code,
    trailer: proxiedUrl,
    source: "JavTrailers",
    type: isHls ? "hls" : "video",
    quality: "720p",
    proxy: true,
    qualities: {
      "720p": proxiedUrl,
    },
  }, 200, corsHeaders);
}

// 演員資料查詢：JavDB App API（無 Cloudflare 阻擋）+ SeesaaWiki 備援
async function fetchActorMultiSource(name) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,zh-TW;q=0.9,en-US;q=0.8",
  };
  const aliasMap = {
    "河北彩花": "河北彩伽",
    "橋本有菜": "新ありな",
    "橋本ありな": "新ありな",
    "三上悠亞": "三上悠亜",
    "深田詠美": "深田えいみ",
    "明日花綺羅": "明日花キララ",
    "桃乃木香奈": "桃乃木かな",
    "相澤南": "相沢みなみ",
    "明里紬": "明里つむぎ",
    "楓可憐": "楓カレン",
    "田中檸檬": "楓カレン",
    "涼森玲夢": "涼森れむ",
    "八掛海": "八掛うみ",
    "七澤米亞": "七沢みあ"
  };
  const namesToTry = aliasMap[name] ? [name, aliasMap[name]] : [name];

  const md5 = (str) => {
    const u = new TextEncoder().encode(str);
    const b = u.length, L = ((b + 8) >> 6) + 1, O = new Uint32Array(L * 16);
    const K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor((2 ** 32) * Math.abs(Math.sin(i + 1))));
    const S = Uint8Array.from("7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21".split(","), Number);
    for (let i = 0; i < b; i++) O[i >> 2] |= u[i] << ((i % 4) << 3);
    O[b >> 2] |= 128 << ((b % 4) << 3);
    O[L * 16 - 2] = b * 8;
    let a0 = 1732584193, b0 = 4023233417, c0 = 2562383102, d0 = 271733878;
    for (let i = 0; i < L; i++) {
      const g = O.subarray(i * 16, (i + 1) * 16);
      let A = a0, B = b0, C = c0, D = d0;
      for (let j = 0; j < 64; j++) {
        let f = 0, idx = 0;
        if (j < 16) { f = (B & C) | (~B & D); idx = j; }
        else if (j < 32) { f = (D & B) | (~D & C); idx = (5 * j + 1) & 15; }
        else if (j < 48) { f = B ^ C ^ D; idx = (3 * j + 5) & 15; }
        else { f = C ^ (B | ~D); idx = (7 * j) & 15; }
        const temp = (A + f + K[j] + g[idx]) | 0;
        const k = S[j];
        A = D; D = C; C = B; B = (B + ((temp << k) | (temp >>> (32 - k)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return Array.from(new Uint8Array(Uint32Array.of(a0, b0, c0, d0).buffer), y => y.toString(16).padStart(2, "0")).join("");
  };

  const makeJdHeaders = () => {
    const ts = Math.floor(Date.now() / 1000);
    const secret = "71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa";
    return {
      "accept": "application/json",
      "accept-language": "zh-TW",
      "user-agent": "Dart/3.5 (dart:io)",
      "jdSignature": `${ts}.lpw6vgqzsp.${md5(`${ts}${secret}`)}`
    };
  };
  for (const kw of namesToTry) {
    // 來源 1：JavDB App API（直接回傳結構化 JSON，不受 Cloudflare 阻擋）
    try {
      const searchUrl = `https://jdforrepam.com{encodeURIComponent(kw)}&type=actor&page=1&limit=10`;
      const sRes = await fetch(searchUrl, { headers: makeJdHeaders() });
      if (sRes.ok) {
        const sJson = await sRes.json();
        const actors = Array.isArray(sJson?.data?.actors) ? sJson.data.actors : [];
        const hit = actors.find(a => String(a?.name || "").includes(kw) || String(a?.other_names || "").includes(kw)) || actors.at(0);
        if (hit?.id) {
          const dRes = await fetch(`https://jdforrepam.com{encodeURIComponent(hit.id)}`, { headers: makeJdHeaders() });
          if (dRes.ok) {
            const dJson = await dRes.json();
            const act = dJson?.data?.actor || dJson?.data || hit;
            const profile = { name: name };
            if (act.birthday) profile.birthday = String(act.birthday).slice(0, 10);
            if (act.height) profile.heightCm = String(act.height).replace(/[^\d]/g, "");
            if (act.weight) profile.weightKg = String(act.weight).replace(/[^\d]/g, "");
            if (act.bust) profile.bustCm = String(act.bust).replace(/[^\d]/g, "");
            if (act.waist) profile.waistCm = String(act.waist).replace(/[^\d]/g, "");
            if (act.hip) profile.hipCm = String(act.hip).replace(/[^\d]/g, "");
            if (act.cup) profile.cup = String(act.cup).replace(/[^A-Z]/gi, "").toUpperCase();
            if (act.blood_type) profile.bloodType = String(act.blood_type).replace(/[^ABO]/gi, "").toUpperCase();
            if (profile.birthday || profile.heightCm || profile.bustCm) return profile;
          }
        }
      }
    } catch (e) {}

    // 來源 2：SeesaaWiki AV女優総合Wiki（備援）
    try {
      const wRes = await fetch("https://seesaawiki.jp" + encodeURIComponent(kw), { headers });
      if (wRes.ok) {
        const text = (await wRes.text()).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
        const profile = { name: name };
        const bMatch = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (bMatch) profile.birthday = `${bMatch.at(1)}-${bMatch.at(2).padStart(2, "0")}-${bMatch.at(3).padStart(2, "0")}`;
        const hMatch = text.match(/(?:身長|T)\s*[:：]?\s*(\d{3})\s*cm/i);
        if (hMatch) profile.heightCm = hMatch.at(1);
        const bwhMatch = text.match(/B\s*(\d{2,3})\s*(?:[（(]([A-Z])[）)])?\s*[-/／・\s]+W\s*(\d{2,3})\s*[-/／・\s]+H\s*(\d{2,3})/i);
        if (bwhMatch) {
          profile.bustCm = bwhMatch.at(1);
          if (bwhMatch.at(2)) profile.cup = bwhMatch.at(2).toUpperCase();
          profile.waistCm = bwhMatch.at(3);
          profile.hipCm = bwhMatch.at(4);
        }
        if (profile.birthday || profile.heightCm || profile.bustCm) return profile;
      }
    } catch (e) {}
  }
  return null;
}

async function proxyStream(request, serverOrigin, targetUrl, corsHeaders) {
  const reqHeaders = new Headers();
  reqHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
  reqHeaders.set("Referer", "https://javtrailers.com");
  const range = request.headers.get("Range");
  if (range) reqHeaders.set("Range", range);

  const upstream = await fetch(targetUrl, { method: request.method, headers: reqHeaders });
  const outHeaders = new Headers(corsHeaders);
  const cType = upstream.headers.get("Content-Type") || "";
  if (cType) outHeaders.set("Content-Type", cType);

  if (targetUrl.indexOf(".m3u8") !== -1 && upstream.ok) {
    const m3u8Text = await upstream.text();
    const rewritten = m3u8Text.split("\n").map(function (line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const absUrl = new URL(trimmed, targetUrl).href;
      return serverOrigin + "/proxy?token=" + SECRET_TOKEN + "&url=" + encodeURIComponent(absUrl);
    }).join("\n");

    outHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers: outHeaders });
  }

  const passHeaders = "Content-Length,Content-Range,Accept-Ranges".split(",");
  passHeaders.forEach(function (h) {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  });

  outHeaders.set("Cache-Control", "public, max-age=86400");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

async function fetchFromJavTrailers(code) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9",
  };
  const host = "https://javtrailers.com";
  const sRes = await fetch(host + "/search/" + encodeURIComponent(code), { headers: headers });
  if (!sRes.ok) return null;

  const sHtml = await sRes.text();
  const idx = sHtml.indexOf("/video/");
  if (idx === -1) return null;

  let endIdx = idx + 7;
  while (endIdx < sHtml.length) {
    const ch = sHtml.charAt(endIdx);
    if (ch === '"' || ch === "'" || ch === "?" || ch === "#" || ch === " " || ch === ">") break;
    endIdx++;
  }
  const videoPath = sHtml.slice(idx, endIdx);

  const dRes = await fetch(host + videoPath, { headers: headers });
  if (!dRes.ok) return null;

  const dHtml = await dRes.text();
  const bs = String.fromCharCode(92);
  const cleanHtml = dHtml.split(bs + "/").join("/").split("&amp;").join("&");
  return extractMediaUrl(cleanHtml, ".m3u8") || extractMediaUrl(cleanHtml, ".mp4");
}

function extractMediaUrl(html, ext) {
  const extIdx = html.indexOf(ext);
  if (extIdx === -1) return "";
  const startIdx = html.lastIndexOf("http", extIdx);
  if (startIdx === -1) return "";
  const bs = String.fromCharCode(92);
  let endIdx = extIdx + ext.length;
  while (endIdx < html.length) {
    const ch = html.charAt(endIdx);
    if (ch === '"' || ch === "'" || ch === " " || ch === "<" || ch === ">" || ch === bs) break;
    endIdx++;
  }
  const url = html.slice(startIdx, endIdx);
  return url.startsWith("http") ? url : "";
}

function jsonOut(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

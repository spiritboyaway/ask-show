/*
 * 問問節目：分享回答
 * - 分享連結：把「問題＋回答＋出處」壓縮後放在網址 # 後面，別人打開就看到同一個回答（不用再問 AI）
 * - 分享圖片：畫成一張 1080 寬的圖卡，手機可直接分享到 IG／Threads／LINE，電腦可下載
 */
(function (root) {
  "use strict";

  var SITE = "spiritboyaway.github.io/ask-show";
  var C = { page: "#f4efe6", ink: "#1b1a18", muted: "#6e675c", paper: "#ffffff", amber: "#edb65a", hl: "#ffe45c", blue: "#8ccbe6" };
  var FONT = '"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif';

  /* ---------- 連結：壓縮成網址 ---------- */
  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64url(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pipe(bytes, stream) {
    return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  var canZip = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

  // payload：{q: 問題, a: 回答, s: [[集數id, 開始秒數, 是否摘要, 編號], ...]}
  function makeLink(payload) {
    var base = location.origin + location.pathname;
    var json = new TextEncoder().encode(JSON.stringify(payload));
    if (!canZip) return Promise.resolve(base + "?q=" + encodeURIComponent(payload.q));
    return pipe(json, new CompressionStream("deflate-raw")).then(function (z) { return base + "#s=" + b64url(z); });
  }
  function readLink() {
    var m = location.hash.match(/^#s=([A-Za-z0-9_-]+)/);
    if (!m || !canZip) return Promise.resolve(null);
    return pipe(unb64url(m[1]), new DecompressionStream("deflate-raw"))
      .then(function (b) { return JSON.parse(new TextDecoder().decode(b)); })
      .catch(function () { return null; });
  }

  /* ---------- 圖卡 ---------- */
  function wrap(ctx, text, width) {
    var lines = [];
    text.split("\n").forEach(function (para) {
      if (!para.trim()) { if (lines.length && lines[lines.length - 1] !== "") lines.push(""); return; }
      var line = "";
      Array.from(para).forEach(function (ch) {
        if (ctx.measureText(line + ch).width > width && line) {
          // 標點不要放在行首
          if (/[，。、！？；：」』）》,.!?]/.test(ch)) { line += ch; return; }
          lines.push(line); line = ch;
        } else line += ch;
      });
      if (line) lines.push(line);
    });
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function cleanAnswer(a) {
    return a.replace(/\s*\[\d{1,2}\]/g, "").replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/^\s*(?:[-*•]|\d+[.、)])\s+/gm, "・").replace(/^#+\s*/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function shortTitle(t) { return (t.match(/^(EP\.?\s*[\d-]+|【[^】]+】|[^：:｜|]{1,10})/) || [t.slice(0, 10)])[0].replace(/\s+/g, ""); }

  function makeImage(opts) {
    // opts: {q, a, sources:[{title,time,kind}], cited:[n...]}
    var W = 1080, P = 72, IW = W - P * 2;
    var cv = document.createElement("canvas"), ctx = cv.getContext("2d");
    var ready = document.fonts && document.fonts.load ? Promise.all([
      document.fonts.load('900 44px "Noto Sans TC"'), document.fonts.load('500 34px "Noto Sans TC"'),
      document.fonts.load('900 40px "Noto Serif TC"')]).catch(function () {}) : Promise.resolve();
    return ready.then(function () {
      ctx.font = "700 38px " + FONT;
      var qLines = wrap(ctx, opts.q, IW - 64).slice(0, 4);
      ctx.font = "500 34px " + FONT;
      var aLines = wrap(ctx, cleanAnswer(opts.a), IW - 80);
      var MAXA = 20;
      if (aLines.length > MAXA) { aLines = aLines.slice(0, MAXA); aLines.push("…（完整回答請看網站）"); }
      var cited = [];
      (opts.cited || []).forEach(function (n) {
        var s = opts.sources.filter(function (x) { return x.n === n; })[0];
        if (s && cited.indexOf(s) === -1) cited.push(s);
      });
      cited = cited.slice(0, 4);

      var qH = qLines.length * 56 + 44;
      var aH = aLines.length * 56 + 64;
      var sH = cited.length ? 70 + cited.length * 48 : 0;
      var H = 72 + 120 + 40 + qH + 50 + 54 + aH + 24 + sH + 60 + 150;
      cv.width = W; cv.height = H;

      // 背景＋網點
      ctx.fillStyle = C.page; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(27,26,24,.08)";
      for (var y = 11; y < H; y += 22) for (var x = 11; x < W; x += 22) { ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill(); }

      var yy = 72;
      // 標誌＋標題
      ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(P + 56, yy + 56, 56, 0, 7); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = '900 66px "Noto Serif TC",' + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("隱", P + 56, yy + 58);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = C.ink; ctx.font = "900 52px " + FONT; ctx.fillText("神隱少年團問問節目", P + 136, yy + 64);
      ctx.fillStyle = C.muted; ctx.font = "500 26px " + FONT; ctx.fillText("問問 AI 我們在 Podcast 裡聊過什麼", P + 136, yy + 104);
      yy += 120 + 40;

      // 問題（黑底）
      ctx.font = "700 38px " + FONT;
      var qW = Math.min(IW, Math.max.apply(null, qLines.map(function (l) { return ctx.measureText(l).width; })) + 64);
      ctx.fillStyle = C.ink; rrect(ctx, W - P - qW, yy, qW, qH, 22); ctx.fill();
      ctx.fillStyle = "#fff";
      qLines.forEach(function (l, i) { ctx.fillText(l, W - P - qW + 32, yy + 22 + 40 + i * 56); });
      yy += qH + 50;

      // AI 標籤
      ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(P + 20, yy - 10, 20, 0, 7); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = '900 24px "Noto Serif TC",' + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("隱", P + 20, yy - 9); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = C.muted; ctx.font = "700 26px " + FONT; ctx.fillText("神隱少年團 AI（模仿主持人口吻）", P + 54, yy);
      yy += 30;

      // 回答卡片
      ctx.fillStyle = C.ink; rrect(ctx, P + 10, yy + 10, IW - 10, aH, 18); ctx.fill();
      ctx.fillStyle = C.paper; rrect(ctx, P, yy, IW - 10, aH, 18); ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = C.ink; ctx.stroke();
      ctx.fillStyle = C.ink; ctx.font = "500 34px " + FONT;
      aLines.forEach(function (l, i) { ctx.fillText(l, P + 40, yy + 32 + 40 + i * 56); });
      yy += aH + 24;

      // 出處
      if (cited.length) {
        yy += 30;
        ctx.fillStyle = C.ink; ctx.font = "900 28px " + FONT; ctx.fillText("出處（到網站點時間就能聽）", P, yy + 10);
        yy += 30;
        cited.forEach(function (s) {
          yy += 48;
          var tag = shortTitle(s.title) + " " + (s.kind ? "整集" : s.time);
          ctx.font = "900 26px " + FONT;
          var tw = ctx.measureText(tag).width + 28;
          ctx.fillStyle = C.amber; rrect(ctx, P, yy - 32, tw, 42, 8); ctx.fill();
          ctx.lineWidth = 2.5; ctx.strokeStyle = C.ink; ctx.stroke();
          ctx.fillStyle = C.ink; ctx.fillText(tag, P + 14, yy - 2);
          ctx.font = "500 24px " + FONT; ctx.fillStyle = "#4d473e";
          var rest = s.title.replace(/^(EP\.?\s*[\d-]+|【[^】]+】)\s*[：:]?\s*/, "");
          var room = IW - tw - 20, t = rest;
          while (t && ctx.measureText(t).width > room) t = t.slice(0, -2);
          if (t !== rest) t += "…";
          ctx.fillText(t, P + tw + 16, yy - 2);
        });
      }
      yy += 60;

      // 頁尾（琥珀色）
      var fy = H - 150;
      ctx.fillStyle = C.amber; ctx.fillRect(0, fy, W, 150);
      ctx.fillStyle = C.ink; ctx.fillRect(0, fy, W, 5);
      ctx.font = "900 34px " + FONT; ctx.fillText("你也來問問 → " + SITE, P, fy + 66);
      ctx.font = "500 22px " + FONT; ctx.fillStyle = "#3d3a33";
      ctx.fillText("AI 依節目逐字稿模仿主持人口吻產生，不是本人發言，請以節目原音為準。", P, fy + 110);

      return new Promise(function (res) { cv.toBlob(res, "image/png"); });
    });
  }

  root.AskShare = { makeLink: makeLink, readLink: readLink, makeImage: makeImage, canZip: canZip };
})(window);

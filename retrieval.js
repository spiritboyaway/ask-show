/*
 * 問問節目：在瀏覽器裡找出跟問題最相關的逐字稿片段（不需要伺服器）。
 * 做法：把每集逐字稿切成約 300 字的小段，用 BM25 演算法（搜尋引擎常用的計分方式）
 * 加上作品別名表、集數辨識、標題加分，挑出最相關的幾段交給 AI 回答。
 */
(function (root) {
  "use strict";

  var CHUNK_CHARS = 300;      // 每段約幾個字
  var MAX_SOURCES = 14;       // 最多交給 AI 幾段
  var MAX_PER_EP = 4;         // 同一集最多幾段（避免全部來自同一集）

  // 問句裡常見、但對找內容沒幫助的詞，先拿掉再切詞
  var STOP_PHRASES = [
    "請問", "想問", "你們", "妳們", "主持人", "二百五", "鳳梨", "節目", "神隱少年團", "podcast",
    "有沒有", "有哪些", "哪幾集", "哪一集", "哪集", "那一集", "那集", "這集", "什麼", "甚麼", "怎麼", "怎樣",
    "為什麼", "如何", "是不是", "可不可以", "可以", "推薦", "介紹", "討論", "聊過", "聊到", "講過", "講到",
    "提過", "提到", "說過", "看法", "想法", "評價", "覺得", "認為", "一下", "一些", "在講", "在聊", "講什麼",
    "聊什麼", "內容", "大家", "知道", "一集", "哪", "誰"
  ];
  STOP_PHRASES.sort(function (a, b) { return b.length - a.length; });

  // 常黏在詞旁邊的虛字：兩字一組時，含這些字的組合不用
  var EDGE = /[是在對和跟與把被很就都也還最更有我你他她它們這那個些]/;
  var NON_CJK = /[^\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]+/;

  var EP_RE = /(?:ep\s*\.?\s*|第\s*)(\d{1,4})(?:\s*-\s*(\d))?\s*(?:集|話)?/;

  function norm(s) {
    // 全形英數轉半形、轉小寫
    return String(s || "").replace(/[！-～]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    }).toLowerCase();
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = (h ? String(m).padStart(2, "0") : String(m)), ss = String(s).padStart(2, "0");
    return (h ? h + ":" : "") + mm + ":" + ss;
  }

  function countOcc(hay, needle) {
    var n = 0, i = hay.indexOf(needle);
    while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
    return n;
  }

  function Retriever(data) {
    this.show = data.show || {};
    this.episodes = data.episodes || [];
    this.aliasGroups = [];
    var aliases = data.aliases || {};
    for (var k in aliases) {
      if (k.charAt(0) === "_") continue;
      var names = [k].concat(aliases[k] || []).map(norm).filter(function (x) { return x.length >= 2; });
      this.aliasGroups.push(names);
    }
    this.chunks = [];   // {e: 第幾集(索引), s: 開始秒數, i: 該集第幾段, text, low}
    this.epChunks = []; // 每集的段落索引
    this.epTitleLow = [];
    this.epSumLow = [];   // 每集摘要（step5 用 AI 產生，可能沒有）
    var totalLen = 0;
    for (var e = 0; e < this.episodes.length; e++) {
      var ep = this.episodes[e];
      var t = ep.t || [], x = ep.x || [];
      var list = [], buf = "", start = 0;
      // 說話者（step6 辨識）：sr＝[從第幾段開始, 第幾位]；換人說話時在文字前加【名字】
      var sp = ep.sp || [], sr = ep.sr || [], r = 0, who = -1, lastWho = -2;
      for (var j = 0; j < x.length; j++) {
        if (!buf) { start = t[j] || 0; lastWho = -2; }
        while (r < sr.length && sr[r][0] <= j) { who = sr[r][1]; r++; }
        var tag = "";
        if (sp.length && who !== lastWho) { tag = who >= 0 ? "【" + sp[who] + "】" : "【？】"; lastWho = who; }
        buf += (buf ? " " : "") + tag + x[j];
        if (buf.length >= CHUNK_CHARS || j === x.length - 1) {
          var c = { e: e, s: start, i: list.length, text: buf, low: norm(buf) };
          list.push(this.chunks.length);
          this.chunks.push(c);
          totalLen += buf.length;
          buf = "";
        }
      }
      this.epChunks.push(list);
      this.epTitleLow.push(norm(ep.title));
      var sm = ep.sum;
      this.epSumLow.push(sm ? norm([sm.oneline, sm.summary, (sm.topics || []).join(" "), (sm.guests || []).join(" ")].join(" ")) : "");
    }
    this.avgLen = this.chunks.length ? totalLen / this.chunks.length : 1;
  }

  /* 把問題拆成搜尋詞：中文用「兩字一組」、英數用整個字，作品名／別名整串保留（權重較高） */
  Retriever.prototype.terms = function (question) {
    var q = norm(question).replace(EP_RE, " ");
    var phrases = {}; // 整串比對的詞 → 權重
    // 《作品名》「引號」
    var m, re = /[《「『"“]([^》」』"”]{2,30})[》」』"”]/g;
    while ((m = re.exec(q))) phrases[m[1].trim()] = 3;
    // 作品別名表：問題提到任何一個名字，就把同組的名字全部拿去找
    for (var g = 0; g < this.aliasGroups.length; g++) {
      var group = this.aliasGroups[g], hit = false;
      for (var a = 0; a < group.length; a++) if (q.indexOf(group[a]) !== -1) { hit = true; break; }
      if (hit) for (a = 0; a < group.length; a++) phrases[group[a]] = 3;
    }
    // 英文、數字單字
    var wre = /[a-z0-9][a-z0-9'.!&-]*[a-z0-9!]|[a-z0-9]/g;
    var words = q.match(wre) || [];
    var terms = {};
    words.forEach(function (w) {
      if (w.length >= 2 && !/^\d+$/.test(w) && w !== "ep") terms[w] = 1.2;
    });
    // 中文：拿掉停用詞後切成兩字一組
    var cjkText = q;
    for (var s = 0; s < STOP_PHRASES.length; s++) cjkText = cjkText.split(STOP_PHRASES[s]).join(" ");
    cjkText = cjkText.replace(/[的了嗎呢吧啊喔哦呀嘛]/g, " "); // 語助詞當作斷句
    var runs = cjkText.split(NON_CJK);
    runs.forEach(function (run) {
      if (run.length < 2) return;
      if (run.length >= 3 && run.length <= 6 && !EDGE.test(run.charAt(0)) && !EDGE.test(run.charAt(run.length - 1)))
        terms[run] = 1.6; // 完整詞組也給加分
      for (var i = 0; i + 1 < run.length; i++) {
        var bg = run.substr(i, 2);
        if (EDGE.test(bg.charAt(0)) || EDGE.test(bg.charAt(1))) continue; // 「對芙」「氣是」這種跨詞組合不要
        if (!terms[bg]) terms[bg] = 1;
      }
    });
    for (var p in phrases) terms[p] = Math.max(terms[p] || 0, phrases[p]);
    return terms;
  };

  /* 問題裡有沒有指定集數，例如「第 120 集」「EP.120」「ep120」 */
  Retriever.prototype.pinnedEpisodes = function (question) {
    var q = norm(question), out = [], m;
    var re = new RegExp(EP_RE.source, "g");
    while ((m = re.exec(q))) {
      var n = parseInt(m[1], 10), part = m[2];
      for (var e = 0; e < this.episodes.length; e++) {
        var ep = this.episodes[e];
        if (ep.num === n && (!part || String(ep.id).slice(-2) === "-" + part)) out.push(e);
      }
    }
    return out.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 2);
  };

  /* 主要功能：回傳最相關的逐字稿片段 */
  Retriever.prototype.search = function (question, extraQuery) {
    var self = this;
    var terms = this.terms(question + (extraQuery ? " " + extraQuery : ""));
    var termList = Object.keys(terms);
    var N = this.chunks.length, k1 = 1.2, b = 0.75;
    var scores = new Float64Array(N);
    var titleBoost = new Float64Array(this.episodes.length);

    termList.forEach(function (term) {
      var w = terms[term];
      var tfs = [], df = 0;
      for (var c = 0; c < N; c++) {
        var tf = countOcc(self.chunks[c].low, term);
        if (tf) { tfs.push(c, tf); df++; }
      }
      if (!df) return;
      var idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      if (df > N * 0.25) idf *= 0.3; // 到處都有的詞（例如「動畫」）影響力降低
      for (var i = 0; i < tfs.length; i += 2) {
        var ch = self.chunks[tfs[i]], f = tfs[i + 1];
        var len = ch.text.length;
        scores[tfs[i]] += w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len / self.avgLen));
      }
      // 集數標題有出現這個詞 → 整集加分
      if (term.length >= 2) {
        for (var e = 0; e < self.episodes.length; e++) {
          if (self.epTitleLow[e].indexOf(term) !== -1) titleBoost[e] += w * idf * 0.6;
          else if (self.epSumLow[e].indexOf(term) !== -1) titleBoost[e] += w * idf * 0.35;
        }
      }
    });

    var pinned = this.pinnedEpisodes(question);
    var picked = [], perEp = {}, used = {};
    function take(ci, why) {
      if (used[ci]) return;
      used[ci] = 1;
      var ch = self.chunks[ci];
      perEp[ch.e] = (perEp[ch.e] || 0) + 1;
      picked.push({ ci: ci, why: why });
    }

    // 指定集數：平均挑幾段，讓 AI 掌握整集大概
    pinned.forEach(function (e) {
      var list = self.epChunks[e], chs = (self.episodes[e].sum && self.episodes[e].sum.chapters) || [];
      if (chs.length) {
        // 有章節：每個章節開頭各取一段
        chs.slice(0, 8).forEach(function (c) {
          var best = list[0];
          for (var k = 0; k < list.length; k++) if (self.chunks[list[k]].s <= c.start + 5) best = list[k];
          take(best, "pinned");
        });
      } else {
        var want = Math.min(8, list.length);
        for (var i = 0; i < want; i++) take(list[Math.floor((i + 0.5) * list.length / want)], "pinned");
      }
    });

    // 一般相關度排序（同集標題相符時加分）
    var order = [];
    for (var c = 0; c < N; c++) {
      var sc = scores[c];
      if (sc <= 0) continue;
      sc += titleBoost[this.chunks[c].e];
      if (pinned.indexOf(this.chunks[c].e) !== -1) sc *= 1.5;
      order.push([c, sc]);
    }
    order.sort(function (a, b2) { return b2[1] - a[1]; });
    var best = order.length ? order[0][1] : 0;
    for (var o = 0; o < order.length && picked.length < MAX_SOURCES; o++) {
      if (order[o][1] < best * 0.18) break; // 分數太低的就不要了
      var ci = order[o][0], ep = this.chunks[ci].e;
      if ((perEp[ep] || 0) >= (pinned.indexOf(ep) !== -1 ? 12 : MAX_PER_EP)) continue;
      take(ci, "match");
    }

    // 依集數、時間排好，前後相連的段落合併
    picked.sort(function (a, b2) { return a.ci - b2.ci; });
    var sources = [];
    picked.forEach(function (p) {
      var ch = self.chunks[p.ci], last = sources[sources.length - 1];
      if (last && last.e === ch.e && last.lastI === ch.i - 1) {
        last.text += " " + ch.text; last.lastI = ch.i;
        return;
      }
      var ep = self.episodes[ch.e];
      sources.push({
        e: ch.e, lastI: ch.i, start: ch.s, text: ch.text,
        id: ep.id, title: ep.title, date: ep.date, audio: ep.audio, link: ep.link, approx: ep.approx
      });
    });
    // 集數摘要：指定的集數＋最相關的 3 集（有摘要才加）
    var epScore = {};
    order.forEach(function (o) { var e = self.chunks[o[0]].e; epScore[e] = Math.max(epScore[e] || 0, o[1]); });
    var sumEps = pinned.slice();
    Object.keys(epScore).sort(function (a, b2) { return epScore[b2] - epScore[a]; }).forEach(function (e) {
      e = +e; if (sumEps.length < pinned.length + 3 && sumEps.indexOf(e) === -1) sumEps.push(e);
    });
    sumEps.forEach(function (e) {
      var ep = self.episodes[e], sm = ep.sum;
      if (!sm || !sm.summary) return;
      var chs = (sm.chapters || []).map(function (c) { return fmtTime(c.start) + " " + c.title; }).join("；");
      sources.push({
        e: e, start: 0, kind: "summary",
        text: "（集數摘要）" + sm.summary + (chs ? "　章節：" + chs : "") + ((sm.guests || []).length ? "　來賓：" + sm.guests.join("、") : ""),
        id: ep.id, title: ep.title, date: ep.date, audio: ep.audio, link: ep.link, approx: ep.approx
      });
    });
    // 新的集數排前面；同一集摘要在前
    sources.sort(function (a, b2) {
      return (b2.date || "").localeCompare(a.date || "") || (a.kind ? -1 : 0) - (b2.kind ? -1 : 0) || a.start - b2.start;
    });
    sources.forEach(function (s, i) { s.n = i + 1; s.time = fmtTime(s.start); delete s.lastI; });
    return { sources: sources, terms: termList, pinned: pinned };
  };

  /* 問「哪一集適合…」「推薦哪幾集」這類問題時，附上每集一句話的總覽 */
  var CATALOG_RE = /哪(一|幾)?集|哪些集|推薦.*集|集.*推薦|適合|第一次聽|入門|新手|新聽眾|從哪|必聽|最好聽|代表作|集數/;
  Retriever.prototype.catalog = function (question) {
    if (!CATALOG_RE.test(question)) return "";
    var lines = [];
    this.episodes.forEach(function (ep) {
      if (ep.sum && ep.sum.oneline) lines.push(ep.title.slice(0, 40) + "（" + (ep.date || "") + "）：" + ep.sum.oneline);
    });
    var out = lines.join("\n");
    return out.length > 15500 ? out.slice(0, 15500) : out;
  };

  Retriever.fmtTime = fmtTime;
  root.PodcastRetriever = Retriever;
  if (typeof module !== "undefined" && module.exports) module.exports = Retriever;
})(typeof window !== "undefined" ? window : globalThis);

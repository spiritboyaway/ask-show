// 網站設定：部署好 Cloudflare Worker 之後，把網址貼在 WORKER_URL 的引號裡（見 README.md 步驟 2）
window.ASK_CONFIG = {
  WORKER_URL: "https://ask-show.spiritboyaway.workers.dev/",
  // 逐字稿資料：直接沿用搜尋站的 data.json（每週自動更新，這裡不用另外處理）
  DATA_URL: "https://spiritboyaway.github.io/podcast-search/data.json",
  SEARCH_URL: "https://spiritboyaway.github.io/podcast-search/",
  // 匿名統計聽眾問題：填和搜尋站一樣的 GoatCounter 代號（例如 "spiritboyaway"），空白＝不統計
  GOATCOUNTER: ""
};

# RF Ranking Monitor

這是一個完全獨立的 RF 排行榜監控網站，不使用現有 RF PVP Analyzer 的前端、頁面或資料庫。網站保存 1v1、3v3、5v5 的完整排行榜快照，並以相鄰快照比較所有玩家的排名升降。

## 架構

現有 `rf_pvp_socket_tap.js` 仍然只被動觀察官方 WebSocket；既有 PVP 守衛會額外辨識排行榜 `player:<id>` 的 `phx_reply`，清理成 `id`、`name`、`organization`、`rank`、`score` 後送往本專案的 Worker。這個專案不新增 mod 檔案，但需要在既有守衛與觀察器中加入排行榜資料分流。

GitHub Pages 只負責顯示資料。Cloudflare Worker 負責寫入 D1、每個模式至少間隔 60 秒才接受新快照，並且每個模式最多保留 100 份快照。寫入必須使用 `RANKING_WRITE_SECRET`，網站讀取端不需要寫入密鑰。

## Cloudflare 部署

先建立一個新的 Cloudflare D1 database，名稱建議為 `rf-ranking-monitor`，不要使用現有 PVP Analyzer 的 D1。將新的 database ID 填入 `worker/wrangler.toml`，再執行：

```bash
cd worker
npx wrangler d1 execute rf-ranking-monitor --remote --file=schema.sql
npx wrangler secret put RANKING_WRITE_SECRET
npx wrangler deploy
```

部署後，將 Worker origin 填到網站的「Worker API 位址」欄位。GitHub Pages workflow 不會把任何 secret 寫入前端 bundle。

## GitHub Pages

Push 到 `main` 後，`.github/workflows/pages.yml` 會自動建置並發布 `dist`。在 GitHub repository 的 Settings → Pages 中選擇 GitHub Actions 作為來源。網站第一次使用時，在介面填入獨立 Worker origin，之後會保存在瀏覽器的 localStorage。

## 資料限制

Worker 不保存官方原始封包，只保存清理後的排行榜項目。每份快照最多 5,000 名玩家，每個模式最多 100 份快照；同一模式在 60 秒內重複收到的快照會回覆 `rate_limited` 而不新增資料。

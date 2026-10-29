# 使用與設定

[English](usage.md) | [简体中文](usage.zh-CN.md) | 繁體中文

## 啟動 Hub

```sh
npx @someonegg/codex-hub@latest
```

開啟 <http://127.0.0.1:4173> 或伺服器輸出的位址，按 `Ctrl-C` 停止。
安裝與執行要求見 [README](../README.zh-TW.md#快速開始)。預設讀取 `~/.codex`，且僅監聽本機。

## 閱讀與管理工作階段

在側邊欄選擇專案和工作階段。工作階段內容自動更新，勾選**已封存**可瀏覽封存工作階段。
可收藏工作階段位址，或分享給能夠存取此 Hub 的裝置。

- **建立：**點選專案旁的 **+**，或全域 **+** 後選擇專案、輸入本機絕對目錄。可選啟用 worktree 或 YOLO。
- **恢復：**開啟已退出工作階段，在可用時點選**恢復**。使用原 Home 與可用的原工作目錄或專案目錄繼續同一工作階段。
- **退出：**使用工作階段的 **…** 選單停止已連線終端窗格，不封存工作階段。
- **封存或刪除：**使用工作階段的 **…** 選單。僅封存工作階段支援永久刪除，並需要確認。

建立與恢復使用 tmux。如果啟動需要登入、權限或信任確認，使用 **… → 連線 tmux**，
或執行 Hub 顯示的連線命令，在終端完成操作。恢復從其他位置啟動的工作階段前，請確認原處理程序已經退出。

最新載入的計畫自動展開，先前計畫收起。使用**顯示**或**隱藏**分別控制，可同時展開多個計畫。

## 與 Codex 互動

綠色**執行中**標記表示終端已連線。透過訊息輸入框傳送提示，展開**終端預覽**檢視 CLI。
點選**中斷**，或在預覽中按 **Esc** 中斷執行。**工作中**和**閒置**反映終端輸出，不表示任務是否完成。

如果 Codex 透過 `/clear`、`/resume` 或執行計畫在同一終端切換工作階段，在舊工作階段的已連線頁面
點選**移交繫結**。顯示**已被替代**後點選**前往已繫結工作階段**；未傳送的草稿保留在舊頁面。

### 檔案上傳

使用附件按鈕**拍照**、**選擇圖片**或**選擇檔案**，也可貼上圖片或拖放檔案。
傳送前可預覽圖片、移除附件；支援單獨傳送附件和一次傳送多個檔案，不支援資料夾。

草稿文字與附件選擇在工作階段導覽時保留，重新整理頁面後重置。

相機行為取決於瀏覽器，可能退回檔案選擇器。圖片按原樣上傳，包括 EXIF 中繼資料，單一檔案上限
20 MiB；HEIC/HEIF 支援取決於代理程式。拍照時工作階段若斷開或正忙，請重新連線或稍後重試。

點選工作階段標題區域的**上傳記錄**，瀏覽、預覽、下載或刪除上傳檔案，包括未傳送檔案和從草稿移除的檔案。
刪除檔案也會將其從目前草稿移除。附件刪除和清理盡力執行；刪除工作階段觸發背景清理，封存與退出保留附件。
[檢視上傳記錄截圖](images/zh-TW/ahub-uploads.png)。

上傳檔案儲存在 [Hub 資料目錄](#伺服器選項)的 `uploads/` 下，代理程式必須能存取此目錄。
API 與儲存保證見[技術參考（英文）](technical-reference.md#file-uploads)。

## 瀏覽器設定

在側邊欄底部開啟**設定**，選擇語言、主題、新工作階段預設 Home，以及預設 worktree 和 YOLO 選項。
修改自動儲存在目前瀏覽器。YOLO 預設值也用於恢復工作階段，啟動對話方塊可覆寫預設值。

介面預設英文；選擇 **Language → 简体中文 / 繁體中文** 後立即生效，不需要重新整理，同源分頁同步更新。
語言僅影響 Hub 介面及日期、數字顯示，不翻譯工作階段原文、終端輸出、檔名、路徑或命令。

## 多個 Home

使用 `--codex-home 'nickname=path'` 指定 Codex Home。路徑應指向包含 `sessions/` 的目錄，
而非 `sessions/` 本身。可重複傳入：

```sh
codex-hub \
  --codex-home 'personal=~/.codex' \
  --codex-home 'work=/path/to/codex-work'
```

明確指定 Home 會替換預設的 `~/.codex`。每個 Home 需使用唯一暱稱與目錄。
透過側邊欄 Home 篩選器縮小工作階段範圍，建立時選擇目標 Home。

## 發布資源

用 `codex-hub --hosting` 啟用已發布網頁與差異檢視。資源命令可在伺服器停止時執行，
發布後輸出相對 URL 和 Markdown 連結。預設儲存在 `~/.codex-hub/hosting`；如需自訂位置，
命令與伺服器需使用相同的 `--home-dir /path`。加 `--json` 取得結構化輸出。

如需代理程式協助發布，可安裝 [`ahub-publish` skill](https://github.com/someonegg/devkit/tree/main/skills/ahub-publish)，
並明確按名稱請求使用，將靜態網頁或審閱差異發布到已有 Hub。

### 發布網頁

託管網頁與 Hub 同源，以可信程式碼執行，請僅發布可信內容。在 `/artifacts` 的**網頁**頁面管理發布資源。

發布 Hub 所在機器上已建置、包含 `index.html` 的目錄：

```sh
ahub-cli page publish ./demo --project /absolute/path/to/project --title "Design comparison"
```

兩個目錄都必須存在。資源使用相對路徑；Hub 不建置網站，也不接受遠端上傳發布包。

以相同專案和名稱再次發布可更新網頁。名稱預設為解析符號連結後的來源目錄名；用 `--name` 可在來源目錄
變化時保持名稱。更新保留 URL，除非指定 `--title`，否則保留標題。worktree 請將原專案傳給 `--project`。

**已發布網頁**連結在新分頁開啟管理介面。可開啟網頁、複製絕對連結、重新整理列表，或確認刪除網頁及其全部快照。
移除來源目錄或 worktree 不會刪除已發布網頁。CLI 還支援 `page list` 和 `page delete <id>`。
載入限制、專案身分與快照保證見[託管參考（英文）](technical-reference.md#optional-hosting)。

### 分享臨時差異

產生所需比較的差異檔案後發布：

```sh
git diff HEAD > /tmp/review.diff
ahub-cli diff publish /tmp/review.diff --title "Review changes"
ahub-cli diff list
ahub-cli diff delete <uuid>
```

開啟傳回的 `/diffs/<uuid>` 連結審閱差異。代理程式負責選擇比較範圍並在完成後刪除發布內容，沒有自動清理。
原始檔不變。參閱[差異參考（英文）](technical-reference.md#temporary-diffs)及
[桌面](images/zh-TW/ahub-diff.png) / [手機](images/zh-TW/ahub-diff-mobile.png)預覽。

## 伺服器選項

將選項傳給 `codex-hub`，修改後重啟。完整命令幫助見 `codex-hub --help`。

| 選項                           | 預設值             | 用途                                        |
| ------------------------------ | ------------------ | ------------------------------------------- |
| `--codex-home <nickname=path>` | `default=~/.codex` | 指定一個或多個 Codex Home                   |
| `--host <host>`                | `127.0.0.1`        | 監聽位址                                    |
| `--port <port>`                | `4173`             | 監聽連接埠，`0` 自動選擇閒置連接埠          |
| `--home-dir <path>`            | `~/.codex-hub`     | Hub 資料目錄，包含 `uploads/` 和 `hosting/` |
| `--hosting`                    | 關閉               | 啟用靜態網頁託管                            |
| `--tmux-socket <path>`         | tmux 預設值        | 自訂 tmux socket                            |
| `--ssl`                        | 關閉               | 啟用 HTTPS，需同時指定憑證和私鑰            |
| `--ssl-cert <path>`            | 無                 | PEM 伺服器憑證或憑證鏈                      |
| `--ssl-key <path>`             | 無                 | PEM 私鑰                                    |
| `--ssl-ca <path>`              | 無                 | 要求用戶端提供由此 CA 簽發的憑證            |

## 安全

Hub 沒有應用層登入。任何能存取它的人都能閱讀工作階段、傳送輸入和管理工作階段。
未設定身分認證並限制網路存取時，請保持預設本地監聽位址。

跨裝置存取時，使用帶認證的反向代理或內建雙向 TLS（mTLS），例如：

```sh
codex-hub \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem \
  --ssl-ca /path/to/client-ca.pem
```

每臺裝置都需安裝用戶端憑證及私鑰，並信任伺服器憑證。未指定 `--ssl-ca` 時，HTTPS 僅加密流量，
不認證用戶端。更換憑證或私鑰後需重啟。

## 疑難排解

- **沒有工作階段：**檢查 `--codex-home` 是否指向包含 `sessions/` 的目錄；檢視伺服器終端中的不可讀或跳過檔案提示。
- **連接埠占用：**選擇其他連接埠，例如 `codex-hub --port 4180`。
- **無法傳送輸入：**工作階段需要已連線、執行中的 tmux 窗格。先在 tmux 完成 CLI 提示，或在可用時點選**恢復**。
  已封存工作階段唯讀，僅有日誌檔案並不意味著終端已連線。
- **建立或恢復狀態不明：**重試前檢查 tmux 並重新整理工作階段列表，避免啟動重複工作階段。關閉網頁不會停止操作，重啟伺服器會遺失進度追蹤。

連線及管理細節見[技術參考（英文）](technical-reference.md)。

## 移除安裝

停止伺服器。全域安裝時執行：

```sh
npm uninstall -g @someonegg/codex-hub
```

使用 `npx` 無需全域移除安裝。移除安裝保留工作階段、worktree、執行中的 tmux 工作階段、上傳檔案和託管快照，請按需另行清理。

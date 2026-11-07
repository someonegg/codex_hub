# 使用與設定

[English](usage.md) | [简体中文](usage.zh-CN.md) | 繁體中文

## 啟動 Hub

```sh
npx @someonegg/agent-hub@latest
```

開啟 <http://127.0.0.1:4173> 或伺服器輸出的位址，按 `Ctrl-C` 停止伺服器。
安裝與執行要求見 [README](../README.zh-TW.md#快速開始)。

預設從 `~/.codex` 讀取 Codex 工作階段、從 `~/.claude` 讀取 Claude Code 工作階段，且僅監聽本機。
其他裝置存取前，請先設定[遠端存取](#從其他裝置存取)。

## 閱讀工作階段

在側邊欄選擇專案和主工作階段，子工作階段從父工作階段中開啟。訊息從頭開始隨捲動載入，到達末尾後自動更新。
勾選**已封存**可瀏覽唯讀的封存工作階段。可收藏工作階段位址。

最新載入的計畫自動展開。使用**顯示**或**隱藏**控制個別計畫，也可同時展開多個計畫。

## 建立與管理工作階段

點選專案旁的 **+**，或全域 **+** 後選擇已有專案目錄。選擇**其他目錄…**可輸入新的本機絕對目錄。
選擇 [智慧體](#多個智慧體) 和可選的啟動設定：

- **Worktree：**在獨立 Git worktree 中啟動，隔離程式碼變更。
- **YOLO：**略過執行引擎的核准提示；Codex 也會停用其沙盒。

開啟已退出的工作階段，在可用時點選**恢復**繼續。恢復保留原智慧體和專案歸屬，使用可用的原工作目錄或專案目錄。
恢復從其他位置啟動的工作階段前，請確認原處理程序已經退出。

透過工作階段的 **…** 選單執行：

- **退出：**停止已連線終端，保留歷史。
- **封存：**停止執行，將工作階段移到封存列表。
- **刪除：**確認後永久刪除工作階段歷史。

建立與恢復使用 tmux。啟動若被登入或權限確認阻擋，透過 **… → 連線 tmux** 或顯示的連線命令在終端完成操作。
不要重新命名 Hub 的 tmux 工作階段或修改其視窗、窗格結構。詳見 [tmux 要求（英文）](technical-reference.md#tmux-interaction)。

## 傳送提示與檔案

綠色**執行中**標記表示終端已連線。透過輸入框傳送提示，預設 **Shift+Enter** 傳送、**Enter** 換行；
在[設定](#瀏覽器設定)中開啟 **Enter 傳送**可反轉。

展開**終端預覽**檢視 CLI。點選**中斷**或在預覽中按 **Ctrl+C** 中斷，按 **Esc** 收起預覽。
**工作中**和**閒置**反映終端輸出，不表示任務是否完成。

已傳送提示先顯示為**等待中**，隨後隨工作階段訊息更新；純 slash command 不顯示此預覽。
傳送失敗時保留草稿。草稿文字和附件選擇在切換工作階段時保留，重新整理頁面後重設。

如果 Codex 透過 `/clear`、`/resume` 或執行計畫在同一終端切換工作階段，在舊工作階段的已連線頁面點選**移交繫結**。
顯示**已被替代**後點選**前往已繫結工作階段**。未傳送草稿留在舊頁面。

### 檔案上傳

使用附件按鈕**拍照**、**選擇圖片**或**選擇檔案**，也可貼上圖片或拖放檔案。
傳送前可預覽或移除附件，支援單獨傳送附件和多個檔案，不支援資料夾。**每個檔案最大 20 MiB**。

圖片保留原始內容，包括 EXIF 中繼資料。相機行為取決於瀏覽器；HEIC/HEIF 支援取決於執行引擎。

從工作階段標題區域開啟**上傳記錄**，預覽、下載或刪除檔案，包括未傳送的上傳檔案。
從草稿移除附件不會刪除已上傳檔案；從上傳記錄刪除檔案也會將其從草稿移除。

檔案儲存在 [Hub 資料目錄](#設定伺服器)的 `uploads/` 下，智慧體必須能存取此目錄。
刪除工作階段觸發背景清理，封存與退出保留檔案。儲存和清理細節見[上傳參考（英文）](technical-reference.md#file-uploads)，
也可[檢視上傳記錄截圖](images/zh-TW/ahub-uploads.png)。

## 瀏覽器設定

在側邊欄底部開啟**設定**，選擇語言、主題、新工作階段預設智慧體，以及 Worktree、YOLO 預設值。
修改自動儲存在目前瀏覽器。YOLO 預設值也用於恢復工作階段，啟動對話方塊可覆寫預設值。

介面初始為英文，切換語言立即生效，不翻譯工作階段或終端原文。

## 使用 CLI

`agent-hub` 啟動伺服器，`ahub-cli` 管理工作階段和發布資源。下文範例假定已全域安裝：

```sh
npm install -g @someonegg/agent-hub
ahub-cli --help
```

不需全域安裝時，將範例中的 `ahub-cli` 替換為
`npx --package=@someonegg/agent-hub@latest ahub-cli`。加入 `--json` 可取得結構化命令結果。

### 工作階段命令

先啟動 Hub，再從另一終端執行：

```sh
ahub-cli project list
ahub-cli agent list
ahub-cli session list --project /path/to/project
ahub-cli session create --project /path/to/project
ahub-cli session send <id> --message "Explain the failing tests"
ahub-cli session inspect <id>
ahub-cli session inspect <id> --follow
```

使用 `list` 或 `create` 傳回的 Hub ID。`list` 預設不含封存工作階段，傳入 `--all` 可包含；
`inspect` 也接受子工作階段 ID。將傳回的 `Next after` 值傳給 `--after <value>` 讀取下一頁。
`--follow` 持續觀察直到按 `Ctrl+C` 停止，不會因任務完成自動結束。

建立預設使用專案目錄和第一個已設定智慧體。用 `--cwd` 修改工作目錄而保留專案歸屬，
用 `--agent <nickname>` 選擇智慧體；可選 `--worktree` 和 `--yolo` 控制啟動行為。
`resume <id>` 保留原智慧體，支援 `--yolo`。
用 `create --task <name>` 和 `list --task <name>` 跨專案分組工作階段。

輸入預設要求終端已連線且閒置。用 `send <id> --stdin` 接收管線輸入，`terminal <id>` 檢視終端，
`interrupt <id>` 中斷執行。`send` 或 `keys` 的 `--force` 允許在工作中傳送輸入，
也允許 `send` 傳送以 `/` 開頭的訊息。終端切換工作階段後，用 `handoff <id>` 移交繫結。

預設連線至 `http://127.0.0.1:4173`。用 `AGENT_HUB_URL` 或 `--url` 修改位址，
用 `--timeout <seconds>` 調整逾時。使用私有 CA 時，啟動 CLI 前設定
`NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem`。

傳送成功不表示任務完成。逾時或結束代碼為 `2`（寫入結果不明）時，先用 `list`、`inspect` 或 `terminal` 核查再重試。
停止用戶端不會取消已提交操作。生命週期命令（包括刪除）不會在 CLI 中再次要求確認。
全部命令見 `ahub-cli session --help`，結果與逾時契約見 [CLI 參考（英文）](technical-reference.md#session-cli-and-observation)。

## 發布網頁與差異

用 `--hosting` 啟動 Hub 以檢視發布資源。發布命令讀取 Hub 所在機器的本機檔案，伺服器停止時也可執行。
命令輸出相對 URL 和 Markdown 連結，請在 Hub 伺服器位址下開啟。

預設儲存在 `~/.agent-hub/hosting`。自訂資料目錄時，命令與伺服器必須使用相同的 `--home-dir /path`。

### 發布網頁

發布已建置、包含 `index.html` 的目錄：

```sh
ahub-cli page publish ./demo --project /path/to/project --name demo --title "Design comparison"
```

兩個目錄都必須存在。資源使用相對路徑；Hub 不建置網站，也不接受遠端上傳發布套件。
託管網頁與 Hub 同源，以可信程式碼執行，因此只應發布可信內容。

以相同專案和名稱再次發布即可更新並保留 URL。省略 `--name` 時使用來源目錄名。
worktree 請將原專案傳給 `--project`。

開啟**已發布網頁**（`/artifacts`）瀏覽、複製連結或刪除網頁及其快照。
CLI 也支援 `page list` 和 `page delete <id>`。移除來源目錄或 worktree 不會刪除已發布網頁。
詳見[託管參考（英文）](technical-reference.md#optional-hosting)。

### 分享差異

產生所需比較後發布：

```sh
git diff HEAD > /tmp/review.diff
ahub-cli diff publish /tmp/review.diff --title "Review changes"
```

開啟傳回的 `/diffs/<uuid>` 位址。發布內容不會過期，用 `ahub-cli diff list` 尋找，
審閱結束後用 `ahub-cli diff delete <uuid>` 刪除；原始檔保持不變。
參閱[差異參考（英文）](technical-reference.md#temporary-diffs)及
[桌面](images/zh-TW/ahub-diff.png) / [手機](images/zh-TW/ahub-diff-mobile.png)預覽。

### 透過智慧體發布

安裝附帶的 [`ahub-publish` skill](../skills/ahub-publish)，並按名稱請求使用。
執行 `ahub-cli skill path ahub-publish` 定位目錄；使用 `npx` 時，請將傳回的快取目錄複製到長期使用的技能位置。

## 設定伺服器

啟動時傳入選項，修改後重新啟動。完整列表見 `agent-hub --help`。

| 選項                   | 預設值         | 用途                                        |
| ---------------------- | -------------- | ------------------------------------------- |
| `--port <port>`        | `4173`         | 監聽連接埠，`0` 自動選擇閒置連接埠          |
| `--home-dir <path>`    | `~/.agent-hub` | Hub 資料目錄，包含 `uploads/` 和 `hosting/` |
| `--hosting`            | 關閉           | 提供已發布網頁與差異存取                    |
| `--tmux-socket <path>` | tmux 預設值    | 使用自訂 tmux socket                        |

Agent Hub 預設使用 `~/.agent-hub`，不會自動遷移舊資料。如需使用原有 Codex Hub 資料目錄，請為伺服器和資源管理命令傳入 `--home-dir ~/.codex-hub`。

### 多個智慧體

智慧體是獨立擁有設定、Skills、記憶和模型設定的身分。Codex 和 Claude Code 是執行引擎，任務中衍生的身分稱為子智慧體。智慧體目錄在 Codex 中包含 `sessions/`，在 Claude Code 中包含 `projects/`。
每個智慧體需使用唯一暱稱和目錄：

```sh
agent-hub \
  --codex-agent 'work=~/.codex-work' \
  --claude-agent 'claude=~/.claude'
```

可重複或混合傳入這些選項。明確設定會替換**兩個預設智慧體**，建立預設使用第一項。
透過側邊欄智慧體篩選器縮小範圍。網頁建立時，有效的智慧體篩選或預設智慧體偏好優先於第一項。
完整規則見 [智慧體路由（英文）](technical-reference.md#agent-identity-and-routing)。

## 從其他裝置存取

Hub 沒有應用層登入，任何能存取它的人都能閱讀工作階段、傳送輸入和管理工作階段。
請保持預設 `127.0.0.1` 監聽，除非透過反向代理或雙向 TLS（mTLS）設定了身分認證並限制存取。

使用內建 mTLS：

```sh
agent-hub \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem \
  --ssl-ca /path/to/client-ca.pem
```

每臺裝置需安裝用戶端憑證及私鑰，並信任伺服器憑證。不指定 `--ssl-ca` 時，HTTPS 僅加密流量，不認證用戶端。
更換憑證或私鑰後需重新啟動。

如需本機 CLI 無用戶端憑證存取，啟動伺服器時另加 `--local-port 4174`，然後執行：

```sh
ahub-cli session list --url http://127.0.0.1:4174
```

此額外 HTTP 入口預設關閉，繫結 `127.0.0.1`。本機其他使用者和程序也能存取，請勿將外部代理流量轉送到此入口。

## 疑難排解

- **沒有工作階段：**檢查各智慧體是否包含 `sessions/`（Codex）或 `projects/`（Claude）。檢視伺服器輸出中的不可讀或跳過檔案提示。
- **連接埠占用：**改用其他連接埠，例如 `agent-hub --port 4180`。
- **無法傳送輸入：**透過**連線 tmux**完成 CLI 提示，忙碌時等待，或在可用時使用**恢復**。封存工作階段唯讀，僅有日誌不代表終端已連線。
- **建立或恢復狀態不明：**重試前檢查 tmux 並重新整理工作階段列表，避免重複啟動。關閉頁面不會停止操作，重新啟動伺服器會遺失進度追蹤。
- **相機不可用或上傳中斷：**使用檔案選擇器，檢查工作階段已連線且閒置後重試。

執行與恢復細節見[技術參考（英文）](technical-reference.md)。

## 移除安裝

停止伺服器。全域安裝時執行：

```sh
npm uninstall -g @someonegg/agent-hub
```

`npx` 不需全域移除安裝。工作階段、worktree、執行中的 tmux 工作階段、上傳檔案和託管快照仍會保留，請按需另行清理。

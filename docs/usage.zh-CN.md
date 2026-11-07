# 使用与配置

[English](usage.md) | 简体中文 | [繁體中文](usage.zh-TW.md)

## 启动 Hub

```sh
npx @someonegg/codex-hub@latest
```

打开 <http://127.0.0.1:4173> 或服务器打印的地址，按 `Ctrl-C` 停止服务器。
安装与运行要求见 [README](../README.zh-CN.md#快速开始)。

默认从 `~/.codex` 读取 Codex 会话、从 `~/.claude` 读取 Claude Code 会话，且仅监听本机。
其他设备访问前，请先配置[远程访问](#从其他设备访问)。

## 阅读会话

在侧边栏选择项目和主会话，子会话从父会话中打开。消息从头开始随滚动加载，到达末尾后自动更新。
勾选**已归档**可浏览只读的归档会话。可收藏会话地址。

最新加载的计划自动展开。使用**显示**或**隐藏**控制单个计划，也可同时展开多个计划。

## 创建与管理会话

点击项目旁的 **+**，或全局 **+** 后选择项目、输入本机绝对目录。
选择 [智能体](#多个智能体) 和可选的启动设置：

- **Worktree：**在独立 Git worktree 中启动，隔离代码改动。
- **YOLO：**跳过运行工具的审批提示；Codex 还会禁用其沙盒。

打开已退出的会话，在可用时点击**恢复**继续。恢复保留原智能体和项目归属，使用可用的原工作目录或项目目录。
恢复从其他位置启动的会话前，请确认原进程已经退出。

通过会话的 **…** 菜单执行：

- **退出：**停止已连接终端，保留历史。
- **归档：**停止运行，将会话移到归档列表。
- **删除：**确认后永久删除会话历史。

创建与恢复使用 tmux。启动若被登录或权限确认阻塞，通过 **… → 连接 tmux** 或显示的连接命令在终端完成操作。
不要重命名 Hub 的 tmux 会话或修改其窗口、窗格结构。详见 [tmux 要求（英文）](technical-reference.md#tmux-interaction)。

## 发送提示与文件

绿色**运行中**标记表示终端已连接。通过输入框发送提示，默认 **Shift+Enter** 发送、**Enter** 换行；
在[设置](#浏览器设置)中开启 **Enter 发送**可反转。

展开**终端预览**查看 CLI。点击**中断**或在预览中按 **Ctrl+C** 中断，按 **Esc** 收起预览。
**工作中**和**空闲**反映终端输出，不表示任务是否完成。

已发送提示先显示为**等待中**，随后随会话消息更新；纯 slash command 不显示此预览。
发送失败时保留草稿。草稿文字和附件选择在切换会话时保留，刷新页面后重置。

如果 Codex 通过 `/clear`、`/resume` 或执行计划在同一终端切换会话，在旧会话的已连接页面点击**移交绑定**。
显示**已被替代**后点击**前往已绑定会话**。未发送草稿留在旧页面。

### 文件上传

使用附件按钮**拍照**、**选择图片**或**选择文件**，也可粘贴图片或拖放文件。
发送前可预览或移除附件，支持单独发送附件和多个文件，不支持文件夹。**每个文件最大 20 MiB**。

图片保留原始内容，包括 EXIF 元数据。相机行为取决于浏览器；HEIC/HEIF 支持取决于运行工具。

从会话标题区域打开**上传记录**，预览、下载或删除文件，包括未发送的上传文件。
从草稿移除附件不会删除已上传文件；从上传记录删除文件也会将其从草稿移除。

文件保存在 [Hub 数据目录](#配置服务器)的 `uploads/` 下，智能体必须能访问此目录。
删除会话触发后台清理，归档与退出保留文件。存储和清理细节见[上传参考（英文）](technical-reference.md#file-uploads)，
也可[查看上传记录截图](images/zh-CN/ahub-uploads.png)。

## 浏览器设置

在侧边栏底部打开**设置**，选择语言、主题、新会话默认智能体，以及 Worktree、YOLO 默认值。
修改自动保存在当前浏览器。YOLO 默认值也用于恢复会话，启动对话框可覆盖默认值。

界面初始为英文，切换语言立即生效，不翻译会话或终端原文。

## 使用 CLI

`codex-hub` 启动服务器，`ahub-cli` 管理会话和发布资源。下文示例假定已全局安装：

```sh
npm install -g @someonegg/codex-hub
ahub-cli --help
```

无需全局安装时，将示例中的 `ahub-cli` 替换为
`npx --package=@someonegg/codex-hub@latest ahub-cli`。添加 `--json` 可获取结构化命令结果。

### 会话命令

先启动 Hub，再从另一终端执行：

```sh
ahub-cli session list --project /path/to/project
ahub-cli session create --project /path/to/project
ahub-cli session send <id> --message "Explain the failing tests"
ahub-cli session inspect <id>
ahub-cli session inspect <id> --follow
```

使用 `list` 或 `create` 返回的 Hub ID。`list` 默认不含归档会话，传入 `--all` 可包含；
`inspect` 也接受子会话 ID。将返回的 `Next after` 值传给 `--after <value>` 读取下一页。
`--follow` 持续观察直到按 `Ctrl+C` 停止，不会因任务完成自动结束。

创建默认使用项目目录和第一个已配置智能体。用 `--cwd` 修改工作目录而保留项目归属，
用 `--agent <nickname>` 选择智能体；可选 `--worktree` 和 `--yolo` 控制启动行为。
`resume <id>` 保留原智能体，支持 `--yolo`。
用 `create --task <name>` 和 `list --task <name>` 跨项目分组会话。

输入默认要求终端已连接且空闲。用 `send <id> --stdin` 接收管道输入，`terminal <id>` 查看终端，
`interrupt <id>` 中断执行。`send` 或 `keys` 的 `--force` 允许在工作中发送输入，
也允许 `send` 发送以 `/` 开头的消息。终端切换会话后，用 `handoff <id>` 移交绑定。

默认连接 `http://127.0.0.1:4173`。用 `CODEX_HUB_URL` 或 `--url` 修改地址，
用 `--timeout <seconds>` 调整超时。私有 CA 场景下，启动 CLI 前设置
`NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem`。

发送成功不表示任务完成。超时或退出码为 `2`（写入结果不明）时，先用 `list`、`inspect` 或 `terminal` 核查再重试。
停止客户端不会取消已提交操作。生命周期命令（包括删除）不会在 CLI 中再次要求确认。
全部命令见 `ahub-cli session --help`，结果与超时契约见 [CLI 参考（英文）](technical-reference.md#session-cli-and-observation)。

## 发布网页与差异

用 `--hosting` 启动 Hub 以查看发布资源。发布命令读取 Hub 所在机器的本地文件，服务器停止时也可执行。
命令输出相对 URL 和 Markdown 链接，请在 Hub 服务器地址下打开。

默认存储在 `~/.codex-hub/hosting`。自定义数据目录时，命令与服务器必须使用相同的 `--home-dir /path`。

### 发布网页

发布已构建、包含 `index.html` 的目录：

```sh
ahub-cli page publish ./demo --project /path/to/project --name demo --title "Design comparison"
```

两个目录都必须存在。资源使用相对路径；Hub 不构建网站，也不接受远程上传发布包。
托管网页与 Hub 同源，以可信代码执行，因此只应发布可信内容。

以相同项目和名称再次发布即可更新并保留 URL。省略 `--name` 时使用来源目录名。
worktree 请将原项目传给 `--project`。

打开**已发布网页**（`/artifacts`）浏览、复制链接或删除网页及其快照。
CLI 也支持 `page list` 和 `page delete <id>`。移除来源目录或 worktree 不会删除已发布网页。
详见[托管参考（英文）](technical-reference.md#optional-hosting)。

### 分享差异

生成所需比较后发布：

```sh
git diff HEAD > /tmp/review.diff
ahub-cli diff publish /tmp/review.diff --title "Review changes"
```

打开返回的 `/diffs/<uuid>` 地址。发布内容不会过期，用 `ahub-cli diff list` 查找，
审阅结束后用 `ahub-cli diff delete <uuid>` 删除；原始文件保持不变。
参阅[差异参考（英文）](technical-reference.md#temporary-diffs)及
[桌面](images/zh-CN/ahub-diff.png) / [手机](images/zh-CN/ahub-diff-mobile.png)预览。

### 通过智能体发布

安装附带的 [`ahub-publish` skill](../skills/ahub-publish)，并按名称请求使用。
执行 `ahub-cli skill path ahub-publish` 定位目录；使用 `npx` 时，请将返回的缓存目录复制到长期使用的技能位置。

## 配置服务器

启动时传入选项，修改后重启。完整列表见 `codex-hub --help`。

| 选项                   | 默认值         | 用途                                        |
| ---------------------- | -------------- | ------------------------------------------- |
| `--port <port>`        | `4173`         | 监听端口，`0` 自动选择空闲端口              |
| `--home-dir <path>`    | `~/.codex-hub` | Hub 数据目录，包含 `uploads/` 和 `hosting/` |
| `--hosting`            | 关闭           | 提供已发布网页与差异访问                    |
| `--tmux-socket <path>` | tmux 默认值    | 使用自定义 tmux socket                      |

### 多个智能体

智能体是独立拥有配置、Skills、记忆和模型设置的身份。Codex 和 Claude Code 是运行工具，任务中派生的身份称为子智能体。智能体目录在 Codex 中包含 `sessions/`，在 Claude Code 中包含 `projects/`。
每个智能体需使用唯一昵称和目录：

```sh
codex-hub \
  --codex-agent 'work=~/.codex-work' \
  --claude-agent 'claude=~/.claude'
```

可重复或混合传入这些选项。显式配置会替换**两个默认智能体**，创建默认使用第一项。
通过侧边栏智能体筛选器缩小范围。网页创建时，有效的智能体筛选或默认智能体偏好优先于第一项。
完整规则见 [智能体路由（英文）](technical-reference.md#agent-identity-and-routing)。

## 从其他设备访问

Hub 没有应用层登录，任何能访问它的人都能阅读会话、发送输入和管理会话。
请保持默认 `127.0.0.1` 监听，除非通过反向代理或双向 TLS（mTLS）配置了身份认证并限制访问。

使用内置 mTLS：

```sh
codex-hub \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem \
  --ssl-ca /path/to/client-ca.pem
```

每台设备需安装客户端证书及私钥，并信任服务器证书。不指定 `--ssl-ca` 时，HTTPS 仅加密流量，不认证客户端。
更换证书或私钥后需重启。

如需本机 CLI 无客户端证书访问，启动服务器时另加 `--local-port 4174`，然后执行：

```sh
ahub-cli session list --url http://127.0.0.1:4174
```

此额外 HTTP 入口默认关闭，绑定 `127.0.0.1`。本机其他用户和进程也能访问，请勿将外部代理流量转发到此入口。

## 故障排查

- **没有会话：**检查各智能体是否包含 `sessions/`（Codex）或 `projects/`（Claude）。查看服务器输出中的不可读或跳过文件提示。
- **端口占用：**换用其他端口，例如 `codex-hub --port 4180`。
- **无法发送输入：**通过**连接 tmux**完成 CLI 提示，正忙时等待，或在可用时使用**恢复**。归档会话只读，仅有日志不代表终端已连接。
- **创建或恢复状态不明：**重试前检查 tmux 并刷新会话列表，避免重复启动。关闭页面不会停止操作，重启服务器会丢失进度追踪。
- **相机不可用或上传中断：**使用文件选择器，检查会话已连接且空闲后重试。

运行与恢复细节见[技术参考（英文）](technical-reference.md)。

## 卸载

停止服务器。全局安装时执行：

```sh
npm uninstall -g @someonegg/codex-hub
```

`npx` 无需全局卸载。会话、worktree、运行中的 tmux 会话、上传文件和托管快照仍会保留，请按需另行清理。

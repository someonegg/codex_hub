# 使用与配置

[English](usage.md) | 简体中文 | [繁體中文](usage.zh-TW.md)

## 启动 Hub

```sh
npx @someonegg/codex-hub@latest
```

打开 <http://127.0.0.1:4173> 或服务器打印的地址，按 `Ctrl-C` 停止。
安装与运行要求见 [README](../README.zh-CN.md#快速开始)。默认读取 `~/.codex`，且仅监听本机。

`ahub-cli` 默认输出便于阅读的文本，添加 `--json` 可获取结构化结果和错误。输出通道与错误码见 [CLI 输出约定](technical-reference.md#cli-output-contract)。

## 阅读与管理会话

在侧边栏选择项目和会话。会话内容自动更新，勾选**已归档**可浏览归档会话。
可收藏会话地址，或分享给能够访问此 Hub 的设备。

- **创建：**点击项目旁的 **+**，或全局 **+** 后选择项目、输入本机绝对目录。可选启用 worktree 或 YOLO。
- **恢复：**打开已退出会话，在可用时点击**恢复**。使用原 Home 与可用的原工作目录或项目目录继续同一会话。
- **退出：**使用会话的 **…** 菜单停止已连接终端窗格，不归档会话。
- **归档或删除：**使用会话的 **…** 菜单。仅归档会话支持永久删除，并需要确认。

创建与恢复使用 tmux。如果启动需要登录、权限或信任确认，使用 **… → 连接 tmux**，
或执行 Hub 显示的连接命令，在终端完成操作。恢复从其他位置启动的会话前，请确认原进程已经退出。

最新加载的计划自动展开，先前计划收起。使用**显示**或**隐藏**分别控制，可同时展开多个计划。

## 与 Codex 交互

绿色**运行中**标记表示终端已连接。通过消息输入框发送提示，展开**终端预览**查看 CLI。
点击**中断**，或在预览中按 **Esc** 中断执行。**工作中**和**空闲**反映终端输出，不表示任务是否完成。

如果 Codex 通过 `/clear`、`/resume` 或执行计划在同一终端切换会话，在旧会话的已连接页面
点击**移交绑定**。显示**已被替代**后点击**前往已绑定会话**；未发送的草稿保留在旧页面。

### 文件上传

使用附件按钮**拍照**、**选择图片**或**选择文件**，也可粘贴图片或拖放文件。
发送前可预览图片、移除附件；支持单独发送附件和一次发送多个文件，不支持文件夹。

草稿文字与附件选择在会话导航时保留，刷新页面后重置。

相机行为取决于浏览器，可能退回文件选择器。图片按原样上传，包括 EXIF 元数据，单个文件上限
20 MiB；HEIC/HEIF 支持取决于智能体。拍照时会话若断开或正忙，请重新连接或稍后重试。

点击会话标题区域的**上传记录**，浏览、预览、下载或删除上传文件，包括未发送文件和从草稿移除的文件。
删除文件也会将其从当前草稿移除。附件删除和清理尽力执行；删除会话触发后台清理，归档与退出保留附件。
[查看上传记录截图](images/zh-CN/ahub-uploads.png)。

上传文件保存在 [Hub 数据目录](#服务器选项)的 `uploads/` 下，智能体必须能访问此目录。
API 与存储保证见[技术参考（英文）](technical-reference.md#file-uploads)。

## 浏览器设置

在侧边栏底部打开**设置**，选择语言、主题、新会话默认 Home，以及默认 worktree 和 YOLO 选项。
修改自动保存在当前浏览器。YOLO 默认值也用于恢复会话，启动对话框可覆盖默认值。

界面默认英文；选择 **Language → 简体中文 / 繁體中文** 后立即生效，不需要刷新，同源标签页同步更新。
语言仅影响 Hub 界面及日期、数字显示，不翻译会话原文、终端输出、文件名、路径或命令。

## 多个 Home

使用 `--codex-home 'nickname=path'` 指定 Codex Home。路径应指向包含 `sessions/` 的目录，
而非 `sessions/` 本身。可重复传入：

```sh
codex-hub \
  --codex-home 'personal=~/.codex' \
  --codex-home 'work=/path/to/codex-work'
```

显式指定 Home 会替换默认的 `~/.codex`。每个 Home 需使用唯一昵称与目录。
通过侧边栏 Home 筛选器缩小会话范围，创建时选择目标 Home。

## 发布资源

用 `codex-hub --hosting` 启用已发布网页与差异查看。资源命令可在服务器停止时执行，
发布后打印相对 URL 和 Markdown 链接。默认存储在 `~/.codex-hub/hosting`；如需自定义位置，
命令与服务器需使用相同的 `--home-dir /path`。加 `--json` 获取结构化输出。

如需智能体协助发布，可安装 [`ahub-publish` skill](https://github.com/someonegg/devkit/tree/main/skills/ahub-publish)，
并明确按名称请求使用，将静态网页或审阅差异发布到已有 Hub。

### 发布网页

托管网页与 Hub 同源，以可信代码运行，请仅发布可信内容。在 `/artifacts` 的**网页**页面管理发布资源。

发布 Hub 所在机器上已构建、包含 `index.html` 的目录：

```sh
ahub-cli page publish ./demo --project /absolute/path/to/project --title "Design comparison"
```

两个目录都必须存在。资源使用相对路径；Hub 不构建网站，也不接受远程上传发布包。

以相同项目和名称再次发布可更新网页。名称默认为解析符号链接后的源目录名；用 `--name` 可在源目录
变化时保持名称。更新保留 URL，除非指定 `--title`，否则保留标题。worktree 请将原项目传给 `--project`。

**已发布网页**链接在新标签页打开管理界面。可打开网页、复制绝对链接、刷新列表，或确认删除网页及其全部快照。
移除源目录或 worktree 不会删除已发布网页。CLI 还支持 `page list` 和 `page delete <id>`。
加载限制、项目身份与快照保证见[托管参考（英文）](technical-reference.md#optional-hosting)。

### 分享临时差异

生成所需比较的差异文件后发布：

```sh
git diff HEAD > /tmp/review.diff
ahub-cli diff publish /tmp/review.diff --title "Review changes"
ahub-cli diff list
ahub-cli diff delete <uuid>
```

打开返回的 `/diffs/<uuid>` 链接审阅差异。智能体负责选择比较范围并在完成后删除发布内容，没有自动清理。
源文件不变。参阅[差异参考（英文）](technical-reference.md#temporary-diffs)及
[桌面](images/zh-CN/ahub-diff.png) / [手机](images/zh-CN/ahub-diff-mobile.png)预览。

## 服务器选项

将选项传给 `codex-hub`，修改后重启。完整命令帮助见 `codex-hub --help`。

| 选项                           | 默认值             | 用途                                        |
| ------------------------------ | ------------------ | ------------------------------------------- |
| `--codex-home <nickname=path>` | `default=~/.codex` | 指定一个或多个 Codex Home                   |
| `--host <host>`                | `127.0.0.1`        | 监听地址                                    |
| `--port <port>`                | `4173`             | 监听端口，`0` 自动选择空闲端口              |
| `--home-dir <path>`            | `~/.codex-hub`     | Hub 数据目录，包含 `uploads/` 和 `hosting/` |
| `--hosting`                    | 关闭               | 启用静态网页托管                            |
| `--tmux-socket <path>`         | tmux 默认值        | 自定义 tmux socket                          |
| `--ssl`                        | 关闭               | 启用 HTTPS，需同时指定证书和私钥            |
| `--ssl-cert <path>`            | 无                 | PEM 服务器证书或证书链                      |
| `--ssl-key <path>`             | 无                 | PEM 私钥                                    |
| `--ssl-ca <path>`              | 无                 | 要求客户端提供由此 CA 签发的证书            |

## 安全

Hub 没有应用层登录。任何能访问它的人都能阅读会话、发送输入和管理会话。
未配置身份认证并限制网络访问时，请保持默认本地监听地址。

跨设备访问时，使用带认证的反向代理或内置双向 TLS（mTLS），例如：

```sh
codex-hub \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem \
  --ssl-ca /path/to/client-ca.pem
```

每台设备都需安装客户端证书及私钥，并信任服务器证书。未指定 `--ssl-ca` 时，HTTPS 仅加密流量，
不认证客户端。更换证书或私钥后需重启。

## 故障排查

- **没有会话：**检查 `--codex-home` 是否指向包含 `sessions/` 的目录；查看服务器终端中的不可读或跳过文件提示。
- **端口占用：**选择其他端口，例如 `codex-hub --port 4180`。
- **无法发送输入：**会话需要已连接、运行中的 tmux 窗格。先在 tmux 完成 CLI 提示，或在可用时点击**恢复**。
  已归档会话只读，仅有日志文件并不意味着终端已连接。
- **创建或恢复状态不明：**重试前检查 tmux 并刷新会话列表，避免启动重复会话。关闭网页不会停止操作，重启服务器会丢失进度跟踪。

连接及管理细节见[技术参考（英文）](technical-reference.md)。

## 卸载

停止服务器。全局安装时执行：

```sh
npm uninstall -g @someonegg/codex-hub
```

使用 `npx` 无需全局卸载。卸载保留会话、worktree、运行中的 tmux 会话、上传文件和托管快照，请按需另行清理。

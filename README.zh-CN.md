# opencode-qwenwork-auth — 千问办公（QwenWork）接入 magpie / OpenCode

[English](README.md)

![Platform](https://img.shields.io/badge/platform-macOS-blue) ![Platform](https://img.shields.io/badge/platform-Windows-blue)

把你的千问办公订阅接成 OpenCode provider：用千问办公自己的设备登录流程登录，
再通过千问办公自己的 agent 端点调用它的模型 —— 宿主 agent 的工具会随请求下发。

> 非官方插件。未经 magpie 审阅，安装前请先看代码。
> 已在 macOS 上对着千问办公 1.2.5 桌面版跑通端到端。

| Provider id | 服务 | 模型 |
|---|---|---|
| `qwenwork` | 千问办公（`gateway.qwenwork.cn`） | 账号自己的 `qwork` 目录 |

本包导出 `QwenWorkAuthPlugin`。

## 安装

从这个 GitHub 仓库安装（推荐）：

```sh
magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
magpie plugin login qwenwork
```

`magpie plugin add` 接受 bun 支持的各种 spec：npm 包、`github:owner/repo` 仓库，
或本地目录。本仓库就是给 `github:` 方式安装用的 —— 这样才会跟随这里的代码、并
收到更新。

本插件没有自己的运行时依赖。给某个 agent 选 `qwenwork/<模型>` 即可，例如
`magpie claude qwenwork/flash`。

- **之前是从本地目录装的？** 加上 `github:` spec、再删掉本地目录那条，让 magpie
  改为跟踪仓库：
  ```sh
  magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
  magpie plugin rm /你本地/magpie-plugin-qwenwork 的路径
  ```
  登录态会保留。
- **在应用里找到它。** 本仓库打了 `magpie-plugin` topic，magpie 会把它列在
  插件 → 发现 → *非官方*（社区插件，未经 magpie 审阅）。可以在那里安装，也可以用
  上面的命令。

## 工作原理

登录使用与千问办公桌面端相同的 PKCE 设备流，随后用自带的 refresh token 持续续期
access token。账号按名称显示，取不到时回退到 id。

对话会被改写成千问办公自己的 `agent_chat_generation` 请求 —— 与桌面端引擎、
Qoder 客户端说的是同一种请求：

- 宿主 agent 的**工具随请求下发**，OpenCode 会话在 `qwenwork` 模型上保留完整的
  工具循环（read、edit、bash…）。
- **工具调用以结构化形式返回**：要么是网关原生的 `tool_calls`，要么从内联的
  `<tool_call>` 文本里提取 —— 绝不会以标记形式混进回答。
- 宿主的 system 消息置于一段简短的 QwenWork 前导之下原样保留；reasoning、
  usage 与积分按客户端的展示方式映射回来。
- **提示词缓存按客户端的协议下发**（移植自 magpie-community/plugins #290/#330）：
  最后一个用户消息的末块标 `cache_control: ephemeral`，用户轮同时带 `contents`
  副本；同一会话每轮用同一个 `session_id`，一次用户提问的整条工具循环共享一个
  `request_set_id` / `business` 记录。网关按会话与任务保留提示词缓存，命中数以
  `usage.prompt_tokens_details.cached_tokens` 返回。

以下配置取自千问办公桌面端自身的打包文件：

```text
clientId      e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
web / openapi / api   https://gateway.qwenwork.cn
redirect_uri  qwenwork-cn://
设备流        /device/selectAccounts -> /api/v1/deviceToken/poll
刷新          /api/v1/deviceToken/refresh   (target: "c")
对话          /algo/api/v2/service/pro/sse/agent_chat_generation
模型          "qwork" scene
```

以上每一项，连同 COSY RSA 公钥，都可以通过 `QWENWORK_*` 环境变量和
`defaults.json` 覆盖。

## 用量

magpie 会在 provider 旁边显示账号的积分。数据取自登录时已经在读的同一个
`account-context`，因此不会额外发请求：

| 显示项 | 来源 |
|---|---|
| 计划名 | `plan.name` |
| 重置时间 | `plan.next_refresh_date`，没有则用 `plan.next_due_date` |
| 已用积分 | `quota.used / quota.total`，显示为百分比与 `已用 / 总量 credits` |

读取被拒（401/403）会标记登录失效；其它错误会脱敏后报出。实现见 `index.mjs`
里的 `qwenworkUsage()`。`magpie quota qwenwork` 会在终端打印：

```text
qwenwork · Your Plan · until Nov 1 · you@example.com  subscription  Credits 1% (17.94 / 2000 credits)
```

个人账号的 `quota` 只有 `remaining`，此时余额后面会附上各积分池
（`/api/v1/adapter/user/wallets` 的 daily / monthly / long-term），与千问办公
客户端自己的读法一致；两次读取之间池子的减少量就是这段时间实际花掉的积分。

### 每次请求的 token、缓存命中与费用

- **输入/输出 token 与缓存命中**来自网关在 finish 之后单独下发的 usage chunk，
  流式与非流式都会带回。想确认网关到底发了什么，设
  `QWENWORK_DEBUG_SSE=/path/to/capture.log` 把原始 SSE 逐字节落盘，或设
  `QWENWORK_DEBUG_USAGE=1` 在 stderr 打印每轮的 `in / out / cached (%)` 与
  两次用量读取之间花掉的积分。
- **费用**：千问办公按积分计费（模型列表里的 `price_factor` 倍率，见模型旁的
  `rate`），网关不按请求返回金额，所以 magpie 的美元成本对这类订阅模型默认按
  $0 计。想让 magpie 显示估算成本，可以给模型设一个自己的牌价：
  `magpie model price qwenwork/<model>`（语法见 `magpie model price --help`）；
  真实花费以积分池的减少量为准。

## 说明

- 只服务 chat completions 端点。登录失效会明确报出；上游错误在返回给调用方前
  会做裁剪并脱敏 token。
- provider 图标用的是千问办公的应用图标，用于标识该产品。
- MIT。

## 验证

```sh
node check.mjs     # 离线：mock 上游
./live-e2e.sh      # 在线：经网关验证模型、对话、流式
```

## 文件

- `index.mjs` — provider：配置、设备登录、用量。
- `vendor/qoder.mjs` — 与 Qoder 插件共用的适配层：登录、agent_chat_generation
  编解码、工具调用提取、用量。
- `defaults.json` — 已核实的桌面端配置。
- `icon.png` — provider 图标，即千问办公应用图标。
- `check.mjs`、`live-e2e.sh` — 离线与在线检查。

# 整体连接性润色

离线拼接、编辑和导出不需要模型。润色会发送整份成稿、候选原稿和保护规则；返回的修改必须由你逐项接受。数字、引文和锁定段落仍由程序检查。密钥只在服务端环境提供，不填入网页或稿件。

## Codex CLI：ChatGPT 登录额度

需要已经安装的 Codex CLI。启动服务前，可设置 `DW_CODEX_BIN` 为实际可执行文件路径。应用只使用数据目录内 `.runtime/codex-profile` 的独立登录，不复用或复制其他 profile 的凭据。

```sh
node scripts/login-codex.mjs --device-auth
node scripts/login-codex.mjs --status
node server.mjs
```

如设置了 `DW_DATA_DIR`，登录与服务必须使用相同值。Windows 也可运行对应的 `scripts/login-codex.ps1 -DeviceAuth` 或 `-Status`。

实际核验过的 CLI 是 Windows `0.154.0-alpha.6.2`。适配器使用 `exec --json --output-schema --ephemeral`，需要支持其使用的配置开关；其他 CLI 版本尚未实测。以正常 ChatGPT 登录和实际账户权限为准，不承诺无限额度。CLI 子进程移除继承的 API 鉴权变量，明确拒绝 API-key 登录，不能静默转为 API 计费。父进程环境不变。

## External API：OpenAI 兼容接口

在启动服务的同一个终端设置环境变量。PowerShell 示例：

```powershell
$env:DW_API_BASE_URL = 'https://api.openai.com/v1'
$env:DW_API_STYLE = 'responses'
$env:DW_API_MODEL = 'gpt-6-astra'
$env:DW_API_KEY_ENV = 'DRAFT_API_KEY'
# 用你的秘密管理方式设置 DRAFT_API_KEY，然后：
node server.mjs
```

应用不自动读取 `.env`。支持 Responses 或 Chat Completions 风格；是否支持具体模型和结构化输出，取决于服务商。

| 环境变量 | 默认值／可选值 |
|---|---|
| `DW_API_BASE_URL` | `https://api.openai.com/v1`，不含接口路径 |
| `DW_API_STYLE` | `responses` / `chat-completions` |
| `DW_API_MODEL` | `gpt-6-astra` |
| `DW_API_KEY_ENV` | `OPENAI_API_KEY`；这里填变量名称，非密钥 |
| `DW_API_STRUCTURED` | `json-schema` / `json-object` / `plain` |
| `DW_API_REASONING_EFFORT` | 可选；须与模型支持的值一致 |
| `DW_CODEX_BIN` | `codex` |
| `DW_CODEX_MODEL` / `DW_CODEX_REASONING_EFFORT` | `gpt-6-astra` / `ultra` |
| `DW_MODEL_TIMEOUT_MS` | `120000`，范围 50–600000 |

如果服务不支持 JSON Schema，改用 `json-object` 或 `plain`；本地仍会校验全部修改。鉴权失败、配额不足、超时、取消、截断及结构错误均不会覆盖成稿，也不会自动更换后端。

### 响应完成合同

HTTP 200 本身不代表润色完成。顶层 `error` 非空时先拒绝；上游错误正文不会写入用户错误信息。Responses 必须明确返回 `status: "completed"` 和合法的 `output` 数组，不能有 `incomplete_details` 或未完成的输出项。仅接受文本消息和可选 reasoning 项；拒绝工具调用、refusal、畸形内容。单独的 `output_text` 不能替代原始消息；如果同时提供，必须与消息文本一致。依据：[OpenAI Responses 定义](https://developers.openai.com/api/reference/python/resources/responses/methods/retrieve)。

Chat Completions 必须包含单个 choice、合法 message 和 `finish_reason: "stop"`；拒绝 refusal、工具／函数调用、截断和缺失／未知完成原因。`stop` 对应自然停止或指定停止序列；本应用不配置自定义停止序列。依据：[OpenAI Chat Completions 返回结构](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/retrieve)。

这是本应用对非流式文本润色的明确合同。`json-schema` / `json-object` / `plain` 只改变请求格式，不放宽完成判定。省略状态或只返回 `output_text` 的非标准兼容接口目前不支持；需要服务商满足上述合同后使用。

## 验证你自己的配置

```sh
# 只检查配置和登录状态，不发模型请求
node scripts/check-model.mjs --status
# 只准备自己的保存项目：不检查登录或发送请求
node scripts/check-model.mjs --project "我的文稿.json" --prepare-only
# 显式发起真实请求，使用账户额度／API 计费
node scripts/check-model.mjs --project "我的文稿.json" --provider codex-cli --timeout-ms 120000
# 或
node scripts/check-model.mjs --provider external-api
```

省略 `--project` 使用附带的图书馆样稿；默认无参数等同状态检查。`--prepare-only`、`--status` 优先于 `--provider`，不会因同时给出 provider 意外发送模型请求。Windows 入口支持 `-Project`、`-PrepareOnly`、`-Provider` 和 `-TimeoutMs`。

结果保存在数据目录 `.runtime/model-validation/`，分别保存准备项目、Markdown、完整模型输入、验证报告；收到通过校验的输出后另存原始修改集和待审项目。输入文件字节与结构化模型输入均有 SHA-256，后者不包含提供方指令和 HTTP 外层。不会自动接受建议；失败后可用报告中的 `preparedProject` 作为同一输入重试。

报告区分 `bridgeCallAttempted`（开始调用桥接，不能证明网络请求已发送）、`validatedModelOutputReceived`（桥接返回已校验输出）和 `reviewArtifactSaved`（待审文件已写出）。`validatedGenerationCompleted` / `liveValidatedGenerationCompleted` 仅表明输出通过合同；不证明语义质量。注入测试会明确标记 `contract-fixture`，不能记为真实生成。

`totalElapsedMs` 是报告写入前的总耗时；`generationElapsedMs` 是桥接调用耗时，含内部鉴权、准备及解析，不是纯推理时间，未调用时为 null。usage 缺失与费用无法确定时记 unknown/null，不写零。超时／取消不保证远端零用量。支持 Ctrl+C 的优雅取消；强制结束进程、无效命令参数或无效数据目录不保证生成报告。

当前开发验收没有执行已认证的真实模型润色。接口合同测试证明请求、解析和错误处理；不证明实际润色质量。

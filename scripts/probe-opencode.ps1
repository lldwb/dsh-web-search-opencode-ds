# probe-opencode.ps1 - scripts/probe-opencode.sh 的 Windows 孪生版本。
#
# 验证 OpenCode 的 Anthropic 兼容 Messages 端点确实会运行 DeepSeek 官方的服务端
# `web_search` 工具，并钉死本插件所依赖的两项请求头要求：
#
#   1. x-api-key + Bearer + x-opencode-session  -> 200，且带 web_search_tool_result
#   2. 同样的请求但不带 x-opencode-session      -> 400 MissingSessionID
#   3. 只带 Bearer（不带 x-api-key）            -> 401 AuthError
#
# 插件的 `goMode` 开关在两个共用同一套线上格式的端点之间选择 —— `go` 是包月的 Go
# 订阅，`metered` 是默认的按量计费 API：
#
#   go       https://opencode.ai/zen/go/v1
#   metered  https://opencode.ai/zen/v1
#
# 在没有按量计费余额的账户上，按量计费端点会返回 HTTP 402
# "Insufficient account funds"。这是账户事实，不是路由损坏，因此本脚本把它报告为
# UNFUNDED(402)，并且仍然以 0 退出。
#
# 用法：
#   $env:OPENCODE_API_KEY = 'sk-...'
#   pwsh -File .\scripts\probe-opencode.ps1 ["你的查询词"] [go|metered]
#
# 退出码：0 = 所有检查都符合预期，1 = 有检查偏离预期，2 = 缺少凭据。

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Query = 'DeepSeek V4 Flash release date',

    [Parameter(Position = 1)]
    [ValidateSet('go', 'metered')]
    [string]$Mode = 'go'
)

$ErrorActionPreference = 'Continue'

$DefaultEndpoint = if ($Mode -eq 'metered') { 'https://opencode.ai/zen/v1/messages' } else { 'https://opencode.ai/zen/go/v1/messages' }
$Endpoint   = if ($env:OPENCODE_MESSAGES_URL) { $env:OPENCODE_MESSAGES_URL } else { $DefaultEndpoint }
$Model      = if ($env:OPENCODE_MODEL)        { $env:OPENCODE_MODEL }        else { 'deepseek-v4-pro' }
$ApiVersion = if ($env:OPENCODE_API_VERSION)  { $env:OPENCODE_API_VERSION }  else { '2023-06-01' }
$Timeout    = if ($env:OPENCODE_TIMEOUT)      { [int]$env:OPENCODE_TIMEOUT } else { 120 }
$UserAgent  = 'dsh-web-search-opencode-ds/0.2.0'

$ApiKey = if ($env:OPENCODE_API_KEY) { $env:OPENCODE_API_KEY } elseif ($env:OPENCODE_GO_API_KEY) { $env:OPENCODE_GO_API_KEY } else { '' }
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Error @'
没有 API 密钥。请先设置一个：
  $env:OPENCODE_API_KEY = 'sk-...'
在 https://opencode.ai/auth 订阅并复制密钥 —— Go 套餐与按量计费 API 是同一账户上
的两种独立权益。
'@
    exit 2
}

$Work     = Join-Path $env:TEMP ("probe-opencode-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$ReqBody  = Join-Path $Work 'request.json'
$RespBody = Join-Path $Work 'response.json'

$script:Failed   = 0
$script:Unfunded = 0

function Invoke-ProbeCase {
    param(
        [string]   $Label,
        [int]      $Expected,
        [string[]] $ExtraHeaders
    )

    $curlArgs = @(
        '-sS', '--max-time', "$Timeout", '-o', $RespBody, '-w', '%{http_code}',
        '-X', 'POST', $Endpoint,
        '-H', 'Content-Type: application/json',
        '-H', "anthropic-version: $ApiVersion",
        '-H', 'x-opencode-client: dsh',
        '-H', "User-Agent: $UserAgent"
    ) + $ExtraHeaders + @('--data-binary', "@$ReqBody")

    $status = (& curl.exe @curlArgs 2>$null | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($status)) { $status = '000' }

    $verdict = 'OK'
    if ($status -ne "$Expected") {
        if ($Mode -eq 'metered' -and $status -eq '402') {
            # 路由与鉴权都没问题；只是账户没有按量计费余额。
            $verdict = 'UNFUNDED(402)'
            $script:Unfunded = 1
        } else {
            $verdict = 'DEVIATION'
            $script:Failed = 1
        }
    }

    '{0,-46} 期望 {1,-4} 实际 {2,-4}  [{3}]' -f $Label, $Expected, $status, $verdict
}

$sessionId = [guid]::NewGuid().ToString()

Write-Host "端点 : $Endpoint"
Write-Host "模式 : $Mode"
Write-Host "模型 : $Model"
Write-Host "会话 : $sessionId"
Write-Host "查询 : $Query"
Write-Host ''

$escapedQuery = $Query.Replace('\', '\\').Replace('"', '\"') -replace '[\r\n]', ' '
$body = '{"model":"' + $Model + '","max_tokens":2048,"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: ' + $escapedQuery + '"}]}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]}'
[System.IO.File]::WriteAllText($ReqBody, $body, [System.Text.Encoding]::ASCII)

Write-Host '--- 传输层检查 -------------------------------------------------------'
Invoke-ProbeCase '1. x-api-key + Bearer + 会话头' 200 @(
    "-H", "x-api-key: $ApiKey", "-H", "Authorization: Bearer $ApiKey", "-H", "x-opencode-session: $sessionId"
)
Invoke-ProbeCase '2. 相同请求，但不带会话头' 400 @(
    "-H", "x-api-key: $ApiKey", "-H", "Authorization: Bearer $ApiKey"
)
Invoke-ProbeCase '3. 仅 Bearer（不带 x-api-key），带会话头' 401 @(
    "-H", "Authorization: Bearer $ApiKey", "-H", "x-opencode-session: $sessionId"
)

Write-Host ''
Write-Host '--- 它真的会运行 DeepSeek 服务端 web_search 吗？ ----------------------'

if ($script:Unfunded -eq 1) {
    Write-Host 'SKIPPED: 按量计费账户没有余额（HTTP 402），因此没有可检查的'
    Write-Host '         响应负载。路由与凭据都没有问题 ——'
    Write-Host '         请充值，或改为探测 Go 套餐：'
    Write-Host '             .\scripts\probe-opencode.ps1 "<query>" go'
    $raw = $null
} else {
    Invoke-ProbeCase '4. 重跑用例 1 以检查响应负载' 200 @(
        "-H", "x-api-key: $ApiKey", "-H", "Authorization: Bearer $ApiKey", "-H", "x-opencode-session: $([guid]::NewGuid())"
    ) | Out-Null
    $raw = Get-Content -Raw -Encoding UTF8 $RespBody -ErrorAction SilentlyContinue
}

if ($script:Unfunded -ne 1) {
    if ($raw -and $raw.Contains('"web_search_tool_result"')) {
        $results = ([regex]::Matches($raw, '"type":"web_search_result"')).Count
        Write-Host "PASS: 响应中包含 web_search_tool_result  （结果数：$results）"
        if ($raw.Contains('"server_tool_use"'))        { Write-Host 'PASS: 响应中包含 server_tool_use（模型确实调用了 web_search）' }
        if ($raw.Contains('"web_search_requests"'))    { Write-Host 'PASS: 已上报 usage.server_tool_use.web_search_requests' }
        if ($raw.Contains('"cited_text"')) {
            Write-Host 'NOTE: 存在 cited_text —— 该部署其实会输出摘要'
        } else {
            Write-Host 'NOTE: 响应负载中没有 cited_text/snippet；各项只带 title/url/page_age，'
            Write-Host '      因此插件返回不带摘要的来源，而不是凭空编造一个。'
        }

        Write-Host ''
        Write-Host '前几个来源：'
        [regex]::Matches($raw, '"url":"([^"]*)"') |
            Select-Object -First 5 |
            ForEach-Object { '  - ' + $_.Groups[1].Value }
    } else {
        Write-Host 'FAIL: 响应中没有 web_search_tool_result。'
        Write-Host '      端点有响应，但没有运行服务端工具。'
        if ($raw) { Write-Host ('      前 400 字节：' + $raw.Substring(0, [Math]::Min(400, $raw.Length))) }
        $script:Failed = 1
    }
}

Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue

Write-Host ''
if ($script:Failed -ne 0) {
    Write-Host 'RESULT: 至少有一项检查偏离预期；见上方标记为 DEVIATION/FAIL 的行。'
    exit 1
}
if ($script:Unfunded -eq 1) {
    Write-Host 'RESULT: 路由与鉴权都正确，但按量计费端点需要资金（HTTP 402）。'
    Write-Host '        请使用 Go 套餐（插件默认）或为账户充值。'
    exit 0
}
Write-Host 'RESULT: 所有检查都符合预期 —— 该端点支持 DeepSeek web_search。'
exit 0

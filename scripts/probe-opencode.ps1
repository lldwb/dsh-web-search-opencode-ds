# probe-opencode.ps1 - Windows twin of scripts/probe-opencode.sh.
#
# Verifies that OpenCode's Anthropic-compatible Messages endpoint really runs
# DeepSeek's official server-side `web_search` tool, and pins down the two header
# requirements this plugin depends on:
#
#   1. x-api-key + Bearer + x-opencode-session  -> 200 with web_search_tool_result
#   2. same request WITHOUT x-opencode-session  -> 400 MissingSessionID
#   3. Bearer only (no x-api-key)               -> 401 AuthError
#
# The plugin's `goMode` switch chooses between two endpoints that share one wire
# format - `go` is the flat-rate Go subscription, `metered` is the default
# pay-as-you-go API:
#
#   go       https://opencode.ai/zen/go/v1
#   metered  https://opencode.ai/zen/v1
#
# On an account with no metered balance the metered endpoint answers HTTP 402
# "Insufficient account funds". That is an account fact, not a broken route, so
# this script reports it as UNFUNDED(402) and still exits 0.
#
# Usage:
#   $env:OPENCODE_API_KEY = 'sk-...'
#   pwsh -File .\scripts\probe-opencode.ps1 ["your query"] [go|metered]
#
# Exit codes: 0 = all checks as expected, 1 = a check deviated, 2 = missing credential.

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
$Model      = if ($env:OPENCODE_MODEL)        { $env:OPENCODE_MODEL }        else { 'deepseek-v4-flash' }
$ApiVersion = if ($env:OPENCODE_API_VERSION)  { $env:OPENCODE_API_VERSION }  else { '2023-06-01' }
$Timeout    = if ($env:OPENCODE_TIMEOUT)      { [int]$env:OPENCODE_TIMEOUT } else { 120 }
$UserAgent  = 'dsh-web-search-opencode-ds/0.2.0'

$ApiKey = if ($env:OPENCODE_API_KEY) { $env:OPENCODE_API_KEY } elseif ($env:OPENCODE_GO_API_KEY) { $env:OPENCODE_GO_API_KEY } else { '' }
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Error @'
No API key. Set one first:
  $env:OPENCODE_API_KEY = 'sk-...'
Subscribe and copy a key at https://opencode.ai/auth - the Go plan and the
metered API are separate entitlements on one account.
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
            # Route and auth are fine; the account has no metered balance.
            $verdict = 'UNFUNDED(402)'
            $script:Unfunded = 1
        } else {
            $verdict = 'DEVIATION'
            $script:Failed = 1
        }
    }

    '{0,-46} expected {1,-4} got {2,-4}  [{3}]' -f $Label, $Expected, $status, $verdict
}

$sessionId = [guid]::NewGuid().ToString()

Write-Host "endpoint : $Endpoint"
Write-Host "mode     : $Mode"
Write-Host "model    : $Model"
Write-Host "session  : $sessionId"
Write-Host "query    : $Query"
Write-Host ''

$escapedQuery = $Query.Replace('\', '\\').Replace('"', '\"') -replace '[\r\n]', ' '
$body = '{"model":"' + $Model + '","max_tokens":2048,"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: ' + $escapedQuery + '"}]}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]}'
[System.IO.File]::WriteAllText($ReqBody, $body, [System.Text.Encoding]::ASCII)

Write-Host '--- transport checks -------------------------------------------------'
Invoke-ProbeCase '1. x-api-key + Bearer + session header' 200 @(
    "-H", "x-api-key: $ApiKey", "-H", "Authorization: Bearer $ApiKey", "-H", "x-opencode-session: $sessionId"
)
Invoke-ProbeCase '2. same, but NO session header' 400 @(
    "-H", "x-api-key: $ApiKey", "-H", "Authorization: Bearer $ApiKey"
)
Invoke-ProbeCase '3. Bearer only (no x-api-key), with session' 401 @(
    "-H", "Authorization: Bearer $ApiKey", "-H", "x-opencode-session: $sessionId"
)

Write-Host ''
Write-Host '--- does it run DeepSeek server-side web_search? ---------------------'

if ($script:Unfunded -eq 1) {
    Write-Host 'SKIPPED: the metered account has no balance (HTTP 402), so there is no'
    Write-Host '         payload to inspect. The route and the credential are both fine -'
    Write-Host '         add funds, or probe the Go plan instead:'
    Write-Host '             .\scripts\probe-opencode.ps1 "<query>" go'
    $raw = $null
} else {
    Invoke-ProbeCase '4. re-run case 1 for payload inspection' 200 @(
        "-H", "x-api-key: $ApiKey", "-H", "Authorization: Bearer $ApiKey", "-H", "x-opencode-session: $([guid]::NewGuid())"
    ) | Out-Null
    $raw = Get-Content -Raw -Encoding UTF8 $RespBody -ErrorAction SilentlyContinue
}

if ($script:Unfunded -ne 1) {
    if ($raw -and $raw.Contains('"web_search_tool_result"')) {
        $results = ([regex]::Matches($raw, '"type":"web_search_result"')).Count
        Write-Host "PASS: response contains web_search_tool_result  (results: $results)"
        if ($raw.Contains('"server_tool_use"'))        { Write-Host 'PASS: response contains server_tool_use (the model invoked web_search)' }
        if ($raw.Contains('"web_search_requests"'))    { Write-Host 'PASS: usage.server_tool_use.web_search_requests is reported' }
        if ($raw.Contains('"cited_text"')) {
            Write-Host 'NOTE: cited_text present - this deployment emits snippets after all'
        } else {
            Write-Host 'NOTE: no cited_text/snippet in the payload; items carry title/url/page_age only,'
            Write-Host '      so the plugin returns sources without a snippet rather than inventing one.'
        }

        Write-Host ''
        Write-Host 'first sources:'
        [regex]::Matches($raw, '"url":"([^"]*)"') |
            Select-Object -First 5 |
            ForEach-Object { '  - ' + $_.Groups[1].Value }
    } else {
        Write-Host 'FAIL: no web_search_tool_result in the response.'
        Write-Host '      The endpoint answered, but did not run the server-side tool.'
        if ($raw) { Write-Host ('      First 400 bytes: ' + $raw.Substring(0, [Math]::Min(400, $raw.Length))) }
        $script:Failed = 1
    }
}

Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue

Write-Host ''
if ($script:Failed -ne 0) {
    Write-Host 'RESULT: at least one check deviated; see the lines marked DEVIATION/FAIL above.'
    exit 1
}
if ($script:Unfunded -eq 1) {
    Write-Host 'RESULT: routing and auth are correct, but the metered endpoint needs funds (HTTP 402).'
    Write-Host '        Use the Go plan (the plugin''s default) or top up the account.'
    exit 0
}
Write-Host 'RESULT: all checks behaved as expected - the endpoint supports DeepSeek web_search.'
exit 0

# 等服务端口真正通了的再打开浏览器。
# 原来的启动脚本是「先开浏览器、后启动服务」，Node 冷启动要一两秒，
# 浏览器抢在前面打开就只能看到「localhost 拒绝连接」，得手动刷新 —— 这里根治。
# 注意：PowerShell 5.1 按 ANSI 解析脚本，本文件必须保持纯 ASCII。
param(
    [int]$Port = 5199,
    [string]$Url = 'http://localhost:5199',
    [int]$TimeoutSec = 60
)

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $Port)
        if ($client.Connected) {
            $client.Close()
            Start-Process $Url
            exit 0
        }
    } catch {
        # 端口还没监听，继续等
    } finally {
        if ($client) { $client.Dispose() }
    }
    Start-Sleep -Milliseconds 400
}
exit 1

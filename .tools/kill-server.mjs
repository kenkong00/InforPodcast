/** 收尾清理：把我自己起的后台服务进程从 5199 端口上摘掉 */
import { spawn } from 'child_process';

function run(file, args) {
  return new Promise(res => {
    const p = spawn(file, args, { windowsHide: true, shell: false });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('exit', () => res({ out, err }));
    p.on('error', () => res({ out: '', err: 'spawn failed' }));
  });
}

const ps = process.platform === 'win32' ? 'powershell.exe' : 'ps';
const script =
  '$c = Get-NetTCPConnection -LocalPort 5199 -State Listen -ErrorAction SilentlyContinue;\n' +
  'if ($c) { $c | ForEach-Object { Write-Output ("PID=" + $_.OwningProcess) } } else { Write-Output "NONE" }';

const r = await run(ps, ['-NoProfile', '-Command', script]);
const raw = (r.out || '').trim();
console.log('原始输出:', raw || '(空)');

if (raw.includes('NONE') || !raw.includes('PID=')) {
  console.log('端口 5199 现在没有监听进程，干净的。');
  process.exit(0);
}
const pids = [...new Set(raw.match(/PID=(\d+)/g).map(s => s.slice(4)))];
console.log('发现占用进程:', pids.join(', '));
for (const pid of pids) {
  const k = await run('taskkill.exe', ['/PID', pid, '/T', '/F']);
  console.log(`  终止 ${pid} -> ${(k.out || k.err || '').trim().split(/\r?\n/)[0] || 'ok'}`);
}
await new Promise(r2 => setTimeout(r2, 800));
const again = await run(ps, ['-NoProfile', '-Command', script]);
console.log('复查:', (again.out || '').trim().includes('PID=') ? '仍有残留' : '5199 已释放');
process.exit(0);

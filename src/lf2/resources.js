import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
// Acrab's shared exact Data floor / Activity Monitor-equivalent memory limit.
export function parseMacResources(vm, disk) {
  const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1]);
  const pages = name => Number(vm.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm'))?.[1]);
  const memoryBytes = (pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
  const freeBytes = Number(disk.trim().split('\n').at(-1).trim().split(/\s+/)[3]) * 1024;
  if (!Number.isFinite(memoryBytes) || !Number.isFinite(freeBytes)) throw new Error('Cannot verify shared resource limits');
  if (freeBytes < 1.2 * 1024 ** 3) throw new Error('Data free space is below Acrab\'s 1.2 GiB floor');
  if (memoryBytes >= 15 * 1024 ** 3) throw new Error('Memory Used reached Acrab\'s 15 GiB limit');
  return { memoryBytes, freeBytes };
}
export async function checkMacResources() {
  if (process.platform !== 'darwin') return;
  const [vm, disk] = await Promise.all([execute('/usr/bin/vm_stat'), execute('/bin/df', ['-k', '/System/Volumes/Data'])]);
  return parseMacResources(vm.stdout, disk.stdout);
}

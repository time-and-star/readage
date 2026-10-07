import net from 'node:net';

export async function portOccupied(baseUrl) {
  const address = new URL(baseUrl);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: address.hostname.replace(/^\[|\]$/g, ''), port: Number(address.port || 80) });
    const finish = occupied => { socket.destroy(); resolve(occupied); };
    socket.setTimeout(1500, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

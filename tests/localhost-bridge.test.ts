import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { openLocalhostBridge, loopbackEndpoint } from '../src/localhost-bridge.js';

// Controlled host/Docker identities, not a real Docker daemon or container.
vi.mock('node:os', () => ({platform: () => 'linux', networkInterfaces: () => ({'fixture-bridge': [{address: '127.0.0.2', family: 'IPv4', internal: false}]})}));
vi.mock('node:fs/promises', () => ({stat: async (path: string) => path === '/controlled/docker.sock'
  ? {isSocket: () => true, uid: 0} : {isDirectory: () => path === '/sys/class/net/fixture-bridge/bridge'}}));
const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(closes.splice(0).reverse().map(close => close())); });

function dockerFixture(fault?: string) {
  const id = 'a'.repeat(64), networkId = 'b'.repeat(64);
  let running = true;
  const command = async (args: string[]) => {
    if (args[0] === 'context') return {stdout: JSON.stringify([{Endpoints: {docker: {Host: fault === 'remote' ? 'ssh://remote/daemon' : 'unix:///controlled/docker.sock'}}}])};
    if (args[0] === 'info') return {stdout: JSON.stringify({OSType: 'linux', SecurityOptions: fault === 'rootless' ? ['name=rootless'] : ['name=seccomp'], OperatingSystem: fault === 'desktop' ? 'Docker Desktop' : 'Controlled Linux'})};
    if (args[0] === 'network') return {stdout: JSON.stringify([{Id: networkId, Name: 'fixture', Options: {'com.docker.network.bridge.name': 'fixture-bridge'}, Driver: fault === 'overlay' ? 'overlay' : 'bridge', Scope: 'local', IPAM: {Config: [{Subnet: '127.0.0.0/8', Gateway: fault === 'gateway' ? '192.0.2.1' : '127.0.0.2'}]}, Containers: {[id]: {IPv4Address: '127.0.0.3/8'}}}])};
    if (args[0] === 'inspect') return {stdout: JSON.stringify({Id: id, State: {Running: running}, NetworkSettings: {Networks: {fixture: {NetworkID: networkId, IPAddress: '127.0.0.3', Gateway: '127.0.0.2'}}}})};
    throw Error('Unexpected Docker operation');
  };
  return {command, id, stop: () => { running = false; }};
}

async function peer() {
  const sockets = new Set<Socket>();
  const server = createServer({allowHalfOpen: true}, socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  closes.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return {server, endpoint: `http://127.0.0.1:${(server.address() as {port: number}).port}/proxy/%2Fprefix/`};
}

function client(endpoint: string, localAddress = '127.0.0.3') {
  const url = new URL(endpoint);
  const socket = connect({host: url.hostname, port: Number(url.port), localAddress, allowHalfOpen: true});
  socket.on('error', () => {});
  socket.on('end', () => socket.end());
  socket.resume();
  closes.push(async () => { socket.destroy(); });
  return socket;
}

test('execution bridge streams opaque bytes and half-close only for the verified container', async () => {
  const upstream = await peer(), docker = dockerFixture();
  const bridge = await openLocalhostBridge(loopbackEndpoint(upstream.endpoint)!, 'fixture', docker.command);
  closes.push(() => bridge.close());
  expect(new URL(bridge.endpoint).hostname).toBe('127.0.0.2');
  expect(new URL(bridge.endpoint).pathname).toBe('/proxy/%2Fprefix/');
  expect(new URL(bridge.endpoint).protocol).toBe('http:');
  expect(Number(new URL(bridge.endpoint).port)).toBeGreaterThan(0);
  const early = client(bridge.endpoint);
  await once(early, 'close');
  const received: Buffer[] = [];
  upstream.server.on('connection', socket => {
    socket.on('data', chunk => received.push(chunk));
    socket.on('end', () => socket.end(Buffer.from([0, 255, 1, 13, 10])));
  });
  await bridge.authorize(docker.id);
  const denied = client(bridge.endpoint, '127.0.0.4');
  await once(denied, 'close');
  expect(received).toEqual([]);
  const allowed = client(bridge.endpoint);
  const reply: Buffer[] = [];
  allowed.on('data', chunk => reply.push(chunk));
  allowed.end(Buffer.from([255, 0, 128, 13, 10]));
  await once(allowed, 'close');
  expect(Buffer.concat(received)).toEqual(Buffer.from([255, 0, 128, 13, 10]));
  expect(Buffer.concat(reply)).toEqual(Buffer.from([0, 255, 1, 13, 10]));
  docker.stop();
  const reused = client(bridge.endpoint);
  await once(reused, 'close');
  expect(Buffer.concat(received)).toEqual(Buffer.from([255, 0, 128, 13, 10]));
  await bridge.close();
  const closed = client(bridge.endpoint);
  await new Promise<void>(resolve => closed.once('close', () => resolve()));
  expect(closed.errored).toBeTruthy();
});

test('slow peers apply bounded backpressure in both directions without losing bytes', async () => {
  const upstream = await peer(), docker = dockerFixture();
  const bridge = await openLocalhostBridge(loopbackEndpoint(upstream.endpoint)!, 'fixture', docker.command);
  closes.push(() => bridge.close()); await bridge.authorize(docker.id);
  const payload = Buffer.alloc(32 * 1024 * 1024, 0xa5);
  const hash = createHash('sha256').update(payload).digest('hex');
  const connected = once(upstream.server, 'connection');
  const sender = client(bridge.endpoint);
  await once(sender, 'connect');
  const drained = once(sender, 'drain');
  expect(sender.write(payload)).toBe(false);
  const [receiver] = await connected as [Socket];
  receiver.pause();
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(sender.writableLength).toBeGreaterThan(0);
  const received = createHash('sha256'); receiver.on('data', chunk => received.update(chunk));
  const inbound = once(receiver, 'end'); receiver.resume();
  await drained; sender.end(); await inbound;
  expect(received.digest('hex')).toBe(hash);
  sender.pause();
  expect(receiver.write(payload)).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(receiver.writableLength).toBeGreaterThan(0);
  const returned = createHash('sha256'); sender.on('data', chunk => returned.update(chunk));
  const outbound = once(sender, 'end'); sender.resume(); receiver.end(); await outbound;
  expect(returned.digest('hex')).toBe(hash);
}, 15000);

test.each(['localhost', 'localhost.', '[::1]', '[::ffff:127.0.0.1]', '127.2.3.4'])('HTTPS loopback %s fails explicitly instead of silently using the container loopback', host => {
  expect(() => loopbackEndpoint(`https://${host}:8443/prefix`)).toThrow(/TLS|SNI/);
});

test.each(['remote', 'rootless', 'desktop', 'overlay', 'gateway'])('unsupported %s Docker environment fails closed', async fault => {
  const upstream = await peer(), docker = dockerFixture(fault);
  await expect(openLocalhostBridge(loopbackEndpoint(upstream.endpoint)!, 'fixture', docker.command)).rejects.toThrow(/local Linux rootful Docker.*gateway.*explicit container-reachable/);
});

test('upstream connect failure closes the client without leaking or crashing', async () => {
  const docker = dockerFixture();
  const upstream = await peer();
  const bridge = await openLocalhostBridge(loopbackEndpoint(upstream.endpoint)!, 'fixture', docker.command);
  closes.push(() => bridge.close()); await bridge.authorize(docker.id);
  await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  const socket = client(bridge.endpoint); socket.end('opaque request');
  await new Promise<void>(resolve => socket.once('close', () => resolve()));
});

test('localhost resolves only to pinned host loopback addresses', async () => {
  const upstream = await peer(), docker = dockerFixture();
  upstream.server.on('connection', socket => {socket.on('data', () => {}); socket.on('end', () => socket.end('reply after FIN'));});
  const bridge = await openLocalhostBridge(loopbackEndpoint(upstream.endpoint.replace('127.0.0.1', 'localhost'))!, 'fixture', docker.command);
  closes.push(() => bridge.close()); await bridge.authorize(docker.id);
  const socket = client(bridge.endpoint); let output = '';
  socket.on('data', chunk => {output += chunk;}); socket.end('request');
  await once(socket, 'close');
  expect(output).toBe('reply after FIN');
});

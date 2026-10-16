import { BlockList, createServer, Socket, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { networkInterfaces, platform } from 'node:os';
import { stat } from 'node:fs/promises';

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackAddresses.addAddress('::1', 'ipv6');
const isLoopback = (host: string) => !!isIP(host) && loopbackAddresses.check(host, isIP(host) === 4 ? 'ipv4' : 'ipv6');

export function loopbackEndpoint(endpoint: string | undefined) {
  if (!endpoint) return;
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', 'localhost.'].includes(host) && !isLoopback(host)) return;
  if (url.protocol !== 'http:') throw Error('Localhost bridge does not support HTTPS TLS/SNI rewriting; select an explicit container-reachable endpoint with valid TLS');
  return {url, host};
}

type DockerCommand = (args: string[]) => Promise<{stdout: string}>;
const unsupported = () => Error('Localhost bridge requires local Linux rootful Docker with a verified local bridge gateway; select an explicit container-reachable endpoint');

export async function openLocalhostBridge(target: NonNullable<ReturnType<typeof loopbackEndpoint>>, network: string, command: DockerCommand) {
  // Docker inspection is deliberately formatted: never collect container Config.Env.
  const json = async (args: string[]) => JSON.parse((await command(args)).stdout);
  let upstreamHosts = [target.host];
  if (!isIP(target.host)) {
    const addresses = await lookup(target.host, {all: true}).catch(() => []);
    if (!addresses.length || addresses.some(({address}) => !isLoopback(address))) throw unsupported();
    upstreamHosts = [...new Set(addresses.map(({address}) => address))];
  }
  let networkId: string, gateway: string;
  try {
    if (platform() !== 'linux' || network === 'none' || network === 'host') throw unsupported();
    const [context] = await json(['context', 'inspect']);
    const host = context?.Endpoints?.docker?.Host;
    if (typeof host !== 'string' || !host.startsWith('unix:///')) throw unsupported();
    const socket = await stat(host.slice('unix://'.length));
    if (!socket.isSocket() || socket.uid !== 0) throw unsupported();
    const info = await json(['info', '--format', '{{json .}}']);
    if (info.OSType !== 'linux' || !Array.isArray(info.SecurityOptions)
      || info.SecurityOptions.some((value: unknown) => typeof value !== 'string' || /rootless/i.test(value))
      || /docker desktop/i.test(info.OperatingSystem ?? '')) throw unsupported();
    const [inspected] = await json(['network', 'inspect', network]);
    if (inspected?.Driver !== 'bridge' || inspected.Scope !== 'local' || !/^[a-f0-9]{64}$/.test(inspected.Id)) throw unsupported();
    networkId = inspected.Id;
    const gateways = inspected.IPAM?.Config?.map((entry: {Gateway?: string}) => entry.Gateway).filter((address: unknown) => typeof address === 'string' && isIP(address) === 4);
    if (!Array.isArray(gateways) || gateways.length !== 1) throw unsupported();
    gateway = gateways[0];
    const local = Object.entries(networkInterfaces()).filter(([, addresses]) => addresses?.some(address => address.family === 'IPv4' && address.address === gateway && !address.internal));
    const interfaceName = inspected.Options?.['com.docker.network.bridge.name']
      || (inspected.Options?.['com.docker.network.bridge.default_bridge'] === 'true' ? 'docker0' : `br-${networkId.slice(0, 12)}`);
    if (local.length !== 1 || local[0][0] !== interfaceName || !(await stat(`/sys/class/net/${interfaceName}/bridge`)).isDirectory()) throw unsupported();
  } catch { throw unsupported(); }

  let containerId: string | undefined, address: string | undefined;
  const sockets = new Set<Socket>();
  const identity = async (id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw unsupported();
    const container = await json(['inspect', '--format', '{"Id":{{json .Id}},"State":{{json .State}},"NetworkSettings":{{json .NetworkSettings}}}', id]);
    const attached = Object.values(container?.NetworkSettings?.Networks ?? {}) as {NetworkID: string; IPAddress: string; Gateway: string}[];
    const link = attached.find(link => link.NetworkID === networkId);
    if (container?.Id !== id || container.State?.Running !== true || attached.length !== 1 || !link
      || isIP(link.IPAddress) !== 4 || link.Gateway !== gateway) throw unsupported();
    const [current] = await json(['network', 'inspect', networkId]);
    if (current?.Id !== networkId || current.Containers?.[id]?.IPv4Address?.split('/')[0] !== link.IPAddress) throw unsupported();
    return link.IPAddress;
  };
  const track = (socket: Socket) => {
    socket.unref();
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  let closed = false;
  let checking = 0;
  const server = createServer({allowHalfOpen: true}, client => {
    client.on('error', () => client.destroy());
    if (closed || !containerId || !address || client.remoteAddress !== address || checking >= 8) { client.destroy(); return; }
    track(client);
    client.pause();
    checking++;
    void (async () => {
      try {
        if (await identity(containerId!) !== address || client.destroyed || closed) { client.destroy(); return; }
        const upstream = new Socket({allowHalfOpen: true});
        track(upstream);
        upstream.on('error', () => { client.destroy(); upstream.destroy(); });
        client.on('error', () => upstream.destroy());
        client.on('close', () => { if (!client.readableEnded) upstream.destroy(); });
        upstream.on('close', () => { if (!upstream.readableEnded) client.destroy(); });
        upstream.connect({host: target.host, port: Number(target.url.port || 80),
          lookup: (_hostname, _options, callback) => callback(null, upstreamHosts.map(address => ({address, family: isIP(address)}))),
          autoSelectFamily: true});
        // pipe handles backpressure and FIN independently in each direction.
        client.pipe(upstream); upstream.pipe(client);
      } catch { client.destroy(); }
      finally { checking--; }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, gateway, () => { server.off('error', reject); resolve(); });
  });
  server.maxConnections = 64;
  server.unref(); // Retained unknown bridges must not keep a stopped control service alive.
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  const bound = server.address();
  if (!bound || typeof bound === 'string' || bound.address !== gateway || !bound.port) { server.close(); throw unsupported(); }
  const endpoint = new URL(target.url);
  endpoint.hostname = gateway; endpoint.port = String(bound.port);
  return {
    endpoint: endpoint.href,
    network: networkId,
    async authorize(id: string) { address = await identity(id); containerId = id; },
    async close() {
      if (closed) return;
      closed = true;
      const ended = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await ended;
    },
  };
}

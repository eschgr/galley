import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { createPlatformBridge, channelAddress } from './index';

// The channel listener (R11–R15) over a real OS transport: a named pipe on
// Windows, a Unix-domain socket elsewhere. The caller connects and writes
// newline-terminated absolute paths; the bridge hands each to onFile.
const addrFor = (name: string) => channelAddress(`test-${name}`);

function send(address: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.connect(address, () => client.end(message));
    client.on('error', reject);
    client.on('close', () => resolve());
  });
}

describe('channel listener (R11–R15)', () => {
  it('delivers newline-separated paths sent over the channel', async () => {
    const bridge = createPlatformBridge();
    const addr = addrFor(`mdtool-test-${process.pid}-${Date.now()}`);
    const got: string[] = [];
    await bridge.listenOnChannel(addr, (p) => got.push(p));

    await send(addr, 'C:\\docs\\a.md\nC:\\docs\\b.md\n');
    await new Promise((r) => setTimeout(r, 60));

    expect(got).toEqual(['C:\\docs\\a.md', 'C:\\docs\\b.md']);
    await bridge.closeChannel();
  });

  it('delivers a single path sent without a trailing newline', async () => {
    const bridge = createPlatformBridge();
    const addr = addrFor(`mdtool-test2-${process.pid}-${Date.now()}`);
    const got: string[] = [];
    await bridge.listenOnChannel(addr, (p) => got.push(p));

    await send(addr, '/tmp/x.md');
    await new Promise((r) => setTimeout(r, 60));

    expect(got).toEqual(['/tmp/x.md']);
    await bridge.closeChannel();
  });

  it('rejects if the address is already in use', async () => {
    const a = createPlatformBridge();
    const b = createPlatformBridge();
    const addr = addrFor(`mdtool-test3-${process.pid}-${Date.now()}`);
    const noop = () => {
      /* unused */
    };
    await a.listenOnChannel(addr, noop);
    await expect(b.listenOnChannel(addr, noop)).rejects.toBeTruthy();
    await a.closeChannel();
  });
});

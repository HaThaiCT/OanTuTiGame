#!/usr/bin/env node
import { Socket } from 'node:net';
import { runGameHost } from '../src/game-host.js';

// stdin is a private full-duplex Unix socket supplied by the native supervisor,
// not a terminal or public listener. No CLI Bot paths or native fallback.
const socket = new Socket({ fd: 0, readable: true, writable: true });
runGameHost(socket).catch(() => {
  console.error('GAME_HOST_EXECUTION_FAILED');
  socket.destroy();
  process.exitCode = 1;
});

import * as readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'INIT') {
    process.stdout.write(JSON.stringify({ status: 'READY' }) + '\n');
  } else if (msg.type === 'TURN') {
    // Deliberately move into donut hole (3, 3)
    process.stdout.write(
      JSON.stringify({ action: 'MOVE', piece_id: 1, target: [3, 3] }) + '\n'
    );
  }
});

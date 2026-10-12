import * as readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'INIT') {
    process.stdout.write(JSON.stringify({ status: 'READY' }) + '\n');
  } else if (msg.type === 'TURN') {
    // Deliberately sleep 250ms exceeding 50ms/100ms budget
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ action: 'PASS' }) + '\n');
    }, 250);
  }
});

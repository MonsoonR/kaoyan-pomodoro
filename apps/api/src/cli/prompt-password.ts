import { stdin, stdout } from 'node:process';

export async function promptHidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error('An interactive terminal is required');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onData = (key: string) => {
        if (key === '\u0003') {
          stdin.off('data', onData);
          reject(new Error('Password input cancelled'));
        } else if (key === '\r' || key === '\n') {
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
        } else if (key === '\u007f' || key === '\b') {
          value = value.slice(0, -1);
        } else if (key >= ' ') {
          value += key;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

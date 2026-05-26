#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

function suppressSqliteExperimentalWarning(): void {
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const optionsArg = (typeof args[0] === 'object' && args[0] !== null ? (args[0] as { type?: unknown; name?: unknown }) : null);
    const warningName =
      warning instanceof Error
        ? warning.name
        : typeof optionsArg?.type === 'string'
          ? optionsArg.type
          : typeof optionsArg?.name === 'string'
            ? optionsArg.name
            : typeof args[1] === 'string'
              ? args[1]
              : typeof args[0] === 'string'
                ? args[0]
                : '';
    const warningMessage = warning instanceof Error ? warning.message : String(warning);

    if (warningName === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(warningMessage)) {
      return;
    }

    return emitWarning(warning as never, ...(args as []));
  }) as typeof process.emitWarning;
}

class StdoutWriter {
  write(line: string): void {
    stdout.write(`${line}\n`);
  }
}

class ReadlinePrompt {
  private readonly rl = createInterface({ input: stdin, output: stdout });

  private async hiddenQuestion(prompt: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const input = stdin;
      let value = '';
      const cleanup = () => {
        input.off('data', onData);
        input.setRawMode(false);
        input.pause();
      };
      const finish = (result: string) => {
        cleanup();
        stdout.write('\n');
        resolve(result);
      };
      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const char of text) {
          if (char === '\r' || char === '\n') {
            finish(value);
            return;
          }
          if (char === '\u0003') {
            cleanup();
            reject(new Error('Input cancelled.'));
            return;
          }
          if (char === '\u007f' || char === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          if (char >= ' ' && char !== '\u007f') {
            value += char;
          }
        }
      };

      try {
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
        stdout.write(prompt);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async input(
    label: string,
    description: string,
    fallback: string,
    validate?: (value: string) => string | null,
    options?: { sensitive?: boolean }
  ): Promise<string> {
    stdout.write(`\n${label}\n${description}\n`);

    while (true) {
      const raw = (
        options?.sensitive
          ? await (async () => {
              if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
                return await this.rl.question('Value [hidden]: ');
              }
              this.rl.pause();
              try {
                return await this.hiddenQuestion('Value [hidden]: ');
              } finally {
                this.rl.resume();
              }
            })()
          : await this.rl.question(`Value [${fallback}]: `)
      ).trim();
      const value = raw || fallback;
      const error = validate ? validate(value) : null;
      if (!error) {
        return value;
      }
      stdout.write(`${error}\n`);
    }
  }

  async select<T extends string>(
    label: string,
    description: string,
    options: Array<{ label: string; value: T; description: string }>,
    fallback: T
  ): Promise<T> {
    stdout.write(`\n${label}\n${description}\n`);
    for (const [index, option] of options.entries()) {
      stdout.write(`  ${index + 1}. ${option.label} - ${option.description}\n`);
    }

    const fallbackIndex = Math.max(
      1,
      options.findIndex((option) => option.value === fallback) + 1
    );

    while (true) {
      const raw = (await this.rl.question(`Choose [${fallbackIndex}]: `)).trim();
      if (raw === '') {
        return fallback;
      }

      const selected = Number.parseInt(raw, 10);
      if (Number.isFinite(selected) && selected >= 1 && selected <= options.length) {
        return options[selected - 1].value;
      }

      stdout.write('Please enter one of the option numbers.\n');
    }
  }

  async confirm(label: string, description: string, fallback: boolean): Promise<boolean> {
    stdout.write(`\n${label}\n${description}\n`);

    while (true) {
      const raw = (await this.rl.question(`Value [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
      if (raw === '') {
        return fallback;
      }
      if (raw === 'y' || raw === 'yes') {
        return true;
      }
      if (raw === 'n' || raw === 'no') {
        return false;
      }
      stdout.write('Please answer yes or no.\n');
    }
  }

  close(): void {
    this.rl.close();
  }
}

async function main(): Promise<void> {
  suppressSqliteExperimentalWarning();

  try {
    const cli = await import('./app/cli/cli.js');
    const command = cli.parseCliArgs(process.argv.slice(2));

    const writer = new StdoutWriter();
    const prompt = new ReadlinePrompt();
    const { ChildProcessRunner } = await import('@moorline/core/core/shared/utils/commandRunner.js');
    const exitCode = await cli.executeCli(command, cli.cliDefaults(writer, prompt, new ChildProcessRunner()));
    process.exitCode = exitCode;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (typeof process.versions.bun === 'string' && /node:sqlite|sqlite/i.test(message)) {
      message = `${message}\nMoorline runtime commands must execute on Node.js. Use \`bun run moorline <command>\` or \`node packages/cli/dist/main.js <command>\`.`;
    }
    const writer = new StdoutWriter();
    writer.write(`Error: ${message}`);
    process.exitCode = 1;
  }
}

void main();

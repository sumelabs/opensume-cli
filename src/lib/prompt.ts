import { CliError, ExitCode, UsageError } from "./errors.ts";

/**
 * Read a secret from the terminal without echoing it. Ctrl-C cancels,
 * Backspace edits, and a paste arrives as one chunk.
 */
export function readSecret(question: string, stream: NodeJS.WriteStream = process.stderr): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY)
    throw new UsageError("No terminal to read the key from.", "Pipe it instead: `… | opensume auth login --with-key`.");
  return new Promise((resolve, reject) => {
    let value = "";
    stream.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      stream.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          return done(new CliError("Canceled.", { exitCode: ExitCode.Interrupted, code: "interrupted" }));
        }
        if (char === "\r" || char === "\n" || char === "\u0004") return done();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

import { createInterface } from "node:readline/promises";

/** Ask a yes/no question. Resolves undefined when there's no terminal to ask in. */
export type Confirm = (question: string) => Promise<boolean | undefined>;

export const confirmInTerminal: Confirm = async (question) => {
  if (!process.stdin.isTTY) return undefined;

  // stderr, so the prompt doesn't end up in piped output.
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  prompt.on("SIGINT", () => prompt.close());

  try {
    const answer = await prompt.question(`${question} [y/N] `);

    return /^y(es)?$/i.test(answer.trim());
  } catch {
    // Ctrl+C or a closed input stream: treat as no.
    return false;
  } finally {
    prompt.close();
  }
};

import * as readline from 'readline';

export const DEFAULT_PROVIDER_ORDER = ['google-vertex/global', 'google-vertex', 'fireworks'];

export function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export function waitForUserInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function getNonContainerAncestorXpath(xpath: string): string {
  let currentXpath = xpath.startsWith('xpath=') ? xpath.substring(6) : xpath;
  const containerTags = ['a', 'div', 'span', 'td'];
  let segments = currentXpath.split('/');

  while (segments.length > 1) {
    segments.pop();
    const lastSegment = segments[segments.length - 1];
    if (!lastSegment) break;
    const tagName = lastSegment.split('[')[0].toLowerCase();
    if (!containerTags.includes(tagName)) break;
  }

  const result = segments.join('/');
  return xpath.startsWith('xpath=') ? `xpath=${result}` : result;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/// <reference types="vite/client" />

// Neither ships types; `brandShort` in lib/speakers.ts is the only user.
declare module "hypher" {
  export default class Hypher {
    constructor(language: object);
    hyphenate(word: string): string[];
  }
}
declare module "hyphenation.de" {
  const patterns: object;
  export default patterns;
}

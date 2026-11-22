// The slice of highlight.js the Review tab uses (/vendor/highlight.js is its ES build; it ships no types).
declare const hljs: {
  highlight(code: string, o: { language: string; ignoreIllegals?: boolean }): { value: string };
  getLanguage(name: string): object | undefined;
};
export default hljs;

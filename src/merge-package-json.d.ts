declare module 'merge-package.json' {
  /** Three-way merge of package.json documents, as JSON strings. */
  export default function mergePackageJson(
    local: string,
    base: string,
    remote: string
  ): string
}

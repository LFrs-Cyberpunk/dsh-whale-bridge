/** Reads a wasm module's import list without instantiating it. */
export async function readWasmImports(bytes) {
  const module = await WebAssembly.compile(bytes);
  return WebAssembly.Module.imports(module).map(({ module: m, name, kind }) => ({ module: m, name, kind }));
}

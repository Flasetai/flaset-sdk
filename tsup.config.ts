import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'deals/index': 'src/deals/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: 'es2022',
  external: ['viem'],
});

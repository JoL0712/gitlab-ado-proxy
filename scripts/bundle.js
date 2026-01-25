import * as esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'fs';

const distDir = 'dist/lambda';

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

await esbuild.build({
  entryPoints: ['src/adapters/aws-lambda.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/lambda/index.mjs',
  minify: true,
  sourcemap: true,
  external: [],
  banner: {
    js: '// GitLab-ADO Proxy Lambda Bundle',
  },
});

console.log('Lambda bundle created successfully at dist/lambda/index.mjs');

// Copia a biblioteca do Supabase para www/vendor (o APK funciona sem CDN).
import { mkdirSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('@supabase/supabase-js/package.json'));
const src = path.join(pkgDir, 'dist', 'umd', 'supabase.js');
const destDir = new URL('../www/vendor/', import.meta.url);
mkdirSync(destDir, { recursive: true });
copyFileSync(src, new URL('supabase.js', destDir));
console.log('OK: www/vendor/supabase.js atualizado');

// Ajusta o AndroidManifest para o app aparecer e rodar bem em Android TV
// (funciona em Windows, macOS e Linux):
//  - categoria LEANBACK_LAUNCHER (ícone na tela inicial da TV)
//  - touchscreen não obrigatório (TVs não têm toque)
//  - orientação paisagem
//  - banner próprio da TV (imagem 320x180 na tela inicial do Google TV)
//  - tráfego HTTP liberado (o servidor da padaria roda na rede local, sem https)
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';

const M = new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url);
if (!existsSync(M)) {
  console.error("Rode 'npx cap add android' antes.");
  process.exit(1);
}

let xml = readFileSync(M, 'utf8');

if (!xml.includes('android.software.leanback')) {
  xml = xml.replace(
    '<application',
    '<uses-feature android:name="android.software.leanback" android:required="false" />\n' +
      '    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />\n\n' +
      '    <application android:banner="@drawable/tv_banner"',
  );
}
if (!xml.includes('LEANBACK_LAUNCHER')) {
  xml = xml.replace(
    '<category android:name="android.intent.category.LAUNCHER" />',
    '<category android:name="android.intent.category.LAUNCHER" />\n' +
      '                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />',
  );
}
if (!xml.includes('screenOrientation')) {
  xml = xml.replace(
    'android:name=".MainActivity"',
    'android:name=".MainActivity"\n            android:screenOrientation="sensorLandscape"',
  );
}

if (!xml.includes('usesCleartextTraffic')) {
  xml = xml.replace('<application', '<application android:usesCleartextTraffic="true"');
}
xml = xml.replace('android:banner="@mipmap/ic_launcher"', 'android:banner="@drawable/tv_banner"');

// banner da TV
const RES = new URL('../android/app/src/main/res/drawable-xhdpi/', import.meta.url);
mkdirSync(RES, { recursive: true });
copyFileSync(new URL('./tv-banner.png', import.meta.url), new URL('tv_banner.png', RES));

writeFileSync(M, xml);
console.log('OK: AndroidManifest ajustado para TV.');

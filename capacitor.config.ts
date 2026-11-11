import type { CapacitorConfig } from '@capacitor/cli';

const address = process.env.RECEPCION_URL;
if (!address || new URL(address).protocol !== 'https:') {
  throw new Error('Configura RECEPCION_URL con la dirección HTTPS del servidor compartido.');
}
const config: CapacitorConfig = {
  appId: 'com.umbral.recepcion',
  appName: 'Golden Gate',
  webDir: 'web',
  server: { url: new URL(address).origin, cleartext: false },
};
export default config;

